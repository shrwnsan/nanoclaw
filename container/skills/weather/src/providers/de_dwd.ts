/* eslint-disable @typescript-eslint/naming-convention */
/** German DWD provider via the Bright Sky API. */

import {
  BRIGHTSKY_CONDITION_MAP,
  DE_DWD_CITIES,
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

const BRIGHTSKY_BASE_URL = "https://api.brightsky.dev";
const SUPPORTED_LOCATIONS = new Set([
  ...Object.keys(DE_DWD_CITIES),
  "germany",
  "deutschland",
  "de",
  "德國",
]);

export class DWDProvider implements IWeatherProvider {
  readonly name = "dwd";
  readonly priority = 8;
  readonly supportsForecast = true;
  readonly supportsAirQuality = false;
  readonly requiresApiKey = false;

  supportsLocation(location: Location): boolean {
    return SUPPORTED_LOCATIONS.has(location.normalized.toLowerCase());
  }

  async getCurrent(location: Location): Promise<WeatherData> {
    if (!this.supportsLocation(location)) {
      throw new LocationNotSupportedError(
        `DWD only supports German locations: ${location.raw}`,
      );
    }

    try {
      const [lat, lon] = this.getCoordinates(location);
      const data = await this.fetchApi(`${BRIGHTSKY_BASE_URL}/current_weather`, {
        lat: lat.toFixed(4),
        lon: lon.toFixed(4),
      });
      return this.parseCurrent(location, data);
    } catch (e) {
      if (e instanceof LocationNotSupportedError) throw e;
      throw new ProviderError(`DWD/Bright Sky API error: ${(e as Error).message}`);
    }
  }

  async getForecast(location: Location, days: number = 7): Promise<WeatherData[]> {
    if (!this.supportsLocation(location)) {
      throw new LocationNotSupportedError(
        `DWD only supports German locations: ${location.raw}`,
      );
    }

    try {
      const [lat, lon] = this.getCoordinates(location);
      const today = new Date().toISOString().slice(0, 10);
      const end = new Date(new Date(today).getTime() + days * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const data = await this.fetchApi(`${BRIGHTSKY_BASE_URL}/weather`, {
        lat: lat.toFixed(4),
        lon: lon.toFixed(4),
        date: today,
        last_date: end,
      });
      return this.parseForecast(location, data, days);
    } catch (e) {
      if (e instanceof LocationNotSupportedError) throw e;
      throw new ProviderError(`DWD/Bright Sky API error: ${(e as Error).message}`);
    }
  }

  private getCoordinates(location: Location): [number, number] {
    const normalized = location.normalized.toLowerCase();
    if (DE_DWD_CITIES[normalized]) return DE_DWD_CITIES[normalized];

    for (const [city, coords] of Object.entries(DE_DWD_CITIES)) {
      if (city.includes(normalized) || normalized.includes(city)) return coords;
    }
    return DE_DWD_CITIES.berlin!;
  }

  private getDisplayName(location: Location): string {
    const normalized = location.normalized.toLowerCase();
    if (DE_DWD_CITIES[normalized]) return titleCase(normalized);
    return titleCase(location.raw);
  }

  private async fetchApi(
    baseUrl: string,
    params: Record<string, string>,
  ): Promise<Record<string, any>> {
    const url = `${baseUrl}?${new URLSearchParams(params).toString()}`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          "User-Agent": "WeatherSkill/1.0",
          Accept: "application/json",
        },
      });
    } catch (e) {
      throw new ProviderError((e as Error).message);
    }
    if (!res.ok) {
      throw new ProviderError(`HTTP ${res.status}`);
    }
    return (await res.json()) as Record<string, any>;
  }

  private parseCurrent(location: Location, data: Record<string, any>): WeatherData {
    const weather = data.weather as Record<string, any> | undefined;
    if (!weather) throw new ProviderError("No weather data from Bright Sky");

    const humidity = numberOrUndefined(weather.relative_humidity);
    const windDir = numberOrUndefined(weather.wind_direction_10);
    const visibility = numberOrUndefined(weather.visibility);
    const obs = typeof weather.timestamp === "string"
      ? new Date(weather.timestamp)
      : undefined;

    return makeWeatherData({
      location: this.getDisplayName(location),
      temperature: numberOrUndefined(weather.temperature) ?? 0,
      humidity: humidity == null ? undefined : Math.round(humidity),
      wind_speed: numberOrUndefined(weather.wind_speed_10),
      wind_direction: windDir == null ? undefined : degToCompass(windDir),
      condition: BRIGHTSKY_CONDITION_MAP[String(weather.icon ?? "")] ?? WeatherCondition.Unknown,
      pressure: numberOrUndefined(weather.pressure_msl),
      visibility: visibility == null ? undefined : visibility / 1000,
      observed_at: obs && !Number.isNaN(obs.getTime()) ? obs : undefined,
      provider_name: this.name,
    });
  }

  private parseForecast(
    location: Location,
    data: Record<string, any>,
    days: number,
  ): WeatherData[] {
    const displayName = this.getDisplayName(location);
    const weatherList = Array.isArray(data.weather) ? data.weather : [];
    const daily = new Map<string, {
      temps: number[];
      humidity: number[];
      precip: number;
      icons: string[];
    }>();

    for (const entry of weatherList as Record<string, any>[]) {
      if (typeof entry.timestamp !== "string") continue;
      const dt = new Date(entry.timestamp);
      if (Number.isNaN(dt.getTime())) continue;
      const key = dt.toISOString().slice(0, 10);
      const bucket = daily.get(key) ?? { temps: [], humidity: [], precip: 0, icons: [] };
      const temp = numberOrUndefined(entry.temperature);
      if (temp != null) bucket.temps.push(temp);
      const rh = numberOrUndefined(entry.relative_humidity);
      if (rh != null) bucket.humidity.push(rh);
      const precip = numberOrUndefined(entry.precipitation);
      if (precip != null) bucket.precip += precip;
      if (typeof entry.icon === "string" && entry.icon) bucket.icons.push(entry.icon);
      daily.set(key, bucket);
    }

    return [...daily.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(0, days).map(([date, bucket]) => {
      const tempLow = bucket.temps.length ? Math.min(...bucket.temps) : undefined;
      const tempHigh = bucket.temps.length ? Math.max(...bucket.temps) : undefined;
      const humidity = bucket.humidity.length
        ? Math.round(bucket.humidity.reduce((a, b) => a + b, 0) / bucket.humidity.length)
        : undefined;
      const precipitationChance = bucket.precip > 0
        ? Math.min(100, Math.trunc(bucket.precip * 20))
        : undefined;

      return makeWeatherData({
        location: displayName,
        temperature: tempLow ?? 0,
        temp_high: tempHigh,
        temp_low: tempLow,
        humidity,
        condition: pickDailyCondition(bucket.icons),
        precipitation_chance: precipitationChance,
        forecast_date: new Date(`${date}T00:00:00.000Z`),
        provider_name: this.name,
      });
    });
  }
}

function pickDailyCondition(icons: string[]): WeatherCondition {
  if (icons.length === 0) return WeatherCondition.Unknown;
  const severity: Record<string, number> = {
    thunderstorm: 10,
    hail: 9,
    snow: 8,
    sleet: 7,
    rain: 6,
    fog: 5,
    wind: 4,
    cloudy: 3,
    "partly-cloudy-day": 2,
    "partly-cloudy-night": 2,
    "clear-day": 1,
    "clear-night": 1,
    dry: 0,
  };
  const icon = icons.reduce((best, current) =>
    (severity[current] ?? 0) > (severity[best] ?? 0) ? current : best,
  );
  return BRIGHTSKY_CONDITION_MAP[icon] ?? WeatherCondition.Unknown;
}

function degToCompass(deg: number): string {
  const directions = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return directions[Math.round(deg / 22.5) % 16]!;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (c) => c.toUpperCase());
}
