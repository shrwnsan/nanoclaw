---
name: weather-skill
description: Retrieves current weather and forecasts for user-specified locations and formats results for chat platforms. Use when users ask about weather conditions, forecast outlooks, AQHI or UV levels, or location-based weather summaries.
---

# Weather Skill

Bun-native weather skill with 14 providers, auto-selection, and Telegram/WhatsApp/text formatters. Installed at `/app/skills/weather/`.

## Triggers

- `weather [location]`
- `weather forecast [location]`
- `天氣` (Chinese for weather)

## Usage

```
@agent weather [location]
@agent weather forecast [location]
@agent weather forecast [location] --days 5
```

### Examples

- `@agent weather` - Current weather for default location (Hong Kong)
- `@agent weather Tokyo` - Current weather for Tokyo
- `@agent weather forecast` - 3-day forecast for default location
- `@agent weather forecast --days 5` - 5-day forecast
- `@agent 天氣` - Current weather in Chinese (defaults to HK)

## Agent Execution

```bash
# Current weather
bun run /app/skills/weather/src/cli.ts --location "<location>"

# Forecast
bun run /app/skills/weather/src/cli.ts --location "<location>" --forecast --days 3

# Telegram formatted (MarkdownV2 — ready to send)
bun run /app/skills/weather/src/cli.ts --location "<location>" --format telegram

# JSON (for programmatic use)
bun run /app/skills/weather/src/cli.ts --location "<location>" --format json
```

Default location is Hong Kong. Provider auto-selection picks the best source based on location. 10 of 14 providers work without any API key. Open-Meteo is the zero-config global fallback (priority 11).

## Providers (14)

| Provider | Coverage | API Key | Priority |
|----------|----------|---------|----------|
| HKO | Hong Kong | Free | 1 |
| SG NEA | Singapore | Free | 2 |
| JMA | Japan | Free | 3 |
| CWA | Taiwan | Required | 4 |
| UK Met Office | UK | Required | 5 |
| BOM | Australia | Free | 6 |
| MetService | New Zealand | Free | 7 |
| NWS | USA | Free | 7 |
| BMKG | Indonesia | Free | 8 |
| DWD (Bright Sky) | Germany | Free | 8 |
| KMA | South Korea | Required | 9 |
| TMD | Thailand | Required | 9 |
| OpenWeatherMap | Global | Required | 10 |
| Open-Meteo | Global | Free | 11 (fallback) |

## Output Formats

### Telegram (MarkdownV2)

```
⛅ Hong Kong Weather — Tuesday, Mar 31

🌡️ 26°C (feels 26°C) • High 28° / Low 23°
⛅ Partly Cloudy
💧 Humidity: 80% | 💨 Wind: South force 3
🌧️ Rain: 60% | 🌫️ AQHI: 5 (Moderate)
☀️ UV: 7 (High)
```

### CLI (Text)

```
🌤️ Weather for Hong Kong
🌡️ Temperature: 26°C
💧 Humidity: 80%
📍 Provider: hko
```

## Parse User Input

1. Extract location from user message (default: Hong Kong if user is in HKT timezone)
2. Detect if forecast is requested (keywords: "forecast", "預報", "未來幾天")
3. Parse number of days if specified (default: 3, max: 9 for HKO)
4. Run the appropriate CLI command and return output to user

## Safety

- Read-only: fetch weather data, never modify anything
- No API keys stored or transmitted for free providers
- Do not prompt user to sign up for paid services when free alternatives exist
