/* eslint-disable @typescript-eslint/naming-convention */
/** New Zealand MetService provider using the public local observations API. */

import { makeWeatherData } from "../models.js";
import {
  type IWeatherProvider,
  type Location,
  LocationNotSupportedError,
  ProviderError,
  WeatherCondition,
  type WeatherData,
} from "../types.js";

const METSERVICE_LOCAL_OBS = "https://www.metservice.com/publicData/localObs";

const NZ_LOCATIONS: Record<string, { id: string; lat: number; lon: number }> = {
  auckland: { id: "auckland", lat: -36.8509, lon: 174.7645 },
  wellington: { id: "wellington", lat: -41.2865, lon: 174.7762 },
  christchurch: { id: "christchurch", lat: -43.5321, lon: 172.6362 },
  hamilton: { id: "hamilton", lat: -37.7826, lon: 175.2529 },
  tauranga: { id: "tauranga", lat: -37.6878, lon: 176.1651 },
  dunedin: { id: "dunedin", lat: -45.8788, lon: 170.5028 },
  "palmerston north": { id: "palmerstonNorth", lat: -40.3563, lon: 175.6111 },
  napier: { id: "napier", lat: -39.4928, lon: 176.9125 },
  nelson: { id: "nelson", lat: -41.2708, lon: 173.2840 },
  rotorua: { id: "rotorua", lat: -38.1368, lon: 176.2497 },
  "new plymouth": { id: "newPlymouth", lat: -39.0556, lon: 174.0753 },
  whangarei: { id: "whangarei", lat: -35.7251, lon: 174.3237 },
  invercargill: { id: "invercargill", lat: -46.4132, lon: 168.3538 },
  gisborne: { id: "gisborne", lat: -38.6624, lon: 178.0179 },
  wanganui: { id: "wanganui", lat: -39.9299, lon: 175.0514 },
  whanganui: { id: "wanganui", lat: -39.9299, lon: 175.0514 },
  "hawke's bay": { id: "hawkesBay", lat: -39.6, lon: 176.85 },
};

const SUPPORTED_LOCATIONS = new Set([
  "new zealand",
  "nz",
  "aotearoa",
  "whanganui",
  ...Object.keys(NZ_LOCATIONS),
]);

export class MetServiceProvider implements IWeatherProvider {
  readonly name = "metservice";
  readonly priority = 7;
  readonly supportsForecast = false;
  readonly supportsAirQuality = false;
  readonly requiresApiKey = false;

  supportsLocation(location: Location): boolean {
    const normalized = location.normalized.toLowerCase();
    return SUPPORTED_LOCATIONS.has(normalized) || Object.keys(NZ_LOCATIONS).some((city) => normalized.includes(city));
  }

  async getCurrent(location: Location): Promise<WeatherData> {
    if (!this.supportsLocation(location)) {
      throw new LocationNotSupportedError(
        `MetService only supports New Zealand locations: ${location.raw}`,
      );
    }

    try {
      const locationInfo = this.getLocationInfo(location);
      const data = await this.fetchObservations(locationInfo.id);
      return this.parseCurrent(location, data);
    } catch (e) {
      if (e instanceof LocationNotSupportedError) throw e;
      throw new ProviderError(`MetService API error: ${(e as Error).message}`);
    }
  }

  async getForecast(location: Location, _days: number = 10): Promise<WeatherData[]> {
    if (!this.supportsLocation(location)) {
      throw new LocationNotSupportedError(
        `MetService only supports New Zealand locations: ${location.raw}`,
      );
    }
    return [];
  }

  private getLocationInfo(location: Location): { id: string; lat: number; lon: number } {
    const normalized = location.normalized.toLowerCase();
    for (const [city, info] of Object.entries(NZ_LOCATIONS)) {
      if (city === normalized || normalized.includes(city)) return info;
    }
    return NZ_LOCATIONS.auckland!;
  }

  private async fetchObservations(locationId: string): Promise<Record<string, any>> {
    const url = `${METSERVICE_LOCAL_OBS}_${locationId}`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; WeatherSkill/1.0)",
          Accept: "application/json",
        },
      });
    } catch (e) {
      throw new ProviderError((e as Error).message);
    }
    if (!res.ok) throw new ProviderError(`HTTP ${res.status}`);
    return (await res.json()) as Record<string, any>;
  }

  private parseCurrent(location: Location, data: Record<string, any>): WeatherData {
    const obs = (data.threeHour ?? {}) as Record<string, any>;
    const outlook = (data.twentyFourHour ?? {}) as Record<string, any>;
    const rainfall = parseFloatOrUndefined(outlook.rainfall);
    const hasRain = rainfall != null && rainfall > 0;
    const obsTime = typeof obs.dateTimeISO === "string" ? new Date(obs.dateTimeISO) : undefined;

    return makeWeatherData({
      location: this.getDisplayName(location),
      temperature: parseFloatOrUndefined(obs.temp) ?? 0,
      feels_like: parseFloatOrUndefined(obs.windChill),
      humidity: parseIntOrUndefined(obs.humidity),
      wind_speed: parseFloatOrUndefined(obs.windSpeed),
      wind_direction: typeof obs.windDirection === "string" ? obs.windDirection : undefined,
      pressure: parseFloatOrUndefined(obs.pressure),
      condition: hasRain ? WeatherCondition.Rain : WeatherCondition.Sunny,
      condition_raw: hasRain ? "Rain" : "Fine",
      observed_at: obsTime && !Number.isNaN(obsTime.getTime()) ? obsTime : new Date(),
      provider_name: this.name,
    });
  }

  private getDisplayName(location: Location): string {
    const normalized = location.normalized.toLowerCase();
    for (const city of Object.keys(NZ_LOCATIONS)) {
      if (normalized.includes(city)) return titleCase(city);
    }
    return "New Zealand";
  }
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
