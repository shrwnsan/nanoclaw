"""
Telegram MarkdownV2 formatter for weather data.


Formats weather data for Telegram using MarkdownV2 syntax.
"""

from datetime import date
from ..models import WeatherData, WeatherCondition, CONDITION_EMOJI
from .base import WeatherFormatter, FormatterError


# Telegram MarkdownV2 characters that need escaping
# https://core.telegram.org/bots/api#markdownv2-style
MDV2_ESCAPE_CHARS = r'_*[]()~`>#+-=|{}.!'


def escape_mdv2(text: str) -> str:
    """
    Escape text for Telegram MarkdownV2.

    All characters in MDV2_ESCAPE_CHARS must be escaped with backslash.
    """
    result = []
    for char in text:
        if char in MDV2_ESCAPE_CHARS:
            result.append('\\' + char)
        else:
            result.append(char)
    return ''.join(result)


def get_condition_emoji(condition: WeatherCondition) -> str:
    """Get emoji for weather condition."""
    return CONDITION_EMOJI.get(condition, "❓")


class TelegramFormatter(WeatherFormatter):
    """
    Telegram MarkdownV2 weather formatter.

    Features:
    - MarkdownV2 syntax with proper escaping
    - Emoji weather icons
    - Compact, readable format
    - Max 4096 characters (Telegram limit)
    """

    max_length = 4096

    @property
    def platform(self) -> str:
        return "telegram"

    def format_current(self, data: WeatherData) -> str:
        """
        Format current weather for Telegram.

        Output format:
        ☁️ Hong Kong Weather — Sunday, March 29

        🌡️ 23°C (feels 24°C) • High 27° / Low 22°
        ☁️ Mainly cloudy with light rain patches. Some sunny intervals.
        💧 Humidity: 87%
        💨 Wind: East force 3-4, becoming south force 3
        🌧️ Rain chance: 40%
        🌬️ Air Quality: Moderate (AQHI ~3)
        ☀️ UV Index: 0.1 (Low)
        🌅 Sunrise: 6:25 AM | 🌇 Sunset: 6:35 PM

        Humid and cloudy with occasional light rain — perfect weather for a cozy day indoors.
        """
        lines = []

        # Header with emoji and location
        emoji = get_condition_emoji(data.condition)
        day_str = data.forecast_date.strftime("%A, %B %-d") if data.forecast_date else ""
        if not day_str and data.observed_at:
            day_str = data.observed_at.strftime("%A, %B %-d")
        if not day_str:
            day_str = date.today().strftime("%A, %B %-d")

        header = f"{emoji} {escape_mdv2(data.location)} Weather — {escape_mdv2(day_str)}"
        lines.append(header)
        lines.append("")

        # Temperature line (always show feels-like)
        temp_str = f"🌡️ {data.temperature:.0f}°C"
        feels = data.effective_feels_like
        if abs(feels - data.temperature) > 0.5:
            temp_str += f" \\(feels {feels:.0f}°C\\)"

        if data.temp_high is not None and data.temp_low is not None:
            temp_str += f" • High {data.temp_high:.0f}° / Low {data.temp_low:.0f}°"

        lines.append(temp_str)

        # Condition/Description line
        if data.description:
            # Use first sentence or truncate to 120 chars
            desc = data.description
            # Find first sentence
            first_sentence_end = desc.find('. ')
            if first_sentence_end > 0 and first_sentence_end < 120:
                desc = desc[:first_sentence_end + 1]
            elif len(desc) > 120:
                desc = desc[:117] + "..."
            lines.append(f"{emoji} {escape_mdv2(desc)}")
        else:
            lines.append(f"{emoji} {escape_mdv2(data.condition.value.title())}")

        # Humidity
        if data.humidity is not None:
            lines.append(f"💧 Humidity: {data.humidity}%")

        # Wind
        if data.wind_str and data.wind_str != "N/A":
            wind = data.wind_str.rstrip(".")
            lines.append(f"💨 Wind: {escape_mdv2(wind)}")

        # Rain chance
        if data.precipitation_chance is not None:
            lines.append(f"🌧️ Rain chance: {data.precipitation_chance}%")

        # Air Quality - prefer AQHI (HK scale), fall back to AQI (US EPA scale)
        if data.aqhi is not None:
            aqhi_quality = self._aqhi_quality(data.aqhi)
            lines.append(f"🌬️ Air Quality: {escape_mdv2(aqhi_quality)} \\(AQHI {data.aqhi}\\)")
        elif data.aqi is not None:
            aqi_quality = self._aqi_quality(data.aqi)
            lines.append(f"🌬️ Air Quality: {escape_mdv2(aqi_quality)} \\(AQI {data.aqi}\\)")
        else:
            lines.append(f"🌬️ Air Quality: Data unavailable")

        # UV Index
        if data.uv_index is not None:
            uv_desc = self._uv_description(data.uv_index)
            lines.append(f"☀️ UV Index: {data.uv_index:.1f} \\({escape_mdv2(uv_desc)}\\)")

        # Sunrise/Sunset
        if data.sunrise or data.sunset:
            astro_parts = []
            if data.sunrise:
                astro_parts.append(f"🌅 Sunrise: {escape_mdv2(data.sunrise)}")
            if data.sunset:
                astro_parts.append(f"🌇 Sunset: {escape_mdv2(data.sunset)}")
            lines.append(" | ".join(astro_parts))

        # Summary line
        summary = self._generate_summary(data)
        if summary:
            lines.append("")
            lines.append(escape_mdv2(summary))

        return self.truncate("\n".join(lines))

    def format_forecast(self, data: list[WeatherData]) -> str:
        """
        Format multi-day forecast for Telegram.

        Output format:
        📊 Hong Kong 3-Day Forecast

        Wed Apr 1: ⛅ 27° / 23° — Cloudy with showers
        Thu Apr 2: 🌧️ 25° / 22° — Rain
        Fri Apr 3: ☀️ 28° / 24° — Sunny
        """
        if not data:
            return escape_mdv2("No forecast data available")

        lines = []

        # Header
        location = data[0].location if data else "Hong Kong"
        days = len(data)
        lines.append(f"📊 {escape_mdv2(location)} {days}\\-Day Forecast")
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

            line = f"{escape_mdv2(date_str)}: {emoji} {escape_mdv2(temp_str)} — {escape_mdv2(desc)}"
            lines.append(line)

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

        # Temperature feel
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

        # Humidity feel
        if data.humidity is not None:
            if data.humidity >= 80:
                parts.append("humid")
            elif data.humidity <= 40:
                parts.append("dry")

        # Sky condition
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

        # Build sentence
        summary = " ".join(parts)

        # Add activity suggestion
        if data.condition in [WeatherCondition.RAIN, WeatherCondition.HEAVY_RAIN,
                              WeatherCondition.THUNDERSTORM, WeatherCondition.SHOWERS,
                              WeatherCondition.DRIZZLE]:
            summary += " — perfect weather for a cozy day indoors"
        elif data.condition == WeatherCondition.SUNNY and data.temperature and data.temperature >= 20:
            summary += " — great weather to be outdoors"
        elif data.humidity and data.humidity >= 85:
            summary += " — stay hydrated and keep cool"

        return summary
