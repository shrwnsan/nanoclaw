/**
 * Tests for the bot-to-bot outbound reply seam.
 *
 * When the doorman admits a peer bot's message, its platform message id is
 * recorded as a per-thread "reply target". The seam wraps the Telegram
 * adapter's postMessage so the agent's next outbound post in that thread is
 * sent as a native Telegram reply (reply_parameters.message_id) — exercising
 * the peer's reply-to-me admission leg — and the target is consumed (one
 * shot). Expired or absent targets mean a plain send, exactly pre-seam.
 */
import { describe, expect, it, vi } from 'vitest';

import type { Adapter } from 'chat';
import { createTelegramAdapter } from '@chat-adapter/telegram';

import type { ChannelSetup, InboundMessage } from './adapter.js';
import { BotReplyTargets, createTelegramBotAdmissionWrap, createTelegramReplySeam } from './telegram-bot-admission.js';

// ---------------------------------------------------------------------------
// BotReplyTargets
// ---------------------------------------------------------------------------

describe('BotReplyTargets', () => {
  it('take returns the recorded message id and consumes it (one shot)', () => {
    const store = new BotReplyTargets();
    store.record('telegram', 'telegram:-100:175', '5678');
    expect(store.take('telegram', 'telegram:-100:175')).toBe('5678');
    expect(store.take('telegram', 'telegram:-100:175')).toBeUndefined();
  });

  it('take on a thread with no target is undefined', () => {
    const store = new BotReplyTargets();
    store.record('telegram', 'telegram:-100:175', '5678');
    expect(store.take('telegram', 'telegram:-100:999')).toBeUndefined();
  });

  it('targets expire after the TTL and read as absent', () => {
    let now = 1_000_000;
    const store = new BotReplyTargets({ ttlMs: 900_000, now: () => now });
    store.record('telegram', 'telegram:-100:175', '5678');
    now += 900_001;
    expect(store.take('telegram', 'telegram:-100:175')).toBeUndefined();
  });

  it('a newer admit on the same thread replaces the target', () => {
    const store = new BotReplyTargets();
    store.record('telegram', 'telegram:-100:175', '5678');
    store.record('telegram', 'telegram:-100:175', '9999');
    expect(store.take('telegram', 'telegram:-100:175')).toBe('9999');
  });

  it("instances do not see each other's targets", () => {
    const store = new BotReplyTargets();
    store.record('telegram', 'telegram:-100:175', '5678');
    expect(store.take('telegram-herm', 'telegram:-100:175')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createTelegramReplySeam
// ---------------------------------------------------------------------------

interface SeamFixture {
  wrapped: Adapter;
  /** The underlying post mock — the seam replaces the property, so hold the spy itself. */
  innerPost: ReturnType<typeof vi.fn>;
  store: BotReplyTargets;
}

function makeSeam(now?: () => number): SeamFixture {
  const innerPost = vi.fn(async () => ({ id: 'sent-1' }));
  const store = new BotReplyTargets({ now });
  const wrapped = createTelegramReplySeam({ postMessage: innerPost } as unknown as Adapter, store, 'telegram');
  return { wrapped, innerPost, store };
}

describe('createTelegramReplySeam', () => {
  it('posts with replyToMessageId when a target is pending, and only once', async () => {
    const { wrapped, innerPost, store } = makeSeam();
    store.record('telegram', 'telegram:-100:175', '5678');

    await wrapped.postMessage('telegram:-100:175', { raw: 'first' });
    expect(innerPost).toHaveBeenCalledWith('telegram:-100:175', { raw: 'first' }, { replyToMessageId: '5678' });

    // One shot: the next post in the thread is a plain send.
    await wrapped.postMessage('telegram:-100:175', { raw: 'second' });
    expect(innerPost).toHaveBeenLastCalledWith('telegram:-100:175', { raw: 'second' });
  });

  it('posts plain when no target is pending', async () => {
    const { wrapped, innerPost } = makeSeam();
    await wrapped.postMessage('telegram:-100:175', { raw: 'hello' });
    expect(innerPost).toHaveBeenCalledWith('telegram:-100:175', { raw: 'hello' });
  });

  it('posts plain once the pending target has expired', async () => {
    let now = 1_000_000;
    const { wrapped, innerPost, store } = makeSeam(() => now);
    store.record('telegram', 'telegram:-100:175', '5678');
    now += 900_001;
    await wrapped.postMessage('telegram:-100:175', { raw: 'late' });
    expect(innerPost).toHaveBeenCalledWith('telegram:-100:175', { raw: 'late' });
  });

  it('does not consume the target for file posts — reply semantics apply to text sends only', async () => {
    const { wrapped, innerPost, store } = makeSeam();
    store.record('telegram', 'telegram:-100:175', '5678');
    const doc = { raw: 'doc caption', files: [{ data: Buffer.from('x'), filename: 'a.txt' }] };

    await wrapped.postMessage('telegram:-100:175', doc);
    expect(innerPost).toHaveBeenCalledWith('telegram:-100:175', doc);

    // Target still pending: the next text post carries it.
    await wrapped.postMessage('telegram:-100:175', { raw: 'text reply' });
    expect(innerPost).toHaveBeenLastCalledWith(
      'telegram:-100:175',
      { raw: 'text reply' },
      { replyToMessageId: '5678' },
    );
  });

  it('restores the target when the send throws — the reply is still owed', async () => {
    const innerPost = vi.fn(async () => ({ id: 'sent-1' }));
    innerPost.mockRejectedValueOnce(new Error('network down'));
    const store = new BotReplyTargets();
    const wrapped = createTelegramReplySeam({ postMessage: innerPost } as unknown as Adapter, store, 'telegram');
    store.record('telegram', 'telegram:-100:175', '5678');

    await expect(wrapped.postMessage('telegram:-100:175', { raw: 'flaky' })).rejects.toThrow('network down');
    // Retry consumes the restored target again.
    await wrapped.postMessage('telegram:-100:175', { raw: 'retry' });
    expect(innerPost).toHaveBeenLastCalledWith('telegram:-100:175', { raw: 'retry' }, { replyToMessageId: '5678' });
  });

  it('round-trips a real adapter: composite platform id → native reply with the bare message_id', async () => {
    // Regression: the bridge's message.id is the adapter's composite
    // "chatId:messageId" encoding, and the adapter's postMessage is a
    // prototype method (unbound capture used to throw on every send).
    const adapter = createTelegramAdapter({ botToken: '1:test', mode: 'polling' });
    const calls: { method: string; payload: Record<string, unknown> }[] = [];
    (adapter as unknown as { telegramFetch: unknown }).telegramFetch = async (
      method: string,
      payload: Record<string, unknown>,
    ) => {
      calls.push({ method, payload });
      return { chat: { id: -1003858139698 }, message_id: 42, message_thread_id: 175 };
    };
    const store = new BotReplyTargets();
    const wrapped = createTelegramReplySeam(adapter, store, 'telegram');
    store.record('telegram', 'telegram:-1003858139698:175', '-1003858139698:5678');

    await wrapped.postMessage('telegram:-1003858139698:175', 'reply text');
    expect(calls[0]?.method).toBe('sendMessage');
    expect(calls[0]?.payload.reply_parameters).toEqual({ message_id: 5678, allow_sending_without_reply: true });

    // Plain send reaches the network boundary with no reply parameters.
    await wrapped.postMessage('telegram:-1003858139698:175', 'plain text');
    expect(calls[1]?.payload.reply_parameters).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Doorman integration — admits record the reply target
// ---------------------------------------------------------------------------

const ALLOW = [{ chatId: '-1003858139698', topic: 175 }];
const BOT_USER_ID = '1111111';
const BOT_USERNAME = 'EANano_bot';

function makeSetup(): { setup: ChannelSetup; sent: InboundMessage[] } {
  const sent: InboundMessage[] = [];
  const setup: ChannelSetup = {
    onInbound: (_platformId, _threadId, message) => {
      sent.push(message);
    },
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  };
  return { setup, sent };
}

function makeBotInbound(id: string, text: string): InboundMessage {
  return {
    id,
    kind: 'chat-sdk',
    content: {
      text,
      author: { userId: '2222222', userName: 'herm_bot', fullName: 'Herm', isBot: true, isMe: false },
    },
    timestamp: new Date(0).toISOString(),
    isGroup: true,
  };
}

describe('doorman reply-target recording', () => {
  it('caps consecutive reply-leg admissions per peer; a mention admit resets the streak', async () => {
    const store = new BotReplyTargets();
    const wrap = createTelegramBotAdmissionWrap({
      allow: ALLOW,
      botUserIdFor: () => BOT_USER_ID,
      botUsernameFor: async () => BOT_USERNAME,
      minGapMs: 0,
      maxConsecutiveReplyAdmits: 2,
      replyTargets: store,
    });
    const { setup, sent } = makeSetup();
    const policy = await wrap(setup, 'telegram');

    const replyLeg = (id: string) => makeBotReplyInbound(id);
    await policy.onInbound('telegram:-1003858139698', 'telegram:-1003858139698:175', replyLeg('r1'));
    await policy.onInbound('telegram:-1003858139698', 'telegram:-1003858139698:175', replyLeg('r2'));
    expect(sent).toHaveLength(2);
    await policy.onInbound('telegram:-1003858139698', 'telegram:-1003858139698:175', replyLeg('r3'));
    expect(sent).toHaveLength(2); // third reply-leg turn dropped (reply_depth)

    // A start-anchored mention admits unconditionally and resets the streak.
    await policy.onInbound(
      'telegram:-1003858139698',
      'telegram:-1003858139698:175',
      makeBotInbound('m1', '/ping@EANano_bot again'),
    );
    expect(sent).toHaveLength(3);
    await policy.onInbound('telegram:-1003858139698', 'telegram:-1003858139698:175', replyLeg('r4'));
    expect(sent).toHaveLength(4);
  });
});

function makeBotReplyInbound(id: string): InboundMessage {
  return {
    id,
    kind: 'chat-sdk',
    content: {
      text: 'following up',
      author: { userId: '2222222', userName: 'herm_bot', fullName: 'Herm', isBot: true, isMe: false },
      replyTo: { text: 'earlier', sender: 'Nano', senderUserId: BOT_USER_ID },
    },
    timestamp: new Date(0).toISOString(),
    isGroup: true,
  };
}

describe('doorman reply-target recording', () => {
  it('an admitted bot message records its platform id as the thread reply target', async () => {
    const store = new BotReplyTargets();
    const wrap = createTelegramBotAdmissionWrap({
      allow: ALLOW,
      botUserIdFor: () => BOT_USER_ID,
      botUsernameFor: async () => BOT_USERNAME,
      replyTargets: store,
    });
    const { setup } = makeSetup();
    const policy = await wrap(setup, 'telegram');

    await policy.onInbound(
      'telegram:-1003858139698',
      'telegram:-1003858139698:175',
      makeBotInbound('777', '/ping@EANano_bot hello'),
    );

    expect(store.take('telegram', 'telegram:-1003858139698:175')).toBe('777');
  });

  it('a dropped (not_addressed) bot message records nothing', async () => {
    const store = new BotReplyTargets();
    const wrap = createTelegramBotAdmissionWrap({
      allow: ALLOW,
      botUserIdFor: () => BOT_USER_ID,
      botUsernameFor: async () => BOT_USERNAME,
      replyTargets: store,
    });
    const { setup } = makeSetup();
    const policy = await wrap(setup, 'telegram');

    await policy.onInbound(
      'telegram:-1003858139698',
      'telegram:-1003858139698:175',
      makeBotInbound('778', 'unaddressed chatter'),
    );

    expect(store.take('telegram', 'telegram:-1003858139698:175')).toBeUndefined();
  });
});
