/* eslint-disable @typescript-eslint/naming-convention */
/**
 * Base formatter helpers.
 *
 * TypeScript's `IWeatherFormatter` is a structural interface, so this
 * file does not export a class. Instead it re-exports the truncation
 * helper from `utils.ts` and a small abstract shape that concrete
 * formatters share.
 *
 * Mirrors `weather/formatters/base.py`.
 */

import type { IWeatherFormatter, WeatherData } from "../types.js";
import { truncateMessage } from "../utils.js";

/**
 * Convenience base class for formatters that want shared
 * `format()` dispatch and `truncate()` behavior. Concrete formatters
 * supply `format_current` / `format_forecast` (snake_case to match
 * Python method names on the formatter classes — TS-side these are
 * private/protected and never serialized).
 */
export abstract class BaseFormatter implements IWeatherFormatter {
  /** Maximum message length for this platform (code units). */
  protected readonly maxLength: number = 4096;

  abstract get platform(): string;

  protected abstract formatCurrent(data: WeatherData): string;
  protected abstract formatForecast(data: WeatherData[]): string;

  format(data: WeatherData | WeatherData[]): string {
    if (Array.isArray(data)) return this.formatForecast(data);
    return this.formatCurrent(data);
  }

  protected truncate(message: string, suffix: string = "..."): string {
    return truncateMessage(message, this.maxLength, suffix);
  }
}
