"""
German Weather Service (DWD) Weather Provider via Bright Sky API.

Fetches weather data from Bright Sky, an open-source JSON API for DWD data.
Free, no API key required. Germany coverage (with some European spillover).

API: https://api.brightsky.dev/
Docs: https://brightsky.dev/docs/
Source: https://github.com/jdemaeyer/brightsky
"""

import asyncio
from datetime import timezone, datetime, date, timedelta
from typing import Optional
import urllib.request
import urllib.parse
import json

from .base import WeatherProvider, ProviderError, LocationNotSupportedError
from ..models import WeatherData, WeatherCondition, Location

# Bright Sky API endpoint
BRIGHTSKY_BASE_URL = "https://api.brightsky.dev"
BRIGHTSKY_CURRENT_URL = f"{BRIGHTSKY_BASE_URL}/current_weather"
BRIGHTSKY_WEATHER_URL = f"{BRIGHTSKY_BASE_URL}/weather"

# German cities with coordinates (latitude, longitude)
DE_CITIES = {
    "berlin": (52.5200, 13.4050),
    "hamburg": (53.5511, 9.9937),
    "munich": (48.1351, 11.5820),
    "münchen": (48.1351, 11.5820),
    "cologne": (50.9375, 6.9603),
    "köln": (50.9375, 6.9603),
    "frankfurt": (50.1109, 8.6821),
    "stuttgart": (48.7758, 9.1829),
    "düsseldorf": (51.2277, 6.7735),
    "dortmund": (51.5136, 7.4653),
    "essen": (51.4556, 7.0116),
    "leipzig": (51.3397, 12.3731),
    "bremen": (53.0793, 8.8017),
    "dresden": (51.0504, 13.7373),
    "hannover": (52.3759, 9.7320),
    "nuremberg": (49.4521, 11.0767),
    "nürnberg": (49.4521, 11.0767),
    "duisburg": (51.4344, 6.7624),
    "bochum": (51.4818, 7.2162),
    "wuppertal": (51.2562, 7.1508),
    "bonn": (50.7374, 7.0982),
    "münster": (51.9607, 7.6261),
    "augsburg": (48.3705, 10.8978),
    "freiburg": (47.9990, 7.8421),
    "heidelberg": (49.3988, 8.6724),
    # Country-level default
    "germany": (52.5200, 13.4050),
    "deutschland": (52.5200, 13.4050),
    "de": (52.5200, 13.4050),
}

# Bright Sky weather condition icon to WeatherCondition mapping
# Reference: https://brightsky.dev/docs/#/operations/getWeather
BRIGHTSKY_CONDITION_MAP = {
    "clear-day": WeatherCondition.SUNNY,
    "clear-night": WeatherCondition.CLEAR,
    "partly-cloudy-day": WeatherCondition.PARTLY_CLOUDY,
    "partly-cloudy-night": WeatherCondition.PARTLY_CLOUDY,
    "cloudy": WeatherCondition.CLOUDY,
    "fog": WeatherCondition.FOG,
    "wind": WeatherCondition.WINDY,
    "rain": WeatherCondition.RAIN,
    "sleet": WeatherCondition.SLEET,
    "snow": WeatherCondition.SNOW,
    "hail": WeatherCondition.HAIL,
    "thunderstorm": WeatherCondition.THUNDERSTORM,
    "dry": WeatherCondition.SUNNY,
}

# Supported locations
SUPPORTED_LOCATIONS = set(DE_CITIES.keys()) | {
    "germany", "deutschland", "de", "德國",
}


