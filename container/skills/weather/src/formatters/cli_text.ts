/* eslint-disable @typescript-eslint/naming-convention */
/**
 * CLI text formatter for weather data.
 *
 * Port of `weather/formatters/cli_text.py`. Produces emoji-annotated
 * plain-text reports for terminal display. Only fields with data are
 * rendered — no "N/A" placeholders, matching the Python implementation.
 *
 * Platform string is **"text"** (matches Python's
 * `CliTextFormatter.platform`).
 */

import {
  aqhiStr,
  aqiStr,
  effectiveFeelsLike,
  getEmoji,
  windStr,
} from "../models.js";
import type { WeatherData } from "../types.js";
import {
  formatIsoDate,
  formatTempBare,
  formatTempC,
  formatUv,
  uvDescription,
} from "../utils.js";
import { BaseFormatter } from "./base.js";

export class CliTextFormatter extends BaseFormatter {
  get platform(): string {
    return "text";
  }

  protected formatCurrent(data: WeatherData): string {
    const lines: string[] = [];

    lines.push(`${getEmoji(data.condition)} Weather for ${data.location}`);
    lines.push(`🌡️ Temperature: ${formatTempC(data.temperature)}`);

    const feels = effectiveFeelsLike(data);
    if (Math.abs(feels - data.temperature) > 0.5) {
      lines.push(`   Feels like: ${formatTempC(feels)}`);
    }

    if (data.temp_high != null && data.temp_low != null) {
      lines.push(
        `   Range: ${formatTempBare(data.temp_low)} - ${formatTempBare(data.temp_high)}`,
      );
    }

    if (data.humidity != null) {
      lines.push(`💧 Humidity: ${data.humidity}%`);
    }

    const wind = windStr(data);
    if (wind !== "N/A") {
      lines.push(`💨 Wind: ${wind}`);
    }

    if (data.precipitation_chance != null) {
      lines.push(`🌧️ Rain chance: ${data.precipitation_chance}%`);
    }

    if (data.uv_index != null) {
      lines.push(
        `☀️ UV Index: ${formatUv(data.uv_index)} (${uvDescription(data.uv_index)})`,
      );
    }

    if (data.aqhi != null) {
      lines.push(`🌫️ AQHI: ${aqhiStr(data)}`);
    } else if (data.aqi != null) {
      lines.push(`🌫️ AQI: ${aqiStr(data)}`);
    }

    lines.push(`📍 Provider: ${data.provider_name}`);

    return lines.join("\n");
  }

  protected formatForecast(data: WeatherData[]): string {
    const lines: string[] = ["📊 Weather Forecast\n"];

    for (const day of data) {
      const dateStr = day.forecast_date ? formatIsoDate(day.forecast_date) : "Unknown";
      const tempHigh =
        day.temp_high != null ? formatTempBare(day.temp_high) : "?";
      const tempLow =
        day.temp_low != null ? formatTempBare(day.temp_low) : "?";

      // Match Python: `day.description or day.condition_raw or str(day.condition.value)`
      const condition =
        day.description || day.condition_raw || day.condition;
      lines.push(`${dateStr}: ${tempHigh} / ${tempLow} — ${condition}`);
    }

    return lines.join("\n");
  }
}
