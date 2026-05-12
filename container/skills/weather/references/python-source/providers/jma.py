"""
Japan Meteorological Agency (JMA) Weather Provider.

Fetches weather data from JMA's public JSON endpoints.
Free, no API key required. Japan coverage only.

Note: These are not official APIs — they are JSON endpoints used by JMA's
website, publicly accessible under Japan's government standard license.
Spec may change without notice.

Endpoints:
  Forecast:  https://www.jma.go.jp/bosai/forecast/data/forecast/{area_code}.json
  Overview:  https://www.jma.go.jp/bosai/forecast/data/overview_forecast/{area_code}.json
"""

import asyncio
import re
from datetime import timezone, datetime, date
from typing import Optional
import urllib.request
import json

from .base import WeatherProvider, ProviderError, LocationNotSupportedError
from ..models import WeatherData, WeatherCondition, Location

# JMA area codes for major cities
# Full list: https://www.jma.go.jp/bosai/common/const/area.json
JMA_AREA_CODES = {
    # Hokkaido
    "sapporo": "016000",
    "hokkaido": "016000",
    # Tohoku
    "sendai": "040000",
    "miyagi": "040000",
    # Kanto
    "tokyo": "130000",
    "yokohama": "140000",
    "kanagawa": "140000",
    "chiba": "120000",
    "saitama": "110000",
    # Chubu
    "nagoya": "230000",
    "aichi": "230000",
    "niigata": "150000",
    # Kansai
    "osaka": "270000",
    "kyoto": "260000",
    "kobe": "280000",
    "hyogo": "280000",
    "nara": "290000",
    # Chugoku
    "hiroshima": "340000",
    "okayama": "330000",
    # Shikoku
    "matsuyama": "380000",
    "ehime": "380000",
    # Kyushu
    "fukuoka": "400000",
    "kumamoto": "430000",
    "kagoshima": "460100",
    # Okinawa
    "naha": "471000",
    "okinawa": "471000",
    # Country-level defaults
    "japan": "130000",
    "jp": "130000",
    "日本": "130000",
}

