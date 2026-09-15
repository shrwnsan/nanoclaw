/* eslint-disable @typescript-eslint/naming-convention */
/**
 * Japan Meteorological Agency (JMA) Weather Provider.
 *
 * Fetches weather data from JMA's public JSON endpoints.
 * Free, no API key required. Japan coverage only.
 *
 * Note: These are not official APIs — they are JSON endpoints used by
 * JMA's website, publicly accessible under Japan's government standard
 * license. Spec may change without notice.
 *
 * Endpoints:
 *   Forecast:  https://www.jma.go.jp/bosai/forecast/data/forecast/{areaCode}.json
 *   Overview:  https://www.jma.go.jp/bosai/forecast/data/overview_forecast/{areaCode}.json
 *
 * Mirrors `weather/providers/jma.py`.
 */

import { JMA_AREA_CODES, JMA_WEATHER_CODE_MAP } from "../data-loader.js";
import { makeWeatherData } from "../models.js";
import type { IWeatherProvider, Location, WeatherData } from "../types.js";
import {
  LocationNotSupportedError,
  ProviderError,
  WeatherCondition,
} from "../types.js";

const FORECAST_URL = (areaCode: string): string =>
  `https://www.jma.go.jp/bosai/forecast/data/forecast/${areaCode}.json`;

const OVERVIEW_URL = (areaCode: string): string =>
  `https://www.jma.go.jp/bosai/forecast/data/overview_forecast/${areaCode}.json`;

// JMA may reject requests without a User-Agent. Matches `jma.py:133`.
const USER_AGENT = "WeatherSkill/1.0";

/**
 * Japanese-locale names accepted by `supportsLocation` even though
 * they are not first-class keys in `JMA_AREA_CODES`. The area-code
 * resolver (`getAreaCode`) falls back to Tokyo (`130000`) for these
 * inputs, matching Python's `SUPPORTED_LOCATIONS` set in
 * `weather/providers/jma.py`.
 */
const SUPPORTED_LOCALE_NAMES: ReadonlySet<string> = new Set([
  "日本",
  "東京",
  "大阪",
  "横浜",
  "京都",
  "名古屋",
  "札幌",
  "福岡",
  "広島",
  "仙台",
  "那覇",
]);

/**
 * Japan Meteorological Agency weather provider.
 *
 * - Free, no API key required
 * - Japan coverage only
 * - Provides current weather overview and 7-day forecast
 */
export class JMAProvider implements IWeatherProvider {
  readonly name = "jma";
  readonly priority = 3;
  readonly supportsForecast = true;
  readonly supportsAirQuality = false;
  readonly requiresApiKey = false;

  /** Check if location is in Japan. */
  supportsLocation(location: Location): boolean {
    const normalized = location.normalized.toLowerCase();
    return normalized in JMA_AREA_CODES || SUPPORTED_LOCALE_NAMES.has(normalized);
  }

