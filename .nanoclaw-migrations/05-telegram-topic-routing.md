# Section 05 — Telegram topic routing family (shared-session model)

Fork commits: `b4b48017` (core), `e0ff5b41` (#37), `5b4671d9` (#39), `18c00d3d` (#40), `da9f254f` (#41), plus session-routing fresh-open.

**Model decision stands: shared sessions with explicit topic routing.** Do NOT flip the Telegram adapter's `supportsThreads` — upstream forces `per-thread` session isolation at fanout when true (`src/router.ts:534-540`), which is a different product. The channels-branch adapter still ships `supportsThreads: false` + `threads: false` defaults, so the shared-session thread handling below remains a fork divergence.

## 5.1 DROPPED — upstream independently rebuilt these (do NOT port)

| Fork piece | Upstream replacement |
|---|---|
| #37 batch-thread dispatch priority (core) | `extractRouting` reads the first non-echo row of the current batch; `publishReplyRoute` before query; `adoptTurn` re-publishes at every turn boundary; `QueuedTurn` carries routing for mid-turn pushes (`poll-loop.ts:253,434,531-541`) |
| #37 mixed-batch task-row preference | Tasks are isolated per-series sessions — no mixed batches exist |
| #39 MCP send batch-thread | `resolveRouting` uses `getCurrentReplyRoute()` (`mcp-tools/core.ts:47-63`); `to` is now REQUIRED on send_message/send_file (no-`to` path gone — our #39 motivation is moot) |
| #40 current-batch.ts sidecar + in_reply_to revival | `session_state` reply route: `setCurrentReplyRoute`/`getCurrentReplyRoute` (`container/agent-runner/src/db/session-state.ts:88-135`) — the sanctioned cross-process channel; doc comment names the stdio-subprocess rationale. in_reply_to stamped natively (`poll-loop.ts:1215`, `core.ts:94`). **Delete current-batch.ts, port nothing.** |
| #40 bare-text `<internal>` strip | Option B (see index.md) — upstream nudge owns unwrapped output |
| `RoutingContext.kind` | Upstream `taskRun: boolean` (`formatter.ts:156-162`) — same semantics, no delta to port |
| Racy `ORDER BY seq DESC LIMIT 1` | Survives (`mailbox/sqlite/index.ts:168-177`) but demoted to cross-channel fallback behind a batch-match guard — unreachable for same-channel replies. No patch. |

## 5.2 Router: telegram thread exception — PORT, now TWO gates

Upstream nulls telegram threads in two places; both must keep the thread for the shared-session telegram model:

1. **Pre-strip** `src/router.ts:227-231`: `if (adapter && !adapter.supportsThreads) event = { ...event, threadId: null }` → add the fork's exception (`event.channelType !== 'telegram'` keeps its thread here).
2. **Wiring thread policy** (fork predates this): `resolveThreadPolicy` (`src/channels/channel-defaults.ts:131-139`) forces `threadsEnabled=false` from `supportsThreads:false`; `src/router.ts:385-391` then computes `effectiveThreadId = threadsEnabled ? event.threadId : null` and `deliveryAddr` (~:582) feeds it to `writeSessionMessage` — nulling the thread AGAIN. Port: for telegram shared sessions, keep `effectiveThreadId = event.threadId` while `effectiveSessionMode` stays `shared`. Missing gate 2 is the likeliest silent break (messages_in rows would be threadless and the whole family starves).

## 5.3 session-manager: preserve thread_id across container wake — PORT

`src/session-manager.ts:228-251` — `writeSessionRouting` now runs inside `withMailboxSession(...) { mailbox.setRouting({ channelType, platformId, threadId: session.thread_id }) }`. Port the fork's preservation INSIDE the callback: when `session.thread_id === null`, read the existing routing row through the SAME `mailbox` object (seam rule: never nest same-key sessions — do not open another session handle) and carry the prior thread forward. Value today: `ask_user_question`/`send_card` bound-thread last resort + agent self-awareness (replies no longer read session_routing).

## 5.4 session-routing fresh read — PORT (low priority, correctness)

Upstream regressed to the stale singleton: `sqliteGetSessionRouting()` (`container/agent-runner/src/mailbox/sqlite/operations.ts:206-216`) reads via `getInboundDb()`. Patch it to `openInboundDb()` + `close()` in try/finally (pattern: `sqliteGetPendingMessages`) — in `operations.ts`, NOT in the `db/session-routing.ts` shim.

## 5.5 telegram-topics MCP tool — PORT as-is

`container/agent-runner/src/mcp-tools/telegram-topics.ts` (162 lines) lists forum topics in the group chat. Port unchanged; append `import './telegram-topics.js';` to the `mcp-tools/index.ts` barrel. Same `registerTools([...])` model; keep any `TELEGRAM_BOT_TOKEN` conditional registration at module scope. **Never import or touch `../modules/index.js`** (the singular mailbox slot).

## 5.6 #41 — send results name the resolved thread — PORT (small)

Upstream `send_message`/`send_file` ok results carry only `name` + `seq` (`core.ts:98`). Append the resolved thread/destination to the result text as fork `da9f254f` did, so the agent can self-correct misrouted sends instead of "correcting" a send that actually landed right.

## 5.7 Regression test checklist for this section

- Chat message in topic T → reply routes to T (batch route).
- Scheduled task (isolated session) → `send_message({to: destWithThreadId})` → lands in pinned topic (section 3.3).
- Interactive `send_message` without explicit `to` context → resolves via reply route, not General.
- Container wake does not lose the session thread (5.3).
- `send_message` result names the thread (5.6).
