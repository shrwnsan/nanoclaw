/**
 * One-time backfill: ensure every messaging_group_agents wiring has a
 * corresponding agent_destinations row. The v1→v2 migration created
 * wirings via raw INSERT, bypassing createMessagingGroupAgent's auto-
 * creation logic. Without these rows, writeDestinations() writes an
 * empty destinations table and the agent can't send messages.
 *
 * Runs after migrations, before channel adapters start. Idempotent —
 * skips wirings that already have a destination row.
 */
import { getDb, hasTable } from './db/connection.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import type { MessagingGroupAgent } from './types.js';
import {
  createDestination,
  getDestinationByTarget,
  normalizeName,
  getDestinationByName,
} from './modules/agent-to-agent/db/agent-destinations.js';
import { log } from './log.js';

export function backfillAgentDestinations(): void {
  if (!hasTable(getDb(), 'agent_destinations')) return;

  const db = getDb();

  // Clean up orphaned rows from v1 agent group IDs (underscore format)
  // that no longer exist in agent_groups.
  let deleted = db
    .prepare(
      `DELETE FROM agent_destinations
       WHERE agent_group_id NOT IN (SELECT id FROM agent_groups)`,
    )
    .run().changes;

  // Clean up rows whose target no longer exists: channel destinations
  // pointing at deleted messaging groups, agent destinations pointing at
  // deleted agent groups. Neither delete path cascades to
  // agent_destinations, and writeDestinations() silently drops dangling
  // targets from the per-session projection — so these rows linger
  // invisibly (visible only in `ncl destinations list`) and collide with
  // the auto-namer's suffix loop on a future re-wire of the same channel.
  deleted += db
    .prepare(
      `DELETE FROM agent_destinations
       WHERE (target_type = 'channel' AND target_id NOT IN (SELECT id FROM messaging_groups))
          OR (target_type = 'agent' AND target_id NOT IN (SELECT id FROM agent_groups))`,
    )
    .run().changes;
  if (deleted > 0) {
    log.info('Removed orphaned agent_destinations rows', { count: deleted });
  }

  const wirings = db
    .prepare('SELECT * FROM messaging_group_agents')
    .all() as MessagingGroupAgent[];
  let backfilled = 0;

  for (const w of wirings) {
    if (getDestinationByTarget(w.agent_group_id, 'channel', w.messaging_group_id)) continue;

    const mg = getMessagingGroup(w.messaging_group_id);
    if (!mg) continue;

    const base = normalizeName(mg.name || `${mg.channel_type}-${w.messaging_group_id.slice(0, 8)}`);
    let localName = base;
    let suffix = 2;
    while (getDestinationByName(w.agent_group_id, localName)) {
      localName = `${base}-${suffix}`;
      suffix++;
    }

    createDestination({
      agent_group_id: w.agent_group_id,
      local_name: localName,
      target_type: 'channel',
      target_id: w.messaging_group_id,
      created_at: w.created_at,
    });
    backfilled++;
  }

  if (backfilled > 0) {
    log.info('Backfilled agent_destinations from wirings', { count: backfilled });
  }
}
