"""
Hong Kong Observatory (HKO) Weather Provider.


Fetches weather data from HKO's JSON API.
Free, no API key required. Hong Kong coverage only.
"""

import asyncio
import re
from datetime import timezone, datetime, date
from typing import Optional
import urllib.request
import json

from .base import WeatherProvider, ProviderError, LocationNotSupportedError
from ..models import WeatherData, WeatherCondition, Location

# HKO JSON API endpoint
HKO_API_URL = "https://www.hko.gov.hk/wxinfo/json/one_json.xml"

# HKO icon to condition mapping
HKO_ICON_MAP = {
    # Sunny/Clear
    "pic50.png": WeatherCondition.SUNNY,
    "pic51.png": WeatherCondition.SUNNY,
    "pic52.png": WeatherCondition.PARTLY_CLOUDY,

    # Cloudy/Overcast
    "pic60.png": WeatherCondition.CLOUDY,
    "pic61.png": WeatherCondition.OVERCAST,
    "pic62.png": WeatherCondition.RAIN,  # Light rain
    "pic63.png": WeatherCondition.RAIN,
    "pic64.png": WeatherCondition.HEAVY_RAIN,
    "pic65.png": WeatherCondition.THUNDERSTORM,

    # Showers
    "pic53.png": WeatherCondition.PARTLY_CLOUDY,  # Sunny periods
    "pic54.png": WeatherCondition.DRIZZLE,  # Sunny intervals with showers
    "pic55.png": WeatherCondition.RAIN,  # Showers

    # Wind/Fog
    "pic56.png": WeatherCondition.WINDY,
    "pic57.png": WeatherCondition.FOG,
}

# Supported locations
SUPPORTED_LOCATIONS = {
    "hong kong", "hk", "香港",
    "kowloon", "kln", "九龍",
    "new territories", "nt", "新界",
}


