"""
Indonesia BMKG (Badan Meteorologi, Klimatologi, dan Geofisika) Weather Provider.

Fetches weather data from BMKG's public forecast API.
Free, no API key required. Indonesia coverage only.

API: https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4={area_code}
Docs: https://data.bmkg.go.id/prakiraan-cuaca
"""

import asyncio
from datetime import timezone, datetime, date
from typing import Optional
import urllib.request
import json

from .base import WeatherProvider, ProviderError, LocationNotSupportedError
from ..models import WeatherData, WeatherCondition, Location

# BMKG public API endpoint
BMKG_API_URL = "https://api.bmkg.go.id/publik/prakiraan-cuaca"

# Indonesian cities with their adm4 (village-level) area codes
# Format: {province_code}.{city_code}.{district_code}.{village_code}
BMKG_AREA_CODES = {
    # DKI Jakarta
    "jakarta": "31.71.01.1001",
    "dki jakarta": "31.71.01.1001",
    # West Java
    "bandung": "32.73.01.1001",
    "bogor": "32.71.01.1001",
    "bekasi": "32.75.01.1001",
    # Central Java
    "semarang": "33.74.01.1001",
    "solo": "33.72.01.1001",
    "surakarta": "33.72.01.1001",
    "yogyakarta": "34.71.01.1001",
    # East Java
    "surabaya": "35.78.01.1001",
    "malang": "35.73.01.1001",
    # Bali
    "denpasar": "51.71.01.1001",
    "bali": "51.71.01.1001",
    "ubud": "51.03.03.2001",
    # Sumatra
    "medan": "12.71.01.1001",
    "palembang": "16.71.01.1001",
    "padang": "13.71.01.1001",
    # Kalimantan
    "balikpapan": "64.71.01.1001",
    # Sulawesi
    "makassar": "73.71.01.1001",
    "manado": "71.71.01.1001",
    # Lombok / NTB
    "lombok": "52.71.01.1001",
    "mataram": "52.71.01.1001",
    # Country-level default
    "indonesia": "31.71.01.1001",
    "id": "31.71.01.1001",
}

# BMKG weather description (English) to condition mapping
BMKG_CONDITION_MAP = {
    "clear skies": WeatherCondition.SUNNY,
    "partly cloudy": WeatherCondition.PARTLY_CLOUDY,
    "mostly cloudy": WeatherCondition.CLOUDY,
    "overcast": WeatherCondition.OVERCAST,
    "haze": WeatherCondition.MIST,
    "smoke": WeatherCondition.MIST,
    "fog": WeatherCondition.FOG,
    "light rain": WeatherCondition.DRIZZLE,
    "rain": WeatherCondition.RAIN,
    "moderate rain": WeatherCondition.RAIN,
    "heavy rain": WeatherCondition.HEAVY_RAIN,
    "isolated shower": WeatherCondition.SHOWERS,
    "severe thunderstorm": WeatherCondition.THUNDERSTORM,
    "thunderstorm": WeatherCondition.THUNDERSTORM,
}

# Supported locations
SUPPORTED_LOCATIONS = set(BMKG_AREA_CODES.keys()) | {
    "indonesia", "id",
}