# JMA weather codes (3-digit) to condition mapping
# Reference: https://www.jma.go.jp/bosai/forecast/ (browser console: Forecast.Const.TELOPS)
JMA_WEATHER_CODE_MAP = {
    # Clear/Sunny (100-series)
    "100": WeatherCondition.SUNNY,
    "101": WeatherCondition.PARTLY_CLOUDY,  # sunny then cloudy
    "102": WeatherCondition.RAIN,           # sunny then rain
    "103": WeatherCondition.RAIN,           # sunny then rain
    "104": WeatherCondition.SNOW,           # sunny then snow
    "110": WeatherCondition.PARTLY_CLOUDY,
    "111": WeatherCondition.PARTLY_CLOUDY,  # sunny, cloudy later
    "112": WeatherCondition.RAIN,
    "113": WeatherCondition.RAIN,
    "114": WeatherCondition.RAIN,
    "115": WeatherCondition.SNOW,
    "116": WeatherCondition.RAIN,
    "117": WeatherCondition.THUNDERSTORM,
    "118": WeatherCondition.SNOW,
    "119": WeatherCondition.RAIN,
    "120": WeatherCondition.RAIN,
    "121": WeatherCondition.RAIN,
    "122": WeatherCondition.RAIN,
    "123": WeatherCondition.PARTLY_CLOUDY,
    "124": WeatherCondition.PARTLY_CLOUDY,
    "125": WeatherCondition.RAIN,
    "126": WeatherCondition.RAIN,
    "127": WeatherCondition.RAIN,
    "128": WeatherCondition.RAIN,
    "130": WeatherCondition.FOG,
    "131": WeatherCondition.FOG,
    "132": WeatherCondition.FOG,
    # Cloudy (200-series)
    "200": WeatherCondition.CLOUDY,
    "201": WeatherCondition.CLOUDY,
    "202": WeatherCondition.RAIN,           # cloudy then rain
    "203": WeatherCondition.RAIN,
    "204": WeatherCondition.SNOW,
    "205": WeatherCondition.SNOW,
    "206": WeatherCondition.RAIN,
    "207": WeatherCondition.RAIN,
    "208": WeatherCondition.RAIN,
    "209": WeatherCondition.THUNDERSTORM,
    "210": WeatherCondition.CLOUDY,
    "211": WeatherCondition.CLOUDY,
    "212": WeatherCondition.RAIN,           # cloudy, rain later
    "213": WeatherCondition.RAIN,
    "214": WeatherCondition.RAIN,
    "215": WeatherCondition.SNOW,
    "216": WeatherCondition.RAIN,
    "217": WeatherCondition.THUNDERSTORM,
    "218": WeatherCondition.RAIN,
    "219": WeatherCondition.RAIN,
    "220": WeatherCondition.RAIN,
    "221": WeatherCondition.RAIN,
    "222": WeatherCondition.SNOW,
    "223": WeatherCondition.PARTLY_CLOUDY,  # cloudy then sunny
    "224": WeatherCondition.RAIN,
    "225": WeatherCondition.RAIN,
    "226": WeatherCondition.SNOW,
    "228": WeatherCondition.RAIN,
    "229": WeatherCondition.RAIN,
    "230": WeatherCondition.SNOW,
    "231": WeatherCondition.CLOUDY,
    "240": WeatherCondition.FOG,
    # Rain (300-series)
    "300": WeatherCondition.RAIN,
    "301": WeatherCondition.RAIN,
    "302": WeatherCondition.HEAVY_RAIN,
    "303": WeatherCondition.RAIN,
    "304": WeatherCondition.HEAVY_RAIN,
    "306": WeatherCondition.HEAVY_RAIN,
    "308": WeatherCondition.HEAVY_RAIN,
    "309": WeatherCondition.RAIN,
    "311": WeatherCondition.RAIN,
    "313": WeatherCondition.RAIN,
    "314": WeatherCondition.RAIN,
    "315": WeatherCondition.RAIN,
    "316": WeatherCondition.RAIN,
    "317": WeatherCondition.THUNDERSTORM,
    "320": WeatherCondition.RAIN,
    "321": WeatherCondition.RAIN,
    "322": WeatherCondition.RAIN,
    "323": WeatherCondition.RAIN,
    "324": WeatherCondition.RAIN,
    "325": WeatherCondition.RAIN,
    "326": WeatherCondition.RAIN,
    "327": WeatherCondition.RAIN,
    "328": WeatherCondition.RAIN,
    "329": WeatherCondition.RAIN,
    "340": WeatherCondition.SNOW,
    "350": WeatherCondition.RAIN,
    # Snow (400-series)
    "400": WeatherCondition.SNOW,
    "401": WeatherCondition.SNOW,
    "402": WeatherCondition.HEAVY_SNOW,
    "403": WeatherCondition.SNOW,
    "405": WeatherCondition.HEAVY_SNOW,
    "406": WeatherCondition.SNOW,
    "407": WeatherCondition.HEAVY_SNOW,
    "409": WeatherCondition.SNOW,
    "411": WeatherCondition.SNOW,
    "413": WeatherCondition.SNOW,
    "414": WeatherCondition.SNOW,
    "420": WeatherCondition.SNOW,
    "421": WeatherCondition.SNOW,
    "422": WeatherCondition.SNOW,
    "423": WeatherCondition.SNOW,
    "425": WeatherCondition.SNOW,
    "426": WeatherCondition.SNOW,
    "427": WeatherCondition.SNOW,
    "450": WeatherCondition.SNOW,
}

# Supported locations
SUPPORTED_LOCATIONS = set(JMA_AREA_CODES.keys()) | {
    "日本", "東京", "大阪", "横浜", "京都", "名古屋",
    "札幌", "福岡", "広島", "仙台", "那覇",
}


