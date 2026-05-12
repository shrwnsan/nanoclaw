"""
Weather data models for the Weather Skill.

"""

from dataclasses import dataclass, field
from datetime import timezone, datetime, date
from enum import Enum
from typing import Optional


class WeatherCondition(Enum):
    """Standardized weather conditions."""
    CLEAR = "clear"
    SUNNY = "sunny"
    PARTLY_CLOUDY = "partly_cloudy"
    CLOUDY = "cloudy"
    OVERCAST = "overcast"
    FOG = "fog"
    MIST = "mist"
    DRIZZLE = "drizzle"
    RAIN = "rain"
    SHOWERS = "showers"
    HEAVY_RAIN = "heavy_rain"
    THUNDERSTORM = "thunderstorm"
    SNOW = "snow"
    HEAVY_SNOW = "heavy_snow"
    SLEET = "sleet"
    HAIL = "hail"
    WINDY = "windy"
    HOT = "hot"
    COLD = "cold"
    UNKNOWN = "unknown"


# Condition to emoji mapping
CONDITION_EMOJI = {
    WeatherCondition.CLEAR: "☀️",
    WeatherCondition.SUNNY: "☀️",
    WeatherCondition.PARTLY_CLOUDY: "⛅",
    WeatherCondition.CLOUDY: "☁️",
    WeatherCondition.OVERCAST: "☁️",
    WeatherCondition.FOG: "🌫️",
    WeatherCondition.MIST: "🌫️",
    WeatherCondition.DRIZZLE: "🌦️",
    WeatherCondition.RAIN: "🌧️",
    WeatherCondition.SHOWERS: "🌦️",
    WeatherCondition.HEAVY_RAIN: "⛈️",
    WeatherCondition.THUNDERSTORM: "⛈️",
    WeatherCondition.SNOW: "🌨️",
    WeatherCondition.HEAVY_SNOW: "❄️",
    WeatherCondition.SLEET: "🌨️",
    WeatherCondition.HAIL: "🌨️",
    WeatherCondition.WINDY: "💨",
    WeatherCondition.HOT: "🥵",
    WeatherCondition.COLD: "🥶",
    WeatherCondition.UNKNOWN: "❓",
}


