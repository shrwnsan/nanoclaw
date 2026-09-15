/* eslint-disable @typescript-eslint/naming-convention */
/**
 * Hong Kong Observatory (HKO) Weather Provider.
 *
 * Fetches weather data from HKO's JSON API.
 * Free, no API key required. Hong Kong coverage only.
 *
 * Mirrors `weather/providers/hko.py`.
 */

import { HKO_ICON_MAP } from "../data-loader.js";
import { makeWeatherData } from "../models.js";
import type { IWeatherProvider, Location, WeatherData } from "../types.js";
import {
  LocationNotSupportedError,
  ProviderError,
  WeatherCondition,
} from "../types.js";

// HKO JSON API endpoint
const HKO_API_URL = "https://www.hko.gov.hk/wxinfo/json/one_json.xml";

// Supported locations (mirror weather/providers/hko.py:30-34)
const SUPPORTED_LOCATIONS: ReadonlySet<string> = new Set([
  "hong kong", "hk", "香港",
  "kowloon", "kln", "九龍",
  "new territories", "nt", "新界",
]);

const PSR_MAP: Record<string, number> = {
  "low": 10,
  "medium low": 30,
  "medium": 50,
  "medium high": 70,
  "high": 90,
};

/**
 * Hong Kong Observatory weather provider.
 *
 * - Free, no API key required
 * - Hong Kong coverage only
 * - Provides current weather and 9-day forecast
 */
export class HKOProvider implements IWeatherProvider {
  readonly name = "hko";
  readonly priority = 1; // Highest priority for HK locations
  readonly supportsForecast = true;
  readonly supportsAirQuality = true; // HKO provides AQHI
  readonly requiresApiKey = false;

  /** Check if location is in Hong Kong. */
  supportsLocation(location: Location): boolean {
    return SUPPORTED_LOCATIONS.has(location.normalized.toLowerCase());
  }

