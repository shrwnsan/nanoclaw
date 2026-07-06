# Telegram Forum Topic Routing

## Overview

NanoClaw's router collapses `thread_id` to `null` for all adapters with `supportsThreads: false` (Telegram, WhatsApp, iMessage, email). This was correct for platforms without threading, but Telegram **does** support threads via forum topics. The result: replies always land in General/root regardless of which topic the message came from.

Upstream issue: [nanocoai/nanoclaw#1699](https://github.com/nanocoai/nanoclaw/issues/1699)

## Shared-Session Approach

Our approach preserves **shared sessions** (one container per group, shared context across all topics) while routing replies to the correct topic. This is a middle ground between:

- **Current upstream**: collapse `thread_id` → all replies go to General
- **Full per-topic isolation** (`supportsThreads: true`): each topic gets its own container, isolated conversation history — overkill for a family group chat

### How It Works

1. **Router preserves `thread_id` for Telegram** — the thread-collapse check now skips Telegram (`event.channelType !== 'telegram'`)
2. **Replies route via `resolveDestinationThread`** — the container's `sendToDestination` queries the latest `messages_in` row for the matching channel+platform, not the `session_routing` table. This means replies naturally go to the topic the message came from
3. **`session_routing` stays as a stable default** — only written on container wake (by `writeSessionRouting`), not updated per-message. Scheduled tasks use this stable default instead of inheriting the last message's topic
4. **`writeSessionRouting` preserves existing `thread_id`** — for shared sessions (`session.thread_id = null`), reads back and keeps whatever `thread_id` is already in the DB rather than overwriting with null on every container wake
5. **Fresh DB connections for routing reads** — `session_routing` is written by the host after spawn. The container uses `openInboundDb()` (fresh read-only connection per call) instead of `getInboundDb()` (stale singleton) to see per-message updates

### Files Changed

| File | Change |
|------|--------|
| `src/router.ts` | Skip thread collapse for Telegram |
| `src/session-manager.ts` | Preserve `thread_id` on container wake for shared sessions |
| `container/agent-runner/src/formatter.ts` | `extractRouting` uses last message, not first |
| `container/agent-runner/src/db/session-routing.ts` | Fresh `openInboundDb()` per call + proper `db.close()` |
| `container/agent-runner/src/poll-loop.ts` | Fresh `openInboundDb()` in `resolveDestinationThread` |
| `container/agent-runner/src/mcp-tools/telegram-topics.ts` | **New** — `create_topic` + `edit_topic` MCP tools |
| `container/agent-runner/src/mcp-tools/index.ts` | Barrel registration |

## Design Decisions

### No per-message `upsertSessionRouting`

Early versions updated `session_routing` on every inbound message. This was **removed** because:

- `resolveDestinationThread` already handles reply routing by reading `messages_in` directly — the `session_routing` update was redundant for replies
- The per-message update made `session_routing` "last writer wins", polluting the stable default that scheduled tasks depend on (e.g. weather briefing routed to whatever topic was last active instead of its intended destination)
- The agent reads `session_routing` to understand its context — a volatile value confused the agent's self-reported destination

### No per-topic `agent_destinations`

Per-topic entries in `agent_destinations` (e.g. separate entries for "alerts" and "log") cause the agent to fail silently. With multiple destinations, the agent must specify `to=` on every reply — and it often can't pick the right one, producing `<internal>` scratchpad instead of `<message>` blocks. One destination per messaging group is the correct configuration for shared sessions.

## Scheduled Task Topic Routing

### Problem

Scheduled tasks (e.g., weather briefings) write to `messages_in` with `thread_id = null`. When the agent dispatches the response, `resolveDestinationThread` queries the latest `messages_in` for the platform — which returns whichever topic had the most recent **user message**, not the topic the task should target.

The result is **non-deterministic routing**: the task output goes to whatever topic was last active, not a configured destination.

### Root cause

`resolveDestinationThread` queries `messages_in ORDER BY seq DESC LIMIT 1` — it returns the most recent message regardless of age or kind. If a user message arrives on topic 51 before the task fires, the agent's reply routes to topic 51 instead of the intended destination.

### Fix: `thread_id` on task `messages_in`

The fix writes the correct `thread_id` onto the task message itself at schedule time. When `resolveDestinationThread` queries the latest `messages_in`, it finds the task message with the correct topic. No changes to `resolveDestinationThread` or `sendToDestination` — the routing info travels with the message.

**Flow:**
1. Agent calls `schedule_task` with optional `threadId` parameter (e.g. `"telegram:<chatId>:<topicId>"`)
2. Container writes the `threadId` into the system action payload
3. Host's `handleScheduleTask` writes `thread_id` onto the task's `messages_in` row
4. Task wakes the container → agent processes → dispatches reply
5. `resolveDestinationThread` finds the task message (latest in the batch) with correct `thread_id`
6. Recurring tasks inherit `thread_id` via `insertRecurrence` — one fix propagates to all future occurrences

**Admin config:** `ncl destinations update --agent-group-id <id> --local-name <name> --thread-id "telegram:<chatId>:<topicId>"` sets the thread on a destination. The agent can then use this value when calling `schedule_task`.

**Backward compat:** The `threadId` parameter on `schedule_task` is optional. When omitted, the existing behavior applies (reads from `session_routing.thread_id`). Existing tasks keep working until explicitly updated via `update_task --thread-id "..."`.

### Design decisions

**Why not override `sendToDestination`?** If `dest.threadId` always wins in `sendToDestination`, reply routing breaks — user messages from topic 42 would get redirected to the configured default topic. If `dest.threadId` is a fallback (only when `resolveDestinationThread` returns null), it doesn't fix the problem because `resolveDestinationThread` almost always returns a non-null topic from the latest user message.

**Why not `session_routing` fallback?** We intentionally removed per-message `upsertSessionRouting` to prevent "last writer wins" pollution. `session_routing` is stable for user conversations but doesn't carry per-topic routing for tasks.

**`send_message` MCP tool (Path B) already respects `dest.threadId`** — it prefers the destination's thread over the session's thread. This is correct for explicit mid-response sends. The fix here covers the `<message>` tag path (Path A), where the agent's response is parsed after the provider returns.

### Related

- See [guide-036](../../dotfiles-vps/docs/guides/guide-036-telegram-topic-routing-upstream-analysis.md) for the full Chat SDK adapter verification and session model analysis.

## Cross-Mount DB Visibility

The container's `session_routing` table is written by the host (on the other side of a Docker volume mount). A long-lived `getInboundDb()` singleton connection freezes its view at the first read and never sees host-side updates. The fix is `openInboundDb()` — opens a fresh read-only connection per call with `mmap_size=0`, then closes it. This pattern applies to any table the host writes to after the container's initial connection was opened.

Key prerequisite: `journal_mode=DELETE` (not WAL) — WAL's mmapped `-shm` file doesn't refresh across mounts. See `container/agent-runner/src/db/connection.ts`.

## MCP Tools

### `create_topic`

Creates a Telegram forum topic in the current group chat. Calls `createForumTopic` directly via `fetch` to the Telegram Bot API (same pattern as the Telegram adapter's internal `telegramFetch`). Returns the `message_thread_id`.

Only registered when `TELEGRAM_BOT_TOKEN` is available (conditional registration at module scope).

### `edit_topic`

Renames an existing forum topic or changes its icon emoji. Calls `editForumTopic` via the Bot API.

## Upstream Rebase Notes

When rebasing `dev` onto a newer `upstream/main`, the feature commits (on `dev` as individual commits) may encounter one known conflict in `src/router.ts`:

- **Interceptor API**: upstream changed from a single `messageInterceptor` to an array `messageInterceptors` with a `for` loop
- **Adapter lookup**: `getChannelAdapter(event.channelType)` → `getChannelAdapter(event.instance ?? event.channelType)`

Resolution: merge both patterns — keep the interceptor loop + `event.instance` fallback, add the Telegram `&& event.channelType !== 'telegram'` exception.

The convenience branch `feat/telegram-topics` holds a single squashed commit of all changes for easier cherry-pick if the individual commits prove painful during a rebase.

## Upstream Landscape

### Issue #1699 — "Telegram thread/topic replies lose thread context"

Filed by `Davidsod` (2026-04-08) against the v1 codebase. Describes the same symptom (replies land in General instead of the originating topic) and proposes a straightforward plumbing fix: add `thread_id` to messages table, pass it through `sendMessage` call sites. The issue references v1 files (`src/db.ts`, `src/types.ts`) and doesn't address session model or routing architecture. Still open, no comments from upstream maintainer.

### PR #1626 — "Telegram topic isolation with auto-registration"

Filed by `rsdrahat` (open). Implements **per-topic isolation** — each forum topic gets its own virtual messaging group, separate session, separate container. Uses a custom JID scheme (`tg:…:t:42`) to multiplex topics within one supergroup. This is the full isolation approach — equivalent to setting `supportsThreads: true` on the Telegram adapter, but with additional per-topic folder/CLAUDE.md/parent-context seeding.

### Premald's one-liner approach (PR #1626 comment, 2026-06-07)

Community member `premald` demonstrated that the Chat SDK Telegram adapter on the upstream `channels` branch **already round-trips topics natively**:

1. `parseMessage` encodes `thread.id = telegram:<chatId>:<topicId>` from `message_thread_id`
2. `channelIdFromThreadId` strips the topic back to `telegram:<chatId>` for messaging-group lookup
3. `postMessage` re-appends `message_thread_id` on send

Combined with NanoClaw's existing per-thread session logic, flipping `supportsThreads: false → true` on the Telegram adapter gives per-topic isolation with **one line changed** — no custom JID scheme, no virtual groups.

**Tradeoff vs our approach:** the one-liner gives per-topic *sessions* (isolated conversation history + correct routing) but **not** per-topic *folders / CLAUDE.md / separate containers* — which PR #1626 adds. Our shared-session approach gives the opposite: shared context across topics with correct reply routing, but no isolation.

### Approach comparison

| Aspect | Upstream (broken) | Premald one-liner | PR #1626 (rsdrahat) | Our implementation |
|--------|------------------|-------------------|----------------------|-------------------|
| Session model | One group, no topics | Per-topic isolation | Per-topic isolation | **Shared session** |
| Conversation history | Lost (all in General) | Isolated per topic | Isolated per topic | **Shared across topics** |
| Reply routing | Broken | Correct (native) | Correct (custom JID) | Correct (resolveDestinationThread) |
| Custom code needed | — | ~1 line | ~500+ lines | ~200 lines |
| Destination config | 1 per group | 1 per topic | Auto-created | 1 per group |
| Scheduled task routing | Goes to General | Per-topic session | Per-topic session | Uses stable session_routing default |
| MCP tools | — | — | — | create_topic + edit_topic |
| Agent self-awareness | — | Per-topic context | Per-topic context | Knows its topic via session_routing |

### Upstream PR viability

Our implementation is tightly coupled to v2's two-DB session split, cross-mount SQLite semantics, and the shared-session model. A direct upstream PR would need significant reworking:

- **Drop cross-mount `openInboundDb()` changes** — specific to Docker/virtiofs mounts, not relevant to most installs
- **Adapt router change for `event.instance` pattern** — upstream refactored adapter lookup
- **Decide on session model** — upstream may prefer per-topic isolation (aligns with existing architecture) over shared sessions
- **Verify Chat SDK adapter topic support** — if the current `channels` branch adapter already round-trips `message_thread_id`, the router change could be simplified

**Recommended path:** engage on issue #1699 with our findings before writing a PR. The shared-session vs per-topic isolation tradeoff is a design decision that needs upstream maintainer input. Our `resolveDestinationThread` approach (read latest `messages_in` for topic routing) is compatible with either session model and could be a useful building block regardless.