@dataclass
class WeatherData:
    """Standardized weather data structure."""

    # Location (required)
    location: str

    # Current conditions (temperature is required for current weather)
    temperature: float = 0.0  # Celsius

    # Optional location details
    latitude: Optional[float] = None
    longitude: Optional[float] = None

    # Current conditions (optional)
    feels_like: Optional[float] = None
    humidity: Optional[int] = None  # Percentage
    wind_speed: Optional[float] = None  # km/h
    wind_direction: Optional[str] = None
    wind_description: Optional[str] = None  # Formatted wind string (e.g., "South force 3")
    pressure: Optional[float] = None  # hPa
    visibility: Optional[float] = None  # km
    uv_index: Optional[float] = None

    # Conditions
    condition: WeatherCondition = WeatherCondition.UNKNOWN
    condition_raw: str = ""  # Original condition string from provider
    description: Optional[str] = None  # Detailed description

    # Timestamps
    observed_at: Optional[datetime] = None
    fetched_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    # Forecast-specific
    forecast_date: Optional[date] = None
    temp_high: Optional[float] = None
    temp_low: Optional[float] = None
    precipitation_chance: Optional[int] = None  # Percentage

    # Air quality (optional)
    aqi: Optional[int] = None  # US EPA Air Quality Index (1-500)
    aqhi: Optional[int] = None  # Air Quality Health Index (1-10+, HK/Canada)
    pm25: Optional[float] = None  # PM2.5 (μg/m³)
    pm10: Optional[float] = None  # PM10 (μg/m³)
    o3: Optional[float] = None  # Ozone (μg/m³)
    no2: Optional[float] = None  # Nitrogen dioxide (μg/m³)

    # Astronomy (optional)
    sunrise: Optional[str] = None  # Time string (e.g., "6:25 AM")
    sunset: Optional[str] = None  # Time string (e.g., "6:35 PM")

    # Provider metadata
    provider_name: str = "unknown"

    @property
    def emoji(self) -> str:
        """Get emoji for current condition."""
        return CONDITION_EMOJI.get(self.condition, "❓")

    @property
    def humidity_str(self) -> str:
        """Human-readable humidity."""
        if self.humidity is None:
            return "N/A"
        return f"{self.humidity}%"

    @property
    def wind_str(self) -> str:
        """Human-readable wind."""
        # Use pre-formatted wind description if available
        if self.wind_description:
            return self.wind_description
        if self.wind_speed is None:
            return "N/A"
        direction = f" {self.wind_direction}" if self.wind_direction else ""
        return f"{self.wind_speed:.0f} km/h{direction}"

    @property
    def temp_range_str(self) -> str:
        """Temperature range for forecast."""
        if self.temp_high is not None and self.temp_low is not None:
            return f"{self.temp_low:.0f}°C - {self.temp_high:.0f}°C"
        return f"{self.temperature:.0f}°C"

    @property
    def aqhi_str(self) -> str:
        """Human-readable AQHI with risk level (HK/Canada scale 1-10+)."""
        if self.aqhi is None:
            return "N/A"
        if self.aqhi <= 3:
            return f"{self.aqhi} (Low)"
        elif self.aqhi <= 6:
            return f"{self.aqhi} (Moderate)"
        elif self.aqhi <= 7:
            return f"{self.aqhi} (High)"
        elif self.aqhi <= 10:
            return f"{self.aqhi} (Very High)"
        else:
            return f"{self.aqhi}+ (Serious)"

    @property
    def aqi_str(self) -> str:
        """Human-readable AQI with category (US EPA scale 1-500)."""
        if self.aqi is None:
            return "N/A"
        if self.aqi <= 50:
            return f"{self.aqi} (Good)"
        elif self.aqi <= 100:
            return f"{self.aqi} (Moderate)"
        elif self.aqi <= 150:
            return f"{self.aqi} (Unhealthy for Sensitive)"
        elif self.aqi <= 200:
            return f"{self.aqi} (Unhealthy)"
        elif self.aqi <= 300:
            return f"{self.aqi} (Very Unhealthy)"
        else:
            return f"{self.aqi} (Hazardous)"

    @property
    def effective_feels_like(self) -> float:
        """Get feels-like temperature, calculating if not provided.

        If feels_like is None, calculates from humidity/wind using
        heat index and wind chill formulas.

        Returns:
            Feels-like temperature in Celsius
        """
        if self.feels_like is not None:
            return self.feels_like

        # Calculate from humidity/wind if available
        if self.humidity is not None:
            wind = self.wind_speed / 3.6 if self.wind_speed else 0.0
            return self._calculate_feels_like(self.temperature, self.humidity, wind)

        return self.temperature

    @staticmethod
    def _calculate_feels_like(temp: float, humidity: int, wind_speed: float = 0.0) -> float:
        """Calculate feels-like temperature using heat index and wind chill.

        Uses simplified NWS/NOAA approach:
        - Heat index: applies when temp >= 27°C and humidity >= 40%
        - Wind chill: applies when temp <= 10°C and wind >= 4.8 km/h

        Args:
            temp: Temperature in Celsius
            humidity: Relative humidity percentage (0-100)
            wind_speed: Wind speed in m/s (not km/h — callers must convert)

        Returns:
            Feels-like temperature in Celsius
        """
        # Heat index for hot/humid conditions
        if temp >= 27 and humidity >= 40:
            # Simplified heat index approximation
            # Based on NWS/NOAA Steadman equation
            hi = temp + (0.1 * humidity) - (0.05 * temp)
            # Clamp to at least temp (feels at least as hot)
            return max(round(hi), round(temp))

        # Wind chill for cold/windy conditions
        if temp <= 10 and wind_speed > 1.33:  # 4.8 km/h = 1.33 m/s
            # Wind chill formula (metric): WC = 13.12 + 0.6215*T - 11.37*V^0.16
            # Where V is wind speed in km/h
            wind_kmh = wind_speed * 3.6
            wc = 13.12 + 0.6215 * temp - 11.37 * (wind_kmh ** 0.16)
            return max(round(wc), round(temp))

        # No adjustment needed
        return round(temp)


@dataclass
class Location:
    """Parsed location information."""

    raw: str  # Original input
    city: Optional[str] = None
    country: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None

    # Normalized for provider matching
    normalized: str = ""

    def __post_init__(self):
        if not self.normalized:
            self.normalized = self.raw.lower().strip()


