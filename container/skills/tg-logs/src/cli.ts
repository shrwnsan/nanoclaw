#!/usr/bin/env bun
/**
 * tg-logs skill — reads messages ingested by tg-topic-ingest from the mounted
 * logs.db for a given HKT day and prints them for summarization or lookup.
 *
 * Usage:
 *   bun run /app/skills/tg-logs/src/cli.ts                    # yesterday, all sources, JSON
 *   bun run /app/skills/tg-logs/src/cli.ts --format text      # human-readable
 *   bun run /app/skills/tg-logs/src/cli.ts --days-ago 2       # 2 days ago
 *   bun run /app/skills/tg-logs/src/cli.ts --source <name>    # one source only
 *
 * Override the DB path for host-side testing: TG_LOGS_DB=./data/logs.db
 */
import { Database } from "bun:sqlite";

const DB_PATH = process.env.TG_LOGS_DB ?? "/workspace/extra/logs.db";
const HKT = "Asia/Hong_Kong";
const HKT_OFFSET_MS = 8 * 3600 * 1000;
const DAY_MS = 86400000;

interface Args {
  daysAgo: number;
  format: "json" | "text";
  source: string | null;
}

interface Row {
  msg_id: number;
  source: string;
  sender_name: string | null;
  date: string;
  text: string | null;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { daysAgo: 1, format: "json", source: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === "--days-ago") (a.daysAgo = Number(next ?? 1)), i++;
    else if (flag === "--format") (a.format = next === "text" ? "text" : "json"), i++;
    else if (flag === "--source") (a.source = next ?? null), i++;
    else if (flag === "-h" || flag === "--help") {
      console.log("usage: tg-logs [--days-ago N] [--format json|text] [--source NAME]");
      process.exit(0);
    }
  }
  return a;
}

/** The HKT day `daysAgo` ago, midnight-to-midnight, as UTC ISO strings (+00:00, matching storage). */
function windowFor(daysAgo: number): { start: string; end: string; label: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: HKT, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const [y, m, d] = fmt.format(new Date()).split("-").map(Number);
  const todayMidHktUtcMs = Date.UTC(y, m - 1, d, 0, 0, 0) - HKT_OFFSET_MS; // HKT 00:00 == UTC−8h
  const startMs = todayMidHktUtcMs - daysAgo * DAY_MS;
  const endMs = todayMidHktUtcMs - (daysAgo - 1) * DAY_MS;
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "+00:00");
  return { start: iso(startMs), end: iso(endMs), label: fmt.format(new Date(startMs)) };
}

const args = parseArgs(process.argv.slice(2));

let db: Database;
try {
  db = new Database(DB_PATH, { readonly: true });
} catch (e) {
  console.error(`tg-logs: cannot open ${DB_PATH} (is the additional mount present?): ${e}`);
  process.exit(1);
}

const { start, end, label } = windowFor(args.daysAgo);
const rows: Row[] = args.source
  ? db
      .prepare(
        `SELECT msg_id, source, sender_name, date, text
           FROM messages
          WHERE date >= ? AND date < ? AND source = ?
          ORDER BY date`,
      )
      .all(start, end, args.source)
  : db
      .prepare(
        `SELECT msg_id, source, sender_name, date, text
           FROM messages
          WHERE date >= ? AND date < ?
          ORDER BY date`,
      )
      .all(start, end);
db.close();

const sources = [...new Set(rows.map((r) => r.source))].sort();

if (args.format === "json") {
  console.log(
    JSON.stringify(
      { date: label, window: { start, end }, count: rows.length, sources, messages: rows },
      null,
      2,
    ),
  );
} else {
  const srcs = sources.length ? ` — sources: ${sources.join(", ")}` : "";
  console.log(`tg-logs — ${label} — ${rows.length} messages (${start} → ${end})${srcs}`);
  for (const r of rows) {
    const time = String(r.date).slice(11, 16);
    const who = (r.sender_name ?? "?").padEnd(8);
    const text = (r.text ?? "").replace(/\n/g, " / ");
    console.log(`  ${time}  ${who}  ${text}`);
  }
}
