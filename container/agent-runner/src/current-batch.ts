/**
 * Per-batch context the poll loop publishes for downstream consumers
 * (MCP tools, etc.) that don't sit on the poll-loop's call stack.
 *
 * The poll loop calls `setCurrentBatchRouting` before invoking the
 * provider and `clearCurrentBatchRouting` after the batch completes (or
 * errors). Consumers read it for:
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
 * **Cross-process:** the nanoclaw MCP server (send_message, send_file, …)
 * is NOT in this process — index.ts registers it with the provider as a
 * stdio child (`bun run src/mcp-tools/index.ts`). Module-level state can't
 * cross that boundary, so the poll loop also mirrors the routing into a
 * small JSON sidecar file on the container-local filesystem and the MCP
 * process re-reads it on every lookup (same container, same fs — no
 * cross-mount semantics involved). Writes are atomic via rename; clear
 * removes the file. Both are best-effort: module state still covers
 * in-process reads (tests, future in-process consumers).
 *
 * This is module-level state on purpose: the agent-runner is single-process
 * and processes one batch at a time.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RoutingContext } from './formatter.js';

/** Sidecar path — container-local /tmp; one agent-runner per container. */
export const CURRENT_BATCH_FILE = path.join(os.tmpdir(), 'nanoclaw-current-batch.json');

let currentRouting: RoutingContext | null = null;

function writeStateFile(routing: RoutingContext | null): void {
  try {
    if (routing === null) {
      fs.rmSync(CURRENT_BATCH_FILE, { force: true });
    } else {
      const tmp = `${CURRENT_BATCH_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(routing));
      fs.renameSync(tmp, CURRENT_BATCH_FILE);
    }
  } catch {
    // Sidecar is best-effort — module state still covers in-process reads.
  }
}

function readStateFile(): RoutingContext | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(CURRENT_BATCH_FILE, 'utf8')) as RoutingContext;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function setCurrentBatchRouting(routing: RoutingContext): void {
  currentRouting = routing;
  writeStateFile(routing);
}

export function clearCurrentBatchRouting(): void {
  currentRouting = null;
  writeStateFile(null);
}

export function getCurrentBatchRouting(): RoutingContext | null {
  // In this process the module copy is authoritative (set at batch start,
  // cleared at batch end). The file is the cross-process mirror the MCP
  // server child reads — its own module state is always null.
  if (currentRouting) return currentRouting;
  return readStateFile();
}
