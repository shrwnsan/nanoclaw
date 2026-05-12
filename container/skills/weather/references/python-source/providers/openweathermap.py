"""
OpenWeatherMap provider for global weather data.


Provides weather data for any location worldwide via OpenWeatherMap API.
Free tier: 1000 calls/day.
"""

import urllib.request
import urllib.parse
import json
from datetime import datetime, timezone
from typing import Optional

from ..models import WeatherData, WeatherCondition, Location
from .base import WeatherProvider, ProviderError


class OpenWeatherMapProvider(WeatherProvider):
    """
    OpenWeatherMap weather provider.

    Coverage: Global
    API Key: Required (free tier: 1000 calls/day)
    Priority: 10 (fallback for non-HK locations)
    """

    BASE_URL = "https://api.openweathermap.org/data/2.5"

    # OpenWeatherMap condition codes: https://openweathermap.org/weather-conditions
    CONDITION_MAP = {
        # Thunderstorm (2xx)
        200: WeatherCondition.THUNDERSTORM,
        201: WeatherCondition.THUNDERSTORM,
        202: WeatherCondition.THUNDERSTORM,
        210: WeatherCondition.THUNDERSTORM,
        211: WeatherCondition.THUNDERSTORM,
        212: WeatherCondition.THUNDERSTORM,
        221: WeatherCondition.THUNDERSTORM,
        230: WeatherCondition.THUNDERSTORM,
        231: WeatherCondition.THUNDERSTORM,
        232: WeatherCondition.THUNDERSTORM,
        # Drizzle (3xx)
        300: WeatherCondition.DRIZZLE,
        301: WeatherCondition.DRIZZLE,
        302: WeatherCondition.DRIZZLE,
        310: WeatherCondition.DRIZZLE,
        311: WeatherCondition.DRIZZLE,
        312: WeatherCondition.DRIZZLE,
        313: WeatherCondition.DRIZZLE,
        314: WeatherCondition.DRIZZLE,
        321: WeatherCondition.DRIZZLE,
        # Rain (5xx)
        500: WeatherCondition.DRIZZLE,  # Light rain
        501: WeatherCondition.RAIN,
        502: WeatherCondition.HEAVY_RAIN,
        503: WeatherCondition.HEAVY_RAIN,
        504: WeatherCondition.HEAVY_RAIN,
        511: WeatherCondition.RAIN,
        520: WeatherCondition.SHOWERS,
        521: WeatherCondition.SHOWERS,
        522: WeatherCondition.HEAVY_RAIN,
        531: WeatherCondition.SHOWERS,
        # Snow (6xx)
        600: WeatherCondition.SNOW,  # Light snow
        601: WeatherCondition.SNOW,
        602: WeatherCondition.HEAVY_SNOW,
        611: WeatherCondition.SLEET,
        612: WeatherCondition.SLEET,
        613: WeatherCondition.SLEET,
        615: WeatherCondition.SLEET,
        616: WeatherCondition.SLEET,
        620: WeatherCondition.SNOW,
        621: WeatherCondition.SNOW,
        622: WeatherCondition.HEAVY_SNOW,
        # Atmosphere (7xx)
        701: WeatherCondition.MIST,
        711: WeatherCondition.MIST,  # Smoke -> mist
        721: WeatherCondition.MIST,  # Haze -> mist
        731: WeatherCondition.MIST,  # Dust whirls -> mist
        741: WeatherCondition.FOG,
        751: WeatherCondition.MIST,  # Sand -> mist
        761: WeatherCondition.MIST,  # Dust -> mist
        762: WeatherCondition.MIST,  # Volcanic ash -> mist
        771: WeatherCondition.WINDY,
        781: WeatherCondition.THUNDERSTORM,  # Tornado
        # Clear (800)
        800: WeatherCondition.SUNNY,
        # Clouds (80x)
        801: WeatherCondition.PARTLY_CLOUDY,
        802: WeatherCondition.PARTLY_CLOUDY,
        803: WeatherCondition.CLOUDY,
        804: WeatherCondition.CLOUDY,
    }

    def __init__(self, api_key: str):
        """
        Initialize OpenWeatherMap provider.

        Args:
            api_key: OpenWeatherMap API key (get free at openweathermap.org)
        """
        self.api_key = api_key
        self._priority = 10  # Fallback priority

    @property
    def name(self) -> str:
        return "openweathermap"

    @property
    def priority(self) -> int:
        return self._priority

    @property
    def supports_forecast(self) -> bool:
        return True

    def supports_location(self, location: Location) -> bool:
        """OpenWeatherMap supports all global locations."""
        return True

    async def get_current(self, location: Location) -> WeatherData:
        """Fetch current weather from OpenWeatherMap."""
        params = {
            "q": location.normalized,
            "appid": self.api_key,
            "units": "metric",
        }
        url = f"{self.BASE_URL}/weather?{urllib.parse.urlencode(params)}"

        try:
            with urllib.request.urlopen(url, timeout=10) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 401:
                raise ProviderError("OpenWeatherMap API key is invalid")
            elif e.code == 404:
                raise ProviderError(f"Location not found: {location.raw}")
            else:
                raise ProviderError(f"OpenWeatherMap API error: HTTP {e.code}")
        except Exception as e:
            raise ProviderError(f"OpenWeatherMap request failed: {e}")

        # Also fetch today's forecast for high/low temps
        today_high = None
        today_low = None
        try:
            forecast_params = {
                "q": location.normalized,
                "appid": self.api_key,
                "units": "metric",
                "cnt": 8,  # Next 24 hours (3-hour intervals)
            }
            forecast_url = (
                f"{self.BASE_URL}/forecast?{urllib.parse.urlencode(forecast_params)}"
            )
            with urllib.request.urlopen(forecast_url, timeout=10) as resp:
                forecast_data = json.loads(resp.read().decode("utf-8"))

            # Get today's temps from forecast
            temps = []
            today = datetime.now(timezone.utc).date()
            for item in forecast_data.get("list", []):
                dt = datetime.fromtimestamp(item.get("dt", 0), tz=timezone.utc)
                if dt.date() == today:
                    temps.append(item.get("main", {}).get("temp"))

            if temps:
                today_high = max(temps)
                today_low = min(temps)
        except Exception:
            pass  # High/low are optional enhancements

        return self._parse_current(data, today_high, today_low)

    async def get_current_with_air_quality(self, location: Location) -> WeatherData:
        """Fetch current weather with air quality data."""
        # First get weather data (includes coordinates from _parse_current)
        weather_data = await self.get_current(location)

        # Use coordinates from weather data for air quality lookup
        lat = weather_data.latitude
        lon = weather_data.longitude

        if lat and lon:
            try:
                air_quality = await self.get_air_quality(lat, lon)
                # Add air quality to weather data
                weather_data.aqi = air_quality.get("aqi")
                weather_data.pm25 = air_quality.get("pm25")
                weather_data.pm10 = air_quality.get("pm10")
                weather_data.o3 = air_quality.get("o3")
                weather_data.no2 = air_quality.get("no2")
            except Exception:
                pass  # Air quality is optional

        return weather_data

    async def get_forecast(
        self, location: Location, days: int = 3
    ) -> list[WeatherData]:
        """Fetch weather forecast from OpenWeatherMap."""
        # OpenWeatherMap 5-day forecast gives 3-hour intervals (40 readings)
        # We need to aggregate into daily forecasts
        params = {
            "q": location.normalized,
            "appid": self.api_key,
            "units": "metric",
            "cnt": min(days * 8, 40),  # 8 readings per day, max 40 (5 days)
        }
        url = f"{self.BASE_URL}/forecast?{urllib.parse.urlencode(params)}"

        try:
            with urllib.request.urlopen(url, timeout=10) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 401:
                raise ProviderError("OpenWeatherMap API key is invalid")
            elif e.code == 404:
                raise ProviderError(f"Location not found: {location.raw}")
            else:
                raise ProviderError(f"OpenWeatherMap API error: HTTP {e.code}")
        except Exception as e:
            raise ProviderError(f"OpenWeatherMap request failed: {e}")

        return self._parse_forecast(data, days)

    def _parse_current(
        self,
        data: dict,
        today_high: float | None = None,
        today_low: float | None = None,
    ) -> WeatherData:
        """Parse OpenWeatherMap current weather response."""
        weather = data.get("weather", [{}])[0]
        main = data.get("main", {})
        wind = data.get("wind", {})
        clouds = data.get("clouds", {})
        rain = data.get("rain", {})
        snow = data.get("snow", {})

        condition_code = weather.get("id", 800)
        condition = self.CONDITION_MAP.get(condition_code, WeatherCondition.UNKNOWN)

        # Wind direction
        wind_deg = wind.get("deg")
        wind_direction = self._deg_to_direction(wind_deg) if wind_deg else None

        # Format wind description (e.g., "12 km/h NE")
        wind_description = None
        if wind.get("speed"):
            wind_speed_kmh = wind["speed"] * 3.6  # Convert m/s to km/h
            if wind_direction:
                wind_description = f"{wind_speed_kmh:.0f} km/h {wind_direction}"
            else:
                wind_description = f"{wind_speed_kmh:.0f} km/h"

        # Calculate rain probability from cloud cover (rough estimate)
        rain_probability = None
        if clouds.get("all") is not None:
            rain_probability = min(100, clouds["all"])

        # Capitalize description
        description = weather.get("description", "")
        if description:
            description = description.capitalize()

        # Extract coordinates from response
        coords = data.get("coord", {})

        return WeatherData(
            location=data.get("name", "Unknown"),
            latitude=coords.get("lat"),
            longitude=coords.get("lon"),
            temperature=main.get("temp"),
            feels_like=main.get("feels_like"),
            temp_high=today_high,
            temp_low=today_low,
            humidity=main.get("humidity"),
            pressure=main.get("pressure"),
            wind_speed=wind.get("speed"),
            wind_direction=wind_direction,
            wind_description=wind_description,
            condition=condition,
            description=description,
            precipitation_chance=rain_probability,
            observed_at=datetime.now(timezone.utc),
            provider_name=self.name,
        )

    def _parse_forecast(self, data: dict, days: int) -> list[WeatherData]:
        """Parse OpenWeatherMap 5-day forecast into daily forecasts."""
        # Group readings by date
        daily_data = {}
        location_name = data.get("city", {}).get("name", "Unknown")

        for item in data.get("list", []):
            dt = datetime.fromtimestamp(item.get("dt", 0), tz=timezone.utc)
            date_key = dt.date()

            if date_key not in daily_data:
                daily_data[date_key] = {
                    "temps": [],
                    "humidity": [],
                    "conditions": [],
                    "descriptions": [],
                    "rain_prob": [],
                }

            main = item.get("main", {})
            weather = item.get("weather", [{}])[0]
            pop = (
                item.get("pop", 0) * 100
            )  # Probability of precipitation (0-1 -> 0-100)

            daily_data[date_key]["temps"].append(main.get("temp"))
            daily_data[date_key]["humidity"].append(main.get("humidity"))
            daily_data[date_key]["conditions"].append(weather.get("id", 800))
            daily_data[date_key]["descriptions"].append(weather.get("description"))
            daily_data[date_key]["rain_prob"].append(pop)

        # Build daily forecasts
        forecasts = []
        for i, (date, d) in enumerate(sorted(daily_data.items())[:days]):
            # Most common condition
            condition_code = max(set(d["conditions"]), key=d["conditions"].count)
            condition = self.CONDITION_MAP.get(condition_code, WeatherCondition.UNKNOWN)

            # Most common description
            description = max(set(d["descriptions"]), key=d["descriptions"].count)

            forecasts.append(
                WeatherData(
                    location=location_name,
                    temp_high=max(d["temps"]) if d["temps"] else None,
                    temp_low=min(d["temps"]) if d["temps"] else None,
                    humidity=int(sum(d["humidity"]) / len(d["humidity"]))
                    if d["humidity"]
                    else None,
                    condition=condition,
                    description=description,
                    precipitation_chance=int(max(d["rain_prob"]))
                    if d["rain_prob"]
                    else None,
                    forecast_date=date,
                    provider_name=self.name,
                )
            )

        return forecasts

    def _deg_to_direction(self, deg: int) -> str:
        """Convert wind degrees to cardinal direction."""
        directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
        index = round(deg / 45) % 8
        return directions[index]

    async def get_air_quality(self, latitude: float, longitude: float) -> dict:
        """
        Fetch air quality data from OpenWeatherMap Air Pollution API.

        Returns dict with: aqi, pm25, pm10, o3, no2, co, so2
        """
        url = f"https://api.openweathermap.org/data/2.5/air_pollution?lat={latitude}&lon={longitude}&appid={self.api_key}"

        try:
            with urllib.request.urlopen(url, timeout=10) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 401:
                raise ProviderError("OpenWeatherMap API key is invalid")
            else:
                raise ProviderError(f"Air quality API error: HTTP {e.code}")
        except Exception as e:
            raise ProviderError(f"Air quality request failed: {e}")

        return self._parse_air_quality(data)

    def _parse_air_quality(self, data: dict) -> dict:
        """Parse OpenWeatherMap air pollution response."""
        if not data.get("list"):
            return {}

        item = data["list"][0]
        components = item.get("components", {})
        main = item.get("main", {})

        # AQI is US EPA scale (1-5 mapped to 1-500 range)
        aqi_index = main.get("aqi", 1)  # 1-5 scale
        # Convert to approximate US EPA AQI scale
        aqi_map = {1: 25, 2: 75, 3: 125, 4: 175, 5: 300}
        aqi = aqi_map.get(aqi_index, 50)

        return {
            "aqi": aqi,
            "pm25": components.get("pm2_5"),
            "pm10": components.get("pm10"),
            "o3": components.get("o3"),
            "no2": components.get("no2"),
            "co": components.get("co"),
            "so2": components.get("so2"),
        }
