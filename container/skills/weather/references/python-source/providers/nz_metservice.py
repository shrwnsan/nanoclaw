"""
New Zealand MetService Weather Provider.

Fetches weather data from MetService's public API.
Free, no API key required. New Zealand coverage only.

Note: Only current observations are available via the public API.
Multi-day forecasts require authentication.

API Documentation: https://www.metservice.com/
"""

import asyncio
from datetime import timezone, datetime
from typing import Optional
import urllib.request
import json

from .base import WeatherProvider, ProviderError, LocationNotSupportedError
from ..models import WeatherData, WeatherCondition, Location

# MetService API endpoint
METSERVICE_LOCAL_OBS = "https://www.metservice.com/publicData/localObs"

# New Zealand cities with their location IDs
NZ_LOCATIONS = {
    # Major cities
    "auckland": {"id": "auckland", "lat": -36.8509, "lon": 174.7645},
    "wellington": {"id": "wellington", "lat": -41.2865, "lon": 174.7762},
    "christchurch": {"id": "christchurch", "lat": -43.5321, "lon": 172.6362},
    "hamilton": {"id": "hamilton", "lat": -37.7826, "lon": 175.2529},
    "tauranga": {"id": "tauranga", "lat": -37.6878, "lon": 176.1651},
    "dunedin": {"id": "dunedin", "lat": -45.8788, "lon": 170.5028},
    "palmerston north": {"id": "palmerstonNorth", "lat": -40.3563, "lon": 175.6111},
    "napier": {"id": "napier", "lat": -39.4928, "lon": 176.9125},
    "nelson": {"id": "nelson", "lat": -41.2708, "lon": 173.2840},
    "rotorua": {"id": "rotorua", "lat": -38.1368, "lon": 176.2497},
    "new plymouth": {"id": "newPlymouth", "lat": -39.0556, "lon": 174.0753},
    "whangarei": {"id": "whangarei", "lat": -35.7251, "lon": 174.3237},
    "invercargill": {"id": "invercargill", "lat": -46.4132, "lon": 168.3538},
    "gisborne": {"id": "gisborne", "lat": -38.6624, "lon": 178.0179},
    "wanganui": {"id": "wanganui", "lat": -39.9299, "lon": 175.0514},
    "hawke's bay": {"id": "hawkesBay", "lat": -39.6, "lon": 176.85},
}

# MetService condition mapping
NZ_CONDITION_MAP = {
    # Clear/Sunny
    "sunny": WeatherCondition.SUNNY,
    "clear": WeatherCondition.CLEAR,
    "fine": WeatherCondition.SUNNY,

    # Partly Cloudy
    "partly cloudy": WeatherCondition.PARTLY_CLOUDY,
    "a few clouds": WeatherCondition.PARTLY_CLOUDY,
    "cloud increasing": WeatherCondition.PARTLY_CLOUDY,

    # Cloudy
    "cloudy": WeatherCondition.CLOUDY,
    "overcast": WeatherCondition.OVERCAST,
    "dull": WeatherCondition.OVERCAST,

    # Rain
    "rain": WeatherCondition.RAIN,
    "light rain": WeatherCondition.DRIZZLE,
    "heavy rain": WeatherCondition.HEAVY_RAIN,
    "drizzle": WeatherCondition.DRIZZLE,
    "showers": WeatherCondition.SHOWERS,
    "scattered showers": WeatherCondition.SHOWERS,
    "isolated showers": WeatherCondition.SHOWERS,
    "few showers": WeatherCondition.SHOWERS,
    "periods of rain": WeatherCondition.RAIN,
    "rain developing": WeatherCondition.RAIN,

    # Thunderstorm
    "thunderstorm": WeatherCondition.THUNDERSTORM,
    "thunderstorms": WeatherCondition.THUNDERSTORM,
    "thundery": WeatherCondition.THUNDERSTORM,

    # Snow
    "snow": WeatherCondition.SNOW,
    "light snow": WeatherCondition.SNOW,
    "heavy snow": WeatherCondition.HEAVY_SNOW,
    "sleet": WeatherCondition.SLEET,
    "hail": WeatherCondition.HAIL,

    # Fog/Mist
    "fog": WeatherCondition.FOG,
    "foggy": WeatherCondition.FOG,
    "mist": WeatherCondition.MIST,
    "misty": WeatherCondition.MIST,
    "hazy": WeatherCondition.MIST,

    # Wind
    "windy": WeatherCondition.WINDY,
    "gale": WeatherCondition.WINDY,
}

# Supported locations
SUPPORTED_LOCATIONS = {
    "new zealand", "nz", "aotearoa",
    "auckland", "wellington", "christchurch", "hamilton",
    "tauranga", "dunedin", "palmerston north", "napier",
    "nelson", "rotorua", "new plymouth", "whangarei",
    "invercargill", "gisborne", "wanganui", "whanganui",
}


