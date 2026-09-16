# Section 03 — Destinations: per-topic `thread_id`, orphan sweep, update verb

Fork commits: `30f91ae0` + `65e09307` (thread_id), `2d391ec0` (#38 orphan sweep), `23fcc5ee` (#31 — mostly upstream now).

Why this matters more than before: scheduled tasks are now isolated per-series sessions whose output reaches chat ONLY via explicit one-door `send_message({ to })` — and upstream's dynamic thread resolution lands `thread_id = null` → platform default (General) for task sessions. A destination with a **pinned `thread_id` is the only deterministic task→topic path** in v2.3.

## 3.1 Central DB — `thread_id` on `agent_destinations`

Upstream table: 5 columns, no thread_id (`src/db/migrations/module-agent-to-agent-destinations.ts:27-36`; type `AgentDestination` in `src/types.ts`; INSERT in `src/modules/agent-to-agent/db/agent-destinations.ts:49-52`).

- Add a NEW migration (next number in `src/db/migrations/index.ts` ordering) doing the ALTER. **Guard with `pragma table_info`** so it's a no-op on this install's DB (the fork's live v2.db already has the column from the fork's own migration; the fork's old migration record disappears with the replayed tree — the new migration re-establishes it idempotently for fresh installs).
- `agent_destinations` is created by a `sqliteOnly` module migration → the ALTER must be sqlite-gated or a driver override (`DbMigrationHooks.migrationOverrides`, `src/db/driver.ts:31-38`).
- Extend `AgentDestination` type + `createDestination()` to accept optional `threadId`, **defaulting to NULL** (fork's latent-crash fix).
- **MIGRATION SYSTEM CHECK at replay:** confirm how upstream treats unknown `schema_version` rows (fork's migration names vanish from the tree) and whether boot auto-applies migrations or `pnpm run migrate` is now the explicit path ("Central DB composition and migrations are backend-ready" — `src/index.ts:80` gates backfills on `db.dialect === 'sqlite'`). Adjust runbook (section 07) accordingly.

## 3.2 Canonical mailbox model + session schema (both sides)

Single shared schema file `src/mailbox/sqlite/schema.ts:30-37` (`INBOUND_SCHEMA` destinations table — host writer, container reader of the same shape):

- Add `thread_id TEXT` (nullable) to the destinations CREATE in `INBOUND_SCHEMA`, and to `DestinationRow` (~:59-66) + `replaceDestinations` writer (`src/mailbox/sqlite/session-db.ts:68-78`). Column-add for EXISTING session DBs follows upstream's lazy on-open ALTER pattern (`migrateMessagesInTable`, `src/mailbox/sqlite/session-db.ts:288-312`) — add the same guarded ALTER for the destinations table.
- **Canonical model:** `DestinationRecord` is a strict discriminated union (`src/mailbox/model.ts:122-137`; `parseDestinationRecord` :470 rejects unknown fields). Add `threadId: string | null` to `DestinationRecordBase` + parser, then run **`pnpm run mailbox-model:generate`** (cp's `src/mailbox/model.ts` → `container/agent-runner/src/mailbox/model.generated.ts`) and ensure `pnpm run mailbox-model:check` passes — skipping the regen fails a required check.
- Carry through the resolver: `Destination` (`src/mailbox/types.ts`) → `writeDestinations` (`src/modules/agent-to-agent/write-destinations.ts:17-51`) → container `DestinationEntry` (`container/agent-runner/src/destinations.ts:16-23`).

## 3.3 Container-side preference logic

- `resolveRouting` (`container/agent-runner/src/mcp-tools/core.ts:47-63`): channel destinations prefer `dest.threadId` over the dynamic `resolveDestinationThread(...)?.threadId` — pinned topic wins for explicit sends.
- `resolveDestinationThread` tail (`container/agent-runner/src/db/session-routing.ts:41-57`): when the batch/reply-route branch yields no thread, fall back to the destination's configured `threadId` before (or instead of) `getLatestInboundRoute`. This is the surviving remnant of fork #37's dest-thread fallbacks; it is what routes task-session output to the right topic.

## 3.4 `ncl destinations` — `--thread-id` flag + `update` verb

Upstream verbs: `list`/`add`/`remove` only (`src/cli/resources/destinations.ts`), no update. Port from fork `23fcc5ee`/`30f91ae0`:

- `--thread-id` on `add`.
- Add the fork's `update` verb (validated args per v2.3 conventions) — its handler MUST end with `projectDestinationsToSessions(agentGroupId)` (that upstream helper exists at `src/cli/resources/destinations.ts:20-30` and is already called by add/remove — this replaces our whole #31 projection patch).

## 3.5 Orphan sweep (#38) — PORT as startup sweep

Upstream gap confirmed: `deleteAllDestinationsTouching` exists (`agent-destinations.ts:131-139`) with **zero callers**; channel-target orphans are silently skipped at projection (`write-destinations.ts:23-24`). Port the fork's startup sweep semantics against the async DbDriver:

- Location: idempotent startup step in `main()` after migrations/backfills (`src/index.ts:~74-81`), gated `db.dialect === 'sqlite'` like sibling backfills.
- Logic: delete `agent_destinations` rows whose `target_id` no longer resolves — channel targets must resolve to `messaging_groups` (join on channel_type + platform_id), agent targets to `agent_groups`. Log each sweep.
- Fork commit `2d391ec0` is the reference (host-side, was near-clean even in v2.1).

## 3.6 Task→topic targeting — resolved by 3.3 (no task-side code)

Do NOT port `8fd18dbb` (threadId param on `schedule_task`/`update_task` — those MCP tools are gone). Task sessions get `threadId: null` rows by design (`src/mailbox/model.ts:601`) and deliver only via `send_message({ to })`. With 3.3's dest-thread fallback, `send_message({to: 'alerts'})` from a task session lands in the pinned topic. Group instructions referencing MCP task tools need editing (section 07 runbook).
