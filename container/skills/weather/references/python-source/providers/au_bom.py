"""
Australian Bureau of Meteorology (BOM) Weather Provider.

Fetches weather data from BOM's public JSON feeds.
Free, no API key required. Australia coverage only.

API Documentation: http://www.bom.gov.au/catalogue/
"""

import asyncio
import re
from datetime import timezone, datetime, date
from typing import Optional
import urllib.request
import json

from .base import WeatherProvider, ProviderError, LocationNotSupportedError
from ..models import WeatherData, WeatherCondition, Location

# BOM observation URLs by state and station
# Format: https://www.bom.gov.au/fwo/{STATE_PRODUCT}/{STATE_PRODUCT}.{STATION_ID}.json
BOM_OBSERVATION_BASE = "https://www.bom.gov.au/fwo"

# BOM forecast URLs
# Format: https://www.bom.gov.au/fwo/{STATE_CODE}/ID{STATE_ID}01/ID{STATE_ID}01.{STATION_ID}.json
BOM_FORECAST_BASE = "https://www.bom.gov.au/fwo"

# Australian cities with their BOM station IDs and state codes
# Station IDs from: http://www.bom.gov.au/climate/cdo/about/idc-code.shtml
BOM_STATIONS = {
    # NSW
    "sydney": {"station_id": "94767", "state_code": "IDN60801", "product": "IDN60801"},
    "sydney observatory hill": {"station_id": "66062", "state_code": "IDN60801", "product": "IDN60801"},
    "newcastle nsw": {"station_id": "94789", "state_code": "IDN60801", "product": "IDN60801"},
    "wollongong": {"station_id": "94749", "state_code": "IDN60801", "product": "IDN60801"},
    "canberra": {"station_id": "94926", "state_code": "IDN60801", "product": "IDN60801"},
    # Victoria
    "melbourne": {"station_id": "94866", "state_code": "IDV60801", "product": "IDV60801"},
    "geelong": {"station_id": "94857", "state_code": "IDV60801", "product": "IDV60801"},
    "ballarat": {"station_id": "94852", "state_code": "IDV60801", "product": "IDV60801"},
    "bendigo": {"station_id": "94855", "state_code": "IDV60801", "product": "IDV60801"},
    # Queensland
    "brisbane": {"station_id": "94578", "state_code": "IDQ60801", "product": "IDQ60801"},
    "gold coast": {"station_id": "94784", "state_code": "IDQ60801", "product": "IDQ60801"},
    "sunshine coast": {"station_id": "94561", "state_code": "IDQ60801", "product": "IDQ60801"},
    "cairns": {"station_id": "94287", "state_code": "IDQ60801", "product": "IDQ60801"},
    "townsville": {"station_id": "94294", "state_code": "IDQ60801", "product": "IDQ60801"},
    # Western Australia
    "perth": {"station_id": "94610", "state_code": "IDW60801", "product": "IDW60801"},
    "fremantle": {"station_id": "94615", "state_code": "IDW60801", "product": "IDW60801"},
    "bunbury": {"station_id": "94622", "state_code": "IDW60801", "product": "IDW60801"},
    # South Australia
    "adelaide": {"station_id": "94648", "state_code": "IDS60801", "product": "IDS60801"},
    # Tasmania
    "hobart": {"station_id": "94970", "state_code": "IDT60801", "product": "IDT60801"},
    "launceston": {"station_id": "94973", "state_code": "IDT60801", "product": "IDT60801"},
    # Northern Territory
    "darwin": {"station_id": "94120", "state_code": "IDD60801", "product": "IDD60801"},
    "alice springs": {"station_id": "94362", "state_code": "IDD60801", "product": "IDD60801"},
}

