---
name: tg-logs
description: Reads Telegram topic messages ingested by tg-topic-ingest from the mounted logs.db. Use for daily digests, recent message lookups, rolling counts ("how many in the last 24 hours"), or any question about message volume/timing.
---

# tg-logs Skill

Reads messages from the host-mounted `logs.db` (read-only, at
`/workspace/extra/logs.db`) and prints them for summarization, lookup, or quick
counts.  The DB is populated by the `tg-topic-ingest` service (Telegram forum
topic → SQLite), one row per message, with a `source` column identifying the
originating topic / config source.

## When to Use

- "How many messages in the last 24 hours?" or similar time-range count questions
- "What happened yesterday?" — daily digest / summary
- "Show me recent entries" — message lookup by day or source

**Casual phrasing is fine** — map natural language to the right flags:
| User says … | Run … |
|---|---|
| "how many / count / total" | `--rolling-hours N --format text` |
| "what happened / show entries / digest" | `--days-ago 0 --format json` (then summarize) |
| "yesterday / 2 days ago" | `--days-ago N` |
| a specific source name | add `--source <name>` |
| **daily digest / what really happened that day** | add `--use-content-time` |

## Agent Execution

```bash
# Rolling count — "how many in the last N hours?" (default 24)
bun run /app/skills/tg-logs/src/cli.ts --rolling-hours 24 --format text

# Different rolling window
bun run /app/skills/tg-logs/src/cli.ts --rolling-hours 6 --format text

# Yesterday's entries as JSON (default — summarize this)
bun run /app/skills/tg-logs/src/cli.ts

# Human-readable
bun run /app/skills/tg-logs/src/cli.ts --format text

# A different day (N days ago; 0 = today)
bun run /app/skills/tg-logs/src/cli.ts --days-ago 2

# Limit to one source (as named in the ingest config)
bun run /app/skills/tg-logs/src/cli.ts --source <source-name>

# Filter by content time instead of send time (digests — see Notes)
bun run /app/skills/tg-logs/src/cli.ts --days-ago 1 --use-content-time
```

## Output

### Rolling-hours mode

JSON: `{ window, from, to, total, by_source:[{source, count}] }`
Text: `tg-logs — last 24h — 9 messages (… → …)` with per-source breakdown.

### Day-window mode (default)

JSON: `{ date, window:{start,end}, time_basis, count, sources:[...], messages:[{msg_id, source, sender_name, date, content_time, text}] }`.

- `date` / `window` are ISO-8601 UTC (`+00:00`), matching how `tg-topic-ingest` stores them.
- `sender_name` is the Telegram display name.
- The window is midnight-to-midnight **Asia/Hong_Kong**, converted to UTC.
- **`--use-content-time`** filters/orders by `content_time` — the HKT clock the entry refers to (first line of the message, e.g. `20:20`), not when it was sent. Use this for daily digests: a backdated "20:20" entry posted the next morning correctly belongs to the prior evening. Rows with unparseable first lines (typos like `20:80`, notes) keep `content_time: null` and fall back to their send time, so they never disappear. Send-time `date` is always included for reference.

## Notes

- Read-only: never writes to the DB.
- If it errors "cannot open /workspace/extra/logs.db", the additional mount
  isn't present — check the group's `additionalMounts` and the mount allowlist.
