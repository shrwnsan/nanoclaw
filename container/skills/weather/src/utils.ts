/* eslint-disable @typescript-eslint/naming-convention */
/**
 * Shared formatter helpers.
 *
 * Centralizes the descriptive helpers that the Python implementation
 * duplicates between `weather/formatters/telegram.py` and
 * `weather/formatters/whatsapp.py` (`_aqhi_quality`, `_aqi_quality`,
 * `_uv_description`, `_generate_summary`). The output strings here MUST
 * stay byte-identical to the Python helpers so cross-runtime parity
 * tests in Phase 7 do not flake.
 *
 * Also provides locale-free date formatting helpers that mirror
 * Python's `strftime` directives `%A, %B %-d` and `%a %b %-d`. Using
 * an explicit lookup table avoids surprises from
 * `Intl.DateTimeFormat`, which inserts a comma in `en-US` short form
 * and is otherwise locale-dependent.
 */
import type { WeatherData } from "./types.js";
import { WeatherCondition } from "./types.js";

// ── Date formatting (locale-free, matches Python strftime) ─────────

const WEEKDAY_SHORT = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
] as const;
const WEEKDAY_LONG = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;
const MONTH_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/**
 * Mirror Python `strftime("%A, %B %-d")` → "Sunday, March 29".
 * Uses local timezone fields to match Python's default `datetime`
 * behavior.
 */
export function formatLongDate(d: Date): string {
  return `${WEEKDAY_LONG[d.getDay()]}, ${MONTH_LONG[d.getMonth()]} ${d.getDate()}`;
}

/**
 * Mirror Python `strftime("%a %b %-d")` → "Wed Apr 1".
 */
export function formatShortDate(d: Date): string {
  return `${WEEKDAY_SHORT[d.getDay()]} ${MONTH_SHORT[d.getMonth()]} ${d.getDate()}`;
}

/**
 * Mirror Python `strftime("%Y-%m-%d")` → "2026-04-01".
 * Uses local timezone fields.
 */
export function formatIsoDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// ── Air-quality descriptors ────────────────────────────────────────

/**
 * Map HK/Canada AQHI (1-10+) to a quality description for the
 * Telegram/WhatsApp formatters.
 *
 * Mirrors `_aqhi_quality()` in `weather/formatters/telegram.py` and
 * `whatsapp.py`. Labels are aligned with `aqhiStr()` in `models.ts`.
 */
export function aqhiQuality(aqhi: number): string {
  if (aqhi <= 3) return "Low";
  if (aqhi <= 6) return "Moderate";
  if (aqhi === 7) return "High Risk";
  if (aqhi <= 10) return "Very High Risk";
  return "Serious";
}

/**
 * Map US EPA AQI (1-500) to a quality description.
 *
 * Mirrors `_aqi_quality()` in `weather/formatters/telegram.py` and
 * `whatsapp.py`.
 */
export function aqiQuality(aqi: number): string {
  if (aqi <= 50) return "Good";
  if (aqi <= 100) return "Moderate";
  if (aqi <= 150) return "Unhealthy for Sensitive";
  if (aqi <= 200) return "Unhealthy";
  if (aqi <= 300) return "Very Unhealthy";
  return "Hazardous";
}

/**
 * Map UV index to a textual descriptor.
 *
 * Mirrors `_uv_description()` in `weather/formatters/telegram.py` and
 * `whatsapp.py`.
 */
export function uvDescription(uv: number): string {
  if (uv < 3) return "Low";
  if (uv < 6) return "Moderate";
  if (uv < 8) return "High";
  if (uv < 11) return "Very High";
  return "Extreme";
}

// ── Summary generator ──────────────────────────────────────────────

/**
 * Sky-phrase fragments keyed by condition, used by `generateSummary`.
 * Mirrors the inline `condition_desc` dicts in `telegram.py` and
 * `whatsapp.py`. Conditions not listed here contribute no sky phrase.
 */
const CONDITION_SKY: Record<string, string> = {
  [WeatherCondition.Sunny]: "and sunny",
  [WeatherCondition.Clear]: "and clear",
  [WeatherCondition.PartlyCloudy]: "with partly cloudy skies",
  [WeatherCondition.Cloudy]: "and cloudy",
  [WeatherCondition.Overcast]: "and overcast",
  [WeatherCondition.Fog]: "with fog",
  [WeatherCondition.Mist]: "with mist",
  [WeatherCondition.Drizzle]: "with occasional drizzle",
  [WeatherCondition.Rain]: "with rain expected",
  [WeatherCondition.Showers]: "with scattered showers",
  [WeatherCondition.HeavyRain]: "with heavy rain",
  [WeatherCondition.Thunderstorm]: "with thunderstorms possible",
  [WeatherCondition.Snow]: "with snow",
  [WeatherCondition.HeavySnow]: "with heavy snow",
  [WeatherCondition.Windy]: "and windy",
};

