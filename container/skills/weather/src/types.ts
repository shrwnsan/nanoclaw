/* eslint-disable @typescript-eslint/naming-convention */
/**
 * Core types for the weather skill (Bun/TypeScript runtime).
 *
 * Field names use snake_case throughout to match Python's
 * `dataclasses.asdict()` JSON output exactly. This eliminates the need
 * for a transform shim between the in-memory model and the on-the-wire
 * JSON, and keeps cross-runtime parity tests trivial.
 *
 * Method names on interfaces use camelCase (idiomatic TS) since they
 * never appear in JSON output.
 *
 * Mirrors `weather/models.py`. Any field added or removed here MUST
 * also be reflected in the Python dataclass to preserve parity.
 */

/**
 * Standardized weather conditions. Must match `WeatherCondition` in
 * `weather/models.py` and the canonical list in
 * `weather/data/weather-conditions.json`.
 *
 * 20 values total. Values are snake_case strings.
 */
export enum WeatherCondition {
  Clear = "clear",
  Sunny = "sunny",
  PartlyCloudy = "partly_cloudy",
  Cloudy = "cloudy",
  Overcast = "overcast",
  Fog = "fog",
  Mist = "mist",
  Drizzle = "drizzle",
  Rain = "rain",
  Showers = "showers",
  HeavyRain = "heavy_rain",
  Thunderstorm = "thunderstorm",
  Snow = "snow",
  HeavySnow = "heavy_snow",
  Sleet = "sleet",
  Hail = "hail",
  Windy = "windy",
  Hot = "hot",
  Cold = "cold",
  Unknown = "unknown",
}

/**
 * Standardized weather data structure. Mirrors the
 * `WeatherData` dataclass in `weather/models.py`.
 *
 * Field names are snake_case to match Python's JSON serialization.
 */
export interface WeatherData {
  // Required
  location: string;
  temperature: number; // Celsius

  // Location detail
  latitude?: number;
  longitude?: number;

  // Current conditions
  feels_like?: number;
  humidity?: number; // 0-100
  wind_speed?: number; // km/h
  wind_direction?: string;
  wind_description?: string; // Pre-formatted (e.g. "South force 3")
  pressure?: number; // hPa
  visibility?: number; // km
  uv_index?: number;

  // Conditions
  condition: WeatherCondition;
  condition_raw: string; // Original provider string (default: "")
  description?: string;

  // Timestamps
  observed_at?: Date;
  fetched_at: Date; // Default: now()

  // Forecast
  forecast_date?: Date;
  temp_high?: number;
  temp_low?: number;
  precipitation_chance?: number; // 0-100

  // Air quality
  aqi?: number; // US EPA 1-500
  aqhi?: number; // HK/Canada 1-10+
  pm25?: number;
  pm10?: number;
  o3?: number;
  no2?: number;

  // Astronomy
  sunrise?: string;
  sunset?: string;

  // Provider metadata
  provider_name: string;
}

/**
 * Parsed location information. Mirrors `Location` in
 * `weather/models.py`.
 */
export interface Location {
  raw: string;
  city?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
  /**
   * Lower-cased, trimmed form of `raw` used for provider matching.
   * Populated by `parseLocation()` in `src/models.ts`.
   */
  normalized: string;
}

/**
 * Provider interface. Implementations live under `src/providers/`.
 *
 * Method names use camelCase (they never appear in JSON output).
 */
export interface IWeatherProvider {
  readonly name: string;
  readonly priority: number;
  readonly supportsForecast: boolean;
  readonly supportsAirQuality?: boolean;
  readonly requiresApiKey?: boolean;

  supportsLocation(location: Location): boolean;
  getCurrent(location: Location): Promise<WeatherData>;
  getForecast(location: Location, days?: number): Promise<WeatherData[]>;
}

/**
 * Formatter interface. Implementations live under `src/formatters/`.
 */
export interface IWeatherFormatter {
  readonly platform: string;
  format(data: WeatherData | WeatherData[]): string;
}

/**
 * Options accepted by sender implementations. Channel-specific senders
 * may ignore irrelevant fields.
 */
export interface SendOptions {
  chat_id?: string;
  topic_id?: number;
  [key: string]: unknown;
}

/**
 * Result of a sender call.
 *
 * Mirrors `SendResult` in `weather/senders/base.py`. The Python
 * dataclass does not include a `channel` field — that field is a
 * TypeScript convenience used by the WeatherSkill fallback path
 * when no sender is registered.
 */
export interface SendResult {
  success: boolean;
  channel: string;
  message_id?: string | number;
  error?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Sender interface. Implementations live under `src/senders/`.
 */
export interface IWeatherSender {
  readonly channel: string;
  send(message: string, options?: SendOptions): Promise<SendResult>;
}

/**
 * Errors raised by providers. Mirrors `weather/providers/base.py`.
 */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

export class LocationNotSupportedError extends ProviderError {
  constructor(message: string) {
    super(message);
    this.name = "LocationNotSupportedError";
  }
}

export class NoProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoProviderError";
  }
}

/**
 * Errors raised by formatters. Mirrors `FormatterError` in
 * `weather/formatters/base.py`.
 */
export class FormatterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormatterError";
  }
}

/**
 * Errors raised by senders. Mirrors `SenderError` in
 * `weather/senders/base.py`.
 */
export class SenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SenderError";
  }
}
