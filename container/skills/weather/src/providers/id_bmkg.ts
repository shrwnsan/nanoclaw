/* eslint-disable @typescript-eslint/naming-convention */
/** Indonesia BMKG provider using the public forecast API. */

import { BMKG_CONDITION_MAP } from "../data-loader.js";
import { makeWeatherData } from "../models.js";
import {
  type IWeatherProvider,
  type Location,
  LocationNotSupportedError,
  ProviderError,
  WeatherCondition,
  type WeatherData,
} from "../types.js";

const BMKG_API_URL = "https://api.bmkg.go.id/publik/prakiraan-cuaca";

const BMKG_AREA_CODES: Record<string, string> = {
  jakarta: "31.71.01.1001",
  "dki jakarta": "31.71.01.1001",
  bandung: "32.73.01.1001",
  bogor: "32.71.01.1001",
  bekasi: "32.75.01.1001",
  semarang: "33.74.01.1001",
  solo: "33.72.01.1001",
  surakarta: "33.72.01.1001",
  yogyakarta: "34.71.01.1001",
  surabaya: "35.78.01.1001",
  malang: "35.73.01.1001",
  denpasar: "51.71.01.1001",
  bali: "51.71.01.1001",
  ubud: "51.03.03.2001",
  medan: "12.71.01.1001",
  palembang: "16.71.01.1001",
  padang: "13.71.01.1001",
  balikpapan: "64.71.01.1001",
  makassar: "73.71.01.1001",
  manado: "71.71.01.1001",
  lombok: "52.71.01.1001",
  mataram: "52.71.01.1001",
  indonesia: "31.71.01.1001",
  id: "31.71.01.1001",
};

export class BMKGProvider implements IWeatherProvider {
  readonly name = "bmkg";
  readonly priority = 8;
  readonly supportsForecast = true;
  readonly supportsAirQuality = false;
  readonly requiresApiKey = false;

  supportsLocation(location: Location): boolean {
    return Object.hasOwn(BMKG_AREA_CODES, location.normalized.toLowerCase());
  }

  async getCurrent(location: Location): Promise<WeatherData> {
    if (!this.supportsLocation(location)) {
      throw new LocationNotSupportedError(`BMKG only supports Indonesian locations: ${location.raw}`);
    }
    try {
      const data = await this.fetchForecast(this.getAreaCode(location));
      return this.parseCurrent(location, data);
    } catch (e) {
      if (e instanceof LocationNotSupportedError) throw e;
      throw new ProviderError(`BMKG API error: ${(e as Error).message}`);
    }
  }

  async getForecast(location: Location, days: number = 3): Promise<WeatherData[]> {
    if (!this.supportsLocation(location)) {
      throw new LocationNotSupportedError(`BMKG only supports Indonesian locations: ${location.raw}`);
    }
    try {
      const data = await this.fetchForecast(this.getAreaCode(location));
      return this.parseForecast(location, data, days);
    } catch (e) {
      if (e instanceof LocationNotSupportedError) throw e;
      throw new ProviderError(`BMKG API error: ${(e as Error).message}`);
    }
  }

  private getAreaCode(location: Location): string {
    const normalized = location.normalized.toLowerCase();
    return BMKG_AREA_CODES[normalized] ?? BMKG_AREA_CODES.jakarta!;
  }

