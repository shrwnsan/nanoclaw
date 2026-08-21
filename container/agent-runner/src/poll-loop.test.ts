import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { getPendingMessages, markCompleted } from './db/messages-in.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { formatMessages, extractRouting } from './formatter.js';
import { dispatchResultText } from './poll-loop.js';
import { MockProvider } from './providers/mock.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function insertMessage(
  id: string,
  kind: string,
  content: object,
  opts?: { processAfter?: string; trigger?: 0 | 1; onWake?: 0 | 1 },
) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, process_after, trigger, on_wake, content)
     VALUES (?, ?, datetime('now'), 'pending', ?, ?, ?, ?)`,
    )
    .run(id, kind, opts?.processAfter ?? null, opts?.trigger ?? 1, opts?.onWake ?? 0, JSON.stringify(content));
}

describe('formatter', () => {
  it('should format a single chat message', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello world' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('Hello world');
  });

  it('should format multiple chat messages as XML block', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'chat', { sender: 'Jane', text: 'Hi there' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<messages>');
    expect(prompt).toContain('</messages>');
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('sender="Jane"');
  });

  it('should format task messages', () => {
    insertMessage('m1', 'task', { prompt: 'Review open PRs' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<task');
    expect(prompt).toContain('Review open PRs');
  });

  it('should format webhook messages', () => {
    insertMessage('m1', 'webhook', { source: 'github', event: 'push', payload: { ref: 'main' } });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<webhook');
    expect(prompt).toContain('source="github"');
    expect(prompt).toContain('event="push"');
  });

  it('should format system messages', () => {
    insertMessage('m1', 'system', { action: 'register_group', status: 'success', result: { id: 'ag-1' } });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<system_response');
    expect(prompt).toContain('action="register_group"');
  });

  it('should handle mixed kinds', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'system', { action: 'test', status: 'ok', result: null });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('<system_response');
  });

  it('should escape XML in content', () => {
    insertMessage('m1', 'chat', { sender: 'A<B', text: 'x > y && z' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('A&lt;B');
    expect(prompt).toContain('x &gt; y &amp;&amp; z');
  });
});

describe('accumulate gate (trigger column)', () => {
  it('getPendingMessages returns both trigger=0 and trigger=1 rows', () => {
    // trigger=0 rides along as context, trigger=1 is the wake-eligible row.
    // The poll loop's gate depends on this data contract.
    insertMessage('m1', 'chat', { sender: 'A', text: 'chit chat' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'actual mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(messages).toHaveLength(2);
    const byId = Object.fromEntries(messages.map((m) => [m.id, m]));
    expect(byId.m1.trigger).toBe(0);
    expect(byId.m2.trigger).toBe(1);
  });

  it('trigger=0-only batch: gate predicate `some(trigger===1)` is false', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'noise' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'more noise' }, { trigger: 0 });
    const messages = getPendingMessages();
    // This is the exact predicate the poll loop uses to skip accumulate-only
    // batches — gate should be false, so the loop sleeps without waking the agent.
    expect(messages.some((m) => m.trigger === 1)).toBe(false);
  });

  it('mixed batch: gate is true → loop proceeds, accumulated rows ride along', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'earlier chatter' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'the real mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(messages.some((m) => m.trigger === 1)).toBe(true);
    // Both messages are present for the formatter → agent sees the prior context.
    expect(messages.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('trigger column defaults to 1 for legacy inserts without explicit value', () => {
    // The schema default is 1 (see src/db/schema.ts INBOUND_SCHEMA) — existing
    // rows / tests without the column set are effectively wake-eligible.
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', '{"text":"hi"}')`,
      )
      .run();
    const [msg] = getPendingMessages();
    expect(msg.trigger).toBe(1);
  });
});

