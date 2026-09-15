/* eslint-disable @typescript-eslint/naming-convention */
/**
 * Singapore National Environment Agency (NEA) Weather Provider.
 *
 * Fetches weather data from data.gov.sg real-time weather APIs.
 * Free, no API key required. Singapore coverage only.
 *
 * Mirrors `weather/providers/sg_nea.py`.
 */

import { SG_CONDITION_MAP } from "../data-loader.js";
import { makeWeatherData } from "../models.js";
import type { IWeatherProvider, Location, WeatherData } from "../types.js";
import {
  LocationNotSupportedError,
  ProviderError,
  WeatherCondition,
} from "../types.js";

// data.gov.sg v2 real-time API endpoints (mirror sg_nea.py:21-27)
const SG_AIR_TEMP_URL = "https://api-open.data.gov.sg/v2/real-time/api/air-temperature";
const SG_HUMIDITY_URL = "https://api-open.data.gov.sg/v2/real-time/api/relative-humidity";
const SG_24HR_FORECAST_URL = "https://api-open.data.gov.sg/v2/real-time/api/twenty-four-hr-forecast";
const SG_4DAY_FORECAST_URL = "https://api-open.data.gov.sg/v2/real-time/api/four-day-outlook";
const SG_PSI_URL = "https://api-open.data.gov.sg/v2/real-time/api/psi";

// Common headers (mirror sg_nea.py:117-118)
const NEA_HEADERS: Record<string, string> = {
  "User-Agent": "WeatherSkill/1.0",
  "Accept": "application/json",
};

// Supported locations (mirror sg_nea.py:36-40)
const SUPPORTED_LOCATIONS: ReadonlySet<string> = new Set([
  "singapore", "sg", "sin", "新加坡",
  "changi", "orchard", "jurong", "woodlands",
  "sentosa", "marina bay", "tampines", "bedok",
]);

/** Average of finite numeric values; returns undefined if none. */
function avg(values: readonly (number | null | undefined)[]): number | undefined {
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) return undefined;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/**
 * Singapore NEA weather provider.
 *
 * - Free, no API key required
 * - Singapore coverage only
 * - Provides current weather and 4-day forecast
 * - Air quality via PSI
 */
export class SGNEAProvider implements IWeatherProvider {
  readonly name = "sg_nea";
  readonly priority = 2;
  readonly supportsForecast = true;
  readonly supportsAirQuality = true;
  readonly requiresApiKey = false;

  /** Check if location is in Singapore. */
  supportsLocation(location: Location): boolean {
    return SUPPORTED_LOCATIONS.has(location.normalized.toLowerCase());
  }

