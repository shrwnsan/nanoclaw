import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, initTestSessionDb } from './db/connection.js';
import { buildSystemPromptAddendum, findByName } from './destinations.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function seedDestination(
  name: string,
  displayName: string,
  channelType: string,
  platformId: string,
  threadId?: string | null,
): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id, thread_id)
       VALUES (?, ?, 'channel', ?, ?, NULL, ?)`,
    )
    .run(name, displayName, channelType, platformId, threadId ?? null);
}

describe('buildSystemPromptAddendum — multi-destination routing guidance', () => {
  it('includes default-routing nudge when there are >1 destinations', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');
    seedDestination('whatsapp-mg-17780', 'whatsapp-mg-17780', 'whatsapp', 'phone-2@s.whatsapp.net');

    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('Default routing');
    expect(prompt).toContain('from="name"');
    expect(prompt).toContain('`casa`');
    expect(prompt).toContain('`whatsapp-mg-17780`');
  });

  it('requires explicit wrapping even for a single destination', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');

    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('All output must be wrapped');
    expect(prompt).toContain('<message to="name">');
    expect(prompt).toContain('`casa`');
  });

  it('handles the no-destination case without crashing', () => {
    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('no configured destinations');
    expect(prompt).not.toContain('Default routing');
  });

  it('includes default-routing and wrapping instructions for single destination', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');

    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('All output must be wrapped');
    expect(prompt).toContain('<message to="name">');
    expect(prompt).toContain('Default routing');
    expect(prompt).toContain('`casa`');
  });
});

describe('thread-aware destinations', () => {
  it('findByName returns threadId when set', () => {
    seedDestination('alerts', 'Alerts', 'telegram', 'telegram:-1001234567890', 'telegram:-1001234567890:42');

    const dest = findByName('alerts');
    expect(dest).toBeDefined();
    expect(dest!.threadId).toBe('telegram:-1001234567890:42');
  });

  it('findByName returns undefined threadId when not set', () => {
    seedDestination('general', 'General', 'telegram', 'telegram:-1001234567890');

    const dest = findByName('general');
    expect(dest).toBeDefined();
    expect(dest!.threadId).toBeUndefined();
  });

  it('findByName returns undefined threadId when explicitly null', () => {
    seedDestination('general', 'General', 'telegram', 'telegram:-1001234567890', null);

    const dest = findByName('general');
    expect(dest).toBeDefined();
    expect(dest!.threadId).toBeUndefined();
  });
});
