"""
Thailand Meteorological Department (TMD) Weather Provider.

Fetches weather data from TMD's public API.
Requires free API token from https://data.tmd.go.th/

API: https://data.tmd.go.th/nwpapi/v1/forecast/location/daily/at
Docs: https://data.tmd.go.th/nwpapi/doc/
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

# TMD API endpoints
TMD_OBSERVATION_URL = "https://data.tmd.go.th/api/WeatherToday/v2/"
TMD_FORECAST_URL = "https://data.tmd.go.th/api/WeatherForecast7Days/v2/"

# Thai provinces/cities with TMD station IDs
TH_LOCATIONS = {
    "bangkok": {"province": "กรุงเทพมหานคร", "station": "48455", "lat": 13.7563, "lon": 100.5018},
    "กรุงเทพ": {"province": "กรุงเทพมหานคร", "station": "48455", "lat": 13.7563, "lon": 100.5018},
    "chiang mai": {"province": "เชียงใหม่", "station": "48327", "lat": 18.7883, "lon": 98.9853},
    "เชียงใหม่": {"province": "เชียงใหม่", "station": "48327", "lat": 18.7883, "lon": 98.9853},
    "phuket": {"province": "ภูเก็ต", "station": "48564", "lat": 7.8804, "lon": 98.3923},
    "ภูเก็ต": {"province": "ภูเก็ต", "station": "48564", "lat": 7.8804, "lon": 98.3923},
    "pattaya": {"province": "ชลบุรี", "station": "48477", "lat": 12.9236, "lon": 100.8825},
    "chon buri": {"province": "ชลบุรี", "station": "48477", "lat": 13.3622, "lon": 100.9847},
    "ชลบุรี": {"province": "ชลบุรี", "station": "48477", "lat": 13.3622, "lon": 100.9847},
    "krabi": {"province": "กระบี่", "station": "48565", "lat": 8.0863, "lon": 98.9063},
    "กระบี่": {"province": "กระบี่", "station": "48565", "lat": 8.0863, "lon": 98.9063},
    "koh samui": {"province": "สุราษฎร์ธานี", "station": "48551", "lat": 9.5120, "lon": 100.0136},
    "hat yai": {"province": "สงขลา", "station": "48568", "lat": 7.0036, "lon": 100.4747},
    "nakhon ratchasima": {"province": "นครราชสีมา", "station": "48432", "lat": 14.9799, "lon": 102.0978},
    "โคราช": {"province": "นครราชสีมา", "station": "48432", "lat": 14.9799, "lon": 102.0978},
    "khon kaen": {"province": "ขอนแก่น", "station": "48381", "lat": 16.4322, "lon": 102.8236},
    "ขอนแก่น": {"province": "ขอนแก่น", "station": "48381", "lat": 16.4322, "lon": 102.8236},
    "chiang rai": {"province": "เชียงราย", "station": "48303", "lat": 19.9105, "lon": 99.8406},
    "เชียงราย": {"province": "เชียงราย", "station": "48303", "lat": 19.9105, "lon": 99.8406},
    "hua hin": {"province": "ประจวบคีรีขันธ์", "station": "48500", "lat": 12.5684, "lon": 99.9577},
    "udon thani": {"province": "อุดรธานี", "station": "48354", "lat": 17.4156, "lon": 102.7872},
    "อุดรธานี": {"province": "อุดรธานี", "station": "48354", "lat": 17.4156, "lon": 102.7872},
    # Country-level defaults
    "thailand": {"province": "กรุงเทพมหานคร", "station": "48455", "lat": 13.7563, "lon": 100.5018},
    "th": {"province": "กรุงเทพมหานคร", "station": "48455", "lat": 13.7563, "lon": 100.5018},
    "ไทย": {"province": "กรุงเทพมหานคร", "station": "48455", "lat": 13.7563, "lon": 100.5018},
    "ประเทศไทย": {"province": "กรุงเทพมหานคร", "station": "48455", "lat": 13.7563, "lon": 100.5018},
}

# TMD weather condition mapping
TMD_CONDITION_MAP = {
    "ท้องฟ้าแจ่มใส": WeatherCondition.SUNNY,
    "มีเมฆบางส่วน": WeatherCondition.PARTLY_CLOUDY,
    "เมฆเป็นส่วนมาก": WeatherCondition.CLOUDY,
    "มีเมฆมาก": WeatherCondition.OVERCAST,
    "ฝนตกเล็กน้อย": WeatherCondition.DRIZZLE,
    "ฝนตกปานกลาง": WeatherCondition.RAIN,
    "ฝนตกหนัก": WeatherCondition.HEAVY_RAIN,
    "ฝนฟ้าคะนอง": WeatherCondition.THUNDERSTORM,
    "อากาศหนาวจัด": WeatherCondition.COLD,
    "อากาศร้อนจัด": WeatherCondition.HOT,
}

# Supported locations
SUPPORTED_LOCATIONS = set(TH_LOCATIONS.keys())


class TMDProvider(WeatherProvider):
    """
    Thailand TMD weather provider.

    - Requires API token (free registration at data.tmd.go.th)
    - Thailand coverage only
    - Provides current observations and 7-day forecast
    """

    priority = 9
    supports_forecast = True
    supports_air_quality = False
    requires_api_key = True

    def __init__(self, api_key: Optional[str] = None):
        self._api_key = api_key or os.environ.get("TMD_API_TOKEN", "")

    @property
    def name(self) -> str:
        return "tmd"

    def supports_location(self, location: Location) -> bool:
        """Check if location is in Thailand."""
        if not self._api_key:
            return False
        normalized = location.normalized.lower()
        return normalized in SUPPORTED_LOCATIONS

    async def get_current(self, location: Location) -> WeatherData:
        """Fetch current weather for Thai location."""
        if not self.supports_location(location):
            raise LocationNotSupportedError(
                f"TMD only supports Thai locations: {location.raw}"
            )

        try:
            loc_info = self._get_location_info(location)
            data = await self._fetch_observation(loc_info)
            return self._parse_current(location, data, loc_info)
        except Exception as e:
            raise ProviderError(f"TMD API error: {e}")

    async def get_forecast(
        self,
        location: Location,
        days: int = 7
    ) -> list[WeatherData]:
        """Fetch weather forecast for Thai location."""
        if not self.supports_location(location):
            raise LocationNotSupportedError(
                f"TMD only supports Thai locations: {location.raw}"
            )

        try:
            loc_info = self._get_location_info(location)
            data = await self._fetch_forecast(loc_info)
            return self._parse_forecast(location, data, loc_info, days)
        except Exception as e:
            raise ProviderError(f"TMD API error: {e}")

    def _get_location_info(self, location: Location) -> dict:
        """Get TMD location info."""
        normalized = location.normalized.lower()
        if normalized in TH_LOCATIONS:
            return TH_LOCATIONS[normalized]
        for city, info in TH_LOCATIONS.items():
            if city in normalized or normalized in city:
                return info
        return TH_LOCATIONS["bangkok"]

    def _get_display_name(self, location: Location) -> str:
        """Get display name for location."""
        normalized = location.normalized.lower()
        for city in TH_LOCATIONS:
            if city == normalized and city.isascii():
                return city.title()
        return location.raw.title()

    async def _fetch_observation(self, loc_info: dict) -> dict:
        """Fetch current observations from TMD."""
        params = {
            "uid": self._api_key,
            "ukey": self._api_key,
            "format": "json",
        }
        return await self._fetch_api(TMD_OBSERVATION_URL, params)

    async def _fetch_forecast(self, loc_info: dict) -> dict:
        """Fetch 7-day forecast from TMD."""
        params = {
            "uid": self._api_key,
            "ukey": self._api_key,
            "province": loc_info["province"],
            "format": "json",
        }
        return await self._fetch_api(TMD_FORECAST_URL, params)

    async def _fetch_api(self, base_url: str, params: dict) -> dict:
        """Fetch data from TMD API."""
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

    def _parse_current(
        self,
        location: Location,
        data: dict,
        loc_info: dict,
    ) -> WeatherData:
        """Parse current weather from TMD observation response."""
        display_name = self._get_display_name(location)

        # Find matching station from the list
        stations = data.get("Stations", {}).get("Station", [])
        station_data = None
        target_id = loc_info.get("station", "")

        for s in stations:
            if s.get("WmoStationNumber", "") == target_id:
                station_data = s
                break

        if not station_data and stations:
            station_data = stations[0]

        if not station_data:
            raise ProviderError("No station data in TMD response")

        obs = station_data.get("Observation", {})
        temp = obs.get("MeanTemperature")
        if temp:
            try:
                temp = float(temp)
            except (ValueError, TypeError):
                temp = None

        humidity = obs.get("MeanRelativeHumidity")
        if humidity:
            try:
                humidity = int(float(humidity))
            except (ValueError, TypeError):
                humidity = None

        temp_max = obs.get("MaxTemperature")
        temp_min = obs.get("MinTemperature")
        try:
            temp_max = float(temp_max) if temp_max else None
        except (ValueError, TypeError):
            temp_max = None
        try:
            temp_min = float(temp_min) if temp_min else None
        except (ValueError, TypeError):
            temp_min = None

        return WeatherData(
            location=display_name,
            temperature=temp or 0.0,
            temp_high=temp_max,
            temp_low=temp_min,
            humidity=humidity,
            condition=WeatherCondition.UNKNOWN,
            observed_at=datetime.now(timezone.utc),
            fetched_at=datetime.now(timezone.utc),
            provider_name=self.name,
        )

    def _parse_forecast(
        self,
        location: Location,
        data: dict,
        loc_info: dict,
        days: int,
    ) -> list[WeatherData]:
        """Parse 7-day forecast from TMD response."""
        display_name = self._get_display_name(location)
        results = []

        forecasts = data.get("Provinces", {}).get("Province", [])
        if not forecasts:
            return results

        # Find matching province
        province_data = None
        target_province = loc_info.get("province", "")
        for p in forecasts:
            if p.get("ProvinceNameThai", "") == target_province:
                province_data = p
                break

        if not province_data and forecasts:
            province_data = forecasts[0]

        if not province_data:
            return results

        forecast_days = province_data.get("ForecastDaily", [])
        for fc in forecast_days[:days]:
            date_str = fc.get("Date", "")
            try:
                fc_date = datetime.strptime(date_str, "%d/%m/%Y").date()
            except (ValueError, TypeError):
                try:
                    fc_date = datetime.strptime(date_str, "%Y-%m-%d").date()
                except (ValueError, TypeError):
                    continue

            temp_max = fc.get("MaxTemperature")
            temp_min = fc.get("MinTemperature")
            try:
                temp_max = float(temp_max) if temp_max else None
            except (ValueError, TypeError):
                temp_max = None
            try:
                temp_min = float(temp_min) if temp_min else None
            except (ValueError, TypeError):
                temp_min = None

            description = fc.get("WeatherDescription", "")
            condition = self._text_to_condition(description)

            rain_chance = fc.get("RainChance")
            if rain_chance:
                try:
                    rain_chance = int(rain_chance.replace("%", ""))
                except (ValueError, TypeError):
                    rain_chance = None

            results.append(WeatherData(
                location=display_name,
                temperature=temp_min or 0.0,
                temp_high=temp_max,
                temp_low=temp_min,
                condition=condition,
                description=description,
                precipitation_chance=rain_chance,
                forecast_date=fc_date,
                fetched_at=datetime.now(timezone.utc),
                provider_name=self.name,
            ))

        return results

    def _text_to_condition(self, text: str) -> WeatherCondition:
        """Map TMD weather text to WeatherCondition."""
        if not text:
            return WeatherCondition.UNKNOWN

        # Check Thai exact match
        if text in TMD_CONDITION_MAP:
            return TMD_CONDITION_MAP[text]

        # English keyword match (TMD sometimes returns English)
        text_lower = text.lower()
        if "thunder" in text_lower:
            return WeatherCondition.THUNDERSTORM
        if "heavy rain" in text_lower:
            return WeatherCondition.HEAVY_RAIN
        if "rain" in text_lower or "shower" in text_lower:
            return WeatherCondition.RAIN
        if "partly" in text_lower:
            return WeatherCondition.PARTLY_CLOUDY
        if "cloudy" in text_lower or "overcast" in text_lower:
            return WeatherCondition.CLOUDY
        if "clear" in text_lower or "sunny" in text_lower or "fair" in text_lower:
            return WeatherCondition.SUNNY

        # Thai keyword match
        if "ฟ้าคะนอง" in text:
            return WeatherCondition.THUNDERSTORM
        if "ฝนตกหนัก" in text:
            return WeatherCondition.HEAVY_RAIN
        if "ฝน" in text:
            return WeatherCondition.RAIN
        if "เมฆมาก" in text:
            return WeatherCondition.OVERCAST
        if "เมฆ" in text:
            return WeatherCondition.CLOUDY
        if "แจ่มใส" in text or "ท้องฟ้าแจ่มใส" in text:
            return WeatherCondition.SUNNY

        return WeatherCondition.UNKNOWN
