import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * Add optional thread_id to agent_destinations.
 *
 * Lets a destination carry a platform-specific thread/topic override so
 * agents can send to a specific topic within a supergroup (e.g. Telegram
 * forum topics) instead of the default topic.
 *
 * The value is the adapter's encoded thread-id string
 * (e.g. "telegram:<chatId>:<topicId>").
 */
export const migration016DestinationThreadId: Migration = {
  version: 16,
  name: 'destination-thread-id',
  up(db: Database.Database) {
    db.exec(`ALTER TABLE agent_destinations ADD COLUMN thread_id TEXT`);
  },
};
