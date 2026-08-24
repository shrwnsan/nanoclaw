/**
 * Tests for the core MCP tools' interaction with the per-batch routing
 * context. The agent-runner publishes the batch's RoutingContext at the
 * top of each batch in poll-loop, and outbound writes from MCP tools
 * (send_message, send_file) must pick it up:
 *
 * - in_reply_to, so a2a return-path routing on the host can correlate
 *   replies back to the originating session.
 * - thread_id for no-`to` sends, so they land in the thread the batch
 *   came from (interactive topic or task target) instead of the shared
 *   session's null default (Telegram "General").
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { setCurrentBatchRouting, clearCurrentBatchRouting } from '../current-batch.js';
import type { RoutingContext } from '../formatter.js';
import { sendMessage } from './core.js';

function batch(routing: Partial<RoutingContext>): RoutingContext {
  return { platformId: null, channelType: null, threadId: null, inReplyTo: null, kind: null, ...routing };
}

/** Seed session_routing + a sole `alerts` channel destination with a topic thread. */
function seedSharedSessionWithAlertsDest(): void {
  getInboundDb().exec(`
    CREATE TABLE IF NOT EXISTS session_routing (
      id INTEGER PRIMARY KEY,
      channel_type TEXT,
      platform_id TEXT,
      thread_id TEXT
    );
    INSERT INTO session_routing (id, channel_type, platform_id, thread_id)
    VALUES (1, 'telegram', 'telegram:-100', NULL);
  `);
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id, thread_id)
       VALUES ('alerts', 'Alerts', 'channel', 'telegram', 'telegram:-100', NULL, 'telegram:-100:51')`,
    )
    .run();
}

beforeEach(() => {
  initTestSessionDb();
  // Seed a peer agent destination
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('peer', 'Peer', 'agent', NULL, NULL, 'ag-peer')`,
    )
    .run();
});

afterEach(() => {
  clearCurrentBatchRouting();
  closeSessionDb();
});

describe('send_message MCP tool — in_reply_to plumbing', () => {
  it('stamps current batch in_reply_to on outbound rows', async () => {
    setCurrentBatchRouting(batch({ inReplyTo: 'inbound-msg-1' }));

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('inbound-msg-1');
  });

  it('writes null when no batch is active', async () => {
    // No setCurrentBatchRouting before this call — simulates ad-hoc / out-of-batch invocation.
    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });
});

describe('send_message MCP tool — no-`to` thread resolution (shared sessions)', () => {
  it("lands in the batch's topic, not the platform default", async () => {
    seedSharedSessionWithAlertsDest();
    setCurrentBatchRouting(
      batch({ channelType: 'telegram', platformId: 'telegram:-100', threadId: 'telegram:-100:179', kind: 'chat' }),
    );

    await sendMessage.handler({ text: 'mid-turn update' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].thread_id).toBe('telegram:-100:179');
  });

  it("uses a task batch's target topic", async () => {
    seedSharedSessionWithAlertsDest();
    setCurrentBatchRouting(
      batch({ channelType: 'telegram', platformId: 'telegram:-100', threadId: 'telegram:-100:51', kind: 'task' }),
    );

    await sendMessage.handler({ text: 'briefing progress' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].thread_id).toBe('telegram:-100:51');
  });

  it('falls back to the sole same-channel destination thread for legacy threadless task batches', async () => {
    seedSharedSessionWithAlertsDest();
    setCurrentBatchRouting(batch({ channelType: 'telegram', platformId: 'telegram:-100', threadId: null, kind: 'task' }));

    await sendMessage.handler({ text: 'briefing progress' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].thread_id).toBe('telegram:-100:51');
  });

  it('keeps session_routing thread when no batch is active (regression guard)', async () => {
    seedSharedSessionWithAlertsDest();

    await sendMessage.handler({ text: 'out-of-batch send' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].thread_id).toBeNull();
  });

  it('ignores a batch from a different channel', async () => {
    seedSharedSessionWithAlertsDest();
    setCurrentBatchRouting(
      batch({ channelType: 'slack', platformId: 'slack:T1', threadId: 'slack:T1:99', kind: 'chat' }),
    );

    await sendMessage.handler({ text: 'mid-turn update' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].thread_id).toBeNull();
  });

  it("still prefers the destination's configured thread when `to` is explicit", async () => {
    seedSharedSessionWithAlertsDest();
    setCurrentBatchRouting(
      batch({ channelType: 'telegram', platformId: 'telegram:-100', threadId: 'telegram:-100:179', kind: 'chat' }),
    );

    await sendMessage.handler({ to: 'alerts', text: 'targeted briefing' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].thread_id).toBe('telegram:-100:51');
  });

  it('explicit `to` a threadless same-channel dest uses the batch thread, not General', async () => {
    seedSharedSessionWithAlertsDest();
    // Main channel dest with no configured thread (My Claw Squad-style)
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('fam', 'Family', 'channel', 'telegram', 'telegram:-100', NULL)`,
      )
      .run();
    setCurrentBatchRouting(
      batch({ channelType: 'telegram', platformId: 'telegram:-100', threadId: 'telegram:-100:179', kind: 'chat' }),
    );

    await sendMessage.handler({ to: 'fam', text: 'mid-turn update' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].thread_id).toBe('telegram:-100:179');
  });
});