# BOM condition text mapping
BOM_CONDITION_MAP = {
    # Clear/Sunny
    "sunny": WeatherCondition.SUNNY,
    "clear": WeatherCondition.CLEAR,
    "fine": WeatherCondition.SUNNY,
    "mostly sunny": WeatherCondition.SUNNY,
    "mostly clear": WeatherCondition.CLEAR,

    # Partly Cloudy
    "partly cloudy": WeatherCondition.PARTLY_CLOUDY,
    "mostly cloudy": WeatherCondition.CLOUDY,
    "cloudy": WeatherCondition.CLOUDY,
    "overcast": WeatherCondition.OVERCAST,
    "mostly fine": WeatherCondition.PARTLY_CLOUDY,

    # Rain
    "shower": WeatherCondition.SHOWERS,
    "showers": WeatherCondition.SHOWERS,
    "rain": WeatherCondition.RAIN,
    "light rain": WeatherCondition.DRIZZLE,
    "drizzle": WeatherCondition.DRIZZLE,
    "heavy rain": WeatherCondition.HEAVY_RAIN,
    "rain at times": WeatherCondition.RAIN,
    "shower or two": WeatherCondition.SHOWERS,

    # Thunderstorm
    "thunderstorm": WeatherCondition.THUNDERSTORM,
    "thunderstorms": WeatherCondition.THUNDERSTORM,
    "storm": WeatherCondition.THUNDERSTORM,
    "stormy": WeatherCondition.THUNDERSTORM,

    # Snow
    "snow": WeatherCondition.SNOW,
    "light snow": WeatherCondition.SNOW,
    "heavy snow": WeatherCondition.HEAVY_SNOW,
    "snowing": WeatherCondition.SNOW,

    # Fog/Mist
    "fog": WeatherCondition.FOG,
    "foggy": WeatherCondition.FOG,
    "mist": WeatherCondition.MIST,
    "misty": WeatherCondition.MIST,
    "haze": WeatherCondition.MIST,
    "hazy": WeatherCondition.MIST,

    # Wind
    "windy": WeatherCondition.WINDY,
    "gusty": WeatherCondition.WINDY,
}

# Supported locations
SUPPORTED_LOCATIONS = {
    "australia", "au", "oz", "aussie",
    "sydney", "melbourne", "brisbane", "perth", "adelaide",
    "hobart", "darwin", "canberra", "gold coast",
    "cairns", "townsville", "geelong", "ballarat", "bendigo",
    "newcastle", "wollongong", "fremantle", "bunbury", "launceston",
    "alice springs", "sunshine coast",
}


