"""
United States National Weather Service (NWS) Weather Provider.

Fetches weather data from NWS public API.
Free, no API key required. USA coverage only.

API Documentation: https://www.weather.gov/documentation/services-web-api
"""

import asyncio
import re
from datetime import timezone, datetime, date
from typing import Optional
import urllib.request
import json

from .base import WeatherProvider, ProviderError, LocationNotSupportedError
from ..models import WeatherData, WeatherCondition, Location

# NWS API endpoints
NWS_BASE_URL = "https://api.weather.gov"
NWS_POINTS_URL = f"{NWS_BASE_URL}/points/{{lat}},{{lon}}"
NWS_STATIONS_URL = f"{NWS_BASE_URL}/stations"

# US city coordinates (latitude, longitude)
US_CITIES = {
    # Major metros
    "new york": (40.7128, -74.0060),
    "nyc": (40.7128, -74.0060),
    "los angeles": (34.0522, -118.2437),
    "la": (34.0522, -118.2437),
    "chicago": (41.8781, -87.6298),
    "houston": (29.7604, -95.3698),
    "phoenix": (33.4484, -112.0740),
    "philadelphia": (39.9526, -75.1652),
    "philly": (39.9526, -75.1652),
    "san antonio": (29.4241, -98.4936),
    "san diego": (32.7157, -117.1611),
    "dallas": (32.7767, -96.7970),
    "san jose": (37.3382, -121.8863),
    "austin": (30.2672, -97.7431),
    "jacksonville": (30.3322, -81.6557),
    "fort worth": (32.7555, -97.3308),
    "columbus": (39.9612, -82.9988),
    "charlotte": (35.2271, -80.8431),
    "san francisco": (37.7749, -122.4194),
    "sf": (37.7749, -122.4194),
    "indianapolis": (39.7684, -86.1581),
    "seattle": (47.6062, -122.3321),
    "denver": (39.7392, -104.9903),
    "washington dc": (38.9072, -77.0369),
    "dc": (38.9072, -77.0369),
    "boston": (42.3601, -71.0589),
    "nashville": (36.1627, -86.7816),
    "detroit": (42.3314, -83.0458),
    "portland": (45.5152, -122.6784),
    "las vegas": (36.1699, -115.1398),
    "memphis": (35.1495, -90.0490),
    "louisville": (38.2527, -85.7585),
    "baltimore": (39.2904, -76.6122),
    "milwaukee": (43.0389, -87.9065),
    "albuquerque": (35.0844, -106.6504),
    "tucson": (32.2226, -110.9747),
    "fresno": (36.7378, -119.7871),
    "sacramento": (38.5816, -121.4944),
    "kansas city": (39.0997, -94.5783),
    "atlanta": (33.7490, -84.3880),
    "miami": (25.7617, -80.1918),
    "orlando": (28.5383, -81.3792),
    "minneapolis": (44.9778, -93.2650),
    "pittsburgh": (40.4406, -79.9959),
    "st louis": (38.6270, -90.1994),
    "cleveland": (41.4993, -81.6944),
    "new orleans": (29.9511, -90.0715),
    "tampa": (27.9506, -82.4572),
    "honolulu": (21.3069, -157.8583),
    "anchorage": (61.2181, -149.9003),
}

