/* eslint-disable @typescript-eslint/naming-convention */
/**
 * Open-Meteo provider — zero-config global fallback.
 *
 * Free, no API key. Endpoint: api.open-meteo.com/v1/forecast
 * Requires lat/lon; resolves from the merged city lookup tables.
 * Priority 11 — lowest in the chain, activates when every higher-priority
 * provider has declined or failed.
 */

import {
  CN_CITIES,
  DE_DWD_CITIES,
  METOFFICE_CITIES,
  US_NWS_CITIES,
  WMO_CODE_MAP,
} from "../data-loader.js";
import { makeWeatherData } from "../models.js";
import {
  type IWeatherProvider,
  type Location,
  LocationNotSupportedError,
  ProviderError,
  WeatherCondition,
  type WeatherData,
} from "../types.js";

const BASE_URL = "https://api.open-meteo.com/v1/forecast";

const CURRENT_PARAMS =
  "temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,apparent_temperature";
const DAILY_PARAMS =
  "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset";
const HAS_TIMEZONE_SUFFIX = /(?:Z|[+-]\d{2}:?\d{2})$/;

export class OpenMeteoProvider implements IWeatherProvider {
  readonly name = "open-meteo";
  readonly priority = 11;
  readonly supportsForecast = true;
  readonly requiresApiKey = false;

  supportsLocation(location: Location): boolean {
    return this.resolveCoords(location) !== null;
  }

  async getCurrent(location: Location): Promise<WeatherData> {
    const coords = this.resolveCoords(location);
    if (!coords) {
      throw new LocationNotSupportedError(
        `Open-Meteo: cannot resolve coordinates for: ${location.raw}`,
      );
    }
    const [lat, lon] = coords;
    const url = this.buildUrl(lat, lon, {
      current: CURRENT_PARAMS,
      daily: DAILY_PARAMS,
      forecast_days: "1",
      timezone: "UTC",
    });
    const data = await this.fetchJson(url);
    return this.parseCurrent(location, data);
  }

  async getForecast(location: Location, days: number = 7): Promise<WeatherData[]> {
    const coords = this.resolveCoords(location);
    if (!coords) {
      throw new LocationNotSupportedError(
        `Open-Meteo: cannot resolve coordinates for: ${location.raw}`,
      );
    }
    const [lat, lon] = coords;
    const url = this.buildUrl(lat, lon, {
      daily: DAILY_PARAMS,
      forecast_days: String(Math.min(days, 16)),
      timezone: "UTC",
    });
    const data = await this.fetchJson(url);
    return this.parseForecast(location, data, days);
  }

  // ── Private helpers ───────────────────────────────────────────────

  private resolveCoords(location: Location): [number, number] | null {
    if (location.latitude != null && location.longitude != null) {
      return [location.latitude, location.longitude];
    }
    const n = location.normalized;
    return (
      CN_CITIES[n] ??
      US_NWS_CITIES[n] ??
      DE_DWD_CITIES[n] ??
      METOFFICE_CITIES[n] ??
      null
    );
  }

  private buildUrl(
    lat: number,
    lon: number,
    extra: Record<string, string>,
  ): string {
    const params = new URLSearchParams({
      latitude: lat.toFixed(4),
      longitude: lon.toFixed(4),
      ...extra,
    });
    return `${BASE_URL}?${params.toString()}`;
  }

  private async fetchJson(url: string): Promise<Record<string, any>> {
    let res: Response;
    try {
      res = await fetch(url);
    } catch (e) {
      throw new ProviderError(
        `Open-Meteo request failed: ${(e as Error).message}`,
      );
    }
    if (!res.ok) {
      throw new ProviderError(`Open-Meteo API error: HTTP ${res.status}`);
    }
    return (await res.json()) as Record<string, any>;
  }

