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
