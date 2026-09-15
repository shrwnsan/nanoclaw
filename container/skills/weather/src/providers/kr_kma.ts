/* eslint-disable @typescript-eslint/naming-convention */
/** South Korea KMA provider via data.go.kr. */

import { KMA_PTY_MAP, KMA_SKY_MAP } from "../data-loader.js";
import { makeWeatherData } from "../models.js";
import {
  type IWeatherProvider,
  type Location,
  LocationNotSupportedError,
  ProviderError,
  WeatherCondition,
  type WeatherData,
} from "../types.js";

const KMA_BASE_URL = "https://apis.data.go.kr/1360000/VilageFcstInfoService2.0";
const KMA_FORECAST_URL = `${KMA_BASE_URL}/getVilageFcst`;
const KMA_NOWCAST_URL = `${KMA_BASE_URL}/getUltraSrtNcst`;

const KR_CITIES: Record<string, { lat: number; lon: number; nx: number; ny: number }> = {
  seoul: { lat: 37.5665, lon: 126.9780, nx: 60, ny: 127 },
  busan: { lat: 35.1796, lon: 129.0756, nx: 98, ny: 76 },
  incheon: { lat: 37.4563, lon: 126.7052, nx: 55, ny: 124 },
  daegu: { lat: 35.8714, lon: 128.6014, nx: 89, ny: 90 },
  daejeon: { lat: 36.3504, lon: 127.3845, nx: 67, ny: 100 },
  gwangju: { lat: 35.1595, lon: 126.8526, nx: 58, ny: 74 },
  ulsan: { lat: 35.5384, lon: 129.3114, nx: 102, ny: 84 },
  sejong: { lat: 36.48, lon: 127, nx: 66, ny: 103 },
  suwon: { lat: 37.2636, lon: 127.0286, nx: 60, ny: 121 },
  jeju: { lat: 33.4996, lon: 126.5312, nx: 52, ny: 38 },
  "south korea": { lat: 37.5665, lon: 126.9780, nx: 60, ny: 127 },
  korea: { lat: 37.5665, lon: 126.9780, nx: 60, ny: 127 },
  kr: { lat: 37.5665, lon: 126.9780, nx: 60, ny: 127 },
  "한국": { lat: 37.5665, lon: 126.9780, nx: 60, ny: 127 },
  "서울": { lat: 37.5665, lon: 126.9780, nx: 60, ny: 127 },
  "부산": { lat: 35.1796, lon: 129.0756, nx: 98, ny: 76 },
  "제주": { lat: 33.4996, lon: 126.5312, nx: 52, ny: 38 },
};

export class KMAProvider implements IWeatherProvider {
  readonly name = "kma";
  readonly priority = 9;
  readonly supportsForecast = true;
  readonly supportsAirQuality = false;
  readonly requiresApiKey = true;

  private readonly apiKey: string;

  constructor(apiKey: string = process.env.KMA_SERVICE_KEY ?? "") {
    this.apiKey = apiKey;
  }

  supportsLocation(location: Location): boolean {
    if (!this.apiKey) return false;
    return Object.hasOwn(KR_CITIES, location.normalized.toLowerCase());
  }

  async getCurrent(location: Location): Promise<WeatherData> {
    if (!this.supportsLocation(location)) {
      throw new LocationNotSupportedError(`KMA only supports Korean locations: ${location.raw}`);
    }
    try {
      const city = this.getCityInfo(location);
      const data = await this.fetchNowcast(city.nx, city.ny);
      return this.parseNowcast(location, data);
    } catch (e) {
      if (e instanceof LocationNotSupportedError) throw e;
      throw new ProviderError(`KMA API error: ${(e as Error).message}`);
    }
  }

  async getForecast(location: Location, days: number = 3): Promise<WeatherData[]> {
    if (!this.supportsLocation(location)) {
      throw new LocationNotSupportedError(`KMA only supports Korean locations: ${location.raw}`);
    }
    try {
      const city = this.getCityInfo(location);
      const data = await this.fetchForecast(city.nx, city.ny);
      return this.parseForecast(location, data, days);
    } catch (e) {
      if (e instanceof LocationNotSupportedError) throw e;
      throw new ProviderError(`KMA API error: ${(e as Error).message}`);
    }
  }

  private getCityInfo(location: Location): { lat: number; lon: number; nx: number; ny: number } {
    const normalized = location.normalized.toLowerCase();
    return KR_CITIES[normalized] ?? KR_CITIES.seoul!;
  }

  private getDisplayName(location: Location): string {
    const normalized = location.normalized.toLowerCase();
    if (Object.hasOwn(KR_CITIES, normalized)) return titleCase(normalized);
    return titleCase(location.raw);
  }

