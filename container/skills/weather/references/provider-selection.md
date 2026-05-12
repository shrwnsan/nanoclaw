# Weather Skill Provider Selection

## Default Behavior

### Location Resolution

1. **User specifies location** → Use that location
2. **No location specified** → Agent attempts to infer from:
   - User's profile/timezone
   - Previous conversations
   - Prompt user: "What location would you like weather for?"

### Provider Selection

The skill automatically selects the best provider based on location:

1. **Hong Kong** → HKO (free)
2. **Singapore** → SG NEA (free)
3. **Japan** → JMA (www.jma.go.jp)
4. **Taiwan** → CWA (opendata.cwa.gov.tw, requires API key)
5. **United Kingdom** → Met Office (datahub.metoffice.gov.uk, requires API key)
6. **Australia** → BOM (www.bom.gov.au)
7. **New Zealand** → MetService (www.metservice.com)
8. **USA** → NWS (www.weather.gov)
9. **Indonesia** → BMKG (free)
10. **Germany** → DWD via Bright Sky (free)
11. **South Korea** → KMA (data.go.kr, requires API key)
12. **Thailand** → TMD (data.tmd.go.th, requires API key)
13. **Other** → OpenWeatherMap (www.openweathermap.org)

## Provider Matrix

| Provider | Coverage | API Key | Priority | Forecast | Air Quality |
|----------|----------|---------|----------|----------|-------------|
| HKO | Hong Kong | Free | 1 | 9-day | AQHI (HK scale) |
| SG NEA | Singapore | Free | 2 | 4-day | PSI (1-hr) |
| JMA | Japan | Free | 3 | 7-day | No |
| CWA | Taiwan | Required | 4 | 7-day | No |
| UK Met Office | United Kingdom | Required | 5 | 7-day | No |
| BOM | Australia | Free | 6 | 7-day | No |
| MetService | New Zealand | Free | 7 | Current only | No |
| NWS | USA | Free | 7 | 7-day | No |
| BMKG | Indonesia | Free | 8 | 3-day | No |
| DWD (Bright Sky) | Germany | Free | 8 | 10-day | No |
| KMA | South Korea | Required | 9 | 3-day | No |
| TMD | Thailand | Required | 9 | 7-day | No |
| OpenWeatherMap | Global | Required | 10 | 5-day | AQI |

## Selection Flow

```
┌─────────────┐
│   User      │
│   Query     │
└──────┬──────┘
       │
       ▼
┌─────────────────┐
│ Parse Location  │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────────────┐
│           Try Providers by Priority          │
├─────────────────────────────────────────────┤
│ 1. HKO (HK only)                            │
│ 2. SG NEA (Singapore only)                  │
│ 3. JMA (Japan only)                         │
│ 4. CWA (Taiwan, needs API key)              │
│ 5. UK Met Office (UK, needs API key)        │
│ 6. BOM (Australia)                          │
│ 7. MetService (NZ, current only)            │
│ 7. NWS (USA)                                │
│ 8. BMKG (Indonesia)                         │
│ 8. DWD (Germany)                            │
│ 9. KMA (S. Korea, needs API key)            │
│ 9. TMD (Thailand, needs API key)            │
│ 10. OpenWeatherMap (global fallback)        │
└──────────────┬──────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────┐
│ First provider that supports location wins  │
└─────────────────────────────────────────────┘
```

## Free vs Paid Providers

### Free (No API Key Required)

| Provider | Coverage | Registration |
|----------|----------|--------------|
| HKO | Hong Kong | None |
| SG NEA | Singapore | None |
| JMA | Japan | None |
| BOM | Australia | None |
| MetService | New Zealand | None |
| NWS | USA | None |
| BMKG | Indonesia | None |
| DWD (Bright Sky) | Germany | None |

### Requires API Key

| Provider | Coverage | Sign Up URL |
|----------|----------|-------------|
| CWA | Taiwan | https://opendata.cwa.gov.tw/ |
| UK Met Office | United Kingdom | https://datahub.metoffice.gov.uk/ |
| KMA | South Korea | https://data.go.kr/ |
| TMD | Thailand | https://data.tmd.go.th/ |
| OpenWeatherMap | Global | https://openweathermap.org/api |

## Feels-like Temperature

### Standardized Calculation

The `effective_feels_like` property ensures consistent feels-like temperature across all providers:

```python
# Heat index: applies when temp >= 27C and humidity >= 40%
if temp >= 27 and humidity >= 40:
    hi = temp + (0.1 * humidity) - (0.05 * temp)
    return max(round(hi), round(temp))

# Wind chill: applies when temp <= 10C and wind > 4.8 km/h
if temp <= 10 and wind_speed > 1.33:  # 4.8 km/h = 1.33 m/s
    wind_kmh = wind_speed * 3.6
    wc = 13.12 + 0.6215 * temp - 11.37 * (wind_kmh ** 0.16)
    return max(round(wc), round(temp))

# No adjustment needed
return round(temp)
```

## Air Quality

### Provider Support

| Provider | Air Quality Source |
|----------|-------------------|
| HKO | AQHI (HK scale 1-10+) |
| SG NEA | PSI (1-hr, 24-hr) |
| OpenWeatherMap | AQI (US EPA scale 1-500) |

### HKO Air Quality Health Index (AQHI)

The HK scale:
- 1-3: Low health risk
- 4-6: Moderate
- 7: High
- 8-10: Very High
- 10+: Serious

## Output Format

All providers use consistent formatting:

```
City Weather - Tuesday, April 1

Temperature: 23C (feels 24C)
High 27C / Low 22C
Condition: Partly cloudy
Humidity: 87%
Wind: East 15 km/h
Rain chance: 40%
Air Quality: Moderate (AQHI 5)
UV Index: 7 (High)
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | For Telegram | Telegram bot token |
| `TELEGRAM_CHAT_ID` | For Telegram | Default chat ID |
| `OPENWEATHERMAP_API_KEY` | For global | OpenWeatherMap API key |
| `CWA_API_KEY` | For Taiwan | Taiwan CWA API key |
| `METOFFICE_API_KEY` | For UK | UK Met Office API key |
| `KMA_SERVICE_KEY` | For S. Korea | Korea KMA service key |
| `TMD_API_TOKEN` | For Thailand | Thailand TMD API token |
