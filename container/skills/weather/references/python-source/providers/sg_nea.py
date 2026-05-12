"""
Singapore National Environment Agency (NEA) Weather Provider.

Fetches weather data from data.gov.sg real-time weather APIs.
Free, no API key required. Singapore coverage only.

API Documentation: https://data.gov.sg/datasets?formats=API
"""

import asyncio
from datetime import timezone, datetime, date
from typing import Optional
import urllib.request
import json

from .base import WeatherProvider, ProviderError, LocationNotSupportedError
from ..models import WeatherData, WeatherCondition, Location

# data.gov.sg v2 real-time API endpoints
SG_AIR_TEMP_URL = "https://api-open.data.gov.sg/v2/real-time/api/air-temperature"
SG_HUMIDITY_URL = "https://api-open.data.gov.sg/v2/real-time/api/relative-humidity"
SG_WIND_DIR_URL = "https://api-open.data.gov.sg/v2/real-time/api/wind-direction"
SG_WIND_SPEED_URL = "https://api-open.data.gov.sg/v2/real-time/api/wind-speed"
SG_24HR_FORECAST_URL = "https://api-open.data.gov.sg/v2/real-time/api/twenty-four-hr-forecast"
SG_4DAY_FORECAST_URL = "https://api-open.data.gov.sg/v2/real-time/api/four-day-outlook"
SG_PSI_URL = "https://api-open.data.gov.sg/v2/real-time/api/psi"

# NEA forecast text to condition mapping
SG_CONDITION_MAP = {
    "fair": WeatherCondition.SUNNY,
    "fair (day)": WeatherCondition.SUNNY,
    "fair (night)": WeatherCondition.CLEAR,
    "fair and warm": WeatherCondition.HOT,
    "partly cloudy": WeatherCondition.PARTLY_CLOUDY,
    "partly cloudy (day)": WeatherCondition.PARTLY_CLOUDY,
    "partly cloudy (night)": WeatherCondition.PARTLY_CLOUDY,
    "cloudy": WeatherCondition.CLOUDY,
    "hazy": WeatherCondition.MIST,
    "slightly hazy": WeatherCondition.MIST,
    "windy": WeatherCondition.WINDY,
    "mist": WeatherCondition.MIST,
    "fog": WeatherCondition.FOG,
    "light rain": WeatherCondition.DRIZZLE,
    "moderate rain": WeatherCondition.RAIN,
    "heavy rain": WeatherCondition.HEAVY_RAIN,
    "passing showers": WeatherCondition.SHOWERS,
    "light showers": WeatherCondition.SHOWERS,
    "showers": WeatherCondition.SHOWERS,
    "heavy showers": WeatherCondition.HEAVY_RAIN,
    "thundery showers": WeatherCondition.THUNDERSTORM,
    "heavy thundery showers": WeatherCondition.THUNDERSTORM,
    "heavy thundery showers with gusty winds": WeatherCondition.THUNDERSTORM,
}

# Supported locations
SUPPORTED_LOCATIONS = {
    "singapore", "sg", "sin", "新加坡",
    "changi", "orchard", "jurong", "woodlands",
    "sentosa", "marina bay", "tampines", "bedok",
}


def _avg(values: list) -> Optional[float]:
    """Average of non-None numeric values."""
    nums = [v for v in values if v is not None]
    return sum(nums) / len(nums) if nums else None


