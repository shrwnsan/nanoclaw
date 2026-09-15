/* eslint-disable @typescript-eslint/naming-convention */
/**
 * Telegram MarkdownV2 formatter for weather data.
 *
 * Port of `weather/formatters/telegram.py`. Produces MarkdownV2 output
 * with byte-identical escaping rules — every character listed in
 * `MDV2_ESCAPE_CHARS` (matching the Python regex literal) must be
 * prefixed with a backslash before being inserted into the message.
 *
 * Platform string is **"telegram"** (matches Python's
 * `TelegramFormatter.platform`).
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

/**
 * Characters that MUST be escaped with a backslash in Telegram
 * MarkdownV2. Copied verbatim from `weather/formatters/telegram.py:15`
 * (Python literal: `r'_*[]()~\`>#+-=|{}.!'`). Storing as a `Set` for
 * O(1) lookup in the hot path.
 */
export const MDV2_ESCAPE_CHARS: ReadonlySet<string> = new Set(
  "_*[]()~`>#+-=|{}.!".split(""),
);

/**
 * Escape text for Telegram MarkdownV2. Mirrors `escape_mdv2()` in
 * `weather/formatters/telegram.py`.
 */
export function escapeMdv2(text: string): string {
  let out = "";
  for (const ch of text) {
    if (MDV2_ESCAPE_CHARS.has(ch)) {
      out += "\\" + ch;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Get emoji for a weather condition. Mirrors `get_condition_emoji()`
 * in `weather/formatters/telegram.py` (which itself wraps
 * `CONDITION_EMOJI`).
 */
function conditionEmoji(condition: WeatherCondition): string {
  return getEmoji(condition);
}

export class TelegramFormatter extends BaseFormatter {
  /** Telegram message length limit. */
  protected override readonly maxLength = 4096;

  get platform(): string {
    return "telegram";
  }

  protected formatCurrent(data: WeatherData): string {
    const lines: string[] = [];

    const emoji = conditionEmoji(data.condition);

    // Header date: forecast_date → observed_at → today (local time)
    let dayStr = "";
    if (data.forecast_date) dayStr = formatLongDate(data.forecast_date);
    if (!dayStr && data.observed_at) dayStr = formatLongDate(data.observed_at);
    if (!dayStr) dayStr = formatLongDate(new Date());

    lines.push(
      `${emoji} ${escapeMdv2(data.location)} Weather — ${escapeMdv2(dayStr)}`,
    );
    lines.push("");

    // Temperature line (raw degree sign; °/C/digits don't need escaping)
    let tempStr = `🌡️ ${formatTempC(data.temperature)}`;
    const feels = effectiveFeelsLike(data);
    if (Math.abs(feels - data.temperature) > 0.5) {
      tempStr += ` \\(feels ${formatTempC(feels)}\\)`;
    }
    if (data.temp_high != null && data.temp_low != null) {
      tempStr += ` • High ${formatTempBare(data.temp_high)} / Low ${formatTempBare(data.temp_low)}`;
    }
    lines.push(tempStr);

    // Condition / description
    if (data.description) {
      const desc = truncateDescription(data.description);
      lines.push(`${emoji} ${escapeMdv2(desc)}`);
    } else {
      lines.push(`${emoji} ${escapeMdv2(conditionTitle(data.condition))}`);
    }

    if (data.humidity != null) {
      lines.push(`💧 Humidity: ${data.humidity}%`);
    }

    // Wind — mirror Python's `if data.wind_str and data.wind_str != "N/A"`.
    if (data.wind_description || data.wind_speed != null) {
      const w = data.wind_description
        ? data.wind_description
        : `${Math.round(data.wind_speed as number)} km/h${data.wind_direction ? " " + data.wind_direction : ""}`;
      if (w !== "N/A") {
        const trimmed = w.replace(/\.+$/, "");
        lines.push(`💨 Wind: ${escapeMdv2(trimmed)}`);
      }
    }

    if (data.precipitation_chance != null) {
      lines.push(`🌧️ Rain chance: ${data.precipitation_chance}%`);
    }

    // Air quality — prefer AQHI, then AQI, then unavailable.
    if (data.aqhi != null) {
      const q = aqhiQuality(data.aqhi);
      lines.push(`🌬️ Air Quality: ${escapeMdv2(q)} \\(AQHI ${data.aqhi}\\)`);
    } else if (data.aqi != null) {
      const q = aqiQuality(data.aqi);
      lines.push(`🌬️ Air Quality: ${escapeMdv2(q)} \\(AQI ${data.aqi}\\)`);
    } else {
      lines.push(`🌬️ Air Quality: Data unavailable`);
    }

    if (data.uv_index != null) {
      const desc = uvDescription(data.uv_index);
      lines.push(
        `☀️ UV Index: ${formatUv(data.uv_index)} \\(${escapeMdv2(desc)}\\)`,
      );
    }

    if (data.sunrise || data.sunset) {
      const astro: string[] = [];
      if (data.sunrise) astro.push(`🌅 Sunrise: ${escapeMdv2(data.sunrise)}`);
      if (data.sunset) astro.push(`🌇 Sunset: ${escapeMdv2(data.sunset)}`);
      lines.push(astro.join(" | "));
    }

    const summary = generateSummary(data);
    if (summary) {
      lines.push("");
      lines.push(escapeMdv2(summary));
    }

    return this.truncate(lines.join("\n"));
  }

  protected formatForecast(data: WeatherData[]): string {
    if (data.length === 0) {
      return escapeMdv2("No forecast data available");
    }

    const lines: string[] = [];
    const location = data[0]!.location;
    const days = data.length;
    lines.push(`📊 ${escapeMdv2(location)} ${days}\\-Day Forecast`);
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

      lines.push(
        `${escapeMdv2(dateStr)}: ${emoji} ${escapeMdv2(tempStr)} — ${escapeMdv2(desc)}`,
      );
    }

    return this.truncate(lines.join("\n"));
  }
}
