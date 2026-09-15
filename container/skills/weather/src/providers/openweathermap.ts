/* eslint-disable @typescript-eslint/naming-convention */
/**
 * OpenWeatherMap provider — global fallback.
 *
 * Port of `weather/providers/openweathermap.py`. Free tier: 1000
 * calls/day. The `q={city}` query parameter accepts free-form location
 * names so no separate geocoding step is needed.
 *
 * NOTE: For parity with the Python implementation, `wind_speed` is
 * stored as m/s (the raw OWM value), even though the field comment
 * says km/h. `wind_description` is the user-facing km/h string. Do not
 * "fix" this without coordinating a Python change.
 */

import { OWM_CONDITION_MAP } from "../data-loader.js";
import { makeWeatherData } from "../models.js";
import {
  type IWeatherProvider,
  type Location,
  LocationNotSupportedError,
  ProviderError,
  WeatherCondition,
  type WeatherData,
} from "../types.js";

const BASE_URL = "https://api.openweathermap.org/data/2.5";
const AIR_POLLUTION_URL =
  "https://api.openweathermap.org/data/2.5/air_pollution";

interface AirQualityResult {
  aqi?: number;
  pm25?: number;
  pm10?: number;
  o3?: number;
  no2?: number;
  co?: number;
  so2?: number;
}

export class OpenWeatherMapProvider implements IWeatherProvider {
  readonly name = "openweathermap";
  readonly priority = 10; // Fallback priority
  readonly supportsForecast = true;
  readonly supportsAirQuality = true;
  readonly requiresApiKey = true;

  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /** OpenWeatherMap supports all global locations. */
  supportsLocation(_location: Location): boolean {
    return true;
  }

  async getCurrent(location: Location): Promise<WeatherData> {
    const url = this.buildUrl("weather", {
      q: location.normalized,
      appid: this.apiKey,
      units: "metric",
    });

    const data = await this.fetchJson(url, location);

    // Optionally fetch today's forecast for high/low temps.
    let todayHigh: number | undefined;
    let todayLow: number | undefined;
    try {
      const forecastUrl = this.buildUrl("forecast", {
        q: location.normalized,
        appid: this.apiKey,
        units: "metric",
        cnt: "8", // Next 24 hours (3-hour intervals)
      });
      const forecastData = await this.fetchJson(forecastUrl, location);

      const today = new Date().toISOString().slice(0, 10); // UTC date
      const temps: number[] = [];
      for (const item of forecastData.list ?? []) {
        const dt = new Date((item.dt ?? 0) * 1000);
        const itemDate = dt.toISOString().slice(0, 10);
        if (itemDate === today) {
          const t = item.main?.temp;
          if (typeof t === "number" && Number.isFinite(t)) temps.push(t);
        }
      }
      if (temps.length > 0) {
        todayHigh = Math.max(...temps);
        todayLow = Math.min(...temps);
      }
    } catch {
      // High/low are optional enhancements.
    }

    return this.parseCurrent(data, todayHigh, todayLow);
  }

  /** Fetch current weather and merge in air-quality data. */
  async getCurrentWithAirQuality(location: Location): Promise<WeatherData> {
    const weatherData = await this.getCurrent(location);
    const { latitude: lat, longitude: lon } = weatherData;
    if (lat == null || lon == null) return weatherData;

    try {
      const aq = await this.getAirQuality(lat, lon);
      const merged: WeatherData = { ...weatherData };
      if (aq.aqi != null) merged.aqi = aq.aqi;
      if (aq.pm25 != null) merged.pm25 = aq.pm25;
      if (aq.pm10 != null) merged.pm10 = aq.pm10;
      if (aq.o3 != null) merged.o3 = aq.o3;
      if (aq.no2 != null) merged.no2 = aq.no2;
      return merged;
    } catch {
      return weatherData; // Air quality is optional.
    }
  }

  async getForecast(
    location: Location,
    days: number = 3,
  ): Promise<WeatherData[]> {
    // 5-day forecast is 3-hour intervals (40 readings max).
    const cnt = Math.min(days * 8, 40);
    const url = this.buildUrl("forecast", {
      q: location.normalized,
      appid: this.apiKey,
      units: "metric",
      cnt: String(cnt),
    });

    const data = await this.fetchJson(url, location);
    return this.parseForecast(data, days);
  }

  // ── HTTP helpers ─────────────────────────────────────────────────

  private buildUrl(path: string, params: Record<string, string>): string {
    const qs = new URLSearchParams(params).toString();
    return `${BASE_URL}/${path}?${qs}`;
  }

