/* eslint-disable @typescript-eslint/naming-convention */
/** UK Met Office DataHub provider. */

import { METOFFICE_CITIES, METOFFICE_CONDITION_MAP } from "../data-loader.js";
import { makeWeatherData } from "../models.js";
import {
  type IWeatherProvider,
  type Location,
  LocationNotSupportedError,
  ProviderError,
  WeatherCondition,
  type WeatherData,
} from "../types.js";

const METOFFICE_BASE_URL = "https://data.hub.api.metoffice.gov.uk/sitespecific/v0/point";
const SUPPORTED_LOCATIONS = new Set([
  ...Object.keys(METOFFICE_CITIES),
  "uk", "united kingdom", "britain", "england", "scotland", "wales", "northern ireland", "英國",
]);

export class UKMetOfficeProvider implements IWeatherProvider {
  readonly name = "metoffice";
  readonly priority = 5;
  readonly supportsForecast = true;
  readonly supportsAirQuality = false;
  readonly requiresApiKey = true;

  private readonly apiKey: string;

  constructor(apiKey: string = process.env.METOFFICE_API_KEY ?? "") {
    this.apiKey = apiKey;
  }

  supportsLocation(location: Location): boolean {
    if (!this.apiKey) return false;
    return SUPPORTED_LOCATIONS.has(location.normalized.toLowerCase());
  }

  async getCurrent(location: Location): Promise<WeatherData> {
    if (!this.supportsLocation(location)) {
      throw new LocationNotSupportedError(`Met Office only supports UK locations: ${location.raw}`);
    }
    try {
      const [lat, lon] = this.getCoordinates(location);
      const data = await this.fetchApi(`${METOFFICE_BASE_URL}/hourly`, lat, lon);
      return this.parseCurrent(location, data);
    } catch (e) {
      if (e instanceof LocationNotSupportedError) throw e;
      throw new ProviderError(`Met Office API error: ${(e as Error).message}`);
    }
  }

  async getForecast(location: Location, days: number = 7): Promise<WeatherData[]> {
    if (!this.supportsLocation(location)) {
      throw new LocationNotSupportedError(`Met Office only supports UK locations: ${location.raw}`);
    }
    try {
      const [lat, lon] = this.getCoordinates(location);
      const data = await this.fetchApi(`${METOFFICE_BASE_URL}/daily`, lat, lon);
      return this.parseForecast(location, data, days);
    } catch (e) {
      if (e instanceof LocationNotSupportedError) throw e;
      throw new ProviderError(`Met Office API error: ${(e as Error).message}`);
    }
  }

  private getCoordinates(location: Location): [number, number] {
    const normalized = location.normalized.toLowerCase();
    if (METOFFICE_CITIES[normalized]) return METOFFICE_CITIES[normalized];
    for (const [city, coords] of Object.entries(METOFFICE_CITIES)) {
      if (city.includes(normalized) || normalized.includes(city)) return coords;
    }
    return METOFFICE_CITIES.london!;
  }

  private async fetchApi(baseUrl: string, lat: number, lon: number): Promise<Record<string, any>> {
    const url = `${baseUrl}?${new URLSearchParams({ latitude: lat.toFixed(4), longitude: lon.toFixed(4) }).toString()}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "WeatherSkill/1.0",
        Accept: "application/json",
        apikey: this.apiKey,
      },
    });
    if (!res.ok) throw new ProviderError(`HTTP ${res.status}`);
    return (await res.json()) as Record<string, any>;
  }

  private parseCurrent(location: Location, data: Record<string, any>): WeatherData {
    const features = Array.isArray(data.features) ? data.features : [];
    if (features.length === 0) throw new ProviderError("No data returned from Met Office API");
    const series = features[0]?.properties?.timeSeries;
    if (!Array.isArray(series) || series.length === 0) throw new ProviderError("No time series data from Met Office API");
    const current = series[0] as Record<string, any>;
    const humidity = numberOrUndefined(current.screenRelativeHumidity);
    const windMs = numberOrUndefined(current.windSpeed10m);
    const windDir = numberOrUndefined(current.windDirectionFrom10m);
    const visibility = numberOrUndefined(current.visibility);
    const observed = typeof current.time === "string" ? new Date(current.time) : undefined;

    return makeWeatherData({
      location: this.getDisplayName(location),
      temperature: numberOrUndefined(current.screenTemperature) ?? 0,
      feels_like: numberOrUndefined(current.feelsLikeTemperature),
      humidity: humidity == null ? undefined : Math.round(humidity),
      wind_speed: windMs == null ? undefined : Math.round(windMs * 36) / 10,
      wind_direction: windDir == null ? undefined : degToCompass(windDir),
      condition: METOFFICE_CONDITION_MAP[String(current.significantWeatherCode ?? -1)] ?? WeatherCondition.Unknown,
      visibility: visibility == null ? undefined : visibility / 1000,
      uv_index: numberOrUndefined(current.uvIndex),
      precipitation_chance: numberOrUndefined(current.probOfPrecipitation),
      observed_at: observed && !Number.isNaN(observed.getTime()) ? observed : undefined,
      provider_name: this.name,
    });
  }

  private parseForecast(location: Location, data: Record<string, any>, days: number): WeatherData[] {
    const series = data.features?.[0]?.properties?.timeSeries;
    if (!Array.isArray(series)) return [];
    return (series as Record<string, any>[]).slice(0, days).flatMap((entry) => {
      const date = typeof entry.time === "string" ? new Date(entry.time) : undefined;
      if (!date || Number.isNaN(date.getTime())) return [];
      const windMs = numberOrUndefined(entry.midday10MWindSpeed);
      const windDir = numberOrUndefined(entry.midday10MWindDirection);
      const humidity = numberOrUndefined(entry.middayRelativeHumidity);
      const code = entry.daySignificantWeatherCode ?? entry.nightSignificantWeatherCode ?? -1;
      return [makeWeatherData({
        location: this.getDisplayName(location),
        temperature: numberOrUndefined(entry.nightMinScreenTemperature) ?? 0,
        temp_high: numberOrUndefined(entry.dayMaxScreenTemperature),
        temp_low: numberOrUndefined(entry.nightMinScreenTemperature),
        humidity: humidity == null ? undefined : Math.round(humidity),
        wind_speed: windMs == null ? undefined : Math.round(windMs * 36) / 10,
        wind_direction: windDir == null ? undefined : degToCompass(windDir),
        condition: METOFFICE_CONDITION_MAP[String(code)] ?? WeatherCondition.Unknown,
        uv_index: numberOrUndefined(entry.maxUvIndex),
        precipitation_chance: numberOrUndefined(entry.dayProbabilityOfPrecipitation ?? entry.nightProbabilityOfPrecipitation),
        forecast_date: new Date(`${date.toISOString().slice(0, 10)}T00:00:00.000Z`),
        provider_name: this.name,
      })];
    });
  }

  private getDisplayName(location: Location): string {
    const normalized = location.normalized.toLowerCase();
    for (const city of Object.keys(METOFFICE_CITIES)) {
      if (city === normalized) return titleCase(city);
    }
    return titleCase(location.raw);
  }
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

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (c) => c.toUpperCase());
}
