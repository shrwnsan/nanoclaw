# Section 04 — Task surface: verdicts (mostly drops)

Fork commits: `65af4832` (pre-task timeout), `87269446` (task-script retry), `8fd18dbb` (#29 task threadId).

v2.3 reality (verified in code, not assumed):

| Fork piece | Verdict | Reason |
|---|---|---|
| `65af4832` pre-task script timeout | **DROP** | Upstream has `SCRIPT_TIMEOUT_MS = 30_000` + killed/timeout discrimination (`container/agent-runner/src/scheduling/task-script.ts:7,47-50`), still hooked from poll-loop (`MODULE-HOOK:scheduling-pre-task`). |
| `87269446` task-script retry | **DROP — upstream's design differs deliberately** | In-container retries removed; failures ack as skips and the HOST backs off (`scriptBackoffMinutes` 2,4,8…60, auto-pause after 8 consecutive failures, `src/modules/scheduling/recurrence.ts:33-40,66-88`) + generic stuck-message retry (`src/reconcile-session.ts:51-52`). Host-side backoff supersedes our in-container retry. |
| `8fd18dbb` threadId on `schedule_task`/`update_task` | **DROP** | Scheduling MCP tools no longer exist; `ncl tasks` (verbs list/get/create/append-log/update/cancel/run/pause/resume/delete, `src/cli/resources/tasks.ts:417+`) has no thread param. Task rows are `kind='task'` in isolated `system:tasks:<seriesId>` sessions with channel/platform/thread always NULL (`src/mailbox/sqlite/tasks.ts:20-23`). |

The user-visible goal of #29 (scheduled briefings land in the right topic) is delivered by **section 03** (pinned per-topic destinations + dest-thread fallback in `resolveDestinationThread`) — task output reaches chat only via `send_message({to})`, which resolves the pinned topic deterministically.

Residual follow-ups (runbook, section 07): group/persona instructions that mention `schedule_task`/`update_task` MCP tools must be rewritten for `ncl tasks`; strict task lifecycle semantics (delete cascades session state; updates refuse already-due runs; recurring selection uses the active series snapshot) are behavior changes worth knowing operationally.
