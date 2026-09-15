/* eslint-disable @typescript-eslint/naming-convention */
/**
 * WhatsApp formatter for weather data.
 *
 * Port of `weather/formatters/whatsapp.py`. Uses WhatsApp's
 * lightweight formatting syntax (`*bold*`, `_italic_`) with no
 * MarkdownV2-style escaping required.
 *
 * Platform string is **"whatsapp"** (matches Python's
 * `WhatsAppFormatter.platform`).
 */

import { effectiveFeelsLike, getEmoji } from "../models.js";
import type { WeatherData } from "../types.js";
import { WeatherCondition } from "../types.js";
import {
  aqhiQuality,
  aqiQuality,
  conditionTitle,
  formatLongDate,
  formatShortDate,
  formatTempBare,
  formatTempC,
  formatUv,
  generateSummary,
  truncateDescription,
  uvDescription,
} from "../utils.js";
import { BaseFormatter } from "./base.js";

function conditionEmoji(condition: WeatherCondition): string {
  return getEmoji(condition);
}

export class WhatsAppFormatter extends BaseFormatter {
  /** WhatsApp message length limit (matches Python). */
  protected override readonly maxLength = 65536;

  get platform(): string {
    return "whatsapp";
  }

  protected formatCurrent(data: WeatherData): string {
    const lines: string[] = [];

    const emoji = conditionEmoji(data.condition);

    // Header date
    let dayStr = "";
    if (data.forecast_date) dayStr = formatLongDate(data.forecast_date);
    if (!dayStr && data.observed_at) dayStr = formatLongDate(data.observed_at);
    if (!dayStr) dayStr = formatLongDate(new Date());

    lines.push(`*${emoji} ${data.location} Weather — ${dayStr}*`);
    lines.push("");

    // Temperature line
    let tempStr = `🌡️ ${formatTempC(data.temperature)}`;
    const feels = effectiveFeelsLike(data);
    if (Math.abs(feels - data.temperature) > 0.5) {
      tempStr += ` (feels ${formatTempC(feels)})`;
    }
    if (data.temp_high != null && data.temp_low != null) {
      tempStr += ` • High ${formatTempBare(data.temp_high)} / Low ${formatTempBare(data.temp_low)}`;
    }
    lines.push(tempStr);

    // Condition / description
    if (data.description) {
      lines.push(`${emoji} ${truncateDescription(data.description)}`);
    } else {
      lines.push(`${emoji} ${conditionTitle(data.condition)}`);
    }

    if (data.humidity != null) {
      lines.push(`💧 Humidity: ${data.humidity}%`);
    }

    // Wind — mirror Python's `if data.wind_str and data.wind_str != "N/A"`.
    // The literal `"N/A"` filter is defensive: real providers never feed
    // it in, but a hand-built `wind_description` could.
    if (data.wind_description || data.wind_speed != null) {
      const w = data.wind_description
        ? data.wind_description
        : `${Math.round(data.wind_speed as number)} km/h${data.wind_direction ? " " + data.wind_direction : ""}`;
      if (w !== "N/A") {
        const trimmed = w.replace(/\.+$/, "");
        lines.push(`💨 Wind: ${trimmed}`);
      }
    }

    if (data.precipitation_chance != null) {
      lines.push(`🌧️ Rain chance: ${data.precipitation_chance}%`);
    }

    // Air quality — Python's whatsapp.py omits the "Data unavailable"
    // fallback that telegram.py has; keep the asymmetry for parity.
    if (data.aqhi != null) {
      lines.push(
        `🌬️ Air Quality: ${aqhiQuality(data.aqhi)} (AQHI ${data.aqhi})`,
      );
    } else if (data.aqi != null) {
      lines.push(
        `🌬️ Air Quality: ${aqiQuality(data.aqi)} (AQI ${data.aqi})`,
      );
    }

    if (data.uv_index != null) {
      lines.push(
        `☀️ UV Index: ${formatUv(data.uv_index)} (${uvDescription(data.uv_index)})`,
      );
    }

    if (data.sunrise || data.sunset) {
      const astro: string[] = [];
      if (data.sunrise) astro.push(`🌅 Sunrise: ${data.sunrise}`);
      if (data.sunset) astro.push(`🌇 Sunset: ${data.sunset}`);
      lines.push(astro.join(" | "));
    }

    const summary = generateSummary(data);
    if (summary) {
      lines.push("");
      lines.push(`_${summary}_`);
    }

    return this.truncate(lines.join("\n"));
  }

  protected formatForecast(data: WeatherData[]): string {
    if (data.length === 0) {
      return "No forecast data available";
    }

    const lines: string[] = [];
    const location = data[0]!.location;
    const days = data.length;
    lines.push(`*📊 ${location} ${days}-Day Forecast*`);
    lines.push("");

    for (const day of data) {
      const emoji = conditionEmoji(day.condition);
      const dateStr = day.forecast_date
        ? formatShortDate(day.forecast_date)
        : "Unknown";

      let tempStr = "";
      if (day.temp_high != null && day.temp_low != null) {
        tempStr = `${formatTempBare(day.temp_high)} / ${formatTempBare(day.temp_low)}`;
      } else if (day.temperature != null) {
        tempStr = formatTempBare(day.temperature);
      }

      const desc = day.description || conditionTitle(day.condition);
      lines.push(`${dateStr}: ${emoji} ${tempStr} — ${desc}`);
    }

    return this.truncate(lines.join("\n"));
  }
}