  /** Fetch current weather for Singapore. */
  async getCurrent(location: Location): Promise<WeatherData> {
    if (!this.supportsLocation(location)) {
      throw new LocationNotSupportedError(
        `NEA only supports Singapore locations: ${location.raw}`,
      );
    }

    try {
      // Fetch readings and 24h forecast in parallel. Mirrors
      // asyncio.gather(..., return_exceptions=True) — failed sub-requests
      // become `undefined` and downstream parsing handles missing data.
      const [tempData, humidityData, forecastData, psiData] = await Promise.all([
        this.fetchJsonSafe(SG_AIR_TEMP_URL),
        this.fetchJsonSafe(SG_HUMIDITY_URL),
        this.fetchJsonSafe(SG_24HR_FORECAST_URL),
        this.fetchJsonSafe(SG_PSI_URL),
      ]);

      return this.parseCurrent(tempData, humidityData, forecastData, psiData);
    } catch (e) {
      if (e instanceof LocationNotSupportedError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new ProviderError(`NEA API error: ${msg}`);
    }
  }

  /** Fetch weather forecast for Singapore. */
  async getForecast(location: Location, days: number = 4): Promise<WeatherData[]> {
    if (!this.supportsLocation(location)) {
      throw new LocationNotSupportedError(
        `NEA only supports Singapore locations: ${location.raw}`,
      );
    }

    try {
      const data = await this.fetchJson(SG_4DAY_FORECAST_URL);
      return this.parseForecast(data, days);
    } catch (e) {
      if (e instanceof LocationNotSupportedError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new ProviderError(`NEA API error: ${msg}`);
    }
  }

  /** Fetch JSON from data.gov.sg API; throws on HTTP error. */
  private async fetchJson(url: string): Promise<Record<string, any>> {
    const response = await fetch(url, { headers: NEA_HEADERS });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as Record<string, any>;
  }

  /** Like fetchJson but returns undefined on failure (parity with
   * Python's `return_exceptions=True` semantics). */
  private async fetchJsonSafe(url: string): Promise<Record<string, any> | undefined> {
    try {
      return await this.fetchJson(url);
    } catch {
      return undefined;
    }
  }

  /** Parse current weather from NEA responses. */
  private parseCurrent(
    tempData: Record<string, any> | undefined,
    humidityData: Record<string, any> | undefined,
    forecastData: Record<string, any> | undefined,
    psiData: Record<string, any> | undefined,
  ): WeatherData {
    // Temperature — average across stations
    let temp: number | undefined;
    if (tempData && typeof tempData === "object") {
      const readings: any[] = tempData.data?.readings ?? [];
      if (readings.length > 0) {
        const stations: any[] = readings[0].data ?? [];
        const values = stations.map((s) => s?.value);
        temp = avg(values);
      }
    }

    // Humidity — average across stations
    let humidity: number | undefined;
    if (humidityData && typeof humidityData === "object") {
      const readings: any[] = humidityData.data?.readings ?? [];
      if (readings.length > 0) {
        const stations: any[] = readings[0].data ?? [];
        const values = stations.map((s) => s?.value);
        const a = avg(values);
        humidity = a != null ? Math.round(a) : undefined;
      }
    }

    // 24h forecast for condition description and temp range
    let condition: WeatherCondition = WeatherCondition.Unknown;
    let description = "";
    let tempHigh: number | undefined;
    let tempLow: number | undefined;
    let windDescription: string | undefined;
    if (forecastData && typeof forecastData === "object") {
      const records: any[] = forecastData.data?.records ?? [];
      if (records.length > 0) {
        const record = records[0];
        const general: Record<string, any> = record.general ?? {};
        const forecastText: string = general.forecast ?? "";
        description = forecastText;
        condition = this.textToCondition(forecastText);

        const tempRange: Record<string, any> = general.temperature ?? {};
        if (tempRange.high != null) tempHigh = Number(tempRange.high);
        if (tempRange.low != null) tempLow = Number(tempRange.low);

        const humidityRange: Record<string, any> = general.relativeHumidity ?? {};
        if (humidity == null) {
          const hHigh = humidityRange.high;
          const hLow = humidityRange.low;
          if (hHigh && hLow) {
            humidity = Math.round((Number(hHigh) + Number(hLow)) / 2);
          }
        }

        const windInfo: Record<string, any> = general.wind ?? {};
        const windDir: string = windInfo.direction ?? "";
        const windLo = windInfo.speed?.low ?? "";
        const windHi = windInfo.speed?.high ?? "";
        if (windDir && windLo !== "" && windLo != null) {
          windDescription = `${windDir} ${windLo}-${windHi} km/h`;
        }
      }
    }

    // PSI for air quality
    let psiValue: number | undefined;
    if (psiData && typeof psiData === "object") {
      const readings: any[] = psiData.data?.readings ?? [];
      if (readings.length > 0) {
        const items: Record<string, any> = readings[0].data ?? {};
        const psi24h: Record<string, any> = items.psi_twenty_four_hourly ?? {};
        const v = psi24h.national ?? psi24h.central;
        if (v != null) psiValue = Number(v);
      }
    }

    const now = new Date();
    return makeWeatherData({
      location: "Singapore",
      temperature: temp ?? 0.0,
      ...(tempHigh != null ? { temp_high: tempHigh } : {}),
      ...(tempLow != null ? { temp_low: tempLow } : {}),
      ...(humidity != null ? { humidity } : {}),
      condition,
      condition_raw: description,
      ...(description ? { description } : {}),
      ...(windDescription ? { wind_description: windDescription } : {}),
      ...(psiValue != null ? { aqi: psiValue } : {}),
      observed_at: now,
      fetched_at: now,
      provider_name: this.name,
    });
  }

  /** Parse 4-day forecast from NEA response. */
  private parseForecast(data: Record<string, any>, days: number): WeatherData[] {
    const results: WeatherData[] = [];
    const records: any[] = data.data?.records ?? [];
    if (records.length === 0) return results;

    const forecasts: any[] = records[0].forecasts ?? [];
    for (const fc of forecasts.slice(0, days)) {
      // Parse date (ISO YYYY-MM-DD); fall back to today on parse failure.
      const dateStr: string = fc.date ?? "";
      let fcDate: Date;
      const parsed = new Date(dateStr);
      if (dateStr && !Number.isNaN(parsed.getTime())) {
        fcDate = parsed;
      } else {
        fcDate = new Date();
      }

      const forecastText: string = fc.forecast ?? "";
      const condition = this.textToCondition(forecastText);

      const tempRange: Record<string, any> = fc.temperature ?? {};
      const tempHigh = tempRange.high != null ? Number(tempRange.high) : undefined;
      const tempLow = tempRange.low != null ? Number(tempRange.low) : undefined;

      const humidityRange: Record<string, any> = fc.relativeHumidity ?? {};
      let humidity: number | undefined;
      if (humidityRange.high && humidityRange.low) {
        humidity = Math.round((Number(humidityRange.high) + Number(humidityRange.low)) / 2);
      }

      const windInfo: Record<string, any> = fc.wind ?? {};
      const windDir: string = windInfo.direction ?? "";
      const windLo = windInfo.speed?.low ?? "";
      const windHi = windInfo.speed?.high ?? "";
      const windDescription = windDir ? `${windDir} ${windLo}-${windHi} km/h` : undefined;

      results.push(
        makeWeatherData({
          location: "Singapore",
          temperature: tempLow ?? 0.0,
          ...(tempHigh != null ? { temp_high: tempHigh } : {}),
          ...(tempLow != null ? { temp_low: tempLow } : {}),
          ...(humidity != null ? { humidity } : {}),
          condition,
          condition_raw: forecastText,
          ...(forecastText ? { description: forecastText } : {}),
          ...(windDescription ? { wind_description: windDescription } : {}),
          forecast_date: fcDate,
          fetched_at: new Date(),
          provider_name: this.name,
        }),
      );
    }

    return results;
  }

  /** Map NEA forecast text to WeatherCondition. */
  private textToCondition(text: string): WeatherCondition {
    if (!text) return WeatherCondition.Unknown;
    const textLower = text.toLowerCase().trim();

    // Exact match first
    const exact = SG_CONDITION_MAP[textLower];
    if (exact) return exact;

    // Keyword fallbacks (mirror sg_nea.py:268-283)
    if (textLower.includes("thundery")) return WeatherCondition.Thunderstorm;
    if (textLower.includes("heavy rain") || textLower.includes("heavy shower")) {
      return WeatherCondition.HeavyRain;
    }
    if (textLower.includes("rain") || textLower.includes("shower")) {
      return WeatherCondition.Rain;
    }
    if (textLower.includes("drizzle") || textLower.includes("light rain")) {
      return WeatherCondition.Drizzle;
    }
    if (textLower.includes("cloudy")) return WeatherCondition.Cloudy;
    if (textLower.includes("haz")) return WeatherCondition.Mist;
    if (textLower.includes("fair") || textLower.includes("sunny")) {
      return WeatherCondition.Sunny;
    }
    if (textLower.includes("windy")) return WeatherCondition.Windy;

    return WeatherCondition.Unknown;
  }
}