# Common location aliases
LOCATION_ALIASES = {
    # Hong Kong
    "hk": "Hong Kong",
    "hong kong": "Hong Kong",
    "香港": "Hong Kong",
    "hkg": "Hong Kong",
    "kln": "Kowloon",
    "kowloon": "Kowloon",
    "九龍": "Kowloon",
    "kl": "Kowloon",
    "nt": "New Territories",
    "新界": "New Territories",
    # Singapore
    "sg": "Singapore",
    "singapore": "Singapore",
    "sin": "Singapore",
    "新加坡": "Singapore",
    # Japan
    "jp": "Japan",
    "japan": "Japan",
    "日本": "Japan",
    "tokyo": "Tokyo",
    "東京": "Tokyo",
    "osaka": "Osaka",
    "大阪": "Osaka",
    "yokohama": "Yokohama",
    "横浜": "Yokohama",
    "kyoto": "Kyoto",
    "京都": "Kyoto",
    "nagoya": "Nagoya",
    "名古屋": "Nagoya",
    "sapporo": "Sapporo",
    "札幌": "Sapporo",
    "fukuoka": "Fukuoka",
    "福岡": "Fukuoka",
    "hiroshima": "Hiroshima",
    "広島": "Hiroshima",
    "sendai": "Sendai",
    "仙台": "Sendai",
    "naha": "Naha",
    "那覇": "Naha",
    # Taiwan
    "tw": "Taiwan",
    "taiwan": "Taiwan",
    "台灣": "Taiwan",
    "taipei": "Taipei",
    "台北": "Taipei",
    "臺北": "Taipei",
    "kaohsiung": "Kaohsiung",
    "高雄": "Kaohsiung",
    "taichung": "Taichung",
    "台中": "Taichung",
    "臺中": "Taichung",
    "tainan": "Tainan",
    "台南": "Tainan",
    "臺南": "Tainan",
    "taoyuan": "Taoyuan",
    "桃園": "Taoyuan",
    "keelung": "Keelung",
    "基隆": "Keelung",
    "hsinchu": "Hsinchu",
    "新竹": "Hsinchu",
    "chiayi": "Chiayi",
    "嘉義": "Chiayi",
    # United Kingdom
    "uk": "United Kingdom",
    "united kingdom": "United Kingdom",
    "英國": "United Kingdom",
    "britain": "United Kingdom",
    "london": "London",
    "倫敦": "London",
    "manchester": "Manchester",
    "曼徹斯特": "Manchester",
    "edinburgh": "Edinburgh",
    "愛丁堡": "Edinburgh",
    "birmingham": "Birmingham",
    "伯明翰": "Birmingham",
    "glasgow": "Glasgow",
    "格拉斯哥": "Glasgow",
    "liverpool": "Liverpool",
    "利物浦": "Liverpool",
    "bristol": "Bristol",
    "布里斯托": "Bristol",
    "cardiff": "Cardiff",
    "卡迪夫": "Cardiff",
    "belfast": "Belfast",
    "貝尔法斯特": "Belfast",
    "leeds": "Leeds",
    "利兹": "Leeds",
    "sheffield": "Sheffield",
    "谢菲尔德": "Sheffield",
    "newcastle": "Newcastle",
    "纽卡斯尔": "Newcastle",
    "nottingham": "Nottingham",
    "诺丁汉": "Nottingham",
    "southampton": "Southampton",
    "南安普敦": "Southampton",
    "brighton": "Brighton",
    "布莱顿": "Brighton",
    "oxford": "Oxford",
    "牛津": "Oxford",
    "cambridge": "Cambridge",
    "剑桥": "Cambridge",
    # Australia
    "au": "Australia",
    "aus": "Australia",
    "australia": "Australia",
    "oz": "Australia",
    "sydney": "Sydney",
    "melbourne": "Melbourne",
    "brisbane": "Brisbane",
    "perth": "Perth",
    "adelaide": "Adelaide",
    "hobart": "Hobart",
    "darwin": "Darwin",
    "canberra": "Canberra",
    "gold coast": "Gold Coast",
    "cairns": "Cairns",
    "townsville": "Townsville",
    # New Zealand
    "nz": "New Zealand",
    "new zealand": "New Zealand",
    "aotearoa": "New Zealand",
    "auckland": "Auckland",
    "wellington": "Wellington",
    "christchurch": "Christchurch",
    "hamilton": "Hamilton",
    "tauranga": "Tauranga",
    "dunedin": "Dunedin",
    "palmerston north": "Palmerston North",
    "napier": "Napier",
    "nelson": "Nelson",
    "rotorua": "Rotorua",
    "new plymouth": "New Plymouth",
    # USA
    "us": "United States",
    "usa": "United States",
    "united states": "United States",
    "america": "United States",
    "new york": "New York",
    "nyc": "New York",
    "los angeles": "Los Angeles",
    "la": "Los Angeles",
    "chicago": "Chicago",
    "houston": "Houston",
    "phoenix": "Phoenix",
    "philadelphia": "Philadelphia",
    "philly": "Philadelphia",
    "san antonio": "San Antonio",
    "san diego": "San Diego",
    "dallas": "Dallas",
    "san jose": "San Jose",
    "austin": "Austin",
    "jacksonville": "Jacksonville",
    "fort worth": "Fort Worth",
    "columbus": "Columbus",
    "charlotte": "Charlotte",
    "san francisco": "San Francisco",
    "sf": "San Francisco",
    "seattle": "Seattle",
    "denver": "Denver",
    "washington dc": "Washington DC",
    "dc": "Washington DC",
    "boston": "Boston",
    "nashville": "Nashville",
    "detroit": "Detroit",
    "portland": "Portland",
    "las vegas": "Las Vegas",
    "miami": "Miami",
    "atlanta": "Atlanta",
    "minneapolis": "Minneapolis",
    # Indonesia
    "indonesia": "Indonesia",
    "jakarta": "Jakarta",
    "bandung": "Bandung",
    "surabaya": "Surabaya",
    "yogyakarta": "Yogyakarta",
    "bali": "Bali",
    "denpasar": "Denpasar",
    "medan": "Medan",
    "makassar": "Makassar",
    "semarang": "Semarang",
    "malang": "Malang",
    "solo": "Solo",
    "bogor": "Bogor",
    "ubud": "Ubud",
    # Germany
    "germany": "Germany",
    "deutschland": "Germany",
    "berlin": "Berlin",
    "hamburg": "Hamburg",
    "munich": "Munich",
    "münchen": "Munich",
    "cologne": "Cologne",
    "köln": "Cologne",
    "frankfurt": "Frankfurt",
    "stuttgart": "Stuttgart",
    "düsseldorf": "Düsseldorf",
    "dresden": "Dresden",
    "leipzig": "Leipzig",
    "hannover": "Hannover",
    "nuremberg": "Nuremberg",
    "nürnberg": "Nuremberg",
    "bremen": "Bremen",
    "freiburg": "Freiburg",
    "heidelberg": "Heidelberg",
    "bonn": "Bonn",
    # South Korea
    "south korea": "South Korea",
    "korea": "South Korea",
    "kr": "South Korea",
    "한국": "South Korea",
    "seoul": "Seoul",
    "서울": "Seoul",
    "busan": "Busan",
    "부산": "Busan",
    "incheon": "Incheon",
    "daegu": "Daegu",
    "jeju": "Jeju",
    "제주": "Jeju",
    # Thailand
    "thailand": "Thailand",
    "th": "Thailand",
    "ไทย": "Thailand",
    "bangkok": "Bangkok",
    "กรุงเทพ": "Bangkok",
    "chiang mai": "Chiang Mai",
    "เชียงใหม่": "Chiang Mai",
    "phuket": "Phuket",
    "ภูเก็ต": "Phuket",
    "pattaya": "Pattaya",
    "krabi": "Krabi",
    # India (routed to OpenWeatherMap fallback)
    "india": "India",
    "in": "India",
    "भारत": "India",
    "印度": "India",
    "new delhi": "New Delhi",
    "delhi": "New Delhi",
    "दिल्ली": "New Delhi",
    "mumbai": "Mumbai",
    "मुंबई": "Mumbai",
    "bombay": "Mumbai",
    "bangalore": "Bangalore",
    "bengaluru": "Bangalore",
    "बेंगलुरु": "Bangalore",
    "chennai": "Chennai",
    "चेन्नई": "Chennai",
    "madras": "Chennai",
    "hyderabad": "Hyderabad",
    "हैदराबाद": "Hyderabad",
    "kolkata": "Kolkata",
    "कोलकाता": "Kolkata",
    "calcutta": "Kolkata",
    "ahmedabad": "Ahmedabad",
    "pune": "Pune",
    "jaipur": "Jaipur",
    "lucknow": "Lucknow",
    "goa": "Goa",
    "kochi": "Kochi",
    "varanasi": "Varanasi",
    "agra": "Agra",
    "chandigarh": "Chandigarh",
    "srinagar": "Srinagar",
    "shimla": "Shimla",
    "darjeeling": "Darjeeling",
    # Canada (routed to OpenWeatherMap fallback)
    "canada": "Canada",
    "ca": "Canada",
    "加拿大": "Canada",
    "toronto": "Toronto",
    "yyz": "Toronto",
    "vancouver": "Vancouver",
    "yvr": "Vancouver",
    "montreal": "Montreal",
    "montréal": "Montreal",
    "yul": "Montreal",
    "ottawa": "Ottawa",
    "calgary": "Calgary",
    "yyc": "Calgary",
    "edmonton": "Edmonton",
    "winnipeg": "Winnipeg",
    "quebec city": "Quebec City",
    "québec": "Quebec City",
    "halifax": "Halifax",
    "victoria": "Victoria",
    "saskatoon": "Saskatoon",
    "regina": "Regina",
    "st john's": "St. John's",
    "whitehorse": "Whitehorse",
    "yellowknife": "Yellowknife",
}


def normalize_location(location: str) -> str:
    """Normalize location string."""
    loc = location.lower().strip()
    return LOCATION_ALIASES.get(loc, location.strip())
