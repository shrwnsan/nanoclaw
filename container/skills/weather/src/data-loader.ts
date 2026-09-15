/* eslint-disable @typescript-eslint/naming-convention */
/**
 * Static data loader for the weather skill.
 *
 * Uses TypeScript's JSON-module imports so all referenced data files
 * are bundled into the compiled binary by `bun build --compile`. Do
 * NOT use `Bun.file()` for these — that would read from disk at
 * runtime and break the single-binary distribution model used by
 * NanoClaw.
 *
 * The same `weather/data/` JSON files are loaded by Python via
 * `weather/data/loader.py` (importlib.resources). Both runtimes share
 * a single source of truth.
 */

import { WeatherCondition } from "./types.js";

// ── Top-level shared data ──────────────────────────────────────────
import weatherConditionsRaw from "../weather/data/weather-conditions.json" with { type: "json" };
import locationAliasesRaw from "../weather/data/location-aliases.json" with { type: "json" };
import conditionEmojiRaw from "../weather/data/condition-emoji.json" with { type: "json" };

// ── Cities (location → identifier/coordinates lookups) ─────────────
import jmaAreaCodesRaw from "../weather/data/cities/jma-area-codes.json" with { type: "json" };
import usNwsCitiesRaw from "../weather/data/cities/us-nws.json" with { type: "json" };
import deDwdCitiesRaw from "../weather/data/cities/de-dwd.json" with { type: "json" };
import metofficeCitiesRaw from "../weather/data/cities/metoffice.json" with { type: "json" };
import cnCitiesRaw from "../weather/data/cities/cn.json" with { type: "json" };

// ── Condition maps (provider-specific code → WeatherCondition) ─────
import hkoIconsRaw from "../weather/data/condition_maps/hko-icons.json" with { type: "json" };
import jmaCodesRaw from "../weather/data/condition_maps/jma-codes.json" with { type: "json" };
import nwsConditionsRaw from "../weather/data/condition_maps/nws-conditions.json" with { type: "json" };
import sgNeaForecastRaw from "../weather/data/condition_maps/sg-nea-forecast.json" with { type: "json" };
import owmCodesRaw from "../weather/data/condition_maps/owm-codes.json" with { type: "json" };
import brightskyConditionsRaw from "../weather/data/condition_maps/brightsky-conditions.json" with { type: "json" };
import cwaConditionsRaw from "../weather/data/condition_maps/cwa-conditions.json" with { type: "json" };
import metofficeConditionsRaw from "../weather/data/condition_maps/metoffice-conditions.json" with { type: "json" };
import bomConditionsRaw from "../weather/data/condition_maps/bom-conditions.json" with { type: "json" };
import metserviceConditionsRaw from "../weather/data/condition_maps/metservice-conditions.json" with { type: "json" };
import bmkgConditionsRaw from "../weather/data/condition_maps/bmkg-conditions.json" with { type: "json" };
import kmaPtyRaw from "../weather/data/condition_maps/kma-pty.json" with { type: "json" };
import kmaSkyRaw from "../weather/data/condition_maps/kma-sky.json" with { type: "json" };
import tmdConditionsRaw from "../weather/data/condition_maps/tmd-conditions.json" with { type: "json" };
import wmoCodesRaw from "../weather/data/condition_maps/wmo-codes.json" with { type: "json" };

// ── Helpers ────────────────────────────────────────────────────────

const VALID_CONDITION_VALUES: ReadonlySet<string> = new Set(
  weatherConditionsRaw as readonly string[],
);

/**
 * Convert a string into a `WeatherCondition`. Returns `Unknown` if the
 * value is not in the canonical enum list.
 */
export function toCondition(value: string | null | undefined): WeatherCondition {
  if (value == null) return WeatherCondition.Unknown;
  if (VALID_CONDITION_VALUES.has(value)) {
    return value as WeatherCondition;
  }
  return WeatherCondition.Unknown;
}

/**
 * Build a `Record<string, WeatherCondition>` from a raw map of
 * `{ provider_code: condition_string }`. Null values are dropped (used
 * by KMA's "no precipitation" sentinel).
 */
function buildConditionMap(
  raw: Record<string, string | null>,
): Record<string, WeatherCondition> {
  const out: Record<string, WeatherCondition> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v == null) continue;
    out[k] = toCondition(v);
  }
  return out;
}