class SGNEAProvider(WeatherProvider):
    """
    Singapore NEA weather provider.

    - Free, no API key required
    - Singapore coverage only
    - Provides current weather and 4-day forecast
    - Air quality via PSI
    """

    priority = 2
    supports_forecast = True
    supports_air_quality = True
    requires_api_key = False

    @property
    def name(self) -> str:
        return "sg_nea"

    def supports_location(self, location: Location) -> bool:
        """Check if location is in Singapore."""
        normalized = location.normalized.lower()
        return normalized in SUPPORTED_LOCATIONS

    async def get_current(self, location: Location) -> WeatherData:
        """Fetch current weather for Singapore."""
        if not self.supports_location(location):
            raise LocationNotSupportedError(
                f"NEA only supports Singapore locations: {location.raw}"
            )

        try:
            # Fetch readings and 24h forecast in parallel
            temp_data, humidity_data, forecast_data, psi_data = await asyncio.gather(
                self._fetch_json(SG_AIR_TEMP_URL),
                self._fetch_json(SG_HUMIDITY_URL),
                self._fetch_json(SG_24HR_FORECAST_URL),
                self._fetch_json(SG_PSI_URL),
                return_exceptions=True,
            )

            return self._parse_current(temp_data, humidity_data, forecast_data, psi_data)
        except Exception as e:
            raise ProviderError(f"NEA API error: {e}")

    async def get_forecast(
        self,
        location: Location,
        days: int = 4
    ) -> list[WeatherData]:
        """Fetch weather forecast for Singapore."""
        if not self.supports_location(location):
            raise LocationNotSupportedError(
                f"NEA only supports Singapore locations: {location.raw}"
            )

        try:
            data = await self._fetch_json(SG_4DAY_FORECAST_URL)
            return self._parse_forecast(data, days)
        except Exception as e:
            raise ProviderError(f"NEA API error: {e}")

    async def _fetch_json(self, url: str) -> dict:
        """Fetch JSON from data.gov.sg API."""
        loop = asyncio.get_running_loop()

        def fetch():
            req = urllib.request.Request(url)
            req.add_header("User-Agent", "WeatherSkill/1.0")
            req.add_header("Accept", "application/json")
            with urllib.request.urlopen(req, timeout=15) as response:
                return json.loads(response.read().decode("utf-8"))

        return await loop.run_in_executor(None, fetch)

    def _parse_current(
        self,
        temp_data,
        humidity_data,
        forecast_data,
        psi_data,
    ) -> WeatherData:
        """Parse current weather from NEA responses."""
        # Temperature — average across stations
        temp = None
        if isinstance(temp_data, dict):
            readings = temp_data.get("data", {}).get("readings", [])
            if readings:
                stations = readings[0].get("data", [])
                values = [s.get("value") for s in stations if s.get("value") is not None]
                temp = _avg(values)

        # Humidity — average across stations
        humidity = None
        if isinstance(humidity_data, dict):
            readings = humidity_data.get("data", {}).get("readings", [])
            if readings:
                stations = readings[0].get("data", [])
                values = [s.get("value") for s in stations if s.get("value") is not None]
                humidity = round(_avg(values)) if _avg(values) is not None else None

        # 24h forecast for condition description and temp range
        condition = WeatherCondition.UNKNOWN
        description = ""
        temp_high = None
        temp_low = None
        wind_description = None
        if isinstance(forecast_data, dict):
            records = forecast_data.get("data", {}).get("records", [])
            if records:
                record = records[0]
                general = record.get("general", {})
                forecast_text = general.get("forecast", "")
                description = forecast_text
                condition = self._text_to_condition(forecast_text)

                temp_range = general.get("temperature", {})
                temp_high = temp_range.get("high")
                temp_low = temp_range.get("low")

                humidity_range = general.get("relativeHumidity", {})
                if humidity is None:
                    h_high = humidity_range.get("high")
                    h_low = humidity_range.get("low")
                    if h_high and h_low:
                        humidity = round((h_high + h_low) / 2)

                wind_info = general.get("wind", {})
                wind_dir = wind_info.get("direction", "")
                wind_lo = wind_info.get("speed", {}).get("low", "")
                wind_hi = wind_info.get("speed", {}).get("high", "")
                if wind_dir and wind_lo:
                    wind_description = f"{wind_dir} {wind_lo}-{wind_hi} km/h"

        # PSI for air quality
        psi_value = None
        if isinstance(psi_data, dict):
            readings = psi_data.get("data", {}).get("readings", [])
            if readings:
                items = readings[0].get("data", {})
                psi_24h = items.get("psi_twenty_four_hourly", {})
                psi_value = psi_24h.get("national") or psi_24h.get("central")

        return WeatherData(
            location="Singapore",
            temperature=temp or 0.0,
            temp_high=temp_high,
            temp_low=temp_low,
            humidity=humidity,
            condition=condition,
            description=description,
            wind_description=wind_description,
            aqi=psi_value,  # PSI maps roughly to AQI scale
            observed_at=datetime.now(timezone.utc),
            fetched_at=datetime.now(timezone.utc),
            provider_name=self.name,
        )

    def _parse_forecast(self, data: dict, days: int) -> list[WeatherData]:
        """Parse 4-day forecast from NEA response."""
        results = []
        records = data.get("data", {}).get("records", [])
        if not records:
            return results

        forecasts = records[0].get("forecasts", [])
        for i, fc in enumerate(forecasts[:days]):
            # Parse date
            date_str = fc.get("date", "")
            try:
                fc_date = datetime.strptime(date_str, "%Y-%m-%d").date()
            except (ValueError, TypeError):
                fc_date = date.today()

            forecast_text = fc.get("forecast", "")
            condition = self._text_to_condition(forecast_text)

            temp_range = fc.get("temperature", {})
            temp_high = temp_range.get("high")
            temp_low = temp_range.get("low")

            humidity_range = fc.get("relativeHumidity", {})
            humidity = None
            if humidity_range.get("high") and humidity_range.get("low"):
                humidity = round((humidity_range["high"] + humidity_range["low"]) / 2)

            wind_info = fc.get("wind", {})
            wind_dir = wind_info.get("direction", "")
            wind_lo = wind_info.get("speed", {}).get("low", "")
            wind_hi = wind_info.get("speed", {}).get("high", "")
            wind_description = f"{wind_dir} {wind_lo}-{wind_hi} km/h" if wind_dir else None

            results.append(WeatherData(
                location="Singapore",
                temperature=temp_low or 0.0,
                temp_high=temp_high,
                temp_low=temp_low,
                humidity=humidity,
                condition=condition,
                description=forecast_text,
                wind_description=wind_description,
                forecast_date=fc_date,
                fetched_at=datetime.now(timezone.utc),
                provider_name=self.name,
            ))

        return results

    def _text_to_condition(self, text: str) -> WeatherCondition:
        """Map NEA forecast text to WeatherCondition."""
        if not text:
            return WeatherCondition.UNKNOWN
        text_lower = text.lower().strip()

        # Exact match first
        if text_lower in SG_CONDITION_MAP:
            return SG_CONDITION_MAP[text_lower]

        # Keyword match
        if "thundery" in text_lower:
            return WeatherCondition.THUNDERSTORM
        if "heavy rain" in text_lower or "heavy shower" in text_lower:
            return WeatherCondition.HEAVY_RAIN
        if "rain" in text_lower or "shower" in text_lower:
            return WeatherCondition.RAIN
        if "drizzle" in text_lower or "light rain" in text_lower:
            return WeatherCondition.DRIZZLE
        if "cloudy" in text_lower:
            return WeatherCondition.CLOUDY
        if "haz" in text_lower:
            return WeatherCondition.MIST
        if "fair" in text_lower or "sunny" in text_lower:
            return WeatherCondition.SUNNY
        if "windy" in text_lower:
            return WeatherCondition.WINDY

        return WeatherCondition.UNKNOWN