const WET_CONDITIONS: ReadonlySet<string> = new Set([
  WeatherCondition.Rain,
  WeatherCondition.HeavyRain,
  WeatherCondition.Thunderstorm,
  WeatherCondition.Showers,
  WeatherCondition.Drizzle,
]);

/**
 * Build a one-sentence human-readable summary of the conditions.
 *
 * Mirrors `_generate_summary()` in `weather/formatters/telegram.py`
 * (and the duplicated copy in `whatsapp.py`). Returns "" if fewer
 * than two informative parts are collected.
 */
export function generateSummary(data: WeatherData): string {
  const parts: string[] = [];

  // Temperature feel
  if (data.temperature != null) {
    if (data.temperature >= 30) parts.push("Hot");
    else if (data.temperature >= 25) parts.push("Warm");
    else if (data.temperature >= 20) parts.push("Mild");
    else if (data.temperature >= 15) parts.push("Cool");
    else parts.push("Cold");
  }

  // Humidity feel
  if (data.humidity != null) {
    if (data.humidity >= 80) parts.push("humid");
    else if (data.humidity <= 40) parts.push("dry");
  }

  // Sky condition
  const sky = CONDITION_SKY[data.condition];
  if (sky) parts.push(sky);

  if (parts.length < 2) return "";

  let summary = parts.join(" ");

  // Activity suggestion (mirror Python's ordered if/elif/elif chain)
  if (WET_CONDITIONS.has(data.condition)) {
    summary += " — perfect weather for a cozy day indoors";
  } else if (
    data.condition === WeatherCondition.Sunny &&
    data.temperature != null &&
    data.temperature >= 20
  ) {
    summary += " — great weather to be outdoors";
  } else if (data.humidity != null && data.humidity >= 85) {
    summary += " — stay hydrated and keep cool";
  }

  return summary;
}

/**
 * Convert a snake_case condition value to title-case words.
 *
 * Mirrors Python's `data.condition.value.title()` — `"partly_cloudy"`
 * becomes `"Partly Cloudy"`.
 */
export function conditionTitle(condition: WeatherCondition): string {
  return condition
    .split("_")
    .map((w) => (w.length > 0 ? (w[0] as string).toUpperCase() + w.slice(1) : ""))
    .join(" ");
}

/**
 * Format temperature as `"NN°C"` matching Python's `f"{x:.0f}°C"`.
 */
export function formatTempC(n: number): string {
  return `${Math.round(n)}°C`;
}

/**
 * Format bare temperature as `"NN°"` matching Python's `f"{x:.0f}°"`.
 */
export function formatTempBare(n: number): string {
  return `${Math.round(n)}°`;
}

/**
 * Format UV index with one decimal place, matching Python's
 * `f"{uv:.1f}"`.
 */
export function formatUv(n: number): string {
  return n.toFixed(1);
}

/**
 * Truncate a description to the same shape Python's formatters use:
 * keep the first sentence if it ends before 120 chars, otherwise
 * hard-cut at 117 and append "...".
 *
 * Mirrors the inline truncation logic in `format_current` for both
 * Telegram and WhatsApp formatters.
 */
export function truncateDescription(desc: string): string {
  const firstSentenceEnd = desc.indexOf(". ");
  if (firstSentenceEnd > 0 && firstSentenceEnd < 120) {
    return desc.slice(0, firstSentenceEnd + 1);
  }
  if (desc.length > 120) {
    return desc.slice(0, 117) + "...";
  }
  return desc;
}

/**
 * Truncate a message to `maxLength`, appending `suffix` if cut.
 *
 * Mirrors `WeatherFormatter.truncate()` in
 * `weather/formatters/base.py`. Uses code-unit length, matching
 * Python's `len(str)` for BMP characters; supplementary characters
 * (e.g. some emoji) count as 2 in JS vs. 1 in Python, but this only
 * matters near the limit and is acceptable for v0.1.
 */
export function truncateMessage(
  message: string,
  maxLength: number,
  suffix: string = "...",
): string {
  if (message.length <= maxLength) return message;
  return message.slice(0, maxLength - suffix.length) + suffix;
}
