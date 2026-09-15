#!/usr/bin/env bun
/* eslint-disable @typescript-eslint/naming-convention */
/**
 * Weather Skill CLI (Bun runtime).
 *
 * Port of `weather/cli.py`. Mirrors flags, defaults, exit codes, and
 * output formatting so both runtimes are interchangeable.
 *
 * Usage:
 *   weather --location "Hong Kong"
 *   weather --location "Hong Kong" --forecast --days 3
 *   weather --location "Hong Kong" --format telegram --send
 *   weather --help
 *
 * JSON output mirrors Python's `json.dumps(..., indent=2, sort_keys=True)`
 * with `Date` instances serialized via `toISOString()` (ISO-8601). See
 * the "JSON Schema Parity" section of `docs/prd-002-bun-runtime-support.md`.
 */
import { buildDefaultSkill } from "./bootstrap.js";
import { NoProviderError } from "./types.js";
import type { SendOptions, WeatherData } from "./types.js";

interface CliArgs {
  location: string;
  forecast: boolean;
  days: number;
  format: "text" | "telegram" | "whatsapp" | "json";
  send: boolean;
  chat_id?: string;
  topic_id?: number;
  provider: string;
  verbose: boolean;
}

const HELP_TEXT = `usage: weather [-h] [-l LOCATION] [-f] [-d DAYS]
               [--format {text,telegram,whatsapp,json}] [--send]
               [--chat-id CHAT_ID] [--topic-id TOPIC_ID]
               [--provider PROVIDER] [-v]

Fetch weather information for any location

options:
  -h, --help            show this help message and exit
  -l LOCATION, --location LOCATION
                        Location to fetch weather for (default: Hong Kong)
  -f, --forecast        Fetch forecast instead of current weather
  -d DAYS, --days DAYS  Number of forecast days (default: 3)
  --format {text,telegram,whatsapp,json}
                        Output format (default: text)
  --send                Send to configured channel (requires Telegram setup)
  --chat-id CHAT_ID     Override chat ID for sending
  --topic-id TOPIC_ID   Telegram topic/thread ID
  --provider PROVIDER   Weather provider name (default: auto — uses priority chain)
  -v, --verbose         Verbose output

Examples:
  weather --location "Hong Kong"
  weather -l "Hong Kong" --forecast --days 5
  weather -l "Hong Kong" --format telegram
  weather -l "Hong Kong" --format json
  weather -l "Hong Kong" --send --chat-id "YOUR_CHAT_ID"
`;

/**
 * Parse CLI arguments. Inline parser, no external dependencies.
 *
 * Supports both `--flag value` and `--flag=value` forms; short flags
 * `-l`, `-f`, `-d`, `-v`, `-h`.
 */
export function parseArgs(argv: string[]): CliArgs | { _help: true } {
  const args: CliArgs = {
    location: "Hong Kong",
    forecast: false,
    days: 3,
    format: "text",
    send: false,
    provider: "auto",
    verbose: false,
  };

  const formatChoices = new Set(["text", "telegram", "whatsapp", "json"]);

  // Match Python argparse `type=int`: reject any string that isn't a
  // clean integer (e.g. "3.5" must error, not silently truncate to 3).
  const parseStrictInt = (s: string, flag: string): number => {
    if (!/^-?\d+$/.test(s)) {
      throw new Error(`argument ${flag}: invalid int value: '${s}'`);
    }
    return parseInt(s, 10);
  };

  let i = 0;
  while (i < argv.length) {
    const raw = argv[i]!;
    let arg = raw;
    let inlineValue: string | undefined;
    const eq = raw.indexOf("=");
    if (raw.startsWith("--") && eq !== -1) {
      arg = raw.slice(0, eq);
      inlineValue = raw.slice(eq + 1);
    }

    const next = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      i++;
      if (i >= argv.length) {
        throw new Error(`Argument ${arg} requires a value`);
      }
      return argv[i]!;
    };

    switch (arg) {
      case "-h":
      case "--help":
        return { _help: true };
      case "-l":
      case "--location":
        args.location = next();
        break;
      case "-f":
      case "--forecast":
        args.forecast = true;
        break;
      case "-d":
      case "--days":
        args.days = parseStrictInt(next(), "--days");
        break;
      case "--format": {
        const v = next();
        if (!formatChoices.has(v)) {
          throw new Error(
            `argument --format: invalid choice: '${v}' (choose from 'text', 'telegram', 'whatsapp', 'json')`,
          );
        }
        args.format = v as CliArgs["format"];
        break;
      }
      case "--send":
        args.send = true;
        break;
      case "--chat-id":
        args.chat_id = next();
        break;
      case "--topic-id":
        args.topic_id = parseStrictInt(next(), "--topic-id");
        break;
      case "--provider":
        args.provider = next();
        break;
      case "-v":
      case "--verbose":
        args.verbose = true;
        break;
      default:
        throw new Error(`unrecognized argument: ${raw}`);
    }
    i++;
  }

  return args;
}

