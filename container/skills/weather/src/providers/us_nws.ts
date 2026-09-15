/* eslint-disable @typescript-eslint/naming-convention */
/**
 * United States National Weather Service (NWS) Weather Provider.
 *
 * Fetches weather data from NWS public API.
 * Free, no API key required. USA coverage only.
 *
 * API Documentation: https://www.weather.gov/documentation/services-web-api
 *
 * Mirrors `weather/providers/us_nws.py`.
 */

import { US_NWS_CITIES } from "../data-loader.js";
import { makeWeatherData } from "../models.js";
import type { IWeatherProvider, Location, WeatherData } from "../types.js";
import {
  LocationNotSupportedError,
  ProviderError,
  WeatherCondition,
} from "../types.js";

// NWS API endpoints
const NWS_BASE_URL = "https://api.weather.gov";

// Required by NWS — requests without this header are rejected with 403.
// Mirrors `weather/providers/us_nws.py:133`.
const NWS_USER_AGENT = "WeatherSkill/1.0 (support@weather-skill.io)";

// Supported locations (mirror weather/providers/us_nws.py:39-52)
const SUPPORTED_LOCATIONS: ReadonlySet<string> = new Set([
  "usa", "united states", "america", "us",
  "new york", "los angeles", "chicago", "houston",
  "phoenix", "philadelphia", "san antonio", "san diego",
  "dallas", "san jose", "austin", "jacksonville",
  "fort worth", "columbus", "charlotte", "san francisco",
  "indianapolis", "seattle", "denver", "washington dc",
  "boston", "nashville", "detroit", "portland",
  "las vegas", "memphis", "louisville", "baltimore",
  "milwaukee", "albuquerque", "tucson", "fresno",
  "sacramento", "kansas city", "atlanta", "miami",
  "orlando", "minneapolis", "pittsburgh", "st louis",
  "cleveland", "new orleans", "tampa", "honolulu", "anchorage",
]);

const CARDINAL_DIRECTIONS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
] as const;

/**
 * US National Weather Service weather provider.
 *
 * - Free, no API key required
 * - USA coverage only
 * - Provides current weather and 7-day forecast
 */
export class NWSProvider implements IWeatherProvider {
  readonly name = "nws";
  readonly priority = 7; // After other regional providers
  readonly supportsForecast = true;
  readonly supportsAirQuality = false;
  readonly requiresApiKey = false;

  /** Check if location is in the USA. */
  supportsLocation(location: Location): boolean {
    const normalized = location.normalized.toLowerCase();
    if (SUPPORTED_LOCATIONS.has(normalized)) return true;
    for (const city of Object.keys(US_NWS_CITIES)) {
      if (normalized.includes(city)) return true;
    }
    return false;
  }