  private async fetchJson(
    url: string,
    location: Location,
  ): Promise<Record<string, any>> {
    let res: Response;
    try {
      res = await fetch(url);
    } catch (e) {
      throw new ProviderError(
        `OpenWeatherMap request failed: ${(e as Error).message}`,
      );
    }
    if (!res.ok) {
      if (res.status === 401) {
        throw new ProviderError("OpenWeatherMap API key is invalid");
      }
      if (res.status === 404) {
        throw new ProviderError(`Location not found: ${location.raw}`);
      }
      throw new ProviderError(
        `OpenWeatherMap API error: HTTP ${res.status}`,
      );
    }
    return (await res.json()) as Record<string, any>;
  }

  // ── Parsers ──────────────────────────────────────────────────────

  private parseCurrent(
    data: Record<string, any>,
    todayHigh?: number,
    todayLow?: number,
  ): WeatherData {
    const weather = (data.weather ?? [{}])[0] as Record<string, any>;
    const main = (data.main ?? {}) as Record<string, any>;
    const wind = (data.wind ?? {}) as Record<string, any>;
    const clouds = (data.clouds ?? {}) as Record<string, any>;
    const coords = (data.coord ?? {}) as Record<string, any>;

    const conditionCode = weather.id ?? 800;
    const condition =
      OWM_CONDITION_MAP[String(conditionCode)] ?? WeatherCondition.Unknown;

    // Wind direction
    const windDeg = typeof wind.deg === "number" ? wind.deg : undefined;
    const windDirection =
      windDeg != null ? this.degToDirection(windDeg) : undefined;

    // Format wind description (e.g. "12 km/h NE"). Python: f"{kmh:.0f}".
    let windDescription: string | undefined;
    if (typeof wind.speed === "number" && wind.speed) {
      const kmh = wind.speed * 3.6;
      const kmhRounded = Math.round(kmh).toString();
      windDescription = windDirection
        ? `${kmhRounded} km/h ${windDirection}`
        : `${kmhRounded} km/h`;
    }

    // Rain probability ≈ cloud cover (rough estimate, matches Python).
    let rainProbability: number | undefined;
    if (typeof clouds.all === "number") {
      rainProbability = Math.min(100, clouds.all);
    }

    // Capitalize description (Python: str.capitalize()).
    const rawDesc = (weather.description ?? "") as string;
    const description = rawDesc
      ? rawDesc.charAt(0).toUpperCase() + rawDesc.slice(1).toLowerCase()
      : undefined;

    // Temperature: Python's `main.get("temp")` may return None; in TS
    // we default to 0 to match the dataclass default.
    const temperature = typeof main.temp === "number" ? main.temp : 0;

    return makeWeatherData({
      location: (data.name ?? "Unknown") as string,
      temperature,
      condition,
      condition_raw: rawDesc,
      provider_name: this.name,
      observed_at: new Date(),
      ...(typeof coords.lat === "number" ? { latitude: coords.lat } : {}),
      ...(typeof coords.lon === "number" ? { longitude: coords.lon } : {}),
      ...(typeof main.feels_like === "number"
        ? { feels_like: main.feels_like }
        : {}),
      ...(todayHigh != null ? { temp_high: todayHigh } : {}),
      ...(todayLow != null ? { temp_low: todayLow } : {}),
      ...(typeof main.humidity === "number"
        ? { humidity: main.humidity }
        : {}),
      ...(typeof main.pressure === "number"
        ? { pressure: main.pressure }
        : {}),
      // For parity with Python: wind_speed stores m/s (raw OWM value),
      // not km/h. The user-facing km/h string is in wind_description.
      ...(typeof wind.speed === "number" ? { wind_speed: wind.speed } : {}),
      ...(windDirection ? { wind_direction: windDirection } : {}),
      ...(windDescription ? { wind_description: windDescription } : {}),
      ...(description ? { description } : {}),
      ...(rainProbability != null
        ? { precipitation_chance: rainProbability }
        : {}),
    });
  }