# NWS weather condition mapping
NWS_CONDITION_MAP = {
    # Clear/Sunny
    "skc": WeatherCondition.CLEAR,       # Sky Clear
    "few": WeatherCondition.SUNNY,       # Few Clouds
    "sct": WeatherCondition.PARTLY_CLOUDY,  # Scattered Clouds
    "bkn": WeatherCondition.CLOUDY,      # Broken Clouds
    "ovc": WeatherCondition.OVERCAST,    # Overcast

    # Rain
    "ra": WeatherCondition.RAIN,         # Rain
    "-ra": WeatherCondition.DRIZZLE,     # Light Rain
    "+ra": WeatherCondition.HEAVY_RAIN,  # Heavy Rain
    "rw": WeatherCondition.SHOWERS,      # Rain Showers
    "-rw": WeatherCondition.SHOWERS,     # Light Rain Showers
    "+rw": WeatherCondition.HEAVY_RAIN,  # Heavy Rain Showers
    "ts": WeatherCondition.THUNDERSTORM,  # Thunderstorm
    "-ts": WeatherCondition.THUNDERSTORM, # Light Thunderstorm
    "+ts": WeatherCondition.THUNDERSTORM, # Heavy Thunderstorm

    # Snow
    "sn": WeatherCondition.SNOW,         # Snow
    "-sn": WeatherCondition.SNOW,        # Light Snow
    "+sn": WeatherCondition.HEAVY_SNOW,  # Heavy Snow
    "sw": WeatherCondition.SNOW,         # Snow Showers
    "-sw": WeatherCondition.SNOW,        # Light Snow Showers
    "+sw": WeatherCondition.HEAVY_SNOW,  # Heavy Snow Showers

    # Mixed
    "ip": WeatherCondition.SLEET,        # Ice Pellets
    "fzra": WeatherCondition.SLEET,      # Freezing Rain
    "zyr": WeatherCondition.SLEET,       # Freezing Drizzle

    # Fog/Mist/Haze
    "fg": WeatherCondition.FOG,          # Fog
    "br": WeatherCondition.MIST,         # Mist
    "hz": WeatherCondition.MIST,         # Haze
    "fu": WeatherCondition.FOG,          # Smoke

    # Wind
    "du": WeatherCondition.WINDY,        # Dust
    "sa": WeatherCondition.WINDY,        # Sand
    "po": WeatherCondition.WINDY,        # Volcanic Ash
}

# Supported locations
SUPPORTED_LOCATIONS = {
    "usa", "united states", "america", "us",
    "new york", "los angeles", "chicago", "houston",
    "phoenix", "philadelphia", "san antonio", "san diego",
    "dallas", "san jose", "austin", "jacksonville",
    "fort worth", "columbus", "charlotte", "san francisco",
    "indianapolis", "seattle", "denver", "washington dc",
    "boston", "nashville", "detroit", "portland",
    "las vegas", "memphis", "louisville", "baltimore",
    "milwaukee", "albuquerque", "tucson", "fresno",
    "sacramento", "kansas city", "atlanta", "miami",
    "orlando", "minneapolis", "pittsburgh", "st louis",
    "cleveland", "new orleans", "tampa", "honolulu", "anchorage",
}


