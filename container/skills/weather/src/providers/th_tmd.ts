/* eslint-disable @typescript-eslint/naming-convention */
/** Thailand Meteorological Department provider. */

import { TMD_CONDITION_MAP } from "../data-loader.js";
import { makeWeatherData } from "../models.js";
import {
  type IWeatherProvider,
  type Location,
  LocationNotSupportedError,
  ProviderError,
  WeatherCondition,
  type WeatherData,
} from "../types.js";

const TMD_OBSERVATION_URL = "https://data.tmd.go.th/api/WeatherToday/v2/";
const TMD_FORECAST_URL = "https://data.tmd.go.th/api/WeatherForecast7Days/v2/";

const TH_LOCATIONS: Record<string, { province: string; station: string; lat: number; lon: number }> = {
  bangkok: { province: "กรุงเทพมหานคร", station: "48455", lat: 13.7563, lon: 100.5018 },
  "กรุงเทพ": { province: "กรุงเทพมหานคร", station: "48455", lat: 13.7563, lon: 100.5018 },
  "chiang mai": { province: "เชียงใหม่", station: "48327", lat: 18.7883, lon: 98.9853 },
  "เชียงใหม่": { province: "เชียงใหม่", station: "48327", lat: 18.7883, lon: 98.9853 },
  phuket: { province: "ภูเก็ต", station: "48564", lat: 7.8804, lon: 98.3923 },
  "ภูเก็ต": { province: "ภูเก็ต", station: "48564", lat: 7.8804, lon: 98.3923 },
  pattaya: { province: "ชลบุรี", station: "48477", lat: 12.9236, lon: 100.8825 },
  "chon buri": { province: "ชลบุรี", station: "48477", lat: 13.3622, lon: 100.9847 },
  thailand: { province: "กรุงเทพมหานคร", station: "48455", lat: 13.7563, lon: 100.5018 },
  th: { province: "กรุงเทพมหานคร", station: "48455", lat: 13.7563, lon: 100.5018 },
  "ไทย": { province: "กรุงเทพมหานคร", station: "48455", lat: 13.7563, lon: 100.5018 },
  "ประเทศไทย": { province: "กรุงเทพมหานคร", station: "48455", lat: 13.7563, lon: 100.5018 },
};

export class TMDProvider implements IWeatherProvider {
  readonly name = "tmd";
  readonly priority = 9;
  readonly supportsForecast = true;
  readonly supportsAirQuality = false;
  readonly requiresApiKey = true;

  private readonly apiKey: string;

  constructor(apiKey: string = process.env.TMD_API_TOKEN ?? "") {
    this.apiKey = apiKey;
  }

  supportsLocation(location: Location): boolean {
    if (!this.apiKey) return false;
    return Object.hasOwn(TH_LOCATIONS, location.normalized.toLowerCase());
  }

  async getCurrent(location: Location): Promise<WeatherData> {
    if (!this.supportsLocation(location)) {
      throw new LocationNotSupportedError(`TMD only supports Thai locations: ${location.raw}`);
    }
    try {
      const info = this.getLocationInfo(location);
      const data = await this.fetchApi(TMD_OBSERVATION_URL, {
        uid: this.apiKey,
        ukey: this.apiKey,
        format: "json",
      });
      return this.parseCurrent(location, data, info);
    } catch (e) {
      if (e instanceof LocationNotSupportedError) throw e;
      throw new ProviderError(`TMD API error: ${(e as Error).message}`);
    }
  }

  async getForecast(location: Location, days: number = 7): Promise<WeatherData[]> {
    if (!this.supportsLocation(location)) {
      throw new LocationNotSupportedError(`TMD only supports Thai locations: ${location.raw}`);
    }
    try {
      const info = this.getLocationInfo(location);
      const data = await this.fetchApi(TMD_FORECAST_URL, {
        uid: this.apiKey,
        ukey: this.apiKey,
        province: info.province,
        format: "json",
      });
      return this.parseForecast(location, data, info, days);
    } catch (e) {
      if (e instanceof LocationNotSupportedError) throw e;
      throw new ProviderError(`TMD API error: ${(e as Error).message}`);
    }
  }

  private getLocationInfo(location: Location): { province: string; station: string; lat: number; lon: number } {
    const normalized = location.normalized.toLowerCase();
    return TH_LOCATIONS[normalized] ?? TH_LOCATIONS.bangkok!;
  }