  /** Fetch current weather for Japanese location. */
  async getCurrent(location: Location): Promise<WeatherData> {
    if (!this.supportsLocation(location)) {
      throw new LocationNotSupportedError(
        `JMA only supports Japanese locations: ${location.raw}`,
      );
    }

    try {
      const areaCode = this.getAreaCode(location);
      const [forecastData, overviewData] = await Promise.all([
        this.fetchApi<unknown[]>(FORECAST_URL(areaCode)),
        this.fetchApi<Record<string, any>>(OVERVIEW_URL(areaCode)),
      ]);
      return this.parseCurrent(location, forecastData, overviewData);
    } catch (e) {
      if (e instanceof LocationNotSupportedError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new ProviderError(`JMA API error: ${msg}`);
    }
  }

  /** Fetch weather forecast for Japanese location. */
  async getForecast(location: Location, days: number = 7): Promise<WeatherData[]> {
    if (!this.supportsLocation(location)) {
      throw new LocationNotSupportedError(
        `JMA only supports Japanese locations: ${location.raw}`,
      );
    }

    try {
      const areaCode = this.getAreaCode(location);
      const forecastData = await this.fetchApi<unknown[]>(FORECAST_URL(areaCode));
      return this.parseForecast(location, forecastData, days);
    } catch (e) {
      if (e instanceof LocationNotSupportedError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new ProviderError(`JMA API error: ${msg}`);
    }
  }

  /** Resolve location to JMA area code. */
  private getAreaCode(location: Location): string {
    const normalized = location.normalized.toLowerCase();

    // Direct match
    const direct = JMA_AREA_CODES[normalized];
    if (direct !== undefined) return direct;

    // Partial match
    for (const [city, code] of Object.entries(JMA_AREA_CODES)) {
      if (city.includes(normalized) || normalized.includes(city)) {
        return code;
      }
    }

    // Default to Tokyo
    return "130000";
  }

  /** Fetch JSON from JMA endpoint. */
  private async fetchApi<T>(url: string): Promise<T> {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as T;
  }

  /** Get display name for location. */
  private getDisplayName(location: Location): string {
    const normalized = location.normalized.toLowerCase();
    for (const city of Object.keys(JMA_AREA_CODES)) {
      if (city === normalized) {
        return titleCase(city);
      }
    }
    return titleCase(location.raw);
  }

  /** Parse current weather from JMA forecast + overview. */
  private parseCurrent(
    location: Location,
    forecastData: unknown[],
    overviewData: Record<string, any>,
  ): WeatherData {
    const displayName = this.getDisplayName(location);

    // Overview text description
    let description: string = (overviewData.text as string) ?? "";
    description = description.replace(/\s+/g, " ").trim();
    if (description.length > 200) {
      description = description.slice(0, 197) + "...";
    }

    let condition: WeatherCondition = WeatherCondition.Unknown;
    let tempHigh: number | undefined;
    let tempLow: number | undefined;
    let precipChance: number | undefined;

    // First element of forecastData is short-term (today/tomorrow)
    if (forecastData.length > 0) {
      const shortTerm = forecastData[0] as Record<string, any>;
      const timeSeries: Record<string, any>[] = shortTerm.timeSeries ?? [];

      // First timeSeries: weather codes
      if (timeSeries.length > 0) {
        const ts0 = timeSeries[0] as Record<string, any>;
        const areas: Record<string, any>[] = ts0.areas ?? [];
        if (areas.length > 0) {
          const codes: string[] = (areas[0] as Record<string, any>).weatherCodes ?? [];
          if (codes.length > 0) {
            condition = this.codeToCondition(codes[0] as string);
          }
        }
      }

      // Second timeSeries: precipitation probability (pops)
      if (timeSeries.length > 1) {
        const ts1 = timeSeries[1] as Record<string, any>;
        const areas: Record<string, any>[] = ts1.areas ?? [];
        if (areas.length > 0) {
          const pops: unknown[] = (areas[0] as Record<string, any>).pops ?? [];
          const popNums: number[] = [];
          for (const p of pops) {
            const n = Number.parseInt(String(p), 10);
            if (Number.isFinite(n)) popNums.push(n);
          }
          if (popNums.length > 0) {
            precipChance = Math.max(...popNums);
          }
        }
      }

      // Third timeSeries: temperatures (temps)
      if (timeSeries.length > 2) {
        const ts2 = timeSeries[2] as Record<string, any>;
        const areas: Record<string, any>[] = ts2.areas ?? [];
        if (areas.length > 0) {
          const temps: unknown[] = (areas[0] as Record<string, any>).temps ?? [];
          const tempNums: number[] = [];
          for (const t of temps) {
            const n = Number.parseFloat(String(t));
            if (Number.isFinite(n)) tempNums.push(n);
          }
          if (tempNums.length >= 2) {
            tempLow = Math.min(...tempNums);
            tempHigh = Math.max(...tempNums);
          }
        }
      }
    }

    // Use midpoint of high/low as current temp estimate
    let temp: number | undefined;
    if (tempHigh != null && tempLow != null) {
      temp = (tempHigh + tempLow) / 2;
    } else if (tempHigh != null) {
      temp = tempHigh;
    } else if (tempLow != null) {
      temp = tempLow;
    }

    return makeWeatherData({
      location: displayName,
      temperature: temp ?? 0.0,
      ...(tempHigh != null ? { temp_high: tempHigh } : {}),
      ...(tempLow != null ? { temp_low: tempLow } : {}),
      condition,
      ...(description ? { description } : {}),
      ...(precipChance != null ? { precipitation_chance: precipChance } : {}),
      observed_at: new Date(),
      fetched_at: new Date(),
      provider_name: this.name,
    });
  }

  /** Parse multi-day forecast from JMA response. */
  private parseForecast(
    location: Location,
    forecastData: unknown[],
    days: number,
  ): WeatherData[] {
    const displayName = this.getDisplayName(location);
    const results: WeatherData[] = [];

    // Second element of forecastData is the weekly forecast
    if (forecastData.length < 2) return results;

    const weekly = forecastData[1] as Record<string, any>;
    const timeSeries: Record<string, any>[] = weekly.timeSeries ?? [];
    if (timeSeries.length === 0) return results;

    // First timeSeries: weather codes and pops
    const ts0 = timeSeries[0] as Record<string, any>;
    const timeDefines: string[] = ts0.timeDefines ?? [];
    const areas: Record<string, any>[] = ts0.areas ?? [];
    if (areas.length === 0) return results;

    const area = areas[0] as Record<string, any>;
    const weatherCodes: string[] = area.weatherCodes ?? [];
    const pops: unknown[] = area.pops ?? [];

    // Second timeSeries: temps (min/max)
    let tempsMin: unknown[] = [];
    let tempsMax: unknown[] = [];
    if (timeSeries.length > 1) {
      const ts1 = timeSeries[1] as Record<string, any>;
      const tempAreas: Record<string, any>[] = ts1.areas ?? [];
      if (tempAreas.length > 0) {
        const a0 = tempAreas[0] as Record<string, any>;
        tempsMin = a0.tempsMin ?? [];
        tempsMax = a0.tempsMax ?? [];
      }
    }

    const limit = Math.min(timeDefines.length, days);
    for (let i = 0; i < limit; i++) {
      const td = timeDefines[i] as string;

      // Parse date (ISO-8601 with TZ offset, e.g. "2026-01-01T00:00:00+09:00")
      const fcDate = new Date(td);
      if (Number.isNaN(fcDate.getTime())) continue;

      const code = i < weatherCodes.length ? (weatherCodes[i] as string) : "";
      const condition = this.codeToCondition(code);

      let pop: number | undefined;
      if (i < pops.length) {
        const n = Number.parseInt(String(pops[i]), 10);
        if (Number.isFinite(n)) pop = n;
      }

      let tMin: number | undefined;
      let tMax: number | undefined;
      if (i < tempsMin.length) {
        const n = Number.parseFloat(String(tempsMin[i]));
        if (Number.isFinite(n)) tMin = n;
      }
      if (i < tempsMax.length) {
        const n = Number.parseFloat(String(tempsMax[i]));
        if (Number.isFinite(n)) tMax = n;
      }

      results.push(
        makeWeatherData({
          location: displayName,
          temperature: tMin ?? 0.0,
          ...(tMax != null ? { temp_high: tMax } : {}),
          ...(tMin != null ? { temp_low: tMin } : {}),
          condition,
          ...(pop != null ? { precipitation_chance: pop } : {}),
          forecast_date: fcDate,
          fetched_at: new Date(),
          provider_name: this.name,
        }),
      );
    }

    return results;
  }

  /** Map JMA 3-digit weather code to WeatherCondition. */
  private codeToCondition(code: string): WeatherCondition {
    return JMA_WEATHER_CODE_MAP[code] ?? WeatherCondition.Unknown;
  }
}

/** Title-case helper (mirrors Python `str.title()` for our use). */
function titleCase(s: string): string {
  return s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}
