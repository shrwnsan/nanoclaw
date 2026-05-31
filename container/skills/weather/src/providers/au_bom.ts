/* eslint-disable @typescript-eslint/naming-convention */
/** Australian Bureau of Meteorology provider using public JSON feeds. */

import { BOM_CONDITION_MAP } from "../data-loader.js";
import { makeWeatherData } from "../models.js";
import {
  type IWeatherProvider,
  type Location,
  LocationNotSupportedError,
  ProviderError,
  WeatherCondition,
  type WeatherData,
} from "../types.js";

const BOM_BASE = "https://www.bom.gov.au/fwo";

const BOM_STATIONS: Record<string, { station_id: string; state_code: string; product: string }> = {
  sydney: { station_id: "94767", state_code: "IDN60801", product: "IDN60801" },
  "sydney observatory hill": { station_id: "66062", state_code: "IDN60801", product: "IDN60801" },
  canberra: { station_id: "94926", state_code: "IDN60801", product: "IDN60801" },
  melbourne: { station_id: "94866", state_code: "IDV60801", product: "IDV60801" },
  brisbane: { station_id: "94578", state_code: "IDQ60801", product: "IDQ60801" },
  perth: { station_id: "94610", state_code: "IDW60801", product: "IDW60801" },
  adelaide: { station_id: "94648", state_code: "IDS60801", product: "IDS60801" },
  hobart: { station_id: "94970", state_code: "IDT60801", product: "IDT60801" },
  darwin: { station_id: "94120", state_code: "IDD60801", product: "IDD60801" },
  "gold coast": { station_id: "94784", state_code: "IDQ60801", product: "IDQ60801" },
  cairns: { station_id: "94287", state_code: "IDQ60801", product: "IDQ60801" },
  townsville: { station_id: "94294", state_code: "IDQ60801", product: "IDQ60801" },
  geelong: { station_id: "94857", state_code: "IDV60801", product: "IDV60801" },
  ballarat: { station_id: "94852", state_code: "IDV60801", product: "IDV60801" },
  bendigo: { station_id: "94855", state_code: "IDV60801", product: "IDV60801" },
  wollongong: { station_id: "94749", state_code: "IDN60801", product: "IDN60801" },
  fremantle: { station_id: "94615", state_code: "IDW60801", product: "IDW60801" },
  bunbury: { station_id: "94622", state_code: "IDW60801", product: "IDW60801" },
  launceston: { station_id: "94973", state_code: "IDT60801", product: "IDT60801" },
  "alice springs": { station_id: "94362", state_code: "IDD60801", product: "IDD60801" },
};

const SUPPORTED_LOCATIONS = new Set([
  "australia", "au", "oz", "aussie", "newcastle", "sunshine coast",
  ...Object.keys(BOM_STATIONS),
]);

export class BOMProvider implements IWeatherProvider {
  readonly name = "bom";
  readonly priority = 6;
  readonly supportsForecast = true;
  readonly supportsAirQuality = false;
  readonly requiresApiKey = false;

  supportsLocation(location: Location): boolean {
    const normalized = location.normalized.toLowerCase();
    return SUPPORTED_LOCATIONS.has(normalized) || Object.keys(BOM_STATIONS).some((city) => normalized.includes(city));
  }

  async getCurrent(location: Location): Promise<WeatherData> {
    if (!this.supportsLocation(location)) {
      throw new LocationNotSupportedError(`BOM only supports Australian locations: ${location.raw}`);
    }
    try {
      const station = this.getStationInfo(location);
      const data = await this.fetchJson(`${BOM_BASE}/${station.product}/${station.product}.${station.station_id}.json`);
      return this.parseCurrent(location, data);
    } catch (e) {
      if (e instanceof LocationNotSupportedError) throw e;
      throw new ProviderError(`BOM API error: ${(e as Error).message}`);
    }
  }

  async getForecast(location: Location, days: number = 7): Promise<WeatherData[]> {
    if (!this.supportsLocation(location)) {
      throw new LocationNotSupportedError(`BOM only supports Australian locations: ${location.raw}`);
    }
    try {
      const station = this.getStationInfo(location);
      const data = await this.fetchJson(`${BOM_BASE}/${station.state_code}/${station.state_code}.${station.station_id}.json`);
      return this.parseForecast(location, data, days);
    } catch (e) {
      if (e instanceof LocationNotSupportedError) throw e;
      throw new ProviderError(`BOM API error: ${(e as Error).message}`);
    }
  }