  private parseForecast(
    data: Record<string, any>,
    days: number,
  ): WeatherData[] {
    const locationName = (data.city?.name ?? "Unknown") as string;

    interface DailyBucket {
      temps: number[];
      humidity: number[];
      conditions: number[];
      descriptions: string[];
      rainProb: number[];
      date: Date;
    }

    const dailyData = new Map<string, DailyBucket>();

    for (const item of (data.list ?? []) as Array<Record<string, any>>) {
      const dt = new Date((item.dt ?? 0) * 1000);
      const dateKey = dt.toISOString().slice(0, 10); // UTC date

      let bucket = dailyData.get(dateKey);
      if (!bucket) {
        const [y, m, d] = dateKey.split("-").map(Number);
        bucket = {
          temps: [],
          humidity: [],
          conditions: [],
          descriptions: [],
          rainProb: [],
          date: new Date(Date.UTC(y!, m! - 1, d!)),
        };
        dailyData.set(dateKey, bucket);
      }

      const main = (item.main ?? {}) as Record<string, any>;
      const weather = (item.weather ?? [{}])[0] as Record<string, any>;
      const pop = ((item.pop ?? 0) as number) * 100;

      if (typeof main.temp === "number") bucket.temps.push(main.temp);
      if (typeof main.humidity === "number") bucket.humidity.push(main.humidity);
      bucket.conditions.push((weather.id ?? 800) as number);
      if (typeof weather.description === "string") {
        bucket.descriptions.push(weather.description);
      }
      bucket.rainProb.push(pop);
    }

    // Sort by date and take the first `days` entries.
    const sorted = [...dailyData.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, days);

    const forecasts: WeatherData[] = [];
    for (const [, d] of sorted) {
      const conditionCode = mostCommon(d.conditions) ?? 800;
      const condition =
        OWM_CONDITION_MAP[String(conditionCode)] ?? WeatherCondition.Unknown;
      const description = mostCommon(d.descriptions);

      forecasts.push(
        makeWeatherData({
          location: locationName,
          temperature: 0, // Forecast entries don't have a single "current" temp.
          condition,
          provider_name: this.name,
          forecast_date: d.date,
          ...(d.temps.length > 0
            ? { temp_high: Math.max(...d.temps), temp_low: Math.min(...d.temps) }
            : {}),
          ...(d.humidity.length > 0
            ? {
                humidity: Math.round(
                  d.humidity.reduce((a, b) => a + b, 0) / d.humidity.length,
                ),
              }
            : {}),
          ...(description ? { description } : {}),
          ...(d.rainProb.length > 0
            ? { precipitation_chance: Math.round(Math.max(...d.rainProb)) }
            : {}),
        }),
      );
    }

    return forecasts;
  }

  // ── Air quality (separate endpoint) ──────────────────────────────

  async getAirQuality(
    latitude: number,
    longitude: number,
  ): Promise<AirQualityResult> {
    const url = `${AIR_POLLUTION_URL}?lat=${latitude}&lon=${longitude}&appid=${encodeURIComponent(this.apiKey)}`;

    let res: Response;
    try {
      res = await fetch(url);
    } catch (e) {
      throw new ProviderError(
        `Air quality request failed: ${(e as Error).message}`,
      );
    }
    if (!res.ok) {
      if (res.status === 401) {
        throw new ProviderError("OpenWeatherMap API key is invalid");
      }
      throw new ProviderError(`Air quality API error: HTTP ${res.status}`);
    }
    const data = (await res.json()) as Record<string, any>;
    return this.parseAirQuality(data);
  }

  private parseAirQuality(data: Record<string, any>): AirQualityResult {
    if (!Array.isArray(data.list) || data.list.length === 0) return {};

    const item = data.list[0] as Record<string, any>;
    const components = (item.components ?? {}) as Record<string, any>;
    const main = (item.main ?? {}) as Record<string, any>;

    // OWM returns AQI on a 1-5 scale; map to approximate US EPA scale.
    const aqiIndex = (main.aqi ?? 1) as number;
    const aqiMap: Record<number, number> = {
      1: 25,
      2: 75,
      3: 125,
      4: 175,
      5: 300,
    };
    const aqi = aqiMap[aqiIndex] ?? 50;

    const result: AirQualityResult = { aqi };
    if (typeof components.pm2_5 === "number") result.pm25 = components.pm2_5;
    if (typeof components.pm10 === "number") result.pm10 = components.pm10;
    if (typeof components.o3 === "number") result.o3 = components.o3;
    if (typeof components.no2 === "number") result.no2 = components.no2;
    if (typeof components.co === "number") result.co = components.co;
    if (typeof components.so2 === "number") result.so2 = components.so2;
    return result;
  }

  // ── Misc ─────────────────────────────────────────────────────────

  /** Convert wind degrees to 8-point cardinal direction. */
  private degToDirection(deg: number): string {
    const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    const index = Math.round(deg / 45) % 8;
    return directions[index]!;
  }
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Return the most common element in an array. Mirrors Python's
 * `max(set(items), key=items.count)`. Tie-breaking matches Python's
 * iteration-order behavior: the first element seen in `Set` order
 * (= insertion order) wins.
 */
function mostCommon<T>(items: readonly T[]): T | undefined {
  if (items.length === 0) return undefined;
  const counts = new Map<T, number>();
  for (const item of items) {
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  let best: T | undefined;
  let bestCount = -1;
  for (const [item, count] of counts) {
    if (count > bestCount) {
      best = item;
      bestCount = count;
    }
  }
  return best;
}