class BOMProvider(WeatherProvider):
    """
    Australian Bureau of Meteorology weather provider.

    - Free, no API key required
    - Australia coverage only
    - Provides current weather and 7-day forecast
    - Data updated every 30 minutes
    """

    priority = 6  # After UK Met Office
    supports_forecast = True
    supports_air_quality = False  # BOM doesn't provide AQI
    requires_api_key = False

    @property
    def name(self) -> str:
        return "bom"

    def supports_location(self, location: Location) -> bool:
        """Check if location is in Australia."""
        normalized = location.normalized.lower()
        return normalized in SUPPORTED_LOCATIONS or any(
            city in normalized for city in BOM_STATIONS
        )

    async def get_current(self, location: Location) -> WeatherData:
        """Fetch current weather for Australian location."""
        if not self.supports_location(location):
            raise LocationNotSupportedError(
                f"BOM only supports Australian locations: {location.raw}"
            )

        try:
            station_info = self._get_station_info(location)
            data = await self._fetch_observations(station_info)
            return self._parse_current(location, data, station_info)
        except Exception as e:
            raise ProviderError(f"BOM API error: {e}")

    async def get_forecast(
        self,
        location: Location,
        days: int = 7
    ) -> list[WeatherData]:
        """Fetch weather forecast for Australian location."""
        if not self.supports_location(location):
            raise LocationNotSupportedError(
                f"BOM only supports Australian locations: {location.raw}"
            )

        try:
            station_info = self._get_station_info(location)
            data = await self._fetch_forecast(station_info)
            return self._parse_forecast(location, data, days)
        except Exception as e:
            raise ProviderError(f"BOM API error: {e}")

    def _get_station_info(self, location: Location) -> dict:
        """Get BOM station info for location."""
        normalized = location.normalized.lower()

        # Direct match
        if normalized in BOM_STATIONS:
            return BOM_STATIONS[normalized]

        # Partial match
        for city, info in BOM_STATIONS.items():
            if city in normalized or normalized in city:
                return info

        # Default to Sydney
        return BOM_STATIONS["sydney"]

    async def _fetch_observations(self, station_info: dict) -> dict:
        """Fetch current observations from BOM."""
        product = station_info["product"]
        station_id = station_info["station_id"]
        url = f"{BOM_OBSERVATION_BASE}/{product}/{product}.{station_id}.json"

        loop = asyncio.get_running_loop()

        def fetch():
            req = urllib.request.Request(url)
            req.add_header("User-Agent", "Mozilla/5.0 (compatible; WeatherSkill/1.0)")
            req.add_header("Accept", "application/json")
            with urllib.request.urlopen(req, timeout=10) as response:
                return json.loads(response.read().decode('utf-8'))

        return await loop.run_in_executor(None, fetch)

    async def _fetch_forecast(self, station_info: dict) -> dict:
        """Fetch forecast from BOM."""
        state_code = station_info["state_code"]
        station_id = station_info["station_id"]
        url = f"{BOM_FORECAST_BASE}/{state_code}/{state_code}.{station_id}.json"

        loop = asyncio.get_running_loop()

        def fetch():
            req = urllib.request.Request(url)
            req.add_header("User-Agent", "Mozilla/5.0 (compatible; WeatherSkill/1.0)")
            req.add_header("Accept", "application/json")
            with urllib.request.urlopen(req, timeout=10) as response:
                return json.loads(response.read().decode('utf-8'))

        return await loop.run_in_executor(None, fetch)

    def _parse_current(
        self,
        location: Location,
        data: dict,
        station_info: dict
    ) -> WeatherData:
        """Parse current weather from BOM response."""
        observations = data.get("observations", {})
        data_list = observations.get("data", [])

        if not data_list:
            raise ProviderError("No observation data from BOM")

        # Get the latest observation
        latest = data_list[0] if data_list else {}

        # Extract values
        temp = latest.get("air_temp")
        humidity = latest.get("rel_hum")
        wind_speed = latest.get("wind_spd_kmh")
        wind_dir = latest.get("wind_dir")
        pressure = latest.get("press_msl")
        rain_9am = latest.get("rain_trace")

        # Get apparent temperature if available
        feels_like = latest.get("apparent_temp")

        # Parse observation time
        obs_time = latest.get("local_date_time_full", "")
        try:
            observed_at = datetime.strptime(obs_time, "%Y%m%d%H%M%S")
        except (ValueError, TypeError):
            observed_at = datetime.now(timezone.utc)

        # Get display name
        display_name = self._get_display_name(location)

        return WeatherData(
            location=display_name,
            temperature=temp if temp is not None else 0.0,
            feels_like=feels_like,
            humidity=humidity,
            wind_speed=wind_speed,
            wind_direction=wind_dir,
            pressure=pressure,
            condition=WeatherCondition.UNKNOWN,  # BOM observations don't include condition
            observed_at=observed_at,
            fetched_at=datetime.now(timezone.utc),
            provider_name=self.name,
        )

    def _parse_forecast(
        self,
        location: Location,
        data: dict,
        days: int
    ) -> list[WeatherData]:
        """Parse forecast from BOM response."""
        forecasts = data.get("forecasts", [])
        results = []

        display_name = self._get_display_name(location)

        for i, fc in enumerate(forecasts[:days]):
            # Get date
            date_str = fc.get("date", "")
            try:
                fc_date = datetime.strptime(date_str, "%Y-%m-%d").date()
            except (ValueError, TypeError):
                fc_date = None

            # Get temperature range
            temp_high = fc.get("max_temp")
            temp_low = fc.get("min_temp")

            # Get condition
            condition_raw = fc.get("icon_descriptor", "") or fc.get("short_text", "")
            condition = self._map_condition(condition_raw)

            # Get rain probability
            precip_chance = fc.get("probability_of_precipitation")
            if precip_chance:
                try:
                    precip_chance = int(precip_chance)
                except (ValueError, TypeError):
                    precip_chance = None

            # Get UV index
            uv_index = fc.get("uv")
            if uv_index:
                try:
                    uv_index = int(uv_index)
                except (ValueError, TypeError):
                    uv_index = None

            results.append(WeatherData(
                location=display_name,
                temperature=temp_low or 0,
                temp_high=temp_high,
                temp_low=temp_low,
                forecast_date=fc_date,
                condition=condition,
                condition_raw=condition_raw,
                description=fc.get("extended_text", ""),
                precipitation_chance=precip_chance,
                uv_index=uv_index,
                fetched_at=datetime.now(timezone.utc),
                provider_name=self.name,
            ))

        return results

    def _get_display_name(self, location: Location) -> str:
        """Get display name for location."""
        normalized = location.normalized.lower()

        for city in BOM_STATIONS:
            if city in normalized:
                return city.title()

        return "Australia"

    def _map_condition(self, condition_str: str) -> WeatherCondition:
        """Map BOM condition text to WeatherCondition."""
        if not condition_str:
            return WeatherCondition.UNKNOWN

        normalized = condition_str.lower().strip()

        # Direct match
        if normalized in BOM_CONDITION_MAP:
            return BOM_CONDITION_MAP[normalized]

        # Partial match
        for key, value in BOM_CONDITION_MAP.items():
            if key in normalized or normalized in key:
                return value

        # Keyword matching
        if "sunny" in normalized or "clear" in normalized or "fine" in normalized:
            return WeatherCondition.SUNNY
        if "shower" in normalized:
            return WeatherCondition.SHOWERS
        if "rain" in normalized:
            return WeatherCondition.RAIN
        if "thunder" in normalized or "storm" in normalized:
            return WeatherCondition.THUNDERSTORM
        if "cloud" in normalized:
            return WeatherCondition.CLOUDY
        if "fog" in normalized:
            return WeatherCondition.FOG
        if "snow" in normalized:
            return WeatherCondition.SNOW

        return WeatherCondition.UNKNOWN