  private getStationInfo(location: Location): { station_id: string; state_code: string; product: string } {
    const normalized = location.normalized.toLowerCase();
    if (BOM_STATIONS[normalized]) return BOM_STATIONS[normalized];
    for (const [city, info] of Object.entries(BOM_STATIONS)) {
      if (city.includes(normalized) || normalized.includes(city)) return info;
    }
    return BOM_STATIONS.sydney!;
  }

  private async fetchJson(url: string): Promise<Record<string, any>> {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; WeatherSkill/1.0)",
        Accept: "application/json",
      },
    });
    if (!res.ok) throw new ProviderError(`HTTP ${res.status}`);
    return (await res.json()) as Record<string, any>;
  }

  private parseCurrent(location: Location, data: Record<string, any>): WeatherData {
    const latest = data.observations?.data?.[0] as Record<string, any> | undefined;
    if (!latest) throw new ProviderError("No observation data from BOM");
    const observed = parseBomTime(latest.local_date_time_full);

    return makeWeatherData({
      location: this.getDisplayName(location),
      temperature: numberOrUndefined(latest.air_temp) ?? 0,
      feels_like: numberOrUndefined(latest.apparent_temp),
      humidity: numberOrUndefined(latest.rel_hum),
      wind_speed: numberOrUndefined(latest.wind_spd_kmh),
      wind_direction: typeof latest.wind_dir === "string" ? latest.wind_dir : undefined,
      pressure: numberOrUndefined(latest.press_msl),
      condition: WeatherCondition.Unknown,
      observed_at: observed ?? new Date(),
      provider_name: this.name,
    });
  }

  private parseForecast(location: Location, data: Record<string, any>, days: number): WeatherData[] {
    const forecasts = Array.isArray(data.forecasts) ? data.forecasts : [];
    return (forecasts as Record<string, any>[]).slice(0, days).map((fc) => {
      const raw = String(fc.icon_descriptor || fc.short_text || "");
      return makeWeatherData({
        location: this.getDisplayName(location),
        temperature: numberOrUndefined(fc.min_temp) ?? 0,
        temp_high: numberOrUndefined(fc.max_temp),
        temp_low: numberOrUndefined(fc.min_temp),
        forecast_date: parseDate(fc.date),
        condition: mapCondition(raw),
        condition_raw: raw,
        description: typeof fc.extended_text === "string" ? fc.extended_text : undefined,
        precipitation_chance: parseIntOrUndefined(fc.probability_of_precipitation),
        uv_index: parseIntOrUndefined(fc.uv),
        provider_name: this.name,
      });
    });
  }

  private getDisplayName(location: Location): string {
    const normalized = location.normalized.toLowerCase();
    for (const city of Object.keys(BOM_STATIONS)) {
      if (normalized.includes(city)) return titleCase(city);
    }
    return "Australia";
  }
}

function mapCondition(value: string): WeatherCondition {
  const normalized = value.toLowerCase().trim();
  if (!normalized) return WeatherCondition.Unknown;
  if (BOM_CONDITION_MAP[normalized]) return BOM_CONDITION_MAP[normalized];
  for (const [key, condition] of Object.entries(BOM_CONDITION_MAP)) {
    if (key.includes(normalized) || normalized.includes(key)) return condition;
  }
  if (normalized.includes("sunny") || normalized.includes("clear") || normalized.includes("fine")) return WeatherCondition.Sunny;
  if (normalized.includes("shower")) return WeatherCondition.Showers;
  if (normalized.includes("rain")) return WeatherCondition.Rain;
  if (normalized.includes("thunder") || normalized.includes("storm")) return WeatherCondition.Thunderstorm;
  if (normalized.includes("cloud")) return WeatherCondition.Cloudy;
  if (normalized.includes("fog")) return WeatherCondition.Fog;
  if (normalized.includes("snow")) return WeatherCondition.Snow;
  return WeatherCondition.Unknown;
}

function parseBomTime(value: unknown): Date | undefined {
  if (typeof value !== "string" || !/^\d{14}$/.test(value)) return undefined;
  return new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}.000Z`);
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  return new Date(`${value}T00:00:00.000Z`);
}

function numberOrUndefined(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(n) ? n : undefined;
}

function parseIntOrUndefined(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? n : undefined;
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (c) => c.toUpperCase());
}
