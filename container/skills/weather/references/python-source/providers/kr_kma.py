"""
South Korea Meteorological Administration (KMA) Weather Provider.

Fetches weather data from KMA via data.go.kr public data portal.
Requires free API key (ServiceKey) from https://data.go.kr/

API: https://apis.data.go.kr/1360000/VilageFcstInfoService2.0
"""

import asyncio
import math
import os
from datetime import timezone, datetime, date, timedelta
from typing import Optional
import urllib.request
import urllib.parse
import json

from .base import WeatherProvider, ProviderError, LocationNotSupportedError
from ..models import WeatherData, WeatherCondition, Location

# KMA API endpoint
KMA_BASE_URL = "https://apis.data.go.kr/1360000/VilageFcstInfoService2.0"
KMA_FORECAST_URL = f"{KMA_BASE_URL}/getVilageFcst"
KMA_NOWCAST_URL = f"{KMA_BASE_URL}/getUltraSrtNcst"

# Korean cities with coordinates and pre-computed grid (nx, ny)
# Grid conversion uses Lambert Conformal Conic projection
KR_CITIES = {
    "seoul": {"lat": 37.5665, "lon": 126.9780, "nx": 60, "ny": 127},
    "busan": {"lat": 35.1796, "lon": 129.0756, "nx": 98, "ny": 76},
    "incheon": {"lat": 37.4563, "lon": 126.7052, "nx": 55, "ny": 124},
    "daegu": {"lat": 35.8714, "lon": 128.6014, "nx": 89, "ny": 90},
    "daejeon": {"lat": 36.3504, "lon": 127.3845, "nx": 67, "ny": 100},
    "gwangju": {"lat": 35.1595, "lon": 126.8526, "nx": 58, "ny": 74},
    "ulsan": {"lat": 35.5384, "lon": 129.3114, "nx": 102, "ny": 84},
    "sejong": {"lat": 36.4800, "lon": 127.0000, "nx": 66, "ny": 103},
    "suwon": {"lat": 37.2636, "lon": 127.0286, "nx": 60, "ny": 121},
    "jeju": {"lat": 33.4996, "lon": 126.5312, "nx": 52, "ny": 38},
    "cheongju": {"lat": 36.6424, "lon": 127.4890, "nx": 69, "ny": 107},
    "jeonju": {"lat": 35.8242, "lon": 127.1480, "nx": 63, "ny": 89},
    "changwon": {"lat": 35.2281, "lon": 128.6812, "nx": 90, "ny": 77},
    "goyang": {"lat": 37.6584, "lon": 126.8320, "nx": 57, "ny": 128},
    "yongin": {"lat": 37.2411, "lon": 127.1776, "nx": 62, "ny": 121},
    "seongnam": {"lat": 37.4449, "lon": 127.1389, "nx": 62, "ny": 124},
    "bucheon": {"lat": 37.5034, "lon": 126.7660, "nx": 56, "ny": 125},
    "gangneung": {"lat": 37.7519, "lon": 128.8761, "nx": 92, "ny": 131},
    # Country-level defaults
    "south korea": {"lat": 37.5665, "lon": 126.9780, "nx": 60, "ny": 127},
    "korea": {"lat": 37.5665, "lon": 126.9780, "nx": 60, "ny": 127},
    "kr": {"lat": 37.5665, "lon": 126.9780, "nx": 60, "ny": 127},
    "한국": {"lat": 37.5665, "lon": 126.9780, "nx": 60, "ny": 127},
    "서울": {"lat": 37.5665, "lon": 126.9780, "nx": 60, "ny": 127},
    "부산": {"lat": 35.1796, "lon": 129.0756, "nx": 98, "ny": 76},
    "제주": {"lat": 33.4996, "lon": 126.5312, "nx": 52, "ny": 38},
}

# KMA category codes to WeatherCondition mapping
# SKY: 1=Clear, 3=PartlyCloudy, 4=Cloudy
# PTY: 0=None, 1=Rain, 2=Rain/Snow, 3=Snow, 4=Shower, 5=Drizzle, 6=DrizzleSnow, 7=SnowFlurry
KMA_PTY_MAP = {
    "0": None,  # No precipitation — use SKY instead
    "1": WeatherCondition.RAIN,
    "2": WeatherCondition.SLEET,
    "3": WeatherCondition.SNOW,
    "4": WeatherCondition.SHOWERS,
    "5": WeatherCondition.DRIZZLE,
    "6": WeatherCondition.SLEET,
    "7": WeatherCondition.SNOW,
}