  private async fetchForecast(areaCode: string): Promise<Record<string, any>> {
    const url = `${BMKG_API_URL}?${new URLSearchParams({ adm4: areaCode }).toString()}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "WeatherSkill/1.0",
        Accept: "application/json",
      },
    });
    if (!res.ok) throw new ProviderError(`HTTP ${res.status}`);
    return (await res.json()) as Record<string, any>;
  }

  private parseCurrent(location: Location, data: Record<string, any>): WeatherData {
    const displayName = this.getDisplayName(location, data);
    const days = extractCuacaDays(data);
    if (days.length === 0) throw new ProviderError("No weather data in BMKG response");

    const now = Date.now();
    let best: Record<string, any> | undefined;
    let bestDiff = Number.POSITIVE_INFINITY;
    for (const day of days) {
      for (const entry of day) {
        const parsed = parseBmkgUtc(entry.utc_datetime);
        if (!parsed) continue;
        const diff = Math.abs(now - parsed.getTime());
        if (diff < bestDiff) {
          bestDiff = diff;
          best = entry;
        }
      }
    }

    best ??= days[0]?.[0];
    return this.entryToWeatherData(displayName, best ?? {}, true);
  }

  private parseForecast(location: Location, data: Record<string, any>, days: number): WeatherData[] {
    const displayName = this.getDisplayName(location, data);
    const results: WeatherData[] = [];
    const seen = new Set<string>();

    for (const dayEntries of extractCuacaDays(data)) {
      for (const entry of dayEntries) {
        const local = parseBmkgLocal(entry.local_datetime);
        if (!local) continue;
        const key = local.toISOString().slice(0, 10);
        if (seen.has(key)) continue;

        if (local.getUTCHours() < 10 || local.getUTCHours() > 15) {
          const hasMidday = dayEntries.some((e) =>
            typeof e.local_datetime === "string" &&
            (e.local_datetime.endsWith("12:00:00") || e.local_datetime.endsWith("13:00:00")),
          );
          if (hasMidday) continue;
        }

        seen.add(key);
        const wd = this.entryToWeatherData(displayName, entry, false);
        wd.forecast_date = new Date(`${key}T00:00:00.000Z`);
        results.push(wd);
        if (results.length >= days) return results;
      }
    }
    return results;
  }

  private entryToWeatherData(displayName: string, entry: Record<string, any>, isCurrent: boolean): WeatherData {
    const windSpeed = numberOrUndefined(entry.ws);
    const windDir = typeof entry.wd === "string" ? entry.wd : "";
    const weather = typeof entry.weather_desc_en === "string" ? entry.weather_desc_en : "";
    const observed = isCurrent ? parseBmkgUtc(entry.utc_datetime) : undefined;
    return makeWeatherData({
      location: displayName,
      temperature: numberOrUndefined(entry.t) ?? 0,
      humidity: numberOrUndefined(entry.hu),
      condition: textToCondition(weather),
      description: weather || undefined,
      wind_speed: windSpeed,
      wind_description: windDir && windSpeed != null ? `${windDir} ${windSpeed} km/h` : undefined,
      observed_at: observed,
      provider_name: this.name,
    });
  }

  private getDisplayName(location: Location, data: Record<string, any>): string {
    const lokasi = (data.lokasi ?? {}) as Record<string, any>;
    if (typeof lokasi.kotkab === "string" && lokasi.kotkab) return lokasi.kotkab;
    if (typeof lokasi.provinsi === "string" && lokasi.provinsi) return lokasi.provinsi;
    return titleCase(location.normalized);
  }
}

function extractCuacaDays(data: Record<string, any>): Record<string, any>[][] {
  const cuaca = data.data?.[0]?.cuaca;
  return Array.isArray(cuaca) ? cuaca : [];
}

function textToCondition(text: string): WeatherCondition {
  const lower = text.toLowerCase().trim();
  if (!lower) return WeatherCondition.Unknown;
  if (BMKG_CONDITION_MAP[lower]) return BMKG_CONDITION_MAP[lower];
  if (lower.includes("thunder")) return WeatherCondition.Thunderstorm;
  if (lower.includes("heavy rain")) return WeatherCondition.HeavyRain;
  if (lower.includes("rain") || lower.includes("shower")) return WeatherCondition.Rain;
  if (lower.includes("drizzle") || lower.includes("light rain")) return WeatherCondition.Drizzle;
  if (lower.includes("cloud") || lower.includes("overcast")) return WeatherCondition.Cloudy;
  if (lower.includes("haze") || lower.includes("smoke")) return WeatherCondition.Mist;
  if (lower.includes("fog")) return WeatherCondition.Fog;
  if (lower.includes("clear") || lower.includes("sunny")) return WeatherCondition.Sunny;
  return WeatherCondition.Unknown;
}

function parseBmkgUtc(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const date = new Date(`${value.replace(" ", "T")}.000Z`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseBmkgLocal(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const date = new Date(`${value.replace(" ", "T")}.000Z`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function numberOrUndefined(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(n) ? n : undefined;
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (c) => c.toUpperCase());
}
