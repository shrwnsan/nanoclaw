import type { Migration } from './index.js';

/**
 * Optional `thread_id` on agent destinations (fork): pin a channel destination
 * to a specific platform thread (e.g. a Telegram forum topic). When set, sends
 * to that destination land in the pinned thread deterministically — the only
 * deterministic task→topic path, since isolated task sessions have no reply
 * context. NULL keeps the dynamic reply/latest-inbound resolution.
 */
export const migration026: Migration = {
  version: 26,
  name: 'destinations-thread-id',
  async up(db) {
    try {
      await db.exec(`ALTER TABLE agent_destinations ADD COLUMN thread_id TEXT;`);
    } catch (err) {
      // Fork-replay edge: installs upgraded from our pre-seam tree already
      // carry the column (added by the fork's earlier, differently named
      // migration). The portable idiom is an unconditional ALTER — migration
      // identity prevents re-runs upstream, but cannot know about the fork's
      // row — so a duplicate column here means the schema is already where
      // this migration would put it.
      const message = err instanceof Error ? err.message : String(err);
      if (/duplicate column/i.test(message)) return;
      throw err;
    }
  },
};
