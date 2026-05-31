/* eslint-disable @typescript-eslint/naming-convention */
/** Taiwan Central Weather Administration provider. */

import { CWA_CONDITION_MAP } from "../data-loader.js";
import { makeWeatherData } from "../models.js";
import {
  type IWeatherProvider,
  type Location,
  LocationNotSupportedError,
  ProviderError,
  WeatherCondition,
  type WeatherData,
} from "../types.js";

const CWA_BASE_URL = "https://opendata.cwa.gov.tw/api/v1/rest/datastore";
const CWA_OBSERVATION_ID = "O-A0003-001";
const CWA_FORECAST_36HR_ID = "F-C0032-001";
const CWA_FORECAST_1WEEK_ID = "F-D0047-091";

const TW_LOCATIONS: Record<string, string> = {
  taipei: "臺北市", "台北": "臺北市", "臺北": "臺北市",
  "new taipei": "新北市", "新北": "新北市",
  taoyuan: "桃園市", "桃園": "桃園市",
  taichung: "臺中市", "台中": "臺中市", "臺中": "臺中市",
  tainan: "臺南市", "台南": "臺南市", "臺南": "臺南市",
  kaohsiung: "高雄市", "高雄": "高雄市",
  keelung: "基隆市", "基隆": "基隆市",
  hsinchu: "新竹市", "新竹": "新竹市",
  taiwan: "臺北市", tw: "臺北市", "台灣": "臺北市", "臺灣": "臺北市",
};

const CWA_STATIONS: Record<string, string> = {
  "臺北市": "臺北",
  "新北市": "板橋",
  "桃園市": "桃園",
  "臺中市": "臺中",
  "臺南市": "臺南",
  "高雄市": "高雄",
  "基隆市": "基隆",
  "新竹市": "新竹",
};

export class CWAProvider implements IWeatherProvider {
  readonly name = "cwa";
  readonly priority = 4;
  readonly supportsForecast = true;
  readonly supportsAirQuality = false;
  readonly requiresApiKey = true;

  private readonly apiKey: string;

  constructor(apiKey: string = process.env.CWA_API_KEY ?? "") {
    this.apiKey = apiKey;
  }

  supportsLocation(location: Location): boolean {
    if (!this.apiKey) return false;
    return Object.hasOwn(TW_LOCATIONS, location.normalized.toLowerCase());
  }

  async getCurrent(location: Location): Promise<WeatherData> {
    if (!this.supportsLocation(location)) {
      throw new LocationNotSupportedError(`CWA only supports Taiwanese locations: ${location.raw}`);
    }
    try {
      const cwaName = this.getCwaName(location);
      const station = CWA_STATIONS[cwaName] ?? cwaName.replace(/[市縣]$/, "");
      const [obs, fc] = await Promise.all([
        this.fetchApi(CWA_OBSERVATION_ID, { Authorization: this.apiKey, StationName: station }),
        this.fetchApi(CWA_FORECAST_36HR_ID, { Authorization: this.apiKey, locationName: cwaName }),
      ]);
      return this.parseCurrent(cwaName, obs, fc);
    } catch (e) {
      if (e instanceof LocationNotSupportedError) throw e;
      throw new ProviderError(`CWA API error: ${(e as Error).message}`);
    }
  }

  async getForecast(location: Location, days: number = 7): Promise<WeatherData[]> {
    if (!this.supportsLocation(location)) {
      throw new LocationNotSupportedError(`CWA only supports Taiwanese locations: ${location.raw}`);
    }
    try {
      const cwaName = this.getCwaName(location);
      const data = await this.fetchApi(CWA_FORECAST_1WEEK_ID, { Authorization: this.apiKey, locationName: cwaName });
      return this.parseForecast(cwaName, data, days);
    } catch (e) {
      if (e instanceof LocationNotSupportedError) throw e;
      throw new ProviderError(`CWA API error: ${(e as Error).message}`);
    }
  }

  private getCwaName(location: Location): string {
    return TW_LOCATIONS[location.normalized.toLowerCase()] ?? "臺北市";
  }