/**
 * Recursively sort object keys for deterministic JSON output. Mirrors
 * Python's `json.dumps(..., sort_keys=True)`. `Date` instances pass
 * through unchanged so the replacer in `JSON.stringify` can serialize
 * them via `toISOString()`.
 */
function sortKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(sortKeys);
  if (obj && typeof obj === "object" && !(obj instanceof Date)) {
    const src = obj as Record<string, unknown>;
    return Object.keys(src)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortKeys(src[k]);
        return acc;
      }, {});
  }
  return obj;
}

/**
 * Serialize WeatherData (or an array of WeatherData) to JSON matching
 * Python's `json.dumps(asdict(...), indent=2, sort_keys=True, default=...)`.
 */
export function toJson(output: WeatherData | WeatherData[]): string {
  return JSON.stringify(
    sortKeys(output),
    (_k, v) => (v instanceof Date ? v.toISOString() : v),
    2,
  );
}

export async function run(argv: string[]): Promise<number> {
  let parsed: CliArgs | { _help: true };
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`Error: ${msg}\n`);
    return 1;
  }

  if ("_help" in parsed) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  const args = parsed;

  try {
    if (args.send && args.format === "json") {
      process.stderr.write(
        "Error: --send is not compatible with --format json\n",
      );
      return 2;
    }

    if (args.verbose) {
      process.stderr.write(`Fetching weather for: ${args.location}\n`);
    }

    const skill = buildDefaultSkill();
    const providerName = args.provider === "auto" ? undefined : args.provider;

    if (providerName && !skill.providers.some((p) => p.name === providerName)) {
      const names = skill.providers
        .map((p) => p.name)
        .sort()
        .join(", ");
      throw new NoProviderError(
        `Provider not found: ${providerName}\nAvailable providers: ${names}`,
      );
    }

    const data = args.forecast
      ? await skill.getForecast(args.location, args.days, providerName)
      : await skill.getCurrent(args.location, providerName);

    if (args.format === "json") {
      process.stdout.write(toJson(data) + "\n");
      return 0;
    }

    const message = skill.format(data, args.format);

    if (args.send) {
      const options: SendOptions = {
        ...(args.chat_id != null ? { chat_id: args.chat_id } : {}),
        ...(args.topic_id != null ? { topic_id: args.topic_id } : {}),
      };
      const result = await skill.send(message, "telegram", options);
      if (result.success) {
        process.stderr.write("✓ Message sent successfully\n");
        return 0;
      }
      process.stderr.write(`✗ Failed: ${result.error ?? "unknown error"}\n`);
      return 1;
    }

    process.stdout.write(message + "\n");
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`Error: ${msg}\n`);
    if (args.verbose && e instanceof Error && e.stack) {
      process.stderr.write(e.stack + "\n");
    }
    return 1;
  }
}

// Entry point: only when executed directly (not when imported).
if (import.meta.main) {
  run(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