class BMKGProvider(WeatherProvider):
    """
    Indonesia BMKG weather provider.

    - Free, no API key required
    - Indonesia coverage only
    - Provides 3-day forecast (3-hourly intervals)
    - Rate limit: 60 requests/min per IP
    """

    priority = 8
    supports_forecast = True
    supports_air_quality = False
    requires_api_key = False

    @property
    def name(self) -> str:
        return "bmkg"

    def supports_location(self, location: Location) -> bool:
        """Check if location is in Indonesia."""
        normalized = location.normalized.lower()
        return normalized in SUPPORTED_LOCATIONS

    async def get_current(self, location: Location) -> WeatherData:
        """Fetch current weather for Indonesian location."""
        if not self.supports_location(location):
            raise LocationNotSupportedError(
                f"BMKG only supports Indonesian locations: {location.raw}"
            )

        try:
            area_code = self._get_area_code(location)
            data = await self._fetch_forecast(area_code)
            return self._parse_current(location, data)
        except Exception as e:
            raise ProviderError(f"BMKG API error: {e}")

    async def get_forecast(
        self,
        location: Location,
        days: int = 3
    ) -> list[WeatherData]:
        """Fetch weather forecast for Indonesian location."""
        if not self.supports_location(location):
            raise LocationNotSupportedError(
                f"BMKG only supports Indonesian locations: {location.raw}"
            )

        try:
            area_code = self._get_area_code(location)
            data = await self._fetch_forecast(area_code)
            return self._parse_forecast(location, data, days)
        except Exception as e:
            raise ProviderError(f"BMKG API error: {e}")

    def _get_area_code(self, location: Location) -> str:
        """Resolve location to BMKG adm4 area code."""
        normalized = location.normalized.lower()

        if normalized in BMKG_AREA_CODES:
            return BMKG_AREA_CODES[normalized]

        for city, code in BMKG_AREA_CODES.items():
            if city in normalized or normalized in city:
                return code

        # Default to Jakarta
        return BMKG_AREA_CODES["jakarta"]

    def _get_display_name(self, location: Location, data: dict) -> str:
        """Get display name from API response or location."""
        lokasi = data.get("lokasi", {})
        kotkab = lokasi.get("kotkab", "")
        provinsi = lokasi.get("provinsi", "")
        if kotkab:
            return kotkab
        if provinsi:
            return provinsi
        normalized = location.normalized.lower()
        for city in BMKG_AREA_CODES:
            if city == normalized:
                return city.title()
        return location.raw.title()

    async def _fetch_forecast(self, area_code: str) -> dict:
        """Fetch forecast from BMKG API."""
        url = f"{BMKG_API_URL}?adm4={area_code}"

        loop = asyncio.get_running_loop()

        def fetch():
            req = urllib.request.Request(url)
            req.add_header("User-Agent", "WeatherSkill/1.0")
            req.add_header("Accept", "application/json")
            with urllib.request.urlopen(req, timeout=15) as response:
                return json.loads(response.read().decode("utf-8"))

        return await loop.run_in_executor(None, fetch)

    def _parse_current(self, location: Location, data: dict) -> WeatherData:
        """Parse current weather from BMKG response (nearest 3h interval)."""
        display_name = self._get_display_name(location, data)

        # data.data[0].cuaca is a list of days, each day is a list of 3h intervals
        cuaca_days = data.get("data", [{}])[0].get("cuaca", [])
        if not cuaca_days:
            raise ProviderError("No weather data in BMKG response")

        # Find the most recent/current interval
        now = datetime.now(timezone.utc)
        best = None
        best_diff = float("inf")

        for day in cuaca_days:
            for entry in day:
                utc_str = entry.get("utc_datetime", "")
                if not utc_str:
                    continue
                try:
                    entry_time = datetime.strptime(
                        utc_str, "%Y-%m-%d %H:%M:%S"
                    ).replace(tzinfo=timezone.utc)
                    diff = abs((now - entry_time).total_seconds())
                    if diff < best_diff:
                        best_diff = diff
                        best = entry
                except (ValueError, TypeError):
                    continue

        if not best:
            # Fall back to first entry
            best = cuaca_days[0][0] if cuaca_days and cuaca_days[0] else {}

        return self._entry_to_weather_data(display_name, best, is_current=True)

    def _parse_forecast(
        self,
        location: Location,
        data: dict,
        days: int,
    ) -> list[WeatherData]:
        """Parse multi-day forecast from BMKG response."""
        display_name = self._get_display_name(location, data)
        results = []

        cuaca_days = data.get("data", [{}])[0].get("cuaca", [])

        # Group by date, take midday entry per day
        seen_dates = set()
        for day_entries in cuaca_days:
            for entry in day_entries:
                local_str = entry.get("local_datetime", "")
                if not local_str:
                    continue
                try:
                    local_dt = datetime.strptime(local_str, "%Y-%m-%d %H:%M:%S")
                    fc_date = local_dt.date()
                except (ValueError, TypeError):
                    continue

                if fc_date in seen_dates:
                    continue

                # Prefer midday entry (12:00 local) for daily representative
                if local_dt.hour < 10 or local_dt.hour > 15:
                    # Check if we have a better entry for this date
                    has_midday = any(
                        e.get("local_datetime", "").endswith("12:00:00")
                        or e.get("local_datetime", "").endswith("13:00:00")
                        for e in day_entries
                    )
                    if has_midday:
                        continue

                seen_dates.add(fc_date)
                if len(results) >= days:
                    break

                wd = self._entry_to_weather_data(display_name, entry, is_current=False)
                wd.forecast_date = fc_date
                results.append(wd)

            if len(results) >= days:
                break

        return results

    def _entry_to_weather_data(
        self,
        display_name: str,
        entry: dict,
        is_current: bool = False,
    ) -> WeatherData:
        """Convert a single BMKG 3h forecast entry to WeatherData."""
        temp = entry.get("t")  # °C
        humidity = entry.get("hu")  # %
        weather_en = entry.get("weather_desc_en", "")
        wind_speed = entry.get("ws")  # km/h
        wind_dir = entry.get("wd", "")
        cloud_cover = entry.get("tcc")  # %
        visibility_text = entry.get("vs_text", "")

        condition = self._text_to_condition(weather_en)

        wind_description = None
        if wind_dir and wind_speed:
            wind_description = f"{wind_dir} {wind_speed} km/h"

        observed_at = None
        if is_current:
            utc_str = entry.get("utc_datetime", "")
            if utc_str:
                try:
                    observed_at = datetime.strptime(
                        utc_str, "%Y-%m-%d %H:%M:%S"
                    ).replace(tzinfo=timezone.utc)
                except (ValueError, TypeError):
                    pass

        return WeatherData(
            location=display_name,
            temperature=float(temp) if temp is not None else 0.0,
            humidity=int(humidity) if humidity is not None else None,
            condition=condition,
            description=weather_en,
            wind_speed=float(wind_speed) if wind_speed is not None else None,
            wind_description=wind_description,
            observed_at=observed_at,
            fetched_at=datetime.now(timezone.utc),
            provider_name=self.name,
        )

    def _text_to_condition(self, text: str) -> WeatherCondition:
        """Map BMKG English weather description to WeatherCondition."""
        if not text:
            return WeatherCondition.UNKNOWN
        text_lower = text.lower().strip()

        if text_lower in BMKG_CONDITION_MAP:
            return BMKG_CONDITION_MAP[text_lower]

        if "thunder" in text_lower:
            return WeatherCondition.THUNDERSTORM
        if "heavy rain" in text_lower:
            return WeatherCondition.HEAVY_RAIN
        if "rain" in text_lower or "shower" in text_lower:
            return WeatherCondition.RAIN
        if "drizzle" in text_lower or "light rain" in text_lower:
            return WeatherCondition.DRIZZLE
        if "cloud" in text_lower or "overcast" in text_lower:
            return WeatherCondition.CLOUDY
        if "haze" in text_lower or "smoke" in text_lower:
            return WeatherCondition.MIST
        if "fog" in text_lower:
            return WeatherCondition.FOG
        if "clear" in text_lower or "sunny" in text_lower:
            return WeatherCondition.SUNNY

        return WeatherCondition.UNKNOWN