class DWDProvider(WeatherProvider):
    """
    German DWD weather provider via Bright Sky API.

    - Free, no API key required
    - Germany coverage (some European spillover from MOSMIX model)
    - Provides current weather and 10-day forecast
    - Backed by official DWD MOSMIX model data
    """

    priority = 8
    supports_forecast = True
    supports_air_quality = False
    requires_api_key = False

    @property
    def name(self) -> str:
        return "dwd"

    def supports_location(self, location: Location) -> bool:
        """Check if location is in Germany."""
        normalized = location.normalized.lower()
        return normalized in SUPPORTED_LOCATIONS

    async def get_current(self, location: Location) -> WeatherData:
        """Fetch current weather for German location."""
        if not self.supports_location(location):
            raise LocationNotSupportedError(
                f"DWD only supports German locations: {location.raw}"
            )

        try:
            lat, lon = self._get_coordinates(location)
            data = await self._fetch_current(lat, lon)
            return self._parse_current(location, data)
        except Exception as e:
            raise ProviderError(f"DWD/Bright Sky API error: {e}")

    async def get_forecast(
        self,
        location: Location,
        days: int = 7
    ) -> list[WeatherData]:
        """Fetch weather forecast for German location."""
        if not self.supports_location(location):
            raise LocationNotSupportedError(
                f"DWD only supports German locations: {location.raw}"
            )

        try:
            lat, lon = self._get_coordinates(location)
            data = await self._fetch_weather(lat, lon, days)
            return self._parse_forecast(location, data, days)
        except Exception as e:
            raise ProviderError(f"DWD/Bright Sky API error: {e}")

    def _get_coordinates(self, location: Location) -> tuple[float, float]:
        """Get coordinates for German location."""
        normalized = location.normalized.lower()

        if normalized in DE_CITIES:
            return DE_CITIES[normalized]

        for city, coords in DE_CITIES.items():
            if city in normalized or normalized in city:
                return coords

        return DE_CITIES["berlin"]

    def _get_display_name(self, location: Location) -> str:
        """Get display name for location."""
        normalized = location.normalized.lower()
        for city in DE_CITIES:
            if city == normalized:
                return city.title()
        return location.raw.title()

    async def _fetch_current(self, lat: float, lon: float) -> dict:
        """Fetch current weather from Bright Sky."""
        params = {
            "lat": f"{lat:.4f}",
            "lon": f"{lon:.4f}",
        }
        return await self._fetch_api(BRIGHTSKY_CURRENT_URL, params)

    async def _fetch_weather(self, lat: float, lon: float, days: int) -> dict:
        """Fetch forecast from Bright Sky."""
        today = date.today()
        end = today + timedelta(days=days)
        params = {
            "lat": f"{lat:.4f}",
            "lon": f"{lon:.4f}",
            "date": today.isoformat(),
            "last_date": end.isoformat(),
        }
        return await self._fetch_api(BRIGHTSKY_WEATHER_URL, params)

    async def _fetch_api(self, base_url: str, params: dict) -> dict:
        """Fetch data from Bright Sky API."""
        query = urllib.parse.urlencode(params)
        url = f"{base_url}?{query}"

        loop = asyncio.get_running_loop()

        def fetch():
            req = urllib.request.Request(url)
            req.add_header("User-Agent", "WeatherSkill/1.0")
            req.add_header("Accept", "application/json")
            with urllib.request.urlopen(req, timeout=15) as response:
                return json.loads(response.read().decode("utf-8"))

        return await loop.run_in_executor(None, fetch)

    def _parse_current(self, location: Location, data: dict) -> WeatherData:
        """Parse current weather from Bright Sky /current_weather response."""
        display_name = self._get_display_name(location)

        weather = data.get("weather", {})
        if not weather:
            raise ProviderError("No weather data from Bright Sky")

        temp = weather.get("temperature")
        humidity = weather.get("relative_humidity")
        if isinstance(humidity, (int, float)):
            humidity = round(humidity)

        wind_speed = weather.get("wind_speed_10")  # km/h
        wind_dir_deg = weather.get("wind_direction_10")
        wind_direction = self._deg_to_compass(wind_dir_deg) if wind_dir_deg is not None else None

        icon = weather.get("icon", "")
        condition = BRIGHTSKY_CONDITION_MAP.get(icon, WeatherCondition.UNKNOWN)

        visibility = weather.get("visibility")  # metres
        if visibility:
            visibility = visibility / 1000  # km

        pressure = weather.get("pressure_msl")
        sunshine_min = weather.get("sunshine")  # minutes in last hour

        # Parse observation time
        obs_time = weather.get("timestamp", "")
        observed_at = None
        if obs_time:
            try:
                observed_at = datetime.fromisoformat(obs_time.replace("Z", "+00:00"))
            except (ValueError, TypeError):
                pass

        return WeatherData(
            location=display_name,
            temperature=temp if temp is not None else 0.0,
            humidity=humidity,
            wind_speed=wind_speed,
            wind_direction=wind_direction,
            condition=condition,
            pressure=pressure,
            visibility=visibility,
            observed_at=observed_at,
            fetched_at=datetime.now(timezone.utc),
            provider_name=self.name,
        )

    def _parse_forecast(
        self,
        location: Location,
        data: dict,
        days: int,
    ) -> list[WeatherData]:
        """Parse multi-day forecast from Bright Sky /weather response."""
        display_name = self._get_display_name(location)
        results = []

        weather_list = data.get("weather", [])
        if not weather_list:
            return results

        # Group hourly data by date, aggregate daily
        daily = {}
        for entry in weather_list:
            ts = entry.get("timestamp", "")
            if not ts:
                continue
            try:
                dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                fc_date = dt.date()
            except (ValueError, TypeError):
                continue

            if fc_date not in daily:
                daily[fc_date] = {
                    "temps": [],
                    "humidity": [],
                    "wind_speeds": [],
                    "precip": 0.0,
                    "icons": [],
                }

            d = daily[fc_date]
            temp = entry.get("temperature")
            if temp is not None:
                d["temps"].append(temp)

            rh = entry.get("relative_humidity")
            if rh is not None:
                d["humidity"].append(rh)

            ws = entry.get("wind_speed_10")
            if ws is not None:
                d["wind_speeds"].append(ws)

            precip = entry.get("precipitation")
            if precip is not None:
                d["precip"] += precip

            icon = entry.get("icon", "")
            if icon:
                d["icons"].append(icon)

        # Build daily WeatherData
        for fc_date in sorted(daily.keys())[:days]:
            d = daily[fc_date]

            temp_high = max(d["temps"]) if d["temps"] else None
            temp_low = min(d["temps"]) if d["temps"] else None
            humidity = round(sum(d["humidity"]) / len(d["humidity"])) if d["humidity"] else None

            # Pick the most common/severe weather icon for the day
            condition = self._pick_daily_condition(d["icons"])

            # Estimate precipitation chance from total precipitation
            precip_chance = None
            if d["precip"] > 0:
                precip_chance = min(100, int(d["precip"] * 20))  # rough heuristic

            results.append(WeatherData(
                location=display_name,
                temperature=temp_low or 0.0,
                temp_high=temp_high,
                temp_low=temp_low,
                humidity=humidity,
                condition=condition,
                precipitation_chance=precip_chance,
                forecast_date=fc_date,
                fetched_at=datetime.now(timezone.utc),
                provider_name=self.name,
            ))

        return results

    def _pick_daily_condition(self, icons: list[str]) -> WeatherCondition:
        """Pick the most representative weather condition for a day."""
        if not icons:
            return WeatherCondition.UNKNOWN

        # Severity ranking — higher is more significant
        severity = {
            "thunderstorm": 10,
            "hail": 9,
            "snow": 8,
            "sleet": 7,
            "rain": 6,
            "fog": 5,
            "wind": 4,
            "cloudy": 3,
            "partly-cloudy-day": 2,
            "partly-cloudy-night": 2,
            "clear-day": 1,
            "clear-night": 1,
            "dry": 0,
        }

        most_severe = max(icons, key=lambda i: severity.get(i, 0))
        return BRIGHTSKY_CONDITION_MAP.get(most_severe, WeatherCondition.UNKNOWN)

    @staticmethod
    def _deg_to_compass(deg: float) -> str:
        """Convert wind direction degrees to compass direction."""
        directions = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                       "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
        idx = round(deg / 22.5) % 16
        return directions[idx]