class JMAProvider(WeatherProvider):
    """
    Japan Meteorological Agency weather provider.

    - Free, no API key required
    - Japan coverage only
    - Provides current weather overview and 7-day forecast
    """

    priority = 3
    supports_forecast = True
    supports_air_quality = False
    requires_api_key = False

    @property
    def name(self) -> str:
        return "jma"

    def supports_location(self, location: Location) -> bool:
        """Check if location is in Japan."""
        normalized = location.normalized.lower()
        return normalized in SUPPORTED_LOCATIONS

    async def get_current(self, location: Location) -> WeatherData:
        """Fetch current weather for Japanese location."""
        if not self.supports_location(location):
            raise LocationNotSupportedError(
                f"JMA only supports Japanese locations: {location.raw}"
            )

        try:
            area_code = self._get_area_code(location)
            forecast_data = await self._fetch_forecast(area_code)
            overview_data = await self._fetch_overview(area_code)
            return self._parse_current(location, forecast_data, overview_data)
        except Exception as e:
            raise ProviderError(f"JMA API error: {e}")

    async def get_forecast(
        self,
        location: Location,
        days: int = 7
    ) -> list[WeatherData]:
        """Fetch weather forecast for Japanese location."""
        if not self.supports_location(location):
            raise LocationNotSupportedError(
                f"JMA only supports Japanese locations: {location.raw}"
            )

        try:
            area_code = self._get_area_code(location)
            data = await self._fetch_forecast(area_code)
            return self._parse_forecast(location, data, days)
        except Exception as e:
            raise ProviderError(f"JMA API error: {e}")

    def _get_area_code(self, location: Location) -> str:
        """Resolve location to JMA area code."""
        normalized = location.normalized.lower()

        # Direct match
        if normalized in JMA_AREA_CODES:
            return JMA_AREA_CODES[normalized]

        # Partial match
        for city, code in JMA_AREA_CODES.items():
            if city in normalized or normalized in city:
                return code

        # Default to Tokyo
        return "130000"

    async def _fetch_forecast(self, area_code: str) -> list:
        """Fetch forecast JSON from JMA."""
        url = f"https://www.jma.go.jp/bosai/forecast/data/forecast/{area_code}.json"
        return await self._fetch_json(url)

    async def _fetch_overview(self, area_code: str) -> dict:
        """Fetch overview forecast from JMA."""
        url = f"https://www.jma.go.jp/bosai/forecast/data/overview_forecast/{area_code}.json"
        return await self._fetch_json(url)

    async def _fetch_json(self, url: str):
        """Fetch JSON from JMA endpoint."""
        loop = asyncio.get_running_loop()

        def fetch():
            req = urllib.request.Request(url)
            req.add_header("User-Agent", "WeatherSkill/1.0")
            with urllib.request.urlopen(req, timeout=15) as response:
                return json.loads(response.read().decode("utf-8"))

        return await loop.run_in_executor(None, fetch)

    def _get_display_name(self, location: Location) -> str:
        """Get display name for location."""
        normalized = location.normalized.lower()
        # Capitalise city names
        for city in JMA_AREA_CODES:
            if city == normalized:
                return city.title()
        return location.raw.title()

    def _parse_current(
        self,
        location: Location,
        forecast_data: list,
        overview_data: dict,
    ) -> WeatherData:
        """Parse current weather from JMA forecast + overview."""
        display_name = self._get_display_name(location)

        # Overview has a text description
        description = overview_data.get("text", "")
        # Clean up whitespace in Japanese text
        description = re.sub(r"\s+", " ", description).strip()
        if len(description) > 200:
            description = description[:197] + "..."

        # First element of forecast_data is short-term (today/tomorrow)
        condition = WeatherCondition.UNKNOWN
        temp_high = None
        temp_low = None
        precip_chance = None

        if forecast_data and len(forecast_data) > 0:
            short_term = forecast_data[0]
            time_series = short_term.get("timeSeries", [])

            # First timeSeries: weather codes, weathers, winds
            if time_series:
                ts0 = time_series[0]
                areas = ts0.get("areas", [])
                if areas:
                    area = areas[0]
                    codes = area.get("weatherCodes", [])
                    if codes:
                        condition = self._code_to_condition(codes[0])

            # Second timeSeries: precipitation probability (pops)
            if len(time_series) > 1:
                ts1 = time_series[1]
                areas = ts1.get("areas", [])
                if areas:
                    pops = areas[0].get("pops", [])
                    # Take the max of today's pops
                    pop_nums = []
                    for p in pops:
                        try:
                            pop_nums.append(int(p))
                        except (ValueError, TypeError):
                            pass
                    if pop_nums:
                        precip_chance = max(pop_nums)

            # Third timeSeries: temperatures (temps)
            if len(time_series) > 2:
                ts2 = time_series[2]
                areas = ts2.get("areas", [])
                if areas:
                    temps = areas[0].get("temps", [])
                    temp_nums = []
                    for t in temps:
                        try:
                            temp_nums.append(float(t))
                        except (ValueError, TypeError):
                            pass
                    if len(temp_nums) >= 2:
                        temp_low = min(temp_nums)
                        temp_high = max(temp_nums)

        # Use midpoint of high/low as current temp estimate
        temp = None
        if temp_high is not None and temp_low is not None:
            temp = (temp_high + temp_low) / 2
        elif temp_high is not None:
            temp = temp_high
        elif temp_low is not None:
            temp = temp_low

        return WeatherData(
            location=display_name,
            temperature=temp or 0.0,
            temp_high=temp_high,
            temp_low=temp_low,
            condition=condition,
            description=description,
            precipitation_chance=precip_chance,
            observed_at=datetime.now(timezone.utc),
            fetched_at=datetime.now(timezone.utc),
            provider_name=self.name,
        )

    def _parse_forecast(
        self,
        location: Location,
        forecast_data: list,
        days: int,
    ) -> list[WeatherData]:
        """Parse multi-day forecast from JMA response."""
        display_name = self._get_display_name(location)
        results = []

        # Second element of forecast_data is the weekly forecast
        if len(forecast_data) < 2:
            return results

        weekly = forecast_data[1]
        time_series = weekly.get("timeSeries", [])
        if not time_series:
            return results

        # First timeSeries: weather codes and pops
        ts0 = time_series[0]
        time_defines = ts0.get("timeDefines", [])
        areas = ts0.get("areas", [])
        if not areas:
            return results

        area = areas[0]
        weather_codes = area.get("weatherCodes", [])
        pops = area.get("pops", [])

        # Second timeSeries: temps (min/max)
        temps_min = []
        temps_max = []
        if len(time_series) > 1:
            ts1 = time_series[1]
            temp_areas = ts1.get("areas", [])
            if temp_areas:
                temps_min = temp_areas[0].get("tempsMin", [])
                temps_max = temp_areas[0].get("tempsMax", [])

        for i, td in enumerate(time_defines[:days]):
            # Parse date
            try:
                fc_date = datetime.fromisoformat(td.replace("Z", "+00:00")).date()
            except (ValueError, TypeError):
                continue

            code = weather_codes[i] if i < len(weather_codes) else ""
            condition = self._code_to_condition(code)

            pop = None
            if i < len(pops):
                try:
                    pop = int(pops[i])
                except (ValueError, TypeError):
                    pass

            t_min = None
            t_max = None
            if i < len(temps_min):
                try:
                    t_min = float(temps_min[i])
                except (ValueError, TypeError):
                    pass
            if i < len(temps_max):
                try:
                    t_max = float(temps_max[i])
                except (ValueError, TypeError):
                    pass

            results.append(WeatherData(
                location=display_name,
                temperature=t_min or 0.0,
                temp_high=t_max,
                temp_low=t_min,
                condition=condition,
                precipitation_chance=pop,
                forecast_date=fc_date,
                fetched_at=datetime.now(timezone.utc),
                provider_name=self.name,
            ))

        return results

    def _code_to_condition(self, code: str) -> WeatherCondition:
        """Map JMA 3-digit weather code to WeatherCondition."""
        return JMA_WEATHER_CODE_MAP.get(code, WeatherCondition.UNKNOWN)
