/**
 * Per-batch context the poll loop publishes for downstream consumers
 * (MCP tools, etc.) that don't sit on the poll-loop's call stack.
 *
 * The poll loop calls `setCurrentBatchRouting` before invoking the
 * provider and `clearCurrentBatchRouting` after the batch completes (or
 * errors). MCP tools read it for:
 *
 * - `inReplyTo` — the id of the first inbound message in the batch,
 *   stamped onto outbound rows (send_message, send_file) so the host's
 *   a2a return-path routing can correlate replies back to the originating
 *   session.
 * - `threadId` / `kind` — `send_message`/`send_file` without an explicit
 *   `to` reply in the thread the batch came from (the Telegram forum topic
 *   of an interactive message, or a scheduled task's target topic),
 *   mirroring how `sendToDestination` routes `<message>` dispatch. For
 *   shared sessions `session_routing.thread_id` is null, so without this
 *   those sends would land in the platform's default topic ("General").
 *
 * This is module-level state on purpose: the agent-runner is single-process
 * and processes one batch at a time.
 */
import type { RoutingContext } from './formatter.js';

let currentRouting: RoutingContext | null = null;

export function setCurrentBatchRouting(routing: RoutingContext): void {
  currentRouting = routing;
}

export function clearCurrentBatchRouting(): void {
  currentRouting = null;
}

export function getCurrentBatchRouting(): RoutingContext | null {
  return currentRouting;
}