  private async fetchApi(dataset: string, params: Record<string, string>): Promise<Record<string, any>> {
    const url = `${CWA_BASE_URL}/${dataset}?${new URLSearchParams(params).toString()}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "WeatherSkill/1.0",
        Accept: "application/json",
      },
    });
    if (!res.ok) throw new ProviderError(`HTTP ${res.status}`);
    return (await res.json()) as Record<string, any>;
  }

  private parseCurrent(cwaName: string, obsData: Record<string, any>, fcData: Record<string, any>): WeatherData {
    const station = obsData.records?.Station?.[0] as Record<string, any> | undefined;
    const elements = (station?.WeatherElement ?? {}) as Record<string, any>;
    const humidity = numberOrUndefined(elements.RelativeHumidity);
    const windDeg = numberOrUndefined(elements.WindDirection);
    const observed = typeof station?.ObsTime?.DateTime === "string"
      ? new Date(station.ObsTime.DateTime)
      : undefined;

    let condition = WeatherCondition.Unknown;
    let description = "";
    let pop: number | undefined;
    for (const elem of fcData.records?.location?.[0]?.weatherElement ?? []) {
      const name = elem.elementName;
      const param = elem.time?.[0]?.parameter ?? {};
      if (name === "Wx") {
        description = String(param.parameterName ?? "");
        condition = textToCondition(description);
      } else if (name === "PoP") {
        pop = parseIntOrUndefined(param.parameterName);
      }
    }

    return makeWeatherData({
      location: cwaName,
      temperature: numberOrUndefined(elements.AirTemperature) ?? 0,
      humidity: humidity == null ? undefined : Math.round(humidity),
      wind_speed: numberOrUndefined(elements.WindSpeed),
      wind_direction: windDeg == null ? undefined : degToCompass(windDeg),
      condition,
      description,
      precipitation_chance: pop,
      observed_at: observed && !Number.isNaN(observed.getTime()) ? observed : undefined,
      provider_name: this.name,
    });
  }

  private parseForecast(cwaName: string, data: Record<string, any>, days: number): WeatherData[] {
    const elements = data.records?.locations?.[0]?.location?.[0]?.weatherElement;
    if (!Array.isArray(elements)) return [];
    let wxTimes: Record<string, any>[] = [];
    let minTemps: Record<string, any>[] = [];
    let maxTemps: Record<string, any>[] = [];
    let pops: Record<string, any>[] = [];
    for (const elem of elements) {
      if (elem.elementName === "Wx") wxTimes = elem.time ?? [];
      else if (elem.elementName === "MinT") minTemps = elem.time ?? [];
      else if (elem.elementName === "MaxT") maxTemps = elem.time ?? [];
      else if (elem.elementName === "PoP12h" || elem.elementName === "PoP") pops = elem.time ?? [];
    }

    const seen = new Set<string>();
    const results: WeatherData[] = [];
    for (let i = 0; i < wxTimes.length && results.length < days; i++) {
      const start = wxTimes[i]?.startTime;
      if (typeof start !== "string") continue;
      const date = new Date(start);
      if (Number.isNaN(date.getTime())) continue;
      const dateKey = start.slice(0, 10);
      if (seen.has(dateKey)) continue;
      seen.add(dateKey);

      const wxText = String(wxTimes[i]?.elementValue?.[0]?.value ?? "");
      results.push(makeWeatherData({
        location: cwaName,
        temperature: numberOrUndefined(minTemps[i]?.elementValue?.[0]?.value) ?? 0,
        temp_high: numberOrUndefined(maxTemps[i]?.elementValue?.[0]?.value),
        temp_low: numberOrUndefined(minTemps[i]?.elementValue?.[0]?.value),
        condition: textToCondition(wxText),
        description: wxText,
        precipitation_chance: parseIntOrUndefined(pops[i]?.elementValue?.[0]?.value),
        forecast_date: new Date(`${dateKey}T00:00:00.000Z`),
        provider_name: this.name,
      }));
    }
    return results;
  }
}

function textToCondition(text: string): WeatherCondition {
  if (!text) return WeatherCondition.Unknown;
  if (CWA_CONDITION_MAP[text]) return CWA_CONDITION_MAP[text];
  if (text.includes("雷")) return WeatherCondition.Thunderstorm;
  if (text.includes("大雨") || text.includes("豪雨")) return WeatherCondition.HeavyRain;
  if (text.includes("雨")) return WeatherCondition.Rain;
  if (text.includes("雪")) return WeatherCondition.Snow;
  if (text.includes("霧")) return WeatherCondition.Fog;
  if (text.includes("陰")) return WeatherCondition.Overcast;
  if (text.includes("多雲")) return WeatherCondition.Cloudy;
  if (text.includes("晴")) return WeatherCondition.Sunny;
  return WeatherCondition.Unknown;
}

function degToCompass(deg: number): string {
  const directions = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return directions[Math.round(deg / 22.5) % 16]!;
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
