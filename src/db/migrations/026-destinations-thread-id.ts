import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * Optional `thread_id` on agent destinations (fork): pin a channel destination
 * to a specific platform thread (e.g. a Telegram forum topic). When set, sends
 * to that destination land in the pinned thread deterministically — the only
 * deterministic task→topic path, since isolated task sessions have no reply
 * context. NULL keeps the dynamic reply/latest-inbound resolution.
 *
 * Idempotent by column probe: installs migrating from the fork's earlier
 * (differently named) migration already carry the column.
 */
export const migration026: Migration = {
  version: 26,
  name: 'destinations-thread-id',
  sqliteOnly: true,
  up(db: Database.Database) {
    const cols = db.prepare('PRAGMA table_info(agent_destinations)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'thread_id')) {
      db.exec('ALTER TABLE agent_destinations ADD COLUMN thread_id TEXT');
    }
  },
};
