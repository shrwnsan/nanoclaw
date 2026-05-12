"""
CLI text formatter for weather data.

Formats weather data as plain text for terminal output.
"""

from ..models import WeatherData
from .base import WeatherFormatter


class CliTextFormatter(WeatherFormatter):
    """
    Plain text formatter for CLI output.

    Produces emoji-annotated weather reports suitable for terminal display.
    Only includes fields that have data present (no "N/A" placeholders).
    """

    @property
    def platform(self) -> str:
        """Target platform name."""
        return "text"

    def format_current(self, data: WeatherData) -> str:
        """
        Format current weather for CLI display.

        Args:
            data: Current weather data

        Returns:
            Plain text weather report
        """
        lines: list[str] = []

        lines.append(f"{data.emoji} Weather for {data.location}")
        lines.append(f"🌡️ Temperature: {data.temperature:.0f}°C")

        feels = data.effective_feels_like
        if abs(feels - data.temperature) > 0.5:
            lines.append(f"   Feels like: {feels:.0f}°C")

        if data.temp_high is not None and data.temp_low is not None:
            lines.append(f"   Range: {data.temp_low:.0f}° - {data.temp_high:.0f}°")

        if data.humidity is not None:
            lines.append(f"💧 Humidity: {data.humidity}%")

        wind = data.wind_str
        if wind != "N/A":
            lines.append(f"💨 Wind: {wind}")

        if data.precipitation_chance is not None:
            lines.append(f"🌧️ Rain chance: {data.precipitation_chance}%")

        if data.uv_index is not None:
            lines.append(f"☀️ UV Index: {data.uv_index}")

        if data.aqhi is not None:
            lines.append(f"🌫️ AQHI: {data.aqhi_str}")
        elif data.aqi is not None:
            lines.append(f"🌫️ AQI: {data.aqi_str}")

        lines.append(f"📍 Provider: {data.provider_name}")

        return "\n".join(lines)

    def format_forecast(self, data: list[WeatherData]) -> str:
        """
        Format multi-day forecast for CLI display.

        Args:
            data: List of forecast weather data

        Returns:
            Plain text forecast report
        """
        lines: list[str] = ["📊 Weather Forecast\n"]

        for day in data:
            if day.forecast_date:
                date_str = day.forecast_date.strftime("%Y-%m-%d")
            else:
                date_str = "Unknown"

            temp_high = f"{day.temp_high:.0f}°" if day.temp_high is not None else "?"
            temp_low = f"{day.temp_low:.0f}°" if day.temp_low is not None else "?"

            condition = day.description or day.condition_raw or str(day.condition.value)
            lines.append(f"{date_str}: {temp_high} / {temp_low} — {condition}")

        return "\n".join(lines)
