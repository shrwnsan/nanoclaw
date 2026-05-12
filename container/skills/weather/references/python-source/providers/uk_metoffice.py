"""
UK Met Office Weather Provider.

Fetches weather data from Met Office Weather DataHub Global Spot API.
Requires free API key from https://datahub.metoffice.gov.uk/

API Documentation: https://datahub.metoffice.gov.uk/docs
"""

import asyncio
import os
from datetime import timezone, datetime, date
from typing import Optional
import urllib.request
import urllib.parse
import json

from .base import WeatherProvider, ProviderError, LocationNotSupportedError
from ..models import WeatherData, WeatherCondition, Location

# Met Office DataHub Global Spot API endpoints
METOFFICE_BASE_URL = "https://data.hub.api.metoffice.gov.uk/sitespecific/v0/point"
METOFFICE_HOURLY_URL = f"{METOFFICE_BASE_URL}/hourly"
METOFFICE_DAILY_URL = f"{METOFFICE_BASE_URL}/daily"

# UK cities with coordinates (latitude, longitude)
UK_CITIES = {
    "london": (51.5074, -0.1278),
    "manchester": (53.4808, -2.2426),
    "birmingham": (52.4862, -1.8904),
    "glasgow": (55.8642, -4.2518),
    "edinburgh": (55.9533, -3.1883),
    "liverpool": (53.4084, -2.9916),
    "bristol": (51.4545, -2.5879),
    "leeds": (53.8008, -1.5491),
    "sheffield": (53.3811, -1.4701),
    "cardiff": (51.4816, -3.1791),
    "belfast": (54.5973, -5.9301),
    "newcastle": (54.9783, -1.6178),
    "nottingham": (52.9548, -1.1581),
    "southampton": (50.9097, -1.4044),
    "brighton": (50.8225, -0.1372),
    "oxford": (51.7520, -1.2577),
    "cambridge": (52.2053, 0.1218),
    "york": (53.9591, -1.0815),
    "bath": (51.3811, -2.3590),
    "aberdeen": (57.1497, -2.0943),
    "inverness": (57.4778, -4.2247),
    "swansea": (51.6214, -3.9436),
    "plymouth": (50.3755, -4.1427),
    "coventry": (52.4068, -1.5197),
    "leicester": (52.6369, -1.1398),
}

# Met Office significantWeatherCode to condition mapping
# Reference: Met Office DataHub documentation
METOFFICE_WEATHER_CODES = {
    -1: WeatherCondition.UNKNOWN,  # Not available
    0: WeatherCondition.CLEAR,     # Clear night
    1: WeatherCondition.SUNNY,     # Sunny day
    2: WeatherCondition.PARTLY_CLOUDY,  # Partly cloudy (night)
    3: WeatherCondition.PARTLY_CLOUDY,  # Partly cloudy (day)
    4: WeatherCondition.UNKNOWN,   # Not used
    5: WeatherCondition.MIST,      # Mist
    6: WeatherCondition.FOG,       # Fog
    7: WeatherCondition.CLOUDY,    # Cloudy
    8: WeatherCondition.OVERCAST,  # Overcast
    9: WeatherCondition.SHOWERS,   # Light rain shower (night)
    10: WeatherCondition.SHOWERS,  # Light rain shower (day)
    11: WeatherCondition.RAIN,     # Drizzle
    12: WeatherCondition.DRIZZLE,  # Light rain
    13: WeatherCondition.SHOWERS,  # Heavy rain shower (night)
    14: WeatherCondition.SHOWERS,  # Heavy rain shower (day)
    15: WeatherCondition.HEAVY_RAIN,  # Heavy rain
    16: WeatherCondition.SLEET,    # Sleet shower (night)
    17: WeatherCondition.SLEET,    # Sleet shower (day)
    18: WeatherCondition.SLEET,    # Sleet
    19: WeatherCondition.HAIL,     # Hail shower (night)
    20: WeatherCondition.HAIL,     # Hail shower (day)
    21: WeatherCondition.HAIL,     # Hail
    22: WeatherCondition.SNOW,     # Light snow shower (night)
    23: WeatherCondition.SNOW,     # Light snow shower (day)
    24: WeatherCondition.SNOW,     # Light snow
    25: WeatherCondition.HEAVY_SNOW,  # Heavy snow shower (night)
    26: WeatherCondition.HEAVY_SNOW,  # Heavy snow shower (day)
    27: WeatherCondition.HEAVY_SNOW,  # Heavy snow
    28: WeatherCondition.THUNDERSTORM,  # Thunder shower (night)
    29: WeatherCondition.THUNDERSTORM,  # Thunder shower (day)
    30: WeatherCondition.THUNDERSTORM,  # Thunder
}

