# Telegram Forum Topic Routing

> Updated for the v2.3.0 upgrade (2026-09-15). The pre-seam design (batch-thread
> priority, current-batch sidecar, `RoutingContext.kind`) is history — upstream
> independently rebuilt most of that machinery on the agent-mailbox seam. This
> doc describes what actually ships here now. Full upgrade analysis lives in
> the operator's private recon guide.

## Overview

Telegram forum topics are real threads (`message_thread_id`). Upstream's router
collapses `thread_id` to `null` for adapters with `supportsThreads: false`
(Telegram declares false), which sends every reply to General. Upstream issue:
[nanocoai/nanoclaw#1699](https://github.com/nanocoai/nanoclaw/issues/1699).

Our install keeps **shared sessions** (one container per group, shared context
across all topics) and delivers by topic. The fork divergence is deliberately
narrow: upstream's session/thread machinery is used as-is wherever possible.

Upstream context: `supportsThreads: true` is a trap for us — at fanout it
forces `effectiveSessionMode = 'per-thread'` (`src/router.ts`), i.e. per-topic
session isolation, a different product. Do not flip it.

## What upstream v2.3 does natively (we port nothing)

- **Batch-first reply routing** — `extractRouting` reads the current batch's
  own thread; `publishReplyRoute`/`adoptTurn` keep a per-turn reply stamp;
  `resolveDestinationThread` prefers the reply context, falls back to the
  channel's latest inbound thread (the old racy lookup survives only as a
  guarded cross-channel fallback).
- **Cross-process reply stamp** — `session_state.current_reply_route`
  (outbound.db) replaces our `/tmp/nanoclaw-current-batch.json` sidecar; the
  MCP child reads it via `getCurrentReplyRoute()`. `in_reply_to` is stamped
  natively.
- **Isolated task sessions** — scheduled tasks run in per-series
  `system:tasks:<seriesId>` sessions; their output reaches chat only via the
  one-door `send_message({ to })`, so the old stale-seq race cannot occur.

## The fork divergence (what this install adds)

1. **Router keeps Telegram's topic id through BOTH thread gates**
   (`src/router.ts`):
   - the adapter pre-strip (`!adapter.supportsThreads` → null the thread) is
     skipped for `channelType === 'telegram'`;
   - the wiring thread policy (`resolveThreadPolicy` → `threadsEnabled=false`
     → `effectiveThreadId = null`) keeps the event thread for telegram too.
   The second gate is the easy one to miss — without it, `messages_in` rows
   are threadless and everything below starves. Session identity is
   unaffected: `resolveSession` ignores the thread in `shared` mode, so this
   only threads the `messages_in` rows.

2. **`writeSessionRouting` preserves the bound thread** — shared sessions have
   `session.thread_id = null`; on wake we carry forward the previously written
   routing thread (read through the same mailbox handle — `getRouting()`, a
   fork addition to the seam) instead of nulling it. Backs the
   `ask_user_question`/`send_card` bound-thread last resort and the agent's
   self-knowledge. Replies do NOT read this row (upstream reply routing is
   batch-driven).

3. **Per-topic destinations (pinned `thread_id`)** — `agent_destinations`
   (central, migration `026`) and the session `destinations` projection carry
   an optional `thread_id` (`ncl destinations add/update --thread-id`). A
   pinned thread wins for explicit sends: `resolveRouting` prefers
   `dest.threadId`, and `resolveDestinationThread` inserts it between the
   reply branch and latest-inbound. **This is the deterministic task→topic
   path** — a task session has no reply context, so `send_message({ to:
   "alerts" })` from one lands in the pinned topic.

4. **`sqliteGetSessionRouting` reopens the inbound DB per read** — the
   long-lived singleton can hold a stale view of the cross-mounted file
   (`journal_mode=DELETE` relies on reopen for visibility).

5. **Send results name the resolved thread** — `send_message`/`send_file`
   results append `thread <id>` so the agent can verify routing instead of
   filing a false misroute correction.

6. **`telegram-topics` MCP tool** — create/edit forum topics directly
   (self-gates on `TELEGRAM_BOT_TOKEN`). The Chat SDK Telegram adapter
   round-trips topics internally, but the NanoClaw adapter integration
   discards them (`supportsThreads: false`), so the tool calls the Bot API.

## Files

| File | Change |
|------|--------|
| `src/router.ts` | Telegram exempt from both thread gates |
| `src/session-manager.ts` | Preserve routing thread on wake (shared sessions) |
| `src/mailbox/types.ts`, `src/mailbox/sqlite/*` | `getRouting()` seam read; `thread_id` in destinations schema + lazy migrate |
| `src/db/migrations/026-destinations-thread-id.ts` | Pinned thread on `agent_destinations` |
| `src/cli/resources/destinations.ts` | `--thread-id` on add, `update` verb, projection |
| `container/agent-runner/src/db/session-routing.ts` | `pinnedThreadId` tier in `resolveDestinationThread` |
| `container/agent-runner/src/destinations.ts` | `DestinationEntry.threadId` |
| `container/agent-runner/src/mcp-tools/core.ts` | Pinned-thread preference + thread-named results |
| `container/agent-runner/src/mcp-tools/telegram-topics.ts` | Topic management tool |
| `container/agent-runner/src/mailbox/sqlite/operations.ts` | Fresh-open session_routing read |

## Operational notes

- Scheduled briefings target a topic via a destination with a pinned
  `thread_id`; the task prompt says `send_message({ to: "<name>" })`.
- Un-migrated sessions created before the upgrade already have the
  `destinations.thread_id` column via the lazy session-DB migrate; central
  rows came through the fork's earlier migration, which `026` idempotently
  re-establishes.
- Upstream issue [#1699](https://github.com/nanocoai/nanoclaw/issues/1699)
  tracks the topic-routing landscape (Chat SDK round-trip, per-topic
  isolation PR, our shared-session approach).
