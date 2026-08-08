---
name: tg-logs
description: Reads Telegram topic messages ingested by tg-topic-ingest from the mounted logs.db. Use when asked for a daily digest or summary of a topic's messages, or to look up recent entries by day.
---

# tg-logs Skill

Reads messages from the host-mounted `logs.db` (read-only, at
`/workspace/extra/logs.db`) and prints them for summarization or lookup. The DB
is populated by the `tg-topic-ingest` service (Telegram forum topic → SQLite),
one row per message, with a `source` column identifying the originating topic /
config source.

## Agent Execution

```bash
# Yesterday's entries as JSON (default — summarize this)
bun run /app/skills/tg-logs/src/cli.ts

# Human-readable
bun run /app/skills/tg-logs/src/cli.ts --format text

# A different day (N days ago; 0 = today)
bun run /app/skills/tg-logs/src/cli.ts --days-ago 2

# Limit to one source (as named in the ingest config)
bun run /app/skills/tg-logs/src/cli.ts --source <source-name>
```

## Output

JSON: `{ date, window:{start,end}, count, sources:[...], messages:[{msg_id, source, sender_name, date, text}] }`.

- `date` / `window` are ISO-8601 UTC (`+00:00`), matching how `tg-topic-ingest` stores them.
- `sender_name` is the Telegram display name.
- The window is midnight-to-midnight **Asia/Hong_Kong**, converted to UTC.

## Notes

- Read-only: never writes to the DB.
- If it errors "cannot open /workspace/extra/logs.db", the additional mount
  isn't present — check the group's `additionalMounts` and the mount allowlist.
