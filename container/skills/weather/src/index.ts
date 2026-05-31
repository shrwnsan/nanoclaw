/**
 * Public package entry point for `@shrwnsan/weather-skill`.
 *
 * Re-exports the orchestrator, factory, types, providers, and
 * model helpers so consumers can import everything they need from
 * a single module.
 */

export { WeatherSkill, type WeatherSkillInit } from "./skill.js";
export { buildDefaultSkill } from "./bootstrap.js";

export type {
  IWeatherFormatter,
  IWeatherProvider,
  IWeatherSender,
  Location,
  SendOptions,
  SendResult,
  WeatherData,
} from "./types.js";

export {
  FormatterError,
  LocationNotSupportedError,
  NoProviderError,
  ProviderError,
  SenderError,
  WeatherCondition,
} from "./types.js";

export {
  aqhiStr,
  aqiStr,
  calculateFeelsLike,
  effectiveFeelsLike,
  getEmoji,
  humidityStr,
  makeWeatherData,
  normalizeLocation,
  parseLocation,
  tempRangeStr,
  windStr,
} from "./models.js";

export { HKOProvider } from "./providers/hko.js";
export { JMAProvider } from "./providers/jma.js";
export { OpenWeatherMapProvider } from "./providers/openweathermap.js";
export { SGNEAProvider } from "./providers/sg_nea.js";
export { NWSProvider } from "./providers/us_nws.js";
export { DWDProvider } from "./providers/de_dwd.js";
export { MetServiceProvider } from "./providers/nz_metservice.js";
export { BMKGProvider } from "./providers/id_bmkg.js";
export { BOMProvider } from "./providers/au_bom.js";
export { KMAProvider } from "./providers/kr_kma.js";
export { TMDProvider } from "./providers/th_tmd.js";
export { UKMetOfficeProvider } from "./providers/uk_metoffice.js";
export { CWAProvider } from "./providers/tw_cwa.js";
export { OpenMeteoProvider } from "./providers/open_meteo.js";

export { CliTextFormatter } from "./formatters/cli_text.js";
export {
  MDV2_ESCAPE_CHARS,
  TelegramFormatter,
  escapeMdv2,
} from "./formatters/telegram.js";
export { WhatsAppFormatter } from "./formatters/whatsapp.js";

export { TelegramSender } from "./senders/telegram.js";