  private getBaseTime(): { base_date: string; base_time: string } {
    const nowKst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const baseTimes = [2, 5, 8, 11, 14, 17, 20, 23];
    let baseHour = 23;
    let baseDate = new Date(Date.UTC(nowKst.getUTCFullYear(), nowKst.getUTCMonth(), nowKst.getUTCDate()));
    for (const bt of [...baseTimes].reverse()) {
      if (nowKst.getUTCHours() >= bt) {
        baseHour = bt;
        break;
      }
    }
    if (nowKst.getUTCHours() < 2) baseDate = new Date(baseDate.getTime() - 86_400_000);
    return { base_date: ymd(baseDate), base_time: `${String(baseHour).padStart(2, "0")}00` };
  }

  private async fetchNowcast(nx: number, ny: number): Promise<Record<string, any>> {
    const nowKst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const base = nowKst.getUTCMinutes() < 40
      ? new Date(nowKst.getTime() - 60 * 60 * 1000)
      : nowKst;
    return this.fetchApi(KMA_NOWCAST_URL, {
      serviceKey: this.apiKey,
      numOfRows: "100",
      pageNo: "1",
      dataType: "JSON",
      base_date: ymd(base),
      base_time: `${String(base.getUTCHours()).padStart(2, "0")}00`,
      nx: String(nx),
      ny: String(ny),
    });
  }

  private async fetchForecast(nx: number, ny: number): Promise<Record<string, any>> {
    const base = this.getBaseTime();
    return this.fetchApi(KMA_FORECAST_URL, {
      serviceKey: this.apiKey,
      numOfRows: "1000",
      pageNo: "1",
      dataType: "JSON",
      ...base,
      nx: String(nx),
      ny: String(ny),
    });
  }

  private async fetchApi(baseUrl: string, params: Record<string, string>): Promise<Record<string, any>> {
    const url = `${baseUrl}?${new URLSearchParams(params).toString()}`;
    const res = await fetch(url, { headers: { "User-Agent": "WeatherSkill/1.0" } });
    if (!res.ok) throw new ProviderError(`HTTP ${res.status}`);
    return (await res.json()) as Record<string, any>;
  }

  private parseNowcast(location: Location, data: Record<string, any>): WeatherData {
    const values: Record<string, string> = {};
    for (const item of extractItems(data)) values[String(item.category ?? "")] = String(item.obsrValue ?? "");
    const windMs = Number.parseFloat(values.WSD ?? "0");
    const pty = values.PTY ?? "0";
    return makeWeatherData({
      location: this.getDisplayName(location),
      temperature: Number.parseFloat(values.T1H ?? "0"),
      humidity: Math.trunc(Number.parseFloat(values.REH ?? "0")),
      wind_speed: Math.round(windMs * 36) / 10,
      condition: KMA_PTY_MAP[pty] ?? WeatherCondition.Unknown,
      observed_at: new Date(),
      provider_name: this.name,
    });
  }

  private parseForecast(location: Location, data: Record<string, any>, days: number): WeatherData[] {
    const daily = new Map<string, { TMX?: number; TMN?: number; SKY: string[]; PTY: string[]; POP: number[]; REH: number[] }>();
    for (const item of extractItems(data)) {
      const date = String(item.fcstDate ?? "");
      if (!date) continue;
      const bucket = daily.get(date) ?? { SKY: [], PTY: [], POP: [], REH: [] };
      const cat = String(item.category ?? "");
      const val = String(item.fcstValue ?? "");
      if (cat === "TMX") bucket.TMX = parseNumber(val);
      else if (cat === "TMN") bucket.TMN = parseNumber(val);
      else if (cat === "SKY") bucket.SKY.push(val);
      else if (cat === "PTY") bucket.PTY.push(val);
      else if (cat === "POP") bucket.POP.push(parseNumber(val));
      else if (cat === "REH") bucket.REH.push(parseNumber(val));
      daily.set(date, bucket);
    }

    return [...daily.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(0, days).map(([date, bucket]) => {
      const pty = bucket.PTY.find((p) => p !== "0");
      const sky = mostCommon(bucket.SKY);
      const condition = pty
        ? (KMA_PTY_MAP[pty] ?? WeatherCondition.Rain)
        : (sky ? KMA_SKY_MAP[sky] ?? WeatherCondition.Unknown : WeatherCondition.Unknown);
      const humidity = bucket.REH.length
        ? Math.round(bucket.REH.reduce((a, b) => a + b, 0) / bucket.REH.length)
        : undefined;
      return makeWeatherData({
        location: this.getDisplayName(location),
        temperature: bucket.TMN ?? 0,
        temp_high: bucket.TMX,
        temp_low: bucket.TMN,
        humidity,
        condition,
        precipitation_chance: bucket.POP.length ? Math.max(...bucket.POP) : undefined,
        forecast_date: parseYmdDate(date),
        provider_name: this.name,
      });
    });
  }
}

function extractItems(data: Record<string, any>): Record<string, any>[] {
  const items = data.response?.body?.items?.item;
  return Array.isArray(items) ? items : [];
}

function parseNumber(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function mostCommon(values: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function ymd(date: Date): string {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
}

function parseYmdDate(value: string): Date | undefined {
  if (!/^\d{8}$/.test(value)) return undefined;
  return new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00.000Z`);
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (c) => c.toUpperCase());
}
