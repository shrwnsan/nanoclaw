"""
Base weather formatter interface.

"""

from abc import ABC, abstractmethod
from typing import Optional
from ..models import WeatherData


class FormatterError(Exception):
    """Formatting failed."""
    pass


class WeatherFormatter(ABC):
    """
    Abstract base class for weather output formatters.

    Formatters convert WeatherData to platform-specific message strings.
    Each platform has different formatting requirements:
    - Telegram: MarkdownV2 with escape rules
    - WhatsApp: Basic formatting, character limits
    - CLI: Plain text with colors
    """

    # Maximum message length for this platform
    max_length: int = 4096

    @property
    @abstractmethod
    def platform(self) -> str:
        """Target platform name (e.g., 'telegram', 'whatsapp')."""
        pass

    @abstractmethod
    def format_current(self, data: WeatherData) -> str:
        """
        Format current weather for display.

        Args:
            data: Current weather data

        Returns:
            Formatted message string
        """
        pass

    @abstractmethod
    def format_forecast(self, data: list[WeatherData]) -> str:
        """
        Format multi-day forecast for display.

        Args:
            data: List of forecast weather data

        Returns:
            Formatted message string
        """
        pass

    def format(self, data: WeatherData | list[WeatherData]) -> str:
        """
        Auto-detect format based on input type.

        Args:
            data: Single WeatherData or list for forecast

        Returns:
            Formatted message string
        """
        if isinstance(data, list):
            return self.format_forecast(data)
        return self.format_current(data)

    def truncate(self, message: str, suffix: str = "...") -> str:
        """
        Truncate message to platform max length.

        Args:
            message: Message to truncate
            suffix: Suffix to append if truncated

        Returns:
            Truncated message
        """
        if len(message) <= self.max_length:
            return message
        return message[:self.max_length - len(suffix)] + suffix

    def __repr__(self) -> str:
        return f"<{self.__class__.__name__} platform={self.platform}>"