# Supported locations
SUPPORTED_LOCATIONS = set(UK_CITIES.keys()) | {
    "uk", "united kingdom", "britain", "england",
    "scotland", "wales", "northern ireland",
    "英國",
}


class UKMetOfficeProvider(WeatherProvider):
    """
    UK Met Office weather provider.

    - Requires API key (free registration at datahub.metoffice.gov.uk)
    - UK and global coverage (via Global Spot)
    - Provides hourly and 7-day forecast
    """

    priority = 5
    supports_forecast = True
    supports_air_quality = False
    requires_api_key = True

    def __init__(self, api_key: Optional[str] = None):
        self._api_key = api_key or os.environ.get("METOFFICE_API_KEY", "")

    @property
    def name(self) -> str:
        return "metoffice"

    def supports_location(self, location: Location) -> bool:
        """Check if location is in the UK."""
        if not self._api_key:
            return False
        normalized = location.normalized.lower()
        return normalized in SUPPORTED_LOCATIONS

    async def get_current(self, location: Location) -> WeatherData:
        """Fetch current weather for UK location."""
        if not self.supports_location(location):
            raise LocationNotSupportedError(
                f"Met Office only supports UK locations: {location.raw}"
            )

        try:
            lat, lon = self._get_coordinates(location)
            data = await self._fetch_hourly(lat, lon)
            return self._parse_current(location, data)
        except Exception as e:
            raise ProviderError(f"Met Office API error: {e}")

    async def get_forecast(
        self,
        location: Location,
        days: int = 7
    ) -> list[WeatherData]:
        """Fetch weather forecast for UK location."""
        if not self.supports_location(location):
            raise LocationNotSupportedError(
                f"Met Office only supports UK locations: {location.raw}"
            )

        try:
            lat, lon = self._get_coordinates(location)
            data = await self._fetch_daily(lat, lon)
            return self._parse_forecast(location, data, days)
        except Exception as e:
            raise ProviderError(f"Met Office API error: {e}")

    def _get_coordinates(self, location: Location) -> tuple[float, float]:
        """Get coordinates for UK location."""
        normalized = location.normalized.lower()

        # Direct match
        if normalized in UK_CITIES:
            return UK_CITIES[normalized]

        # Partial match
        for city, coords in UK_CITIES.items():
            if city in normalized or normalized in city:
                return coords

        # Default to London
        return UK_CITIES["london"]

    def _get_display_name(self, location: Location) -> str:
        """Get display name for location."""
        normalized = location.normalized.lower()
        for city in UK_CITIES:
            if city == normalized:
                return city.title()
        return location.raw.title()

    async def _fetch_hourly(self, lat: float, lon: float) -> dict:
        """Fetch hourly forecast from Met Office Global Spot API."""
        params = {
            "latitude": f"{lat:.4f}",
            "longitude": f"{lon:.4f}",
        }
        return await self._fetch_api(METOFFICE_HOURLY_URL, params)

    async def _fetch_daily(self, lat: float, lon: float) -> dict:
        """Fetch daily forecast from Met Office Global Spot API."""
        params = {
            "latitude": f"{lat:.4f}",
            "longitude": f"{lon:.4f}",
        }
        return await self._fetch_api(METOFFICE_DAILY_URL, params)

    async def _fetch_api(self, base_url: str, params: dict) -> dict:
        """Fetch data from Met Office DataHub API."""
        query = urllib.parse.urlencode(params)
        url = f"{base_url}?{query}"

        loop = asyncio.get_running_loop()

        def fetch():
            req = urllib.request.Request(url)
            req.add_header("User-Agent", "WeatherSkill/1.0")
            req.add_header("Accept", "application/json")
            req.add_header("apikey", self._api_key)
            with urllib.request.urlopen(req, timeout=15) as response:
                return json.loads(response.read().decode("utf-8"))

        return await loop.run_in_executor(None, fetch)

    def _parse_current(self, location: Location, data: dict) -> WeatherData:
        """Parse current weather from Met Office hourly response (GeoJSON)."""
        display_name = self._get_display_name(location)

        features = data.get("features", [])
        if not features:
            raise ProviderError("No data returned from Met Office API")

        properties = features[0].get("properties", {})
        time_series = properties.get("timeSeries", [])

        if not time_series:
            raise ProviderError("No time series data from Met Office API")

        # Use the first (most recent) entry
        current = time_series[0]

        temp = current.get("screenTemperature")
        feels_like = current.get("feelsLikeTemperature")
        humidity = current.get("screenRelativeHumidity")
        if isinstance(humidity, (int, float)):
            humidity = round(humidity)

        wind_speed_ms = current.get("windSpeed10m")  # m/s
        wind_speed = round(wind_speed_ms * 3.6, 1) if wind_speed_ms else None  # km/h
        wind_dir_deg = current.get("windDirectionFrom10m")
        wind_direction = self._deg_to_compass(wind_dir_deg) if wind_dir_deg is not None else None

        weather_code = current.get("significantWeatherCode", -1)
        condition = METOFFICE_WEATHER_CODES.get(weather_code, WeatherCondition.UNKNOWN)

        visibility = current.get("visibility")  # metres
        if visibility:
            visibility = visibility / 1000  # km

        uv_index = current.get("uvIndex")
        precip_prob = current.get("probOfPrecipitation")

        # Parse observation time
        obs_time = current.get("time", "")
        observed_at = None
        if obs_time:
            try:
                observed_at = datetime.fromisoformat(obs_time.replace("Z", "+00:00"))
            except (ValueError, TypeError):
                pass

        return WeatherData(
            location=display_name,
            temperature=temp or 0.0,
            feels_like=feels_like,
            humidity=humidity,
            wind_speed=wind_speed,
            wind_direction=wind_direction,
            condition=condition,
            visibility=visibility,
            uv_index=uv_index,
            precipitation_chance=precip_prob,
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
        """Parse multi-day forecast from Met Office daily response."""
        display_name = self._get_display_name(location)
        results = []

        features = data.get("features", [])
        if not features:
            return results

        properties = features[0].get("properties", {})
        time_series = properties.get("timeSeries", [])

        for entry in time_series[:days]:
            time_str = entry.get("time", "")
            try:
                fc_date = datetime.fromisoformat(
                    time_str.replace("Z", "+00:00")
                ).date()
            except (ValueError, TypeError):
                continue

            temp_max = entry.get("dayMaxScreenTemperature")
            temp_min = entry.get("nightMinScreenTemperature")

            # Day weather code takes precedence
            weather_code = entry.get("daySignificantWeatherCode",
                                      entry.get("nightSignificantWeatherCode", -1))
            condition = METOFFICE_WEATHER_CODES.get(weather_code, WeatherCondition.UNKNOWN)

            precip_prob = entry.get("dayProbabilityOfPrecipitation",
                                    entry.get("nightProbabilityOfPrecipitation"))

            uv_index = entry.get("maxUvIndex")

            wind_speed_ms = entry.get("midday10MWindSpeed")
            wind_speed = round(wind_speed_ms * 3.6, 1) if wind_speed_ms else None
            wind_dir_deg = entry.get("midday10MWindDirection")
            wind_direction = self._deg_to_compass(wind_dir_deg) if wind_dir_deg is not None else None

            humidity = entry.get("middayRelativeHumidity")
            if isinstance(humidity, (int, float)):
                humidity = round(humidity)

            results.append(WeatherData(
                location=display_name,
                temperature=temp_min or 0.0,
                temp_high=temp_max,
                temp_low=temp_min,
                humidity=humidity,
                wind_speed=wind_speed,
                wind_direction=wind_direction,
                condition=condition,
                uv_index=uv_index,
                precipitation_chance=precip_prob,
                forecast_date=fc_date,
                fetched_at=datetime.now(timezone.utc),
                provider_name=self.name,
            ))

        return results

    @staticmethod
    def _deg_to_compass(deg: float) -> str:
        """Convert wind direction degrees to compass direction."""
        directions = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                       "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
        idx = round(deg / 22.5) % 16
        return directions[idx]
