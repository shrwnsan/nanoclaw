"""
WhatsApp formatter for weather data.

Formats weather data for WhatsApp using WhatsApp's formatting syntax.
WhatsApp supports: *bold*, _italic_, ~strikethrough~, ```code```
No MarkdownV2 escaping needed — WhatsApp uses simpler formatting.
"""

from datetime import date
from ..models import WeatherData, WeatherCondition, CONDITION_EMOJI
from .base import WeatherFormatter, FormatterError


def get_condition_emoji(condition: WeatherCondition) -> str:
    """Get emoji for weather condition."""
    return CONDITION_EMOJI.get(condition, "❓")


class WhatsAppFormatter(WeatherFormatter):
    """
    WhatsApp weather formatter.

    Features:
    - WhatsApp formatting: *bold*, _italic_
    - No special escaping needed (simpler than Telegram)
    - Emoji weather icons
    - Max 65536 characters (WhatsApp limit)
    - Clean, readable format
    """

    max_length = 65536  # WhatsApp message limit

    @property
    def platform(self) -> str:
        return "whatsapp"

    def format_current(self, data: WeatherData) -> str:
        """
        Format current weather for WhatsApp.

        Output format:
        *☁️ Hong Kong Weather — Sunday, March 29*

        🌡️ 23°C (feels 24°C) • High 27° / Low 22°
        ☁️ Mainly cloudy with light rain patches
        💧 Humidity: 87%
        💨 Wind: East force 3-4
        🌧️ Rain chance: 40%
        🌬️ Air Quality: Moderate (AQHI 3)
        ☀️ UV Index: 0.1 (Low)
        🌅 Sunrise: 6:25 AM | 🌇 Sunset: 6:35 PM

        _Warm and humid with cloudy skies._
        """
        lines = []

        # Header with emoji and location (bold)
        emoji = get_condition_emoji(data.condition)
        day_str = data.forecast_date.strftime("%A, %B %-d") if data.forecast_date else ""
        if not day_str and data.observed_at:
            day_str = data.observed_at.strftime("%A, %B %-d")
        if not day_str:
            day_str = date.today().strftime("%A, %B %-d")

        lines.append(f"*{emoji} {data.location} Weather — {day_str}*")
        lines.append("")

        # Temperature line
        temp_str = f"🌡️ {data.temperature:.0f}°C"
        feels = data.effective_feels_like
        if abs(feels - data.temperature) > 0.5:
            temp_str += f" (feels {feels:.0f}°C)"

        if data.temp_high is not None and data.temp_low is not None:
            temp_str += f" • High {data.temp_high:.0f}° / Low {data.temp_low:.0f}°"

        lines.append(temp_str)

        # Condition/Description
        if data.description:
            desc = data.description
            first_sentence_end = desc.find('. ')
            if first_sentence_end > 0 and first_sentence_end < 120:
                desc = desc[:first_sentence_end + 1]
            elif len(desc) > 120:
                desc = desc[:117] + "..."
            lines.append(f"{emoji} {desc}")
        else:
            lines.append(f"{emoji} {data.condition.value.title()}")

        # Humidity
        if data.humidity is not None:
            lines.append(f"💧 Humidity: {data.humidity}%")

        # Wind
        if data.wind_str and data.wind_str != "N/A":
            wind = data.wind_str.rstrip(".")
            lines.append(f"💨 Wind: {wind}")

        # Rain chance
        if data.precipitation_chance is not None:
            lines.append(f"🌧️ Rain chance: {data.precipitation_chance}%")

        # Air Quality
        if data.aqhi is not None:
            aqhi_quality = self._aqhi_quality(data.aqhi)
            lines.append(f"🌬️ Air Quality: {aqhi_quality} (AQHI {data.aqhi})")
        elif data.aqi is not None:
            aqi_quality = self._aqi_quality(data.aqi)
            lines.append(f"🌬️ Air Quality: {aqi_quality} (AQI {data.aqi})")

        # UV Index
        if data.uv_index is not None:
            uv_desc = self._uv_description(data.uv_index)
            lines.append(f"☀️ UV Index: {data.uv_index:.1f} ({uv_desc})")

        # Sunrise/Sunset
        if data.sunrise or data.sunset:
            astro_parts = []
            if data.sunrise:
                astro_parts.append(f"🌅 Sunrise: {data.sunrise}")
            if data.sunset:
                astro_parts.append(f"🌇 Sunset: {data.sunset}")
            lines.append(" | ".join(astro_parts))

        # Summary line (italic)
        summary = self._generate_summary(data)
        if summary:
            lines.append("")
            lines.append(f"_{summary}_")

        return self.truncate("\n".join(lines))

    def format_forecast(self, data: list[WeatherData]) -> str:
        """
        Format multi-day forecast for WhatsApp.

        Output format:
        *📊 Hong Kong 3-Day Forecast*

        Wed Apr 1: ⛅ 27° / 23° — Cloudy with showers
        Thu Apr 2: 🌧️ 25° / 22° — Rain
        Fri Apr 3: ☀️ 28° / 24° — Sunny
        """
        if not data:
            return "No forecast data available"

        lines = []

        # Header (bold)
        location = data[0].location if data else "Hong Kong"
        days = len(data)
        lines.append(f"*📊 {location} {days}-Day Forecast*")
        lines.append("")

        # Each day
        for day in data:
            emoji = get_condition_emoji(day.condition)
            date_str = day.forecast_date.strftime("%a %b %-d") if day.forecast_date else "Unknown"

            temp_str = ""
            if day.temp_high is not None and day.temp_low is not None:
                temp_str = f"{day.temp_high:.0f}° / {day.temp_low:.0f}°"
            elif day.temperature is not None:
                temp_str = f"{day.temperature:.0f}°"

            desc = day.description or day.condition.value.title()
            lines.append(f"{date_str}: {emoji} {temp_str} — {desc}")

        return self.truncate("\n".join(lines))

    def _aqhi_quality(self, aqhi: int) -> str:
        """Map AQHI (HK/Canada scale 1-10+) to quality description."""
        if aqhi <= 3:
            return "Low"
        elif aqhi <= 6:
            return "Moderate"
        elif aqhi == 7:
            return "High Risk"
        elif aqhi <= 10:
            return "Very High Risk"
        else:
            return "Serious"

    def _aqi_quality(self, aqi: int) -> str:
        """Map AQI (US EPA scale 1-500) to quality description."""
        if aqi <= 50:
            return "Good"
        elif aqi <= 100:
            return "Moderate"
        elif aqi <= 150:
            return "Unhealthy for Sensitive"
        elif aqi <= 200:
            return "Unhealthy"
        elif aqi <= 300:
            return "Very Unhealthy"
        else:
            return "Hazardous"

    def _uv_description(self, uv_index: float) -> str:
        """Map UV index to description."""
        if uv_index < 3:
            return "Low"
        elif uv_index < 6:
            return "Moderate"
        elif uv_index < 8:
            return "High"
        elif uv_index < 11:
            return "Very High"
        else:
            return "Extreme"

    def _generate_summary(self, data: WeatherData) -> str:
        """Generate a brief summary sentence based on conditions."""
        parts = []

        if data.temperature is not None:
            if data.temperature >= 30:
                parts.append("Hot")
            elif data.temperature >= 25:
                parts.append("Warm")
            elif data.temperature >= 20:
                parts.append("Mild")
            elif data.temperature >= 15:
                parts.append("Cool")
            else:
                parts.append("Cold")

        if data.humidity is not None:
            if data.humidity >= 80:
                parts.append("humid")
            elif data.humidity <= 40:
                parts.append("dry")

        condition_desc = {
            WeatherCondition.SUNNY: "and sunny",
            WeatherCondition.CLEAR: "and clear",
            WeatherCondition.PARTLY_CLOUDY: "with partly cloudy skies",
            WeatherCondition.CLOUDY: "and cloudy",
            WeatherCondition.OVERCAST: "and overcast",
            WeatherCondition.FOG: "with fog",
            WeatherCondition.MIST: "with mist",
            WeatherCondition.DRIZZLE: "with occasional drizzle",
            WeatherCondition.RAIN: "with rain expected",
            WeatherCondition.SHOWERS: "with scattered showers",
            WeatherCondition.HEAVY_RAIN: "with heavy rain",
            WeatherCondition.THUNDERSTORM: "with thunderstorms possible",
            WeatherCondition.SNOW: "with snow",
            WeatherCondition.HEAVY_SNOW: "with heavy snow",
            WeatherCondition.WINDY: "and windy",
        }
        sky = condition_desc.get(data.condition, "")
        if sky:
            parts.append(sky)

        if len(parts) < 2:
            return ""

        summary = " ".join(parts)

        if data.condition in [WeatherCondition.RAIN, WeatherCondition.HEAVY_RAIN,
                              WeatherCondition.THUNDERSTORM, WeatherCondition.SHOWERS,
                              WeatherCondition.DRIZZLE]:
            summary += " — perfect weather for a cozy day indoors"
        elif data.condition == WeatherCondition.SUNNY and data.temperature and data.temperature >= 20:
            summary += " — great weather to be outdoors"
        elif data.humidity and data.humidity >= 85:
            summary += " — stay hydrated and keep cool"

        return summary
