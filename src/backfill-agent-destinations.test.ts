import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from './db/index.js';
import { getDb } from './db/connection.js';
import { createDestination, getDestinations } from './modules/agent-to-agent/db/agent-destinations.js';
import { backfillAgentDestinations } from './backfill-agent-destinations.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

function now() {
  return new Date().toISOString();
}

function seedGroup(id: string, folder: string): void {
  createAgentGroup({ id, name: `Group ${id}`, folder, agent_provider: null, created_at: now() });
}

function seedMessagingGroup(id: string): void {
  createMessagingGroup({
    id,
    channel_type: 'telegram',
    platform_id: `telegram:-100${id}`,
    name: `Chat ${id}`,
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
}

describe('backfillAgentDestinations — orphan cleanup', () => {
  it('removes channel destinations whose messaging group was deleted', () => {
    seedGroup('ag-live', 'live');
    seedMessagingGroup('mg-gone');
    createDestination({
      agent_group_id: 'ag-live',
      local_name: 'stale',
      target_type: 'channel',
      target_id: 'mg-gone',
      created_at: now(),
    });

    // deleteMessagingGroup removes its own rows without cascading to
    // agent_destinations — simulate the leftover reference.
    getDb().prepare("DELETE FROM messaging_groups WHERE id = 'mg-gone'").run();

    backfillAgentDestinations();

    expect(getDestinations('ag-live')).toHaveLength(0);
  });

  it('removes agent destinations whose target agent group was deleted', () => {
    seedGroup('ag-live', 'live');
    seedGroup('ag-gone', 'gone');
    createDestination({
      agent_group_id: 'ag-live',
      local_name: 'peer',
      target_type: 'agent',
      target_id: 'ag-gone',
      created_at: now(),
    });

    getDb().prepare("DELETE FROM agent_groups WHERE id = 'ag-gone'").run();

    backfillAgentDestinations();

    expect(getDestinations('ag-live')).toHaveLength(0);
  });

  it('keeps destinations whose targets exist and still backfills wirings', () => {
    seedGroup('ag-live', 'live');
    seedMessagingGroup('mg-live');
    createMessagingGroupAgent({
      id: 'mga-1',
      messaging_group_id: 'mg-live',
      agent_group_id: 'ag-live',
      engage_mode: 'mention',
      engage_pattern: null,
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });

    backfillAgentDestinations();

    const dests = getDestinations('ag-live');
    expect(dests).toHaveLength(1);
    expect(dests[0]!.target_type).toBe('channel');
    expect(dests[0]!.target_id).toBe('mg-live');
  });
});