// ── Public exports ─────────────────────────────────────────────────

/** Canonical list of weather condition string values (20 entries). */
export const WEATHER_CONDITIONS: readonly string[] =
  weatherConditionsRaw as readonly string[];

/** Lower-cased location aliases → canonical location string. */
export const LOCATION_ALIASES: Record<string, string> =
  locationAliasesRaw as Record<string, string>;

/** Condition string value → emoji glyph. */
export const CONDITION_EMOJI: Record<string, string> =
  conditionEmojiRaw as Record<string, string>;

// City lookups
export const JMA_AREA_CODES: Record<string, string> =
  jmaAreaCodesRaw as Record<string, string>;
export const US_NWS_CITIES: Record<string, [number, number]> =
  usNwsCitiesRaw as unknown as Record<string, [number, number]>;
export const DE_DWD_CITIES: Record<string, [number, number]> =
  deDwdCitiesRaw as unknown as Record<string, [number, number]>;
/**
 * UK Met Office city → `[latitude, longitude]` coordinates. The
 * Python provider resolves these to a Met Office site ID at runtime.
 */
export const METOFFICE_CITIES: Record<string, [number, number]> =
  metofficeCitiesRaw as unknown as Record<string, [number, number]>;
export const CN_CITIES: Record<string, [number, number]> =
  cnCitiesRaw as unknown as Record<string, [number, number]>;

// Condition maps (provider-specific code → WeatherCondition)
export const HKO_ICON_MAP: Record<string, WeatherCondition> =
  buildConditionMap(hkoIconsRaw as Record<string, string>);

export const JMA_WEATHER_CODE_MAP: Record<string, WeatherCondition> =
  buildConditionMap(jmaCodesRaw as Record<string, string>);

export const NWS_CONDITION_MAP: Record<string, WeatherCondition> =
  buildConditionMap(nwsConditionsRaw as Record<string, string>);

export const SG_CONDITION_MAP: Record<string, WeatherCondition> =
  buildConditionMap(sgNeaForecastRaw as Record<string, string>);

/**
 * OpenWeatherMap condition map. Keys are integer codes serialized as
 * strings (JSON forces string keys). Callers convert OWM's `weather[0].id`
 * (a number) to string before lookup.
 */
export const OWM_CONDITION_MAP: Record<string, WeatherCondition> =
  buildConditionMap(owmCodesRaw as Record<string, string>);

export const BRIGHTSKY_CONDITION_MAP: Record<string, WeatherCondition> =
  buildConditionMap(brightskyConditionsRaw as Record<string, string>);

export const CWA_CONDITION_MAP: Record<string, WeatherCondition> =
  buildConditionMap(cwaConditionsRaw as Record<string, string>);

/** UK Met Office: numeric codes serialized as JSON string keys. */
export const METOFFICE_CONDITION_MAP: Record<string, WeatherCondition> =
  buildConditionMap(metofficeConditionsRaw as Record<string, string>);

export const BOM_CONDITION_MAP: Record<string, WeatherCondition> =
  buildConditionMap(bomConditionsRaw as Record<string, string>);

export const METSERVICE_CONDITION_MAP: Record<string, WeatherCondition> =
  buildConditionMap(metserviceConditionsRaw as Record<string, string>);

export const BMKG_CONDITION_MAP: Record<string, WeatherCondition> =
  buildConditionMap(bmkgConditionsRaw as Record<string, string>);

/**
 * KMA precipitation type (PTY) → WeatherCondition. The "0" key
 * (no precipitation) is intentionally dropped from this map — callers
 * should treat a missing key as "fall through to KMA_SKY_MAP".
 */
export const KMA_PTY_MAP: Record<string, WeatherCondition> = buildConditionMap(
  kmaPtyRaw as Record<string, string | null>,
);

/** KMA sky condition (SKY) → WeatherCondition. */
export const KMA_SKY_MAP: Record<string, WeatherCondition> = buildConditionMap(
  kmaSkyRaw as Record<string, string>,
);

export const TMD_CONDITION_MAP: Record<string, WeatherCondition> =
  buildConditionMap(tmdConditionsRaw as Record<string, string>);

export const WMO_CODE_MAP: Record<string, WeatherCondition> =
  buildConditionMap(wmoCodesRaw as Record<string, string>);