  private parseCurrent(
    location: Location,
    data: Record<string, any>,
  ): WeatherData {
    const current = (data.current ?? {}) as Record<string, any>;
    const daily = (data.daily ?? {}) as Record<string, any>;

    const wmoCode = current.weather_code ?? 0;
    const condition = WMO_CODE_MAP[String(wmoCode)] ?? WeatherCondition.Unknown;

    const tempHigh =
      Array.isArray(daily.temperature_2m_max) &&
      typeof daily.temperature_2m_max[0] === "number"
        ? daily.temperature_2m_max[0]
        : undefined;
    const tempLow =
      Array.isArray(daily.temperature_2m_min) &&
      typeof daily.temperature_2m_min[0] === "number"
        ? daily.temperature_2m_min[0]
        : undefined;

    const windSpeedKmh =
      typeof current.wind_speed_10m === "number"
        ? current.wind_speed_10m
        : undefined;

    const precipChance =
      Array.isArray(daily.precipitation_probability_max) &&
      typeof daily.precipitation_probability_max[0] === "number"
        ? daily.precipitation_probability_max[0]
        : undefined;

    const sunrise =
      Array.isArray(daily.sunrise) && typeof daily.sunrise[0] === "string"
        ? daily.sunrise[0]
        : undefined;
    const sunset =
      Array.isArray(daily.sunset) && typeof daily.sunset[0] === "string"
        ? daily.sunset[0]
        : undefined;

    return makeWeatherData({
      location: titleCase(location.normalized),
      temperature:
        typeof current.temperature_2m === "number"
          ? current.temperature_2m
          : 0,
      condition,
      condition_raw: `wmo:${wmoCode}`,
      provider_name: this.name,
      observed_at: this.parseObservedAt(current.time),
      latitude: typeof data.latitude === "number" ? data.latitude : undefined,
      longitude:
        typeof data.longitude === "number" ? data.longitude : undefined,
      ...(typeof current.relative_humidity_2m === "number"
        ? { humidity: current.relative_humidity_2m }
        : {}),
      ...(typeof current.apparent_temperature === "number"
        ? { feels_like: current.apparent_temperature }
        : {}),
      ...(windSpeedKmh != null ? { wind_speed: windSpeedKmh } : {}),
      ...(tempHigh != null ? { temp_high: tempHigh } : {}),
      ...(tempLow != null ? { temp_low: tempLow } : {}),
      ...(precipChance != null ? { precipitation_chance: precipChance } : {}),
      ...(sunrise ? { sunrise } : {}),
      ...(sunset ? { sunset } : {}),
    });
  }

  private parseForecast(
    location: Location,
    data: Record<string, any>,
    days: number,
  ): WeatherData[] {
    const daily = (data.daily ?? {}) as Record<string, any>;
    const times: string[] = Array.isArray(daily.time) ? daily.time : [];
    const wmoCodes: number[] = Array.isArray(daily.weather_code)
      ? daily.weather_code
      : [];
    const maxTemps: number[] = Array.isArray(daily.temperature_2m_max)
      ? daily.temperature_2m_max
      : [];
    const minTemps: number[] = Array.isArray(daily.temperature_2m_min)
      ? daily.temperature_2m_min
      : [];
    const precipChances: number[] = Array.isArray(
      daily.precipitation_probability_max,
    )
      ? daily.precipitation_probability_max
      : [];
    const sunrises: string[] = Array.isArray(daily.sunrise)
      ? daily.sunrise
      : [];
    const sunsets: string[] = Array.isArray(daily.sunset) ? daily.sunset : [];

    const locationName = titleCase(location.normalized);

    return times.slice(0, days).map((dateStr, i) => {
      const wmoCode = wmoCodes[i] ?? 0;
      const condition =
        WMO_CODE_MAP[String(wmoCode)] ?? WeatherCondition.Unknown;

      return makeWeatherData({
        location: locationName,
        temperature: 0,
        condition,
        condition_raw: `wmo:${wmoCode}`,
        provider_name: this.name,
        forecast_date: new Date(`${dateStr}T00:00:00.000Z`),
        ...(typeof maxTemps[i] === "number" ? { temp_high: maxTemps[i] } : {}),
        ...(typeof minTemps[i] === "number" ? { temp_low: minTemps[i] } : {}),
        ...(typeof precipChances[i] === "number"
          ? { precipitation_chance: precipChances[i] }
          : {}),
        ...(typeof sunrises[i] === "string" ? { sunrise: sunrises[i] } : {}),
        ...(typeof sunsets[i] === "string" ? { sunset: sunsets[i] } : {}),
      });
    });
  }

  private parseObservedAt(rawTime: unknown): Date {
    if (typeof rawTime !== "string") return new Date();
    const iso = HAS_TIMEZONE_SUFFIX.test(rawTime) ? rawTime : `${rawTime}Z`;
    const parsed = new Date(iso);
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function titleCase(s: string): string {
  return s
    .split(/[\s_-]+/)
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}