class HKOProvider(WeatherProvider):
    """
    Hong Kong Observatory weather provider.

    - Free, no API key required
    - Hong Kong coverage only
    - Provides current weather and 9-day forecast
    """

    priority = 1  # Highest priority for HK locations
    supports_forecast = True
    supports_air_quality = True  # HKO provides AQHI
    requires_api_key = False

    @property
    def name(self) -> str:
        return "hko"

    def supports_location(self, location: Location) -> bool:
        """Check if location is in Hong Kong."""
        normalized = location.normalized.lower()
        return normalized in SUPPORTED_LOCATIONS

    async def get_current(self, location: Location) -> WeatherData:
        """Fetch current weather for Hong Kong."""
        if not self.supports_location(location):
            raise LocationNotSupportedError(
                f"HKO only supports Hong Kong locations: {location.raw}"
            )

        try:
            data = await self._fetch_api()
            return self._parse_current(data)
        except Exception as e:
            raise ProviderError(f"HKO API error: {e}")

    async def get_forecast(
        self,
        location: Location,
        days: int = 3
    ) -> list[WeatherData]:
        """Fetch weather forecast for Hong Kong."""
        if not self.supports_location(location):
            raise LocationNotSupportedError(
                f"HKO only supports Hong Kong locations: {location.raw}"
            )

        try:
            data = await self._fetch_api()
            return self._parse_forecast(data, days)
        except Exception as e:
            raise ProviderError(f"HKO API error: {e}")

    async def _fetch_api(self) -> dict:
        """Fetch data from HKO JSON API."""
        loop = asyncio.get_running_loop()

        def fetch():
            with urllib.request.urlopen(HKO_API_URL, timeout=10) as response:
                return json.loads(response.read().decode('utf-8'))

        return await loop.run_in_executor(None, fetch)

    def _parse_current(self, data: dict) -> WeatherData:
        """Parse current weather from HKO response."""
        # Current observations
        current = data.get("RHRREAD", {})
        hko = data.get("hko", {})
        flw = data.get("FLW", {})

        # Temperature and humidity
        temp_str = hko.get("Temperature") or current.get("hkotemp")
        temp = float(temp_str) if temp_str else None

        rh_str = hko.get("RH") or current.get("hkorh")
        humidity = int(rh_str) if rh_str else None

        # Get icon from forecast
        icon_data = data.get("fcartoon", {})
        icon = icon_data.get("Icon1", "")
        condition = self._icon_to_condition(str(icon))

        # UV Index
        uv_index = None
        uv_data = data.get("RHRREAD", {})
        if uv_data.get("UVIndex"):
            try:
                uv_index = int(float(uv_data["UVIndex"]))
            except (ValueError, TypeError):
                pass

        # Get today's forecast from F9D for high/low temps and wind
        f9d = data.get("F9D", {})
        forecasts = f9d.get("WeatherForecast", [])
        today_fc = forecasts[0] if forecasts else {}

        temp_high = float(today_fc["ForecastMaxtemp"]) if today_fc.get("ForecastMaxtemp") else None
        temp_low = float(today_fc["ForecastMintemp"]) if today_fc.get("ForecastMintemp") else None

        # Wind description from forecast
        wind_description = today_fc.get("ForecastWind", "")

        # Rain probability from PSR
        psr = today_fc.get("PSR", "")
        precip_chance = self._psr_to_percent(psr)

        # Clean forecast description (strip HTML tags)
        raw_desc = flw.get("ForecastDesc", "")
        description = self._strip_html_tags(raw_desc)

        # Bulletin time
        bulletin_time = hko.get("BulletinTime", "")
        observed_at = None
        if bulletin_time:
            try:
                observed_at = datetime.strptime(bulletin_time, "%Y%m%d%H%M")
            except ValueError:
                pass

        return WeatherData(
            location="Hong Kong",
            temperature=temp,
            temp_high=temp_high,
            temp_low=temp_low,
            humidity=humidity,
            condition=condition,
            condition_raw=raw_desc,
            description=description,
            wind_description=wind_description,
            precipitation_chance=precip_chance,
            uv_index=uv_index,
            observed_at=observed_at,
            fetched_at=datetime.now(timezone.utc),
            provider_name=self.name,
        )

    def _parse_forecast(self, data: dict, days: int) -> list[WeatherData]:
        """Parse forecast from HKO response."""
        forecasts = data.get("F9D", {}).get("WeatherForecast", [])
        results = []

        for i, fc in enumerate(forecasts[:days]):
            # Parse date
            date_str = fc.get("ForecastDate", "")
            try:
                fc_date = datetime.strptime(date_str, "%Y%m%d").date()
            except ValueError:
                continue

            # Parse temps
            temp_high = float(fc["ForecastMaxtemp"]) if fc.get("ForecastMaxtemp") else None
            temp_low = float(fc["ForecastMintemp"]) if fc.get("ForecastMintemp") else None

            # Parse condition
            icon = fc.get("ForecastIcon", "")
            condition = self._icon_to_condition(str(icon))

            # Parse rain probability
            psr = fc.get("PSR", "")
            precip_chance = self._psr_to_percent(psr)

            results.append(WeatherData(
                location="Hong Kong",
                temperature=temp_low or 0,
                temp_high=temp_high,
                temp_low=temp_low,
                forecast_date=fc_date,
                condition=condition,
                condition_raw=fc.get("IconDesc", ""),
                description=fc.get("ForecastWeather", ""),
                precipitation_chance=precip_chance,
                fetched_at=datetime.now(timezone.utc),
                provider_name=self.name,
            ))

        return results

    def _icon_to_condition(self, icon: str) -> WeatherCondition:
        """Map HKO icon filename to WeatherCondition."""
        # Handle both "pic54.png" and "54" formats
        icon_name = icon if "pic" in icon else f"pic{icon}.png"
        return HKO_ICON_MAP.get(icon_name, WeatherCondition.UNKNOWN)

    def _psr_to_percent(self, psr: str) -> Optional[int]:
        """Map PSR (Probability of Significant Rain) to percentage."""
        psr_map = {
            "low": 10,
            "medium low": 30,
            "medium": 50,
            "medium high": 70,
            "high": 90,
        }
        return psr_map.get(psr.lower())

    def _strip_html_tags(self, text: str) -> str:
        """Remove HTML tags from text."""
        if not text:
            return ""
        return re.sub(r'<[^>]+>', '', text).strip()