describe('on_wake filtering', () => {
  it('first poll returns on_wake=1 messages', () => {
    insertMessage('m1', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(true);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('m1');
  });

  it('subsequent polls skip on_wake=1 messages', () => {
    insertMessage('m1', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(false);
    expect(messages).toHaveLength(0);
  });

  it('normal messages returned regardless of isFirstPoll', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'hello' });
    expect(getPendingMessages(true)).toHaveLength(1);

    // Reset: mark completed so we can re-test with a fresh message
    markCompleted(['m1']);
    insertMessage('m2', 'chat', { sender: 'A', text: 'hello again' });
    expect(getPendingMessages(false)).toHaveLength(1);
  });

  it('mixed batch: first poll returns both normal and on_wake messages', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'user msg' });
    insertMessage('m2', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(true);
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('mixed batch: subsequent poll returns only normal messages', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'user msg' });
    insertMessage('m2', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(false);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('m1');
  });

  it('on_wake defaults to 0 for inserts without explicit value', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', '{"text":"hi"}')`,
      )
      .run();
    // Should be returned even on non-first poll (on_wake=0)
    expect(getPendingMessages(false)).toHaveLength(1);
  });
});

describe('routing', () => {
  it('should extract routing from messages', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('m1', 'chat', datetime('now'), 'pending', 'chan-123', 'discord', 'thread-456', '{"text":"hi"}')`,
      )
      .run();

    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    expect(routing.platformId).toBe('chan-123');
    expect(routing.channelType).toBe('discord');
    expect(routing.threadId).toBe('thread-456');
    expect(routing.inReplyTo).toBe('m1');
  });
});

describe('origin metadata (from= attribute)', () => {
  function seedDestination(name: string, channelType: string, platformId: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, 'channel', ?, ?, NULL)`,
      )
      .run(name, name, channelType, platformId);
  }

  function insertWithRouting(id: string, kind: string, content: object, channelType: string | null, platformId: string | null): void {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES (?, ?, datetime('now'), 'pending', ?, ?, ?)`,
      )
      .run(id, kind, platformId, channelType, JSON.stringify(content));
  }

  it('chat message includes from= when destination matches', () => {
    seedDestination('discord-main', 'discord', 'chan-1');
    insertWithRouting('m1', 'chat', { sender: 'Alice', text: 'hi' }, 'discord', 'chan-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('from="discord-main"');
  });

  it('chat message falls back to raw routing when no destination matches', () => {
    insertWithRouting('m1', 'chat', { sender: 'Alice', text: 'hi' }, 'telegram', 'chat-999');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('from="unknown:telegram:chat-999"');
  });

  it('chat message omits from= when routing is null', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hi' });
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).not.toContain('from=');
  });

  it('task message includes from= when destination matches', () => {
    seedDestination('slack-ops', 'slack', 'C-OPS');
    insertWithRouting('t1', 'task', { prompt: 'check status' }, 'slack', 'C-OPS');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<task');
    expect(prompt).toContain('from="slack-ops"');
  });

  it('task message omits from= when routing is null', () => {
    insertMessage('t1', 'task', { prompt: 'check status' });
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<task');
    expect(prompt).not.toContain('from=');
  });

  it('webhook message includes from= when destination matches', () => {
    seedDestination('github-ch', 'github', 'repo-1');
    insertWithRouting('w1', 'webhook', { source: 'github', event: 'push', payload: {} }, 'github', 'repo-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<webhook');
    expect(prompt).toContain('from="github-ch"');
  });

  it('system message includes from= when destination matches', () => {
    seedDestination('discord-main', 'discord', 'chan-1');
    insertWithRouting('s1', 'system', { action: 'test', status: 'ok', result: null }, 'discord', 'chan-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<system_response');
    expect(prompt).toContain('from="discord-main"');
  });
});

describe('mock provider', () => {
  it('should produce init + result events', async () => {
    const provider = new MockProvider({}, (prompt) => `Echo: ${prompt}`);
    const query = provider.query({
      prompt: 'Hello',
      cwd: '/tmp',
    });

    const events: Array<{ type: string }> = [];
    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      events.push(event);
    }

    const typed = events.filter((e) => e.type !== 'activity');
    expect(typed.length).toBeGreaterThanOrEqual(2);
    expect(typed[0].type).toBe('init');
    expect(typed[1].type).toBe('result');
    expect((typed[1] as { text: string }).text).toBe('Echo: Hello');
  });

  it('should handle push() during active query', async () => {
    const provider = new MockProvider({}, (prompt) => `Re: ${prompt}`);
    const query = provider.query({
      prompt: 'First',
      cwd: '/tmp',
    });

    const events: Array<{ type: string; text?: string }> = [];

    setTimeout(() => query.push('Second'), 30);
    setTimeout(() => query.end(), 60);

    for await (const event of query.events) {
      events.push(event);
    }

    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(2);
    expect(results[0].text).toBe('Re: First');
    expect(results[1].text).toBe('Re: Second');
  });
});

describe('end-to-end with mock provider', () => {
  it('should read messages_in, process with mock provider, write messages_out', async () => {
    // Insert a chat message into inbound DB
    insertMessage('m1', 'chat', { sender: 'User', text: 'What is 2+2?' });

    // Read and process
    const messages = getPendingMessages();
    expect(messages).toHaveLength(1);

    const routing = extractRouting(messages);
    const prompt = formatMessages(messages);

    // Create mock provider and run query
    const provider = new MockProvider({}, () => 'The answer is 4');
    const query = provider.query({
      prompt,
      cwd: '/tmp',
    });

    // Process events — simulate what poll-loop does
    const { markProcessing } = await import('./db/messages-in.js');
    const { writeMessageOut } = await import('./db/messages-out.js');

    markProcessing(['m1']);

    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      if (event.type === 'result' && event.text) {
        writeMessageOut({
          id: `out-${Date.now()}`,
          in_reply_to: routing.inReplyTo,
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: event.text }),
        });
      }
    }

    markCompleted(['m1']);

    // Verify: message was processed (not pending, acked in processing_ack)
    const processed = getPendingMessages();
    expect(processed).toHaveLength(0);

    // Verify: response was written to outbound DB
    const outMessages = getUndeliveredMessages();
    expect(outMessages).toHaveLength(1);
    expect(JSON.parse(outMessages[0].content).text).toBe('The answer is 4');
    expect(outMessages[0].in_reply_to).toBe('m1');
  });
});

describe('destination thread routing (scheduled tasks vs chat)', () => {
  const PLATFORM = 'telegram:-100999000111';
  const ALERTS_THREAD = `${PLATFORM}:51`;
  const CHAT_THREAD = `${PLATFORM}:179`;

  function seedAlertsDestination(): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id, thread_id)
         VALUES ('alerts', 'alerts', 'channel', 'telegram', ?, NULL, ?)`,
      )
      .run(PLATFORM, ALERTS_THREAD);
  }

  function insertRoutedMessage(
    id: string,
    kind: string,
    seq: number,
    threadId: string | null,
    status: 'pending' | 'completed',
  ): void {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content)
         VALUES (?, ?, ?, datetime('now'), ?, ?, 'telegram', ?, ?)`,
      )
      .run(id, seq, kind, status, PLATFORM, threadId, JSON.stringify({ text: 'x' }));
  }

  it('routes task output to the task row thread even when newer chat outranks it by seq', () => {
    seedAlertsDestination();
    // Task row: written a day earlier (lower seq), carries its target topic.
    insertRoutedMessage('task-1', 'task', 10, ALERTS_THREAD, 'pending');
    // Chat in another topic arrived after the task row was written.
    insertRoutedMessage('chat-1', 'chat-sdk', 12, CHAT_THREAD, 'completed');

    const routing = extractRouting(getPendingMessages());
    dispatchResultText('<message to="alerts">Weather briefing</message>', routing);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].thread_id).toBe(ALERTS_THREAD);
    expect(out[0].in_reply_to).toBe('task-1');
  });

  it('task row wins routing when a newer chat message lands in the same pending batch', () => {
    seedAlertsDestination();
    // Wake collision: due task + fresh chat both pending, chat has higher seq.
    insertRoutedMessage('task-1', 'task', 10, ALERTS_THREAD, 'pending');
    insertRoutedMessage('chat-1', 'chat-sdk', 12, CHAT_THREAD, 'pending');

    const routing = extractRouting(getPendingMessages());
    expect(routing.kind).toBe('task');
    expect(routing.threadId).toBe(ALERTS_THREAD);
    dispatchResultText('<message to="alerts">Digest</message>', routing);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].thread_id).toBe(ALERTS_THREAD);
  });

  it('routes interactive replies to the conversation topic, not the destination default', () => {
    seedAlertsDestination();
    insertRoutedMessage('chat-1', 'chat-sdk', 10, CHAT_THREAD, 'pending');

    const routing = extractRouting(getPendingMessages());
    dispatchResultText('<message to="alerts">Reply here</message>', routing);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].thread_id).toBe(CHAT_THREAD);
  });

  it('keeps null thread (platform default topic) for replies from the default topic', () => {
    seedAlertsDestination();
    insertRoutedMessage('chat-1', 'chat-sdk', 10, null, 'pending');

    const routing = extractRouting(getPendingMessages());
    dispatchResultText('<message to="alerts">General reply</message>', routing);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].thread_id).toBeNull();
  });

  it('falls back to the destination thread for legacy tasks scheduled without a thread', () => {
    seedAlertsDestination();
    insertRoutedMessage('task-1', 'task', 10, null, 'pending');

    const routing = extractRouting(getPendingMessages());
    dispatchResultText('<message to="alerts">Briefing</message>', routing);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].thread_id).toBe(ALERTS_THREAD);
  });

  it('cross-destination send to a channel with no inbound history uses the destination thread', () => {
    seedAlertsDestination();
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id, thread_id)
         VALUES ('squad', 'squad', 'channel', 'telegram', 'telegram:-100999', NULL, 'telegram:-100999:7')`,
      )
      .run();
    // Batch comes from the alerts channel, not the squad channel.
    insertRoutedMessage('task-1', 'task', 10, ALERTS_THREAD, 'pending');

    const routing = extractRouting(getPendingMessages());
    dispatchResultText('<message to="squad">Cross-post</message>', routing);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('telegram:-100999');
    expect(out[0].thread_id).toBe('telegram:-100999:7');
  });

  it('cross-destination send to a channel with inbound history uses the latest inbound thread', () => {
    seedAlertsDestination();
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id, thread_id)
         VALUES ('squad', 'squad', 'channel', 'telegram', 'telegram:-100999', NULL, 'telegram:-100999:7')`,
      )
      .run();
    insertRoutedMessage('task-1', 'task', 10, ALERTS_THREAD, 'pending');
    // The squad channel has its own recent inbound traffic in topic :9.
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content)
         VALUES ('squad-chat', 14, 'chat-sdk', datetime('now'), 'completed', 'telegram:-100999', 'telegram', 'telegram:-100999:9', ?)`,
      )
      .run(JSON.stringify({ text: 'x' }));

    const routing = extractRouting(getPendingMessages());
    dispatchResultText('<message to="squad">Cross-post</message>', routing);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].thread_id).toBe('telegram:-100999:9');
  });

  it('same-channel topic-bound destination is routed by the conversation, not its configured thread', () => {
    // Documents the deliberate limitation: <message> blocks route by the
    // conversation's topic (batch thread); a topic-bound destination on the
    // same channel cannot be targeted via <message> — use send_message,
    // which prefers dest.threadId.
    seedAlertsDestination();
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id, thread_id)
         VALUES ('alerts-topic', 'alerts-topic', 'channel', 'telegram', ?, NULL, ?)`,
      )
      .run(PLATFORM, `${PLATFORM}:23`);
    insertRoutedMessage('chat-1', 'chat-sdk', 10, CHAT_THREAD, 'pending');

    const routing = extractRouting(getPendingMessages());
    dispatchResultText(
      `<message to="alerts">Reply</message><message to="alerts-topic">Cross-topic</message>`,
      routing,
    );

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(2);
    expect(out[0].thread_id).toBe(CHAT_THREAD);
    expect(out[1].thread_id).toBe(CHAT_THREAD);
  });

  it('bare-text fallback sends to the single destination with the batch thread', () => {
    seedAlertsDestination();
    insertRoutedMessage('chat-1', 'chat-sdk', 10, CHAT_THREAD, 'pending');

    const routing = extractRouting(getPendingMessages());
    dispatchResultText('No wrapping, just text', routing);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].thread_id).toBe(CHAT_THREAD);
    expect(JSON.parse(out[0].content).text).toBe('No wrapping, just text');
  });
});
