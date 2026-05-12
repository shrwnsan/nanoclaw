"""
Taiwan Central Weather Administration (CWA) Weather Provider.

Fetches weather data from CWA's Open Data API.
Requires free API key from https://opendata.cwa.gov.tw/index

API Documentation: https://opendata.cwa.gov.tw/dist/opendata-swagger.html
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

# CWA Open Data API endpoints
CWA_BASE_URL = "https://opendata.cwa.gov.tw/api/v1/rest/datastore"
CWA_OBSERVATION_ID = "O-A0003-001"      # Current observations (all stations)
CWA_FORECAST_36HR_ID = "F-C0032-001"    # 36-hour forecast (all counties)
CWA_FORECAST_1WEEK_ID = "F-D0047-091"   # 1-week forecast (all counties)

# Taiwan cities with CWA location names (Traditional Chinese)
TW_LOCATIONS = {
    "taipei": "臺北市",
    "台北": "臺北市",
    "臺北": "臺北市",
    "new taipei": "新北市",
    "新北": "新北市",
    "taoyuan": "桃園市",
    "桃園": "桃園市",
    "taichung": "臺中市",
    "台中": "臺中市",
    "臺中": "臺中市",
    "tainan": "臺南市",
    "台南": "臺南市",
    "臺南": "臺南市",
    "kaohsiung": "高雄市",
    "高雄": "高雄市",
    "keelung": "基隆市",
    "基隆": "基隆市",
    "hsinchu": "新竹市",
    "新竹": "新竹市",
    "chiayi": "嘉義市",
    "嘉義": "嘉義市",
    "hualien": "花蓮縣",
    "花蓮": "花蓮縣",
    "taitung": "臺東縣",
    "台東": "臺東縣",
    "臺東": "臺東縣",
    "yilan": "宜蘭縣",
    "宜蘭": "宜蘭縣",
    "nantou": "南投縣",
    "南投": "南投縣",
    "changhua": "彰化縣",
    "彰化": "彰化縣",
    "yunlin": "雲林縣",
    "雲林": "雲林縣",
    "pingtung": "屏東縣",
    "屏東": "屏東縣",
    "miaoli": "苗栗縣",
    "苗栗": "苗栗縣",
    "penghu": "澎湖縣",
    "澎湖": "澎湖縣",
    "kinmen": "金門縣",
    "金門": "金門縣",
    # Country-level default
    "taiwan": "臺北市",
    "tw": "臺北市",
    "台灣": "臺北市",
    "臺灣": "臺北市",
}

# CWA weather phenomenon text to condition mapping
CWA_CONDITION_MAP = {
    "晴": WeatherCondition.SUNNY,
    "晴時多雲": WeatherCondition.PARTLY_CLOUDY,
    "多雲": WeatherCondition.CLOUDY,
    "多雲時晴": WeatherCondition.PARTLY_CLOUDY,
    "多雲時陰": WeatherCondition.CLOUDY,
    "多雲短暫雨": WeatherCondition.RAIN,
    "陰": WeatherCondition.OVERCAST,
    "陰時多雲": WeatherCondition.CLOUDY,
    "陰天": WeatherCondition.OVERCAST,
    "陰有雨": WeatherCondition.RAIN,
    "陰短暫雨": WeatherCondition.RAIN,
    "短暫雨": WeatherCondition.SHOWERS,
    "短暫陣雨": WeatherCondition.SHOWERS,
    "有雨": WeatherCondition.RAIN,
    "陣雨": WeatherCondition.SHOWERS,
    "雷陣雨": WeatherCondition.THUNDERSTORM,
    "大雨": WeatherCondition.HEAVY_RAIN,
    "豪雨": WeatherCondition.HEAVY_RAIN,
    "大豪雨": WeatherCondition.HEAVY_RAIN,
    "霧": WeatherCondition.FOG,
}

# Observation station names for major cities
CWA_STATIONS = {
    "臺北市": "臺北",
    "新北市": "板橋",
    "桃園市": "桃園",
    "臺中市": "臺中",
    "臺南市": "臺南",
    "高雄市": "高雄",
    "基隆市": "基隆",
    "新竹市": "新竹",
    "嘉義市": "嘉義",
    "花蓮縣": "花蓮",
    "臺東縣": "臺東",
    "宜蘭縣": "宜蘭",
}

# Supported locations
SUPPORTED_LOCATIONS = set(TW_LOCATIONS.keys()) | {
    "台灣", "臺灣", "taiwan", "tw",
}


class CWAProvider(WeatherProvider):
    """
    Taiwan CWA weather provider.

    - Requires API key (free registration at opendata.cwa.gov.tw)
    - Taiwan coverage only
    - Provides current observations and 7-day forecast
    """

    priority = 4
    supports_forecast = True
    supports_air_quality = False
    requires_api_key = True

    def __init__(self, api_key: Optional[str] = None):
        self._api_key = api_key or os.environ.get("CWA_API_KEY", "")

    @property
    def name(self) -> str:
        return "cwa"

    def supports_location(self, location: Location) -> bool:
        """Check if location is in Taiwan."""
        if not self._api_key:
            return False
        normalized = location.normalized.lower()
        return normalized in SUPPORTED_LOCATIONS

    async def get_current(self, location: Location) -> WeatherData:
        """Fetch current weather for Taiwanese location."""
        if not self.supports_location(location):
            raise LocationNotSupportedError(
                f"CWA only supports Taiwanese locations: {location.raw}"
            )

        try:
            cwa_name = self._get_cwa_name(location)
            station_name = CWA_STATIONS.get(cwa_name, cwa_name.rstrip("市縣"))

            # Fetch observations filtered by station
            params = {
                "Authorization": self._api_key,
                "StationName": station_name,
            }
            obs_data = await self._fetch_api(CWA_OBSERVATION_ID, params)

            # Also fetch 36-hour forecast for condition/description
            fc_params = {
                "Authorization": self._api_key,
                "locationName": cwa_name,
            }
            fc_data = await self._fetch_api(CWA_FORECAST_36HR_ID, fc_params)

            return self._parse_current(location, cwa_name, obs_data, fc_data)
        except Exception as e:
            raise ProviderError(f"CWA API error: {e}")

    async def get_forecast(
        self,
        location: Location,
        days: int = 7
    ) -> list[WeatherData]:
        """Fetch weather forecast for Taiwanese location."""
        if not self.supports_location(location):
            raise LocationNotSupportedError(
                f"CWA only supports Taiwanese locations: {location.raw}"
            )

        try:
            cwa_name = self._get_cwa_name(location)
            params = {
                "Authorization": self._api_key,
                "locationName": cwa_name,
            }
            data = await self._fetch_api(CWA_FORECAST_1WEEK_ID, params)
            return self._parse_forecast(location, cwa_name, data, days)
        except Exception as e:
            raise ProviderError(f"CWA API error: {e}")

    def _get_cwa_name(self, location: Location) -> str:
        """Resolve location to CWA location name (Traditional Chinese)."""
        normalized = location.normalized.lower()
        return TW_LOCATIONS.get(normalized, "臺北市")

    async def _fetch_api(self, dataset_id: str, params: dict) -> dict:
        """Fetch data from CWA Open Data API."""
        query = urllib.parse.urlencode(params)
        url = f"{CWA_BASE_URL}/{dataset_id}?{query}"

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
        cwa_name: str,
        obs_data: dict,
        fc_data: dict,
    ) -> WeatherData:
        """Parse current weather from CWA observations + forecast."""
        display_name = cwa_name

        # Parse observation data
        temp = None
        humidity = None
        wind_speed = None
        wind_direction = None
        observed_at = None

        stations = obs_data.get("records", {}).get("Station", [])
        if stations:
            station = stations[0]
            elements = station.get("WeatherElement", {})

            temp = elements.get("AirTemperature")
            humidity = elements.get("RelativeHumidity")
            if isinstance(humidity, (int, float)):
                humidity = round(humidity)

            wind_speed = elements.get("WindSpeed")
            wind_direction_deg = elements.get("WindDirection")
            if wind_direction_deg is not None:
                wind_direction = self._deg_to_compass(wind_direction_deg)

            obs_time = station.get("ObsTime", {}).get("DateTime", "")
            if obs_time:
                try:
                    observed_at = datetime.fromisoformat(obs_time)
                except (ValueError, TypeError):
                    pass

        # Parse forecast for condition and description
        condition = WeatherCondition.UNKNOWN
        description = ""
        pop = None

        locations = fc_data.get("records", {}).get("location", [])
        if locations:
            loc = locations[0]
            elements = loc.get("weatherElement", [])
            for elem in elements:
                elem_name = elem.get("elementName", "")
                time_entries = elem.get("time", [])
                if not time_entries:
                    continue
                first = time_entries[0]
                param = first.get("parameter", {})

                if elem_name == "Wx":  # Weather phenomenon
                    description = param.get("parameterName", "")
                    condition = self._text_to_condition(description)
                elif elem_name == "PoP":  # Probability of precipitation
                    try:
                        pop = int(param.get("parameterName", ""))
                    except (ValueError, TypeError):
                        pass

        return WeatherData(
            location=display_name,
            temperature=temp or 0.0,
            humidity=humidity,
            wind_speed=wind_speed,
            wind_direction=wind_direction,
            condition=condition,
            description=description,
            precipitation_chance=pop,
            observed_at=observed_at,
            fetched_at=datetime.now(timezone.utc),
            provider_name=self.name,
        )

    def _parse_forecast(
        self,
        location: Location,
        cwa_name: str,
        data: dict,
        days: int,
    ) -> list[WeatherData]:
        """Parse multi-day forecast from CWA response."""
        results = []

        locations = data.get("records", {}).get("locations", [])
        if not locations:
            return results

        loc_list = locations[0].get("location", [])
        if not loc_list:
            return results

        loc = loc_list[0]
        elements = loc.get("weatherElement", [])

        # Build per-day data from weather elements
        # Elements include: Wx (weather), MinT, MaxT, PoP12h, etc.
        wx_times = []
        min_temps = []
        max_temps = []
        pops = []

        for elem in elements:
            elem_name = elem.get("elementName", "")
            time_entries = elem.get("time", [])

            if elem_name == "Wx":
                wx_times = time_entries
            elif elem_name == "MinT":
                min_temps = time_entries
            elif elem_name == "MaxT":
                max_temps = time_entries
            elif elem_name in ("PoP12h", "PoP"):
                pops = time_entries

        # Group by date (take first entry per day)
        seen_dates = set()
        for i, wx in enumerate(wx_times):
            start_time = wx.get("startTime", "")
            if not start_time:
                continue

            try:
                fc_dt = datetime.fromisoformat(start_time)
                fc_date = fc_dt.date()
            except (ValueError, TypeError):
                continue

            if fc_date in seen_dates:
                continue
            seen_dates.add(fc_date)

            if len(results) >= days:
                break

            # Weather condition
            elem_values = wx.get("elementValue", [])
            wx_text = elem_values[0].get("value", "") if elem_values else ""
            condition = self._text_to_condition(wx_text)

            # Temperatures
            t_min = None
            t_max = None
            if i < len(min_temps):
                vals = min_temps[i].get("elementValue", [])
                if vals:
                    try:
                        t_min = float(vals[0].get("value", ""))
                    except (ValueError, TypeError):
                        pass
            if i < len(max_temps):
                vals = max_temps[i].get("elementValue", [])
                if vals:
                    try:
                        t_max = float(vals[0].get("value", ""))
                    except (ValueError, TypeError):
                        pass

            # Precipitation chance
            pop = None
            if i < len(pops):
                vals = pops[i].get("elementValue", [])
                if vals:
                    try:
                        pop = int(vals[0].get("value", ""))
                    except (ValueError, TypeError):
                        pass

            results.append(WeatherData(
                location=cwa_name,
                temperature=t_min or 0.0,
                temp_high=t_max,
                temp_low=t_min,
                condition=condition,
                description=wx_text,
                precipitation_chance=pop,
                forecast_date=fc_date,
                fetched_at=datetime.now(timezone.utc),
                provider_name=self.name,
            ))

        return results

    def _text_to_condition(self, text: str) -> WeatherCondition:
        """Map CWA weather text to WeatherCondition."""
        if not text:
            return WeatherCondition.UNKNOWN

        # Exact match
        if text in CWA_CONDITION_MAP:
            return CWA_CONDITION_MAP[text]

        # Keyword match (Chinese)
        if "雷" in text:
            return WeatherCondition.THUNDERSTORM
        if "大雨" in text or "豪雨" in text:
            return WeatherCondition.HEAVY_RAIN
        if "雨" in text:
            return WeatherCondition.RAIN
        if "雪" in text:
            return WeatherCondition.SNOW
        if "霧" in text:
            return WeatherCondition.FOG
        if "陰" in text:
            return WeatherCondition.OVERCAST
        if "多雲" in text:
            return WeatherCondition.CLOUDY
        if "晴" in text:
            return WeatherCondition.SUNNY

        return WeatherCondition.UNKNOWN

    @staticmethod
    def _deg_to_compass(deg: float) -> str:
        """Convert wind direction degrees to compass direction."""
        directions = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                       "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
        idx = round(deg / 22.5) % 16
        return directions[idx]
