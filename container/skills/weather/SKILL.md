---
name: weather
description: Get current weather and forecasts for any location. Use when users ask about weather conditions, forecast outlooks, temperature, humidity, rain chance, or location-based weather summaries. Primary support for Hong Kong via HKO API (free, no key needed).
---

# Weather Skill

Fetch weather data from free public APIs and deliver formatted reports. No external dependencies — uses `fetch()` directly.

## Triggers

- `weather [location]`, `weather forecast [location]`
- `天氣`, `天気`, `날씨`

## Quick Reference: HKO API (Hong Kong)

No API key required. Two endpoints cover current + 9-day forecast:

### Current Conditions

```bash
curl -s "https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=rhrread&lang=en"
```

Returns: temperature, humidity, rainfall, warnings, typhoon info, UV index, icon codes.

### 9-Day Forecast

```bash
curl -s "https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=fnd&lang=en"
```

Returns: daily forecasts with high/low temp, weather description, wind, rain probability (PSR).

### Example: Fetch with `fetch()`

```javascript
const HKO = 'https://data.weather.gov.hk/weatherAPI/opendata/weather.php';

async function hko(type) {
  const r = await fetch(`${HKO}?dataType=${type}&lang=en`);
  return r.json();
}

const [current, forecast] = await Promise.all([hko('rhrread'), hko('fnd')]);

// Current temp
const temp = current.temperature?.data?.find(d => d.place === "Hong Kong Observatory")
  || current.temperature?.data?.[0];
// Today's forecast
const today = forecast.weatherForecast?.[0];
```

### Key Data Fields

| Field | Path | Example |
|-------|------|---------|
| Temperature | `temperature.data[].value` | `26` (°C) |
| Humidity | `humidity.data[0].value` | `80` (%) |
| Weather icon | `icon[0]` | `51` (see icon table) |
| Warnings | `warningMessage` | `""` or storm text |
| Typhoon | `tcmessage` | `""` or TC info |
| Forecast date | `weatherForecast[].forecastDate` | `"20260512"` |
| High/Low | `forecastMaxtemp.value` / `forecastMintemp.value` | `28` / `23` |
| Rain chance | `PSR` | `"High"` / `"Medium-Low"` |
| Wind | `forecastWind` | `"South force 3"` |

### HKO Icon Codes (common)

| Code | Meaning | Code | Meaning |
|------|---------|------|---------|
| 50-52 | Sunny / Mainly sunny | 61-63 | Cloudy / Overcast |
| 53-54 | Sunny periods / Sunny intervals | 64-65 | Rain / Thunderstorm |
| 70-76 | Night clear / Night cloudy | 80-90 | Wind / Fog / Haze |

### Output Format (for chat)

```
Hong Kong Weather — Tuesday, May 12

26°C (feels 26°C) | High 28° / Low 23°
Partly Cloudy
Humidity: 80% | Wind: South force 3
Rain: 60% | AQHI: 5 (Moderate)
UV: 7 (High)
Warnings: None
```

For forecasts, list each day on a separate line:

```
3-Day Forecast for Hong Kong

Wed 5/13: Sunny Periods, 24-29°C, Rain: Low
Thu 5/14: Cloudy, 23-27°C, Rain: Medium-High
Fri 5/15: Thunderstorm, 22-25°C, Rain: High
```

## Other Providers

| Provider | Coverage | Key Needed | Endpoint |
|----------|----------|------------|----------|
| HKO | Hong Kong | No | `data.weather.gov.hk/weatherAPI/opendata/weather.php` |
| Open-Meteo | Global | No | `api.open-meteo.com/v1/forecast` |
| NWS | USA | No | `api.weather.gov` |
| JMA | Japan | No | `www.jma.go.jp/bosai/forecast` |

### Open-Meteo (Global, free, no key)

Use for locations outside HKO coverage:

```javascript
// Example: Tokyo
const r = await fetch(
  'https://api.open-meteo.com/v1/forecast?' +
  'latitude=35.6762&longitude=139.6503&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m' +
  '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=3'
);
const data = await r.json();
```

WMO weather codes: 0=clear, 1-3=mainly clear to overcast, 45/48=fog, 51-55=drizzle, 61-65=rain, 71-75=snow, 80-82=showers, 95=thunderstorm.

## Agent Behavior

1. Detect location from message (default: Hong Kong if user is in HKT timezone)
2. For HK locations, use HKO API (free, most detailed)
3. For other locations, use Open-Meteo (free, global)
4. Format output based on platform (plain text for most, Telegram supports emoji)
5. For scheduled weather briefings, keep the message concise — under 500 chars

## Safety

- Read-only: fetch weather data, never modify anything
- No API keys stored or transmitted for free providers
- Do not prompt user to sign up for paid services when free alternatives exist

## Reference

Full Python implementation with 13 providers, Telegram/WhatsApp formatters, and sender integrations: `references/python-source/`