  /** Fetch current weather for US location. */
  async getCurrent(location: Location): Promise<WeatherData> {
    if (!this.supportsLocation(location)) {
      throw new LocationNotSupportedError(
        `NWS only supports US locations: ${location.raw}`,
      );
    }

    try {
      const [lat, lon] = this.getCoordinates(location);
      const gridData = await this.fetchGridpoint(lat, lon);
      const stationData = await this.fetchObservations(gridData);
      return this.parseCurrent(location, stationData);
    } catch (e) {
      if (e instanceof LocationNotSupportedError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new ProviderError(`NWS API error: ${msg}`);
    }
  }

  /** Fetch weather forecast for US location. */
  async getForecast(
    location: Location,
    days: number = 7,
  ): Promise<WeatherData[]> {
    if (!this.supportsLocation(location)) {
      throw new LocationNotSupportedError(
        `NWS only supports US locations: ${location.raw}`,
      );
    }

    try {
      const [lat, lon] = this.getCoordinates(location);
      const gridData = await this.fetchGridpoint(lat, lon);
      const forecastData = await this.fetchForecast(gridData);
      return this.parseForecast(location, forecastData, days);
    } catch (e) {
      if (e instanceof LocationNotSupportedError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new ProviderError(`NWS API error: ${msg}`);
    }
  }

  /** Get coordinates for US location. Defaults to New York. */
  private getCoordinates(location: Location): [number, number] {
    const normalized = location.normalized.toLowerCase();
    for (const [city, coords] of Object.entries(US_NWS_CITIES)) {
      if (normalized.includes(city)) return coords;
    }
    return US_NWS_CITIES["new york"]!;
  }

  /**
   * GET an NWS endpoint with the required `User-Agent` header. Without
   * this header NWS returns HTTP 403.
   */
  private async fetchJson(url: string): Promise<Record<string, any>> {
    const response = await fetch(url, {
      headers: {
        "User-Agent": NWS_USER_AGENT,
        "Accept": "application/json",
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as Record<string, any>;
  }

  /** Fetch gridpoint metadata (forecast/station URLs) for coordinates. */
  private async fetchGridpoint(
    latitude: number,
    longitude: number,
  ): Promise<Record<string, any>> {
    const url = `${NWS_BASE_URL}/points/${latitude},${longitude}`;
    return this.fetchJson(url);
  }

  /** Fetch current observations from nearest station. */
  private async fetchObservations(
    gridData: Record<string, any>,
  ): Promise<Record<string, any>> {
    const stationsUrl: string | undefined =
      gridData.properties?.observationStations;
    if (!stationsUrl) {
      throw new ProviderError("No observation stations available");
    }

    const stationsData = await this.fetchJson(stationsUrl);
    const features: Record<string, any>[] = stationsData.features ?? [];
    const stationId: string | undefined =
      features[0]?.properties?.stationIdentifier;
    if (!stationId) {
      throw new ProviderError("No station identifier found");
    }

    const obsUrl = `${NWS_BASE_URL}/stations/${stationId}/observations/latest`;
    return this.fetchJson(obsUrl);
  }

  /** Fetch forecast data from NWS. */
  private async fetchForecast(
    gridData: Record<string, any>,
  ): Promise<Record<string, any>> {
    const forecastUrl: string | undefined = gridData.properties?.forecast;
    if (!forecastUrl) {
      throw new ProviderError("No forecast URL available");
    }
    return this.fetchJson(forecastUrl);
  }

  /** Parse current weather from NWS observation response. */
  private parseCurrent(
    location: Location,
    data: Record<string, any>,
  ): WeatherData {
    const properties: Record<string, any> = data.properties ?? {};

    // Temperature (NWS observation values are already Celsius)
    const tempC: number | null | undefined = properties.temperature?.value;
    const temp = tempC != null ? tempC : 0.0;

    // Other observations
    const humidity: number | null | undefined =
      properties.relativeHumidity?.value;
    const windSpeedMps: number | null | undefined = properties.windSpeed?.value;
    const windSpeed = windSpeedMps != null ? windSpeedMps * 3.6 : undefined; // m/s → km/h
    const windDir: number | null | undefined = properties.windDirection?.value;
    const pressure: number | null | undefined =
      properties.barometricPressure?.value;
    const visibility: number | null | undefined = properties.visibility?.value;
    const feelsLikeC: number | null | undefined =
      properties.heatIndex?.value ?? properties.windChill?.value;

    // Text description
    const description: string = properties.textDescription ?? "";
    const condition = this.mapCondition(description);

    // Parse timestamp (ISO-8601, may end in `Z`)
    const timestamp: string = properties.timestamp ?? "";
    let observedAt: Date;
    const parsed = timestamp ? new Date(timestamp) : new Date(NaN);
    if (!Number.isNaN(parsed.getTime())) {
      observedAt = parsed;
    } else {
      observedAt = new Date();
    }

    const displayName = this.getDisplayName(location);
    const windDirection = windDir != null ? this.degToDirection(windDir) : undefined;

    return makeWeatherData({
      location: displayName,
      temperature: temp,
      ...(feelsLikeC != null ? { feels_like: feelsLikeC } : {}),
      ...(humidity != null ? { humidity: Math.trunc(humidity) } : {}),
      ...(windSpeed != null ? { wind_speed: windSpeed } : {}),
      ...(windDirection != null ? { wind_direction: windDirection } : {}),
      ...(pressure != null ? { pressure: pressure / 100 } : {}), // Pa → hPa
      ...(visibility != null ? { visibility: visibility / 1000 } : {}), // m → km
      condition,
      condition_raw: description,
      ...(description ? { description } : {}),
      observed_at: observedAt,
      fetched_at: new Date(),
      provider_name: this.name,
    });
  }

  /** Parse forecast from NWS response. */
  private parseForecast(
    location: Location,
    data: Record<string, any>,
    days: number,
  ): WeatherData[] {
    const properties: Record<string, any> = data.properties ?? {};
    const periods: Record<string, any>[] = properties.periods ?? [];

    const results: WeatherData[] = [];
    const displayName = this.getDisplayName(location);
    const seenDates = new Set<string>();

    for (const period of periods) {
      if (results.length >= days) break;

      const startTime: string = period.startTime ?? "";
      const fcDateTime = startTime ? new Date(startTime) : new Date(NaN);
      if (Number.isNaN(fcDateTime.getTime())) continue;

      // Mirror Python's `datetime.fromisoformat(...).date()` — preserve
      // the LOCAL calendar date from the ISO offset, not UTC. Otherwise
      // a US-eastern-time period like "2026-05-13T23:00:00-04:00"
      // (local: 2026-05-13) would dedupe as 2026-05-14 in UTC and
      // misassign the forecast day.
      const localDateMatch = startTime.match(/^(\d{4}-\d{2}-\d{2})/);
      if (!localDateMatch) continue;
      const dateKey = localDateMatch[1]!;
      if (seenDates.has(dateKey)) continue;
      seenDates.add(dateKey);

      // Forecast date (midnight UTC of the period's local date —
      // matches Python's naive `datetime.date()` JSON serialization).
      const fcDate = new Date(`${dateKey}T00:00:00Z`);

      // Temperature — NWS forecast uses Fahrenheit by default.
      const temp: number = period.temperature ?? 0;
      const tempUnit: string = period.temperatureUnit ?? "F";
      const tempC = tempUnit === "F" ? ((temp - 32) * 5) / 9 : temp;

      const shortForecast: string = period.shortForecast ?? "";
      const condition = this.mapCondition(shortForecast);

      const windStr: string = period.windSpeed ?? "";
      const windSpeed = this.parseWindSpeed(windStr);
      const windDir: string = period.windDirection ?? "";
      const detailedForecast: string = period.detailedForecast ?? "";
      const isDaytime: boolean = period.isDaytime === true;

      results.push(
        makeWeatherData({
          location: displayName,
          temperature: tempC,
          ...(isDaytime ? { temp_high: tempC } : { temp_low: tempC }),
          forecast_date: fcDate,
          condition,
          condition_raw: shortForecast,
          ...(detailedForecast ? { description: detailedForecast } : {}),
          ...(windSpeed != null ? { wind_speed: windSpeed } : {}),
          ...(windDir ? { wind_direction: windDir } : {}),
          fetched_at: new Date(),
          provider_name: this.name,
        }),
      );
    }

    return results;
  }

  /** Get display name for location. */
  private getDisplayName(location: Location): string {
    const normalized = location.normalized.toLowerCase();
    for (const city of Object.keys(US_NWS_CITIES)) {
      if (normalized.includes(city)) {
        return city.replace(/\b\w/g, (c) => c.toUpperCase());
      }
    }
    return "United States";
  }

  /**
   * Map NWS condition text to WeatherCondition via keyword matching.
   * Mirrors `_map_condition` in `weather/providers/us_nws.py`.
   *
   * Note: We intentionally do NOT use `NWS_CONDITION_MAP` from the
   * data loader — that map is keyed on METAR codes (`skc`, `few`,
   * `bkn`, …), not the descriptive text NWS returns in
   * `textDescription` / `shortForecast`.
   */
  private mapCondition(conditionStr: string): WeatherCondition {
    if (!conditionStr) return WeatherCondition.Unknown;
    const normalized = conditionStr.toLowerCase().trim();

    if (
      normalized.includes("sunny") ||
      normalized.includes("clear") ||
      normalized.includes("fair")
    ) return WeatherCondition.Sunny;
    if (
      normalized.includes("partly cloud") ||
      normalized.includes("mostly sunny")
    ) return WeatherCondition.PartlyCloudy;
    if (normalized.includes("cloud") || normalized.includes("overcast")) {
      return WeatherCondition.Cloudy;
    }
    if (normalized.includes("shower")) return WeatherCondition.Showers;
    if (normalized.includes("rain")) return WeatherCondition.Rain;
    if (normalized.includes("thunder") || normalized.includes("t-storm")) {
      return WeatherCondition.Thunderstorm;
    }
    if (normalized.includes("snow")) return WeatherCondition.Snow;
    if (normalized.includes("fog")) return WeatherCondition.Fog;
    if (normalized.includes("wind") || normalized.includes("breezy")) {
      return WeatherCondition.Windy;
    }
    if (normalized.includes("sleet") || normalized.includes("freezing rain")) {
      return WeatherCondition.Sleet;
    }
    if (normalized.includes("hail")) return WeatherCondition.Hail;

    return WeatherCondition.Unknown;
  }

  /**
   * Parse wind speed from NWS string like `"10 to 15 mph"` or
   * `"10 mph"`. Returns km/h, or `undefined` if no number is found.
   */
  private parseWindSpeed(windStr: string): number | undefined {
    if (!windStr) return undefined;
    const matches = windStr.match(/\d+/g);
    if (!matches || matches.length === 0) return undefined;
    const speeds = matches.map((n) => Number.parseInt(n, 10));
    const avgMph = speeds.reduce((a, b) => a + b, 0) / speeds.length;
    return avgMph * 1.60934; // mph → km/h
  }

  /** Convert wind degrees to a 16-point cardinal direction string. */
  private degToDirection(deg: number): string {
    const index = Math.round(deg / 22.5) % 16;
    return CARDINAL_DIRECTIONS[(index + 16) % 16]!;
  }
}