class NWSProvider(WeatherProvider):
    """
    US National Weather Service weather provider.

    - Free, no API key required
    - USA coverage only
    - Provides current weather and 7-day forecast
    """

    priority = 7  # After other regional providers
    supports_forecast = True
    supports_air_quality = False
    requires_api_key = False

    @property
    def name(self) -> str:
        return "nws"

    def supports_location(self, location: Location) -> bool:
        """Check if location is in the USA."""
        normalized = location.normalized.lower()
        return normalized in SUPPORTED_LOCATIONS or any(
            city in normalized for city in US_CITIES
        )

    async def get_current(self, location: Location) -> WeatherData:
        """Fetch current weather for US location."""
        if not self.supports_location(location):
            raise LocationNotSupportedError(
                f"NWS only supports US locations: {location.raw}"
            )

        try:
            lat, lon = self._get_coordinates(location)
            grid_data = await self._fetch_gridpoint(lat, lon)
            station_data = await self._fetch_observations(grid_data)
            return self._parse_current(location, station_data)
        except Exception as e:
            raise ProviderError(f"NWS API error: {e}")

    async def get_forecast(
        self,
        location: Location,
        days: int = 7
    ) -> list[WeatherData]:
        """Fetch weather forecast for US location."""
        if not self.supports_location(location):
            raise LocationNotSupportedError(
                f"NWS only supports US locations: {location.raw}"
            )

        try:
            lat, lon = self._get_coordinates(location)
            grid_data = await self._fetch_gridpoint(lat, lon)
            forecast_data = await self._fetch_forecast(grid_data)
            return self._parse_forecast(location, forecast_data, days)
        except Exception as e:
            raise ProviderError(f"NWS API error: {e}")

    def _get_coordinates(self, location: Location) -> tuple[float, float]:
        """Get coordinates for US location."""
        normalized = location.normalized.lower()

        for city, coords in US_CITIES.items():
            if city in normalized:
                return coords

        # Default to New York
        return US_CITIES["new york"]

    async def _fetch_gridpoint(self, latitude: float, longitude: float) -> dict:
        """Fetch gridpoint data from NWS to get forecast URLs."""
        url = NWS_POINTS_URL.format(lat=latitude, lon=longitude)

        loop = asyncio.get_running_loop()

        def fetch():
            req = urllib.request.Request(url)
            req.add_header("User-Agent", "WeatherSkill/1.0 (support@weather-skill.io)")
            req.add_header("Accept", "application/json")
            with urllib.request.urlopen(req, timeout=10) as response:
                return json.loads(response.read().decode('utf-8'))

        return await loop.run_in_executor(None, fetch)

    async def _fetch_observations(self, grid_data: dict) -> dict:
        """Fetch current observations from nearest station."""
        # Get observation stations URL
        stations_url = grid_data.get("properties", {}).get("observationStations")

        if not stations_url:
            raise ProviderError("No observation stations available")

        loop = asyncio.get_running_loop()

        def fetch():
            req = urllib.request.Request(stations_url)
            req.add_header("User-Agent", "WeatherSkill/1.0 (support@weather-skill.io)")
            req.add_header("Accept", "application/json")
            with urllib.request.urlopen(req, timeout=10) as response:
                stations_data = json.loads(response.read().decode('utf-8'))

            # Get first station's observations
            station_id = stations_data.get("features", [{}])[0].get("properties", {}).get("stationIdentifier")
            if not station_id:
                raise ProviderError("No station identifier found")

            obs_url = f"{NWS_BASE_URL}/stations/{station_id}/observations/latest"
            req = urllib.request.Request(obs_url)
            req.add_header("User-Agent", "WeatherSkill/1.0 (support@weather-skill.io)")
            req.add_header("Accept", "application/json")
            with urllib.request.urlopen(req, timeout=10) as response:
                return json.loads(response.read().decode('utf-8'))

        return await loop.run_in_executor(None, fetch)

    async def _fetch_forecast(self, grid_data: dict) -> dict:
        """Fetch forecast data from NWS."""
        forecast_url = grid_data.get("properties", {}).get("forecast")

        if not forecast_url:
            raise ProviderError("No forecast URL available")

        loop = asyncio.get_running_loop()

        def fetch():
            req = urllib.request.Request(forecast_url)
            req.add_header("User-Agent", "WeatherSkill/1.0 (support@weather-skill.io)")
            req.add_header("Accept", "application/json")
            with urllib.request.urlopen(req, timeout=10) as response:
                return json.loads(response.read().decode('utf-8'))

        return await loop.run_in_executor(None, fetch)

    def _parse_current(self, location: Location, data: dict) -> WeatherData:
        """Parse current weather from NWS response."""
        properties = data.get("properties", {})

        # Temperature (convert from Celsius to ensure consistency)
        temp_c = properties.get("temperature", {}).get("value")
        if temp_c:
            temp = temp_c
        else:
            temp = 0.0

        # Other observations
        humidity = properties.get("relativeHumidity", {}).get("value")
        wind_speed_mps = properties.get("windSpeed", {}).get("value")
        wind_speed = wind_speed_mps * 3.6 if wind_speed_mps else None  # m/s to km/h
        wind_dir = properties.get("windDirection", {}).get("value")
        pressure = properties.get("barometricPressure", {}).get("value")
        visibility = properties.get("visibility", {}).get("value")
        feels_like_c = properties.get("heatIndex", {}).get("value") or properties.get("windChill", {}).get("value")

        # Get text description
        description = properties.get("textDescription", "")

        # Map condition
        condition = self._map_condition(description)

        # Parse timestamp
        timestamp = properties.get("timestamp", "")
        try:
            observed_at = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        except (ValueError, TypeError):
            observed_at = datetime.now(timezone.utc)

        # Get display name
        display_name = self._get_display_name(location)

        # Wind direction
        wind_direction = self._deg_to_direction(wind_dir) if wind_dir else None

        return WeatherData(
            location=display_name,
            temperature=temp if temp is not None else 0.0,
            feels_like=feels_like_c,
            humidity=int(humidity) if humidity else None,
            wind_speed=wind_speed,
            wind_direction=wind_direction,
            pressure=pressure / 100 if pressure else None,  # Pa to hPa
            visibility=visibility / 1000 if visibility else None,  # m to km
            condition=condition,
            condition_raw=description,
            description=description,
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
        """Parse forecast from NWS response."""
        properties = data.get("properties", {})
        periods = properties.get("periods", [])

        results = []
        display_name = self._get_display_name(location)
        seen_dates = set()

        for period in periods:
            if len(results) >= days:
                break

            # Get date
            start_time = period.get("startTime", "")
            try:
                fc_datetime = datetime.fromisoformat(start_time.replace("Z", "+00:00"))
                fc_date = fc_datetime.date()
            except (ValueError, TypeError):
                continue

            # Skip if we already have this date (NWS returns day and night periods)
            if fc_date in seen_dates:
                continue
            seen_dates.add(fc_date)

            # Get temperatures
            temp = period.get("temperature", 0)
            temp_unit = period.get("temperatureUnit", "F")

            # Convert to Celsius if needed
            if temp_unit == "F":
                temp_c = (temp - 32) * 5 / 9
            else:
                temp_c = temp

            # Get condition
            short_forecast = period.get("shortForecast", "")
            condition = self._map_condition(short_forecast)

            # Wind
            wind_str = period.get("windSpeed", "")
            wind_speed = self._parse_wind_speed(wind_str)
            wind_dir = period.get("windDirection", "")

            results.append(WeatherData(
                location=display_name,
                temperature=temp_c,
                temp_high=temp_c if period.get("isDaytime") else None,
                temp_low=temp_c if not period.get("isDaytime") else None,
                forecast_date=fc_date,
                condition=condition,
                condition_raw=short_forecast,
                description=period.get("detailedForecast", ""),
                wind_speed=wind_speed,
                wind_direction=wind_dir,
                fetched_at=datetime.now(timezone.utc),
                provider_name=self.name,
            ))

        return results

    def _get_display_name(self, location: Location) -> str:
        """Get display name for location."""
        normalized = location.normalized.lower()

        for city in US_CITIES:
            if city in normalized:
                return city.title()

        return "United States"

    def _map_condition(self, condition_str: str) -> WeatherCondition:
        """Map NWS condition text to WeatherCondition."""
        if not condition_str:
            return WeatherCondition.UNKNOWN

        normalized = condition_str.lower().strip()

        # Keyword matching (NWS uses descriptive text)
        if "sunny" in normalized or "clear" in normalized or "fair" in normalized:
            return WeatherCondition.SUNNY
        if "partly cloud" in normalized or "mostly sunny" in normalized:
            return WeatherCondition.PARTLY_CLOUDY
        if "cloud" in normalized or "overcast" in normalized:
            return WeatherCondition.CLOUDY
        if "shower" in normalized:
            return WeatherCondition.SHOWERS
        if "rain" in normalized:
            return WeatherCondition.RAIN
        if "thunder" in normalized or "t-storm" in normalized:
            return WeatherCondition.THUNDERSTORM
        if "snow" in normalized:
            return WeatherCondition.SNOW
        if "fog" in normalized:
            return WeatherCondition.FOG
        if "wind" in normalized or "breezy" in normalized:
            return WeatherCondition.WINDY
        if "sleet" in normalized or "freezing rain" in normalized:
            return WeatherCondition.SLEET
        if "hail" in normalized:
            return WeatherCondition.HAIL

        return WeatherCondition.UNKNOWN

    def _parse_wind_speed(self, wind_str: str) -> Optional[float]:
        """Parse wind speed from NWS string like '10 to 15 mph'."""
        if not wind_str:
            return None

        # Extract numbers from string like "10 to 15 mph" or "10 mph"
        numbers = re.findall(r'\d+', wind_str)
        if numbers:
            # Take average if range, or single value
            speeds = [int(n) for n in numbers]
            avg_mph = sum(speeds) / len(speeds)
            return avg_mph * 1.60934  # mph to km/h
        return None

    def _deg_to_direction(self, deg: Optional[float]) -> Optional[str]:
        """Convert wind degrees to cardinal direction."""
        if deg is None:
            return None

        directions = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                      "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
        index = round(deg / 22.5) % 16
        return directions[index]