KMA_SKY_MAP = {
    "1": WeatherCondition.SUNNY,
    "3": WeatherCondition.PARTLY_CLOUDY,
    "4": WeatherCondition.CLOUDY,
}

# Supported locations
SUPPORTED_LOCATIONS = set(KR_CITIES.keys())


class KMAProvider(WeatherProvider):
    """
    South Korea KMA weather provider.

    - Requires API key (free from data.go.kr)
    - South Korea coverage only
    - Provides short-term forecast (3 days, 3h intervals)
    """

    priority = 9
    supports_forecast = True
    supports_air_quality = False
    requires_api_key = True

    def __init__(self, api_key: Optional[str] = None):
        self._api_key = api_key or os.environ.get("KMA_SERVICE_KEY", "")

    @property
    def name(self) -> str:
        return "kma"

    def supports_location(self, location: Location) -> bool:
        """Check if location is in South Korea."""
        if not self._api_key:
            return False
        normalized = location.normalized.lower()
        return normalized in SUPPORTED_LOCATIONS

    async def get_current(self, location: Location) -> WeatherData:
        """Fetch current weather for Korean location."""
        if not self.supports_location(location):
            raise LocationNotSupportedError(
                f"KMA only supports Korean locations: {location.raw}"
            )

        try:
            city_info = self._get_city_info(location)
            data = await self._fetch_nowcast(city_info["nx"], city_info["ny"])
            return self._parse_nowcast(location, data)
        except Exception as e:
            raise ProviderError(f"KMA API error: {e}")

    async def get_forecast(
        self,
        location: Location,
        days: int = 3
    ) -> list[WeatherData]:
        """Fetch weather forecast for Korean location."""
        if not self.supports_location(location):
            raise LocationNotSupportedError(
                f"KMA only supports Korean locations: {location.raw}"
            )

        try:
            city_info = self._get_city_info(location)
            data = await self._fetch_forecast(city_info["nx"], city_info["ny"])
            return self._parse_forecast(location, data, days)
        except Exception as e:
            raise ProviderError(f"KMA API error: {e}")

    def _get_city_info(self, location: Location) -> dict:
        """Get city info including grid coordinates."""
        normalized = location.normalized.lower()
        if normalized in KR_CITIES:
            return KR_CITIES[normalized]
        for city, info in KR_CITIES.items():
            if city in normalized or normalized in city:
                return info
        return KR_CITIES["seoul"]

    def _get_display_name(self, location: Location) -> str:
        """Get display name for location."""
        normalized = location.normalized.lower()
        for city in KR_CITIES:
            if city == normalized:
                return city.title()
        return location.raw.title()

    def _get_base_time(self) -> tuple[str, str]:
        """Get the latest available forecast base_date and base_time.

        KMA short-term forecasts are published at:
        0200, 0500, 0800, 1100, 1400, 1700, 2000, 2300 KST
        Available ~10 min after base_time.
        """
        # KST = UTC+9
        now_kst = datetime.now(timezone.utc) + timedelta(hours=9)
        base_times = [2, 5, 8, 11, 14, 17, 20, 23]

        # Find the most recent base_time
        current_hour = now_kst.hour
        base_hour = 23  # default to previous day's 23:00
        base_date = now_kst.date()

        for bt in reversed(base_times):
            if current_hour >= bt:
                base_hour = bt
                break
        else:
            # Before 02:00 KST, use previous day 23:00
            base_date = base_date - timedelta(days=1)

        return base_date.strftime("%Y%m%d"), f"{base_hour:02d}00"

    async def _fetch_nowcast(self, nx: int, ny: int) -> dict:
        """Fetch ultra-short-term nowcast from KMA."""
        now_kst = datetime.now(timezone.utc) + timedelta(hours=9)
        # Nowcast available at HH:40 for base_time HH:00
        if now_kst.minute < 40:
            base_dt = now_kst - timedelta(hours=1)
        else:
            base_dt = now_kst

        params = {
            "serviceKey": self._api_key,
            "numOfRows": "100",
            "pageNo": "1",
            "dataType": "JSON",
            "base_date": base_dt.strftime("%Y%m%d"),
            "base_time": f"{base_dt.hour:02d}00",
            "nx": str(nx),
            "ny": str(ny),
        }
        return await self._fetch_api(KMA_NOWCAST_URL, params)

    async def _fetch_forecast(self, nx: int, ny: int) -> dict:
        """Fetch short-term forecast from KMA."""
        base_date, base_time = self._get_base_time()
        params = {
            "serviceKey": self._api_key,
            "numOfRows": "1000",
            "pageNo": "1",
            "dataType": "JSON",
            "base_date": base_date,
            "base_time": base_time,
            "nx": str(nx),
            "ny": str(ny),
        }
        return await self._fetch_api(KMA_FORECAST_URL, params)

    async def _fetch_api(self, base_url: str, params: dict) -> dict:
        """Fetch data from KMA API."""
        query = urllib.parse.urlencode(params)
        url = f"{base_url}?{query}"

        loop = asyncio.get_running_loop()

        def fetch():
            req = urllib.request.Request(url)
            req.add_header("User-Agent", "WeatherSkill/1.0")
            with urllib.request.urlopen(req, timeout=15) as response:
                return json.loads(response.read().decode("utf-8"))

        return await loop.run_in_executor(None, fetch)

    def _parse_nowcast(self, location: Location, data: dict) -> WeatherData:
        """Parse current weather from KMA nowcast response."""
        display_name = self._get_display_name(location)

        items = (data.get("response", {}).get("body", {})
                 .get("items", {}).get("item", []))

        values = {}
        for item in items:
            cat = item.get("category", "")
            val = item.get("obsrValue", "")
            values[cat] = val

        temp = float(values.get("T1H", 0))  # Temperature
        humidity = int(float(values.get("REH", 0)))  # Relative humidity
        wind_speed = float(values.get("WSD", 0))  # Wind speed m/s → km/h
        wind_speed_kmh = round(wind_speed * 3.6, 1)
        pty = values.get("PTY", "0")  # Precipitation type

        condition = KMA_PTY_MAP.get(pty, WeatherCondition.UNKNOWN)
        if condition is None:
            condition = WeatherCondition.UNKNOWN  # No precip, no sky info in nowcast

        return WeatherData(
            location=display_name,
            temperature=temp,
            humidity=humidity,
            wind_speed=wind_speed_kmh,
            condition=condition or WeatherCondition.UNKNOWN,
            observed_at=datetime.now(timezone.utc),
            fetched_at=datetime.now(timezone.utc),
            provider_name=self.name,
        )

    def _parse_forecast(
        self,
        location: Location,
        data: dict,
        days: int,
    ) -> list[WeatherData]:
        """Parse multi-day forecast from KMA response."""
        display_name = self._get_display_name(location)

        items = (data.get("response", {}).get("body", {})
                 .get("items", {}).get("item", []))

        # Group by date
        daily = {}
        for item in items:
            fc_date_str = item.get("fcstDate", "")
            cat = item.get("category", "")
            val = item.get("fcstValue", "")

            if fc_date_str not in daily:
                daily[fc_date_str] = {"TMX": None, "TMN": None, "SKY": [], "PTY": [], "POP": [], "REH": []}

            d = daily[fc_date_str]
            if cat == "TMX":
                try:
                    d["TMX"] = float(val)
                except (ValueError, TypeError):
                    pass
            elif cat == "TMN":
                try:
                    d["TMN"] = float(val)
                except (ValueError, TypeError):
                    pass
            elif cat == "SKY":
                d["SKY"].append(val)
            elif cat == "PTY":
                d["PTY"].append(val)
            elif cat == "POP":
                try:
                    d["POP"].append(int(val))
                except (ValueError, TypeError):
                    pass
            elif cat == "REH":
                try:
                    d["REH"].append(int(val))
                except (ValueError, TypeError):
                    pass

        results = []
        for date_str in sorted(daily.keys())[:days]:
            d = daily[date_str]
            try:
                fc_date = datetime.strptime(date_str, "%Y%m%d").date()
            except (ValueError, TypeError):
                continue

            # Determine condition from PTY (precipitation type) and SKY
            condition = WeatherCondition.UNKNOWN
            pty_values = [p for p in d["PTY"] if p != "0"]
            if pty_values:
                condition = KMA_PTY_MAP.get(pty_values[0], WeatherCondition.RAIN)
            elif d["SKY"]:
                # Most common sky condition
                from collections import Counter
                most_common_sky = Counter(d["SKY"]).most_common(1)[0][0]
                condition = KMA_SKY_MAP.get(most_common_sky, WeatherCondition.UNKNOWN)

            pop = max(d["POP"]) if d["POP"] else None
            humidity = round(sum(d["REH"]) / len(d["REH"])) if d["REH"] else None

            results.append(WeatherData(
                location=display_name,
                temperature=d["TMN"] or 0.0,
                temp_high=d["TMX"],
                temp_low=d["TMN"],
                humidity=humidity,
                condition=condition or WeatherCondition.UNKNOWN,
                precipitation_chance=pop,
                forecast_date=fc_date,
                fetched_at=datetime.now(timezone.utc),
                provider_name=self.name,
            ))

        return results