  private async fetchApi(baseUrl: string, params: Record<string, string>): Promise<Record<string, any>> {
    const url = `${baseUrl}?${new URLSearchParams(params).toString()}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "WeatherSkill/1.0",
        Accept: "application/json",
      },
    });
    if (!res.ok) throw new ProviderError(`HTTP ${res.status}`);
    return (await res.json()) as Record<string, any>;
  }

  private parseCurrent(location: Location, data: Record<string, any>, info: { station: string }): WeatherData {
    const stations = data.Stations?.Station;
    if (!Array.isArray(stations)) throw new ProviderError("No station data in TMD response");
    const station = stations.find((s) => s.WmoStationNumber === info.station) ?? stations[0];
    if (!station) throw new ProviderError("No station data in TMD response");
    const obs = (station.Observation ?? {}) as Record<string, any>;

    return makeWeatherData({
      location: this.getDisplayName(location),
      temperature: parseFloatOrUndefined(obs.MeanTemperature) ?? 0,
      temp_high: parseFloatOrUndefined(obs.MaxTemperature),
      temp_low: parseFloatOrUndefined(obs.MinTemperature),
      humidity: parseIntOrUndefined(obs.MeanRelativeHumidity),
      condition: WeatherCondition.Unknown,
      observed_at: new Date(),
      provider_name: this.name,
    });
  }

  private parseForecast(
    location: Location,
    data: Record<string, any>,
    info: { province: string },
    days: number,
  ): WeatherData[] {
    const provinces = data.Provinces?.Province;
    if (!Array.isArray(provinces)) return [];
    const province = provinces.find((p) => p.ProvinceNameThai === info.province) ?? provinces[0];
    const forecasts = province?.ForecastDaily;
    if (!Array.isArray(forecasts)) return [];

    return (forecasts as Record<string, any>[]).slice(0, days).flatMap((fc) => {
      const forecastDate = parseForecastDate(fc.Date);
      if (!forecastDate) return [];
      const description = typeof fc.WeatherDescription === "string" ? fc.WeatherDescription : "";
      return [makeWeatherData({
        location: this.getDisplayName(location),
        temperature: parseFloatOrUndefined(fc.MinTemperature) ?? 0,
        temp_high: parseFloatOrUndefined(fc.MaxTemperature),
        temp_low: parseFloatOrUndefined(fc.MinTemperature),
        condition: textToCondition(description),
        description,
        precipitation_chance: parseRainChance(fc.RainChance),
        forecast_date: forecastDate,
        provider_name: this.name,
      })];
    });
  }

  private getDisplayName(location: Location): string {
    const normalized = location.normalized.toLowerCase();
    for (const city of Object.keys(TH_LOCATIONS)) {
      if (city === normalized && /^[\x00-\x7F]+$/.test(city)) return titleCase(city);
    }
    return titleCase(location.raw);
  }
}

function textToCondition(text: string): WeatherCondition {
  if (!text) return WeatherCondition.Unknown;
  if (TMD_CONDITION_MAP[text]) return TMD_CONDITION_MAP[text];
  const lower = text.toLowerCase();
  if (lower.includes("thunder")) return WeatherCondition.Thunderstorm;
  if (lower.includes("heavy rain")) return WeatherCondition.HeavyRain;
  if (lower.includes("rain") || lower.includes("shower")) return WeatherCondition.Rain;
  if (lower.includes("partly")) return WeatherCondition.PartlyCloudy;
  if (lower.includes("cloudy") || lower.includes("overcast")) return WeatherCondition.Cloudy;
  if (lower.includes("clear") || lower.includes("sunny") || lower.includes("fair")) return WeatherCondition.Sunny;
  if (text.includes("ฟ้าคะนอง")) return WeatherCondition.Thunderstorm;
  if (text.includes("ฝนตกหนัก")) return WeatherCondition.HeavyRain;
  if (text.includes("ฝน")) return WeatherCondition.Rain;
  if (text.includes("เมฆมาก")) return WeatherCondition.Overcast;
  if (text.includes("เมฆ")) return WeatherCondition.Cloudy;
  if (text.includes("แจ่มใส") || text.includes("ท้องฟ้าแจ่มใส")) return WeatherCondition.Sunny;
  return WeatherCondition.Unknown;
}

function parseForecastDate(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const dmy = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (dmy) return new Date(`${dmy[3]}-${dmy[2]}-${dmy[1]}T00:00:00.000Z`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(`${value}T00:00:00.000Z`);
  return undefined;
}

function parseRainChance(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const n = Number.parseInt(String(value).replace("%", ""), 10);
  return Number.isFinite(n) ? n : undefined;
}

function parseFloatOrUndefined(value: unknown): number | undefined {
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
