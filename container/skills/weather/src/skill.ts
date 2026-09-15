/* eslint-disable @typescript-eslint/naming-convention */
/**
 * WeatherSkill orchestrator.
 *
 * Port of `weather/skill.py`. Coordinates the provider chain,
 * formatters, and senders.
 */

import {
  getEmoji,
  humidityStr,
  parseLocation,
  tempRangeStr,
  windStr,
} from "./models.js";
import {
  type IWeatherFormatter,
  type IWeatherProvider,
  type IWeatherSender,
  NoProviderError,
  ProviderError,
  type SendOptions,
  type SendResult,
  type WeatherData,
} from "./types.js";

export interface WeatherSkillInit {
  providers?: IWeatherProvider[];
  formatters?: Record<string, IWeatherFormatter>;
  senders?: Record<string, IWeatherSender>;
}

export class WeatherSkill {
  private readonly _providers: IWeatherProvider[];
  private readonly _formatters: Record<string, IWeatherFormatter>;
  private readonly _senders: Record<string, IWeatherSender>;

  constructor(init: WeatherSkillInit = {}) {
    this._providers = (init.providers ?? []).slice();
    this._formatters = { ...(init.formatters ?? {}) };
    this._senders = { ...(init.senders ?? {}) };
    // Sort providers by priority (lower = higher priority).
    this._providers.sort((a, b) => a.priority - b.priority);
  }

  // ── Mutation helpers (mirror Python) ─────────────────────────────

  addProvider(provider: IWeatherProvider): void {
    this._providers.push(provider);
    this._providers.sort((a, b) => a.priority - b.priority);
  }

  addFormatter(platform: string, formatter: IWeatherFormatter): void {
    this._formatters[platform] = formatter;
  }

  addSender(channel: string, sender: IWeatherSender): void {
    this._senders[channel] = sender;
  }

  // ── Core API ─────────────────────────────────────────────────────

  async getCurrent(
    location: string,
    providerName?: string,
  ): Promise<WeatherData> {
    const loc = parseLocation(location);

    if (providerName) {
      const provider = this._providers.find((p) => p.name === providerName);
      if (!provider) {
        throw new NoProviderError(`Provider not found: ${providerName}`);
      }
      const data = await provider.getCurrent(loc);
      data.provider_name = provider.name;
      return data;
    }

    const errors: string[] = [];
    for (const provider of this._providers) {
      if (!provider.supportsLocation(loc)) continue;
      try {
        const data = await provider.getCurrent(loc);
        data.provider_name = provider.name;
        return data;
      } catch (e) {
        if (e instanceof ProviderError) {
          errors.push(`${provider.name}: ${e.message}`);
          continue;
        }
        throw e;
      }
    }

    if (errors.length > 0) {
      throw new ProviderError(`All providers failed: ${errors.join("; ")}`);
    }
    throw new NoProviderError(`No provider supports location: ${location}`);
  }

  async getForecast(
    location: string,
    days: number = 3,
    providerName?: string,
  ): Promise<WeatherData[]> {
    const loc = parseLocation(location);

    if (providerName) {
      const provider = this._providers.find((p) => p.name === providerName);
      if (!provider) {
        throw new NoProviderError(`Provider not found: ${providerName}`);
      }
      const data = await provider.getForecast(loc, days);
      for (const d of data) d.provider_name = provider.name;
      return data;
    }

    for (const provider of this._providers) {
      if (!provider.supportsLocation(loc)) continue;
      if (!provider.supportsForecast) continue;
      try {
        const data = await provider.getForecast(loc, days);
        for (const d of data) d.provider_name = provider.name;
        return data;
      } catch (e) {
        if (e instanceof ProviderError) continue;
        throw e;
      }
    }

    throw new NoProviderError(`No provider supports location: ${location}`);
  }

  format(
    data: WeatherData | WeatherData[],
    platform: string = "telegram",
  ): string {
    const formatter = this._formatters[platform];
    if (!formatter) {
      // Fallback: simple stringification (mirrors Python's _format_simple).
      return formatSimple(data);
    }
    return formatter.format(data);
  }

  async send(
    message: string,
    channel: string = "telegram",
    options: SendOptions = {},
  ): Promise<SendResult> {
    const sender = this._senders[channel];
    if (!sender) {
      return {
        success: false,
        channel,
        error: `No sender configured for channel: ${channel}`,
      };
    }
    return sender.send(message, options);
  }

  // ── Read-only views ──────────────────────────────────────────────

  get providers(): readonly IWeatherProvider[] {
    return this._providers.slice();
  }

  get platforms(): string[] {
    return Object.keys(this._formatters);
  }

  get channels(): string[] {
    return Object.keys(this._senders);
  }
}

/**
 * Simple text fallback formatter. Mirrors `WeatherSkill._format_simple`
 * in `weather/skill.py`. Used when no formatter is registered for the
 * requested platform.
 */
function formatSimple(data: WeatherData | WeatherData[]): string {
  if (Array.isArray(data)) {
    const lines = ["📊 Weather Forecast\n"];
    for (const d of data) {
      const dateStr = d.forecast_date
        ? d.forecast_date.toISOString().slice(0, 10)
        : "?";
      lines.push(`${dateStr}: ${getEmoji(d.condition)} ${tempRangeStr(d)}`);
    }
    return lines.join("\n");
  }
  // Mirrors Python's `data.condition.value.title()` — title-case each word.
  const conditionTitle = data.condition
    .split("_")
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : ""))
    .join(" ");
  return [
    `🌤️ Weather for ${data.location}`,
    `${getEmoji(data.condition)} ${conditionTitle}`,
    `🌡️ ${Math.round(data.temperature)}°C`,
    `💧 Humidity: ${humidityStr(data)}`,
    `💨 Wind: ${windStr(data)}`,
  ].join("\n");
}
