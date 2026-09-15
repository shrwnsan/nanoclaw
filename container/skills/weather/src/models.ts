/* eslint-disable @typescript-eslint/naming-convention */
/**
 * Helper functions mirroring `WeatherData` properties and module-level
 * helpers in `weather/models.py`.
 *
 * In TypeScript we can't attach computed properties to plain object
 * literals, so each `@property` from the Python dataclass becomes a
 * standalone function that takes the data object as its first argument.
 */

import {
  CONDITION_EMOJI,
  LOCATION_ALIASES,
} from "./data-loader.js";
import type { Location, WeatherData } from "./types.js";
import { WeatherCondition } from "./types.js";

// ── Display helpers (mirror @property methods on WeatherData) ──────

/** Emoji for a weather condition. Mirrors `WeatherData.emoji`. */
export function getEmoji(condition: WeatherCondition): string {
  return CONDITION_EMOJI[condition] ?? "❓";
}

/** Mirrors `WeatherData.humidity_str`. */
export function humidityStr(data: WeatherData): string {
  if (data.humidity == null) return "N/A";
  return `${data.humidity}%`;
}

/** Mirrors `WeatherData.wind_str`. */
export function windStr(data: WeatherData): string {
  if (data.wind_description) return data.wind_description;
  if (data.wind_speed == null) return "N/A";
  const direction = data.wind_direction ? ` ${data.wind_direction}` : "";
  return `${Math.round(data.wind_speed)} km/h${direction}`;
}

/** Mirrors `WeatherData.temp_range_str`. */
export function tempRangeStr(data: WeatherData): string {
  if (data.temp_high != null && data.temp_low != null) {
    return `${Math.round(data.temp_low)}°C - ${Math.round(data.temp_high)}°C`;
  }
  return `${Math.round(data.temperature)}°C`;
}

/** Mirrors `WeatherData.aqhi_str` (HK/Canada AQHI scale 1-10+). */
export function aqhiStr(data: WeatherData): string {
  const aqhi = data.aqhi;
  if (aqhi == null) return "N/A";
  if (aqhi <= 3) return `${aqhi} (Low)`;
  if (aqhi <= 6) return `${aqhi} (Moderate)`;
  if (aqhi <= 7) return `${aqhi} (High Risk)`;
  if (aqhi <= 10) return `${aqhi} (Very High Risk)`;
  return `${aqhi}+ (Serious)`;
}

/** Mirrors `WeatherData.aqi_str` (US EPA AQI scale 1-500). */
export function aqiStr(data: WeatherData): string {
  const aqi = data.aqi;
  if (aqi == null) return "N/A";
  if (aqi <= 50) return `${aqi} (Good)`;
  if (aqi <= 100) return `${aqi} (Moderate)`;
  if (aqi <= 150) return `${aqi} (Unhealthy for Sensitive)`;
  if (aqi <= 200) return `${aqi} (Unhealthy)`;
  if (aqi <= 300) return `${aqi} (Very Unhealthy)`;
  return `${aqi} (Hazardous)`;
}

// ── Feels-like calculation ─────────────────────────────────────────

/**
 * Calculate feels-like temperature using simplified NWS/NOAA formulas.
 * Mirrors `WeatherData._calculate_feels_like` in `weather/models.py`.
 *
 * @param temp Temperature in Celsius.
 * @param humidity Relative humidity percentage (0-100).
 * @param windSpeed Wind speed in **m/s** (not km/h — callers must convert).
 */
export function calculateFeelsLike(
  temp: number,
  humidity: number,
  windSpeed: number = 0,
): number {
  // Heat index (hot/humid)
  if (temp >= 27 && humidity >= 40) {
    const hi = temp + 0.1 * humidity - 0.05 * temp;
    return Math.max(Math.round(hi), Math.round(temp));
  }

  // Wind chill (cold/windy). 4.8 km/h = 1.33 m/s
  if (temp <= 10 && windSpeed > 1.33) {
    const windKmh = windSpeed * 3.6;
    const wc = 13.12 + 0.6215 * temp - 11.37 * windKmh ** 0.16;
    return Math.max(Math.round(wc), Math.round(temp));
  }

  return Math.round(temp);
}

/**
 * Get feels-like temperature, calculating it from humidity/wind if not
 * provided by the upstream data.
 *
 * Mirrors `WeatherData.effective_feels_like`.
 */
export function effectiveFeelsLike(data: WeatherData): number {
  if (data.feels_like != null) return data.feels_like;
  if (data.humidity != null) {
    const windMs = data.wind_speed != null ? data.wind_speed / 3.6 : 0;
    return calculateFeelsLike(data.temperature, data.humidity, windMs);
  }
  return data.temperature;
}

// ── Location helpers ───────────────────────────────────────────────

/**
 * Normalize a free-form location string by lower-casing, trimming, and
 * resolving via `LOCATION_ALIASES`.
 *
 * Mirrors `weather.models.normalize_location`.
 */
export function normalizeLocation(location: string): string {
  const loc = location.toLowerCase().trim();
  return LOCATION_ALIASES[loc] ?? location.trim();
}

/**
 * Construct a `Location` object from a free-form input string.
 *
 * Mirrors `WeatherSkill.parse_location()` in `weather/skill.py`:
 * applies `normalizeLocation()` so `LOCATION_ALIASES` resolves
 * shortcuts like "hk" → "Hong Kong" and "nyc" → "New York" before
 * the value reaches any provider's `supportsLocation()` check.
 *
 * The lower-case form is then used as the `normalized` field so
 * provider lookups (which all compare against lower-case keys) work
 * uniformly regardless of input casing.
 */
export function parseLocation(raw: string): Location {
  const resolved = normalizeLocation(raw);
  return {
    raw,
    normalized: resolved.toLowerCase().trim(),
  };
}

/**
 * Construct a default `WeatherData` object with required fields and
 * `fetched_at` set to the current time. Provider implementations spread
 * additional fields on top of the result.
 *
 * Mirrors the dataclass defaults in `weather/models.py`.
 */
export function makeWeatherData(
  partial: Partial<WeatherData> & {
    location: string;
    provider_name: string;
  },
): WeatherData {
  return {
    temperature: 0.0,
    condition: WeatherCondition.Unknown,
    condition_raw: "",
    fetched_at: new Date(),
    ...partial,
  };
}