  /** Fetch current weather for Hong Kong. */
  async getCurrent(location: Location): Promise<WeatherData> {
    if (!this.supportsLocation(location)) {
      throw new LocationNotSupportedError(
        `HKO only supports Hong Kong locations: ${location.raw}`,
      );
    }

    try {
      const data = await this.fetchApi();
      return this.parseCurrent(data);
    } catch (e) {
      if (e instanceof LocationNotSupportedError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new ProviderError(`HKO API error: ${msg}`);
    }
  }

  /** Fetch weather forecast for Hong Kong. */
  async getForecast(location: Location, days: number = 3): Promise<WeatherData[]> {
    if (!this.supportsLocation(location)) {
      throw new LocationNotSupportedError(
        `HKO only supports Hong Kong locations: ${location.raw}`,
      );
    }

    try {
      const data = await this.fetchApi();
      return this.parseForecast(data, days);
    } catch (e) {
      if (e instanceof LocationNotSupportedError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new ProviderError(`HKO API error: ${msg}`);
    }
  }

  /** Fetch data from HKO JSON API. */
  private async fetchApi(): Promise<Record<string, any>> {
    const response = await fetch(HKO_API_URL);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as Record<string, any>;
  }

  /** Parse current weather from HKO response. */
  private parseCurrent(data: Record<string, any>): WeatherData {
    // Current observations
    const current: Record<string, any> = data.RHRREAD ?? {};
    const hko: Record<string, any> = data.hko ?? {};
    const flw: Record<string, any> = data.FLW ?? {};

    // Temperature and humidity
    const tempStr = hko.Temperature ?? current.hkotemp;
    const temp = tempStr ? Number.parseFloat(String(tempStr)) : undefined;

    const rhStr = hko.RH ?? current.hkorh;
    const humidity = rhStr ? Number.parseInt(String(rhStr), 10) : undefined;

    // Get icon from forecast
    const iconData: Record<string, any> = data.fcartoon ?? {};
    const icon = iconData.Icon1 ?? "";
    const condition = this.iconToCondition(String(icon));

    // UV Index
    let uvIndex: number | undefined;
    const uvData: Record<string, any> = data.RHRREAD ?? {};
    if (uvData.UVIndex) {
      const uvNum = Number.parseFloat(String(uvData.UVIndex));
      if (Number.isFinite(uvNum)) {
        // HKO reports UV as fractional values (e.g. "0.4", "3.7"); preserve precision
        uvIndex = uvNum;
      }
    }

    // Get today's forecast from F9D for high/low temps and wind
    const f9d: Record<string, any> = data.F9D ?? {};
    const forecasts: Record<string, any>[] = f9d.WeatherForecast ?? [];
    const todayFc: Record<string, any> = forecasts[0] ?? {};

    const tempHigh = todayFc.ForecastMaxtemp
      ? Number.parseFloat(String(todayFc.ForecastMaxtemp))
      : undefined;
    const tempLow = todayFc.ForecastMintemp
      ? Number.parseFloat(String(todayFc.ForecastMintemp))
      : undefined;

    // Wind description from forecast
    const windDescription: string = todayFc.ForecastWind ?? "";

    // Rain probability from PSR
    const psr: string = todayFc.PSR ?? "";
    const precipChance = this.psrToPercent(psr);

    // Clean forecast description (strip HTML tags)
    const rawDesc: string = flw.ForecastDesc ?? "";
    const description = this.stripHtmlTags(rawDesc);

    // Bulletin time (format: YYYYMMDDHHmm)
    const bulletinTime: string = hko.BulletinTime ?? "";
    let observedAt: Date | undefined;
    if (bulletinTime && /^\d{12}$/.test(bulletinTime)) {
      const y = Number.parseInt(bulletinTime.slice(0, 4), 10);
      const mo = Number.parseInt(bulletinTime.slice(4, 6), 10);
      const d = Number.parseInt(bulletinTime.slice(6, 8), 10);
      const hh = Number.parseInt(bulletinTime.slice(8, 10), 10);
      const mm = Number.parseInt(bulletinTime.slice(10, 12), 10);
      observedAt = new Date(Date.UTC(y, mo - 1, d, hh, mm));
    }

    return makeWeatherData({
      location: "Hong Kong",
      temperature: temp ?? 0,
      ...(tempHigh != null ? { temp_high: tempHigh } : {}),
      ...(tempLow != null ? { temp_low: tempLow } : {}),
      ...(humidity != null ? { humidity } : {}),
      condition,
      condition_raw: rawDesc,
      ...(description ? { description } : {}),
      ...(windDescription ? { wind_description: windDescription } : {}),
      ...(precipChance != null ? { precipitation_chance: precipChance } : {}),
      ...(uvIndex != null ? { uv_index: uvIndex } : {}),
      ...(observedAt ? { observed_at: observedAt } : {}),
      fetched_at: new Date(),
      provider_name: this.name,
    });
  }

  /** Parse forecast from HKO response. */
  private parseForecast(data: Record<string, any>, days: number): WeatherData[] {
    const f9d: Record<string, any> = data.F9D ?? {};
    const forecasts: Record<string, any>[] = f9d.WeatherForecast ?? [];
    const results: WeatherData[] = [];

    for (const fc of forecasts.slice(0, days)) {
      // Parse date (format: YYYYMMDD)
      const dateStr: string = fc.ForecastDate ?? "";
      if (!/^\d{8}$/.test(dateStr)) continue;
      const y = Number.parseInt(dateStr.slice(0, 4), 10);
      const mo = Number.parseInt(dateStr.slice(4, 6), 10);
      const d = Number.parseInt(dateStr.slice(6, 8), 10);
      const fcDate = new Date(Date.UTC(y, mo - 1, d));

      // Parse temps
      const tempHigh = fc.ForecastMaxtemp
        ? Number.parseFloat(String(fc.ForecastMaxtemp))
        : undefined;
      const tempLow = fc.ForecastMintemp
        ? Number.parseFloat(String(fc.ForecastMintemp))
        : undefined;

      // Parse condition
      const icon = fc.ForecastIcon ?? "";
      const condition = this.iconToCondition(String(icon));

      // Parse rain probability
      const psr: string = fc.PSR ?? "";
      const precipChance = this.psrToPercent(psr);

      results.push(
        makeWeatherData({
          location: "Hong Kong",
          temperature: tempLow ?? 0,
          ...(tempHigh != null ? { temp_high: tempHigh } : {}),
          ...(tempLow != null ? { temp_low: tempLow } : {}),
          forecast_date: fcDate,
          condition,
          condition_raw: fc.IconDesc ?? "",
          ...(fc.ForecastWeather ? { description: fc.ForecastWeather } : {}),
          ...(precipChance != null ? { precipitation_chance: precipChance } : {}),
          fetched_at: new Date(),
          provider_name: this.name,
        }),
      );
    }

    return results;
  }

  /** Map HKO icon filename to WeatherCondition. */
  private iconToCondition(icon: string): WeatherCondition {
    // Handle both "pic54.png" and "54" formats
    const iconName = icon.includes("pic") ? icon : `pic${icon}.png`;
    return HKO_ICON_MAP[iconName] ?? WeatherCondition.Unknown;
  }

  /** Map PSR (Probability of Significant Rain) to percentage. */
  private psrToPercent(psr: string): number | undefined {
    return PSR_MAP[psr.toLowerCase()];
  }

  /** Remove HTML tags from text. */
  private stripHtmlTags(text: string): string {
    if (!text) return "";
    return text.replace(/<[^>]+>/g, "").trim();
  }
}
