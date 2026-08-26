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
import * as fs from 'node:fs';

import { initTestSessionDb, closeSessionDb, getInboundDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { setCurrentBatchRouting, clearCurrentBatchRouting, CURRENT_BATCH_FILE } from '../current-batch.js';
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

    const result = (await sendMessage.handler({ text: 'briefing progress' })) as { content: { text: string }[] };
    expect(result.content[0].text).toContain('sent to alerts');

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].thread_id).toBe('telegram:-100:51');
  });

  it("reports the topic for threads that match no destination's configured thread", async () => {
    seedSharedSessionWithAlertsDest();
    setCurrentBatchRouting(
      batch({ channelType: 'telegram', platformId: 'telegram:-100', threadId: 'telegram:-100:179', kind: 'chat' }),
    );

    const result = (await sendMessage.handler({ text: 'mid-turn update' })) as { content: { text: string }[] };
    expect(result.content[0].text).toContain('topic telegram:-100:179');
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

describe('send_message MCP tool — cross-process sidecar', () => {
  // The nanoclaw MCP server runs as a stdio child process (index.ts) — its
  // module state is always empty, so its lookups go through the sidecar
  // file the poll loop mirrors batch routing into. Simulate the child by
  // writing the file directly with no module state set.
  it('routes no-`to` sends from the sidecar file when module state is empty', async () => {
    seedSharedSessionWithAlertsDest();
    fs.writeFileSync(
      CURRENT_BATCH_FILE,
      JSON.stringify(
        batch({ channelType: 'telegram', platformId: 'telegram:-100', threadId: 'telegram:-100:51', kind: 'task' }),
      ),
    );
    try {
      await sendMessage.handler({ text: 'briefing progress' });
    } finally {
      fs.rmSync(CURRENT_BATCH_FILE, { force: true });
    }

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].thread_id).toBe('telegram:-100:51');
  });

  it('stamps in_reply_to from the sidecar file (a2a return path)', async () => {
    seedSharedSessionWithAlertsDest();
    fs.writeFileSync(
      CURRENT_BATCH_FILE,
      JSON.stringify(batch({ channelType: 'telegram', platformId: 'telegram:-100', inReplyTo: 'inbound-msg-9' })),
    );
    try {
      await sendMessage.handler({ text: 'hello' });
    } finally {
      fs.rmSync(CURRENT_BATCH_FILE, { force: true });
    }

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('inbound-msg-9');
  });

  it('clearCurrentBatchRouting removes the sidecar so post-batch sends see no batch', () => {
    setCurrentBatchRouting(batch({ channelType: 'telegram', platformId: 'telegram:-100', kind: 'task' }));
    expect(fs.existsSync(CURRENT_BATCH_FILE)).toBe(true);
    clearCurrentBatchRouting();
    expect(fs.existsSync(CURRENT_BATCH_FILE)).toBe(false);
  });
});