class MetServiceProvider(WeatherProvider):
    """
    New Zealand MetService weather provider.

    - Free, no API key required
    - New Zealand coverage only
    - Provides current weather only (forecast API not publicly available)
    """

    priority = 7  # After Australia BOM
    supports_forecast = False  # Forecast API not available
    supports_air_quality = False
    requires_api_key = False

    @property
    def name(self) -> str:
        return "metservice"

    def supports_location(self, location: Location) -> bool:
        """Check if location is in New Zealand."""
        normalized = location.normalized.lower()
        return normalized in SUPPORTED_LOCATIONS or any(
            city in normalized for city in NZ_LOCATIONS
        )

    async def get_current(self, location: Location) -> WeatherData:
        """Fetch current weather for New Zealand location."""
        if not self.supports_location(location):
            raise LocationNotSupportedError(
                f"MetService only supports New Zealand locations: {location.raw}"
            )

        try:
            location_info = self._get_location_info(location)
            data = await self._fetch_observations(location_info)
            return self._parse_current(location, data, location_info)
        except Exception as e:
            raise ProviderError(f"MetService API error: {e}")

    async def get_forecast(
        self,
        location: Location,
        days: int = 10
    ) -> list[WeatherData]:
        """Fetch weather forecast for New Zealand location.

        Note: MetService forecast API is not publicly available.
        Current observations include a 24-hour outlook in twentyFourHour data.
        """
        if not self.supports_location(location):
            raise LocationNotSupportedError(
                f"MetService only supports New Zealand locations: {location.raw}"
            )

        # MetService doesn't provide multi-day forecasts via public API
        # Return empty list to indicate forecast not available
        return []

    def _get_location_info(self, location: Location) -> dict:
        """Get location info for New Zealand city."""
        normalized = location.normalized.lower()

        # Direct match
        for city, info in NZ_LOCATIONS.items():
            if city == normalized or city in normalized:
                return info

        # Default to Auckland
        return NZ_LOCATIONS["auckland"]

    async def _fetch_observations(self, location_info: dict) -> dict:
        """Fetch current observations from MetService."""
        url = f"{METSERVICE_LOCAL_OBS}_{location_info['id']}"

        loop = asyncio.get_running_loop()

        def fetch():
            req = urllib.request.Request(url)
            req.add_header("User-Agent", "Mozilla/5.0 (compatible; WeatherSkill/1.0)")
            req.add_header("Accept", "application/json")
            with urllib.request.urlopen(req, timeout=15) as response:
                return json.loads(response.read().decode('utf-8'))

        return await loop.run_in_executor(None, fetch)

    def _parse_current(
        self,
        location: Location,
        data: dict,
        location_info: dict
    ) -> WeatherData:
        """Parse current weather from MetService response."""
        # Get display name
        display_name = self._get_display_name(location)

        # MetService data is nested in "threeHour" object
        obs_data = data.get("threeHour", {})

        # Extract observation data
        temp_str = obs_data.get("temp")
        temp = float(temp_str) if temp_str else None

        humidity_str = obs_data.get("humidity")
        humidity = int(humidity_str) if humidity_str else None

        wind_speed_str = obs_data.get("windSpeed")
        wind_speed = float(wind_speed_str) if wind_speed_str else None

        wind_dir = obs_data.get("windDirection")
        pressure_str = obs_data.get("pressure")
        pressure = float(pressure_str) if pressure_str else None

        feels_like_str = obs_data.get("windChill")
        feels_like = float(feels_like_str) if feels_like_str else None

        # Get condition from twentyFourHour data (24-hour outlook)
        tfh_data = data.get("twentyFourHour", {})
        if isinstance(tfh_data, dict):
            # Extract basic condition info
            max_temp = tfh_data.get("maxTemp")
            min_temp = tfh_data.get("minTemp")
            rainfall = tfh_data.get("rainfall")
        else:
            max_temp = None
            min_temp = None
            rainfall = None

        # Determine condition from temperature and rainfall
        if rainfall and float(rainfall) > 0:
            condition = WeatherCondition.RAIN
            condition_raw = "Rain"
        else:
            condition = WeatherCondition.SUNNY
            condition_raw = "Fine"

        # Parse observation time
        obs_time = obs_data.get("dateTimeISO", "")
        try:
            observed_at = datetime.fromisoformat(obs_time.replace("Z", "+00:00"))
        except (ValueError, TypeError):
            observed_at = datetime.now(timezone.utc)

        return WeatherData(
            location=display_name,
            temperature=temp if temp is not None else 0.0,
            feels_like=feels_like,
            humidity=humidity,
            wind_speed=wind_speed,
            wind_direction=wind_dir,
            pressure=pressure,
            condition=condition,
            condition_raw=condition_raw,
            observed_at=observed_at,
            fetched_at=datetime.now(timezone.utc),
            provider_name=self.name,
        )

    def _get_display_name(self, location: Location) -> str:
        """Get display name for location."""
        normalized = location.normalized.lower()

        for city in NZ_LOCATIONS:
            if city in normalized:
                return city.title()

        return "New Zealand"

    def _map_condition(self, condition_str: str) -> WeatherCondition:
        """Map MetService condition text to WeatherCondition."""
        if not condition_str:
            return WeatherCondition.UNKNOWN

        normalized = condition_str.lower().strip()

        # Direct match
        if normalized in NZ_CONDITION_MAP:
            return NZ_CONDITION_MAP[normalized]

        # Partial match
        for key, value in NZ_CONDITION_MAP.items():
            if key in normalized:
                return value

        # Keyword matching
        if "sunny" in normalized or "fine" in normalized or "clear" in normalized:
            return WeatherCondition.SUNNY
        if "shower" in normalized:
            return WeatherCondition.SHOWERS
        if "rain" in normalized:
            return WeatherCondition.RAIN
        if "thunder" in normalized:
            return WeatherCondition.THUNDERSTORM
        if "cloud" in normalized:
            return WeatherCondition.CLOUDY
        if "snow" in normalized:
            return WeatherCondition.SNOW
        if "fog" in normalized or "mist" in normalized:
            return WeatherCondition.FOG

        return WeatherCondition.UNKNOWN
