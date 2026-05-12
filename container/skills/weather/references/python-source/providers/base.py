"""
Base weather provider interface.

"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from models import WeatherData, Location


class ProviderError(Exception):
    """Provider failed to fetch data."""
    pass


class LocationNotSupportedError(ProviderError):
    """Provider doesn't support this location."""
    pass


class WeatherProvider(ABC):
    """
    Abstract base class for weather data providers.

    Implementations should:
    - Override get_current() to fetch current weather
    - Override get_forecast() to fetch forecast data
    - Override supports_location() to declare coverage
    - Set appropriate priority for provider chain
    """

    # Priority in provider chain (lower = higher priority)
    priority: int = 10

    # Provider capabilities
    supports_forecast: bool = True
    supports_air_quality: bool = False
    requires_api_key: bool = False

    @property
    @abstractmethod
    def name(self) -> str:
        """Provider name for logging and selection."""
        pass

    @abstractmethod
    async def get_current(self, location: "Location") -> "WeatherData":
        """
        Fetch current weather for location.

        Args:
            location: Parsed location information

        Returns:
            WeatherData with current conditions

        Raises:
            ProviderError: If fetch fails
            LocationNotSupportedError: If location not in coverage
        """
        pass

    @abstractmethod
    async def get_forecast(
        self,
        location: "Location",
        days: int = 3
    ) -> list["WeatherData"]:
        """
        Fetch weather forecast for location.

        Args:
            location: Parsed location information
            days: Number of forecast days (max varies by provider)

        Returns:
            List of WeatherData, one per forecast period

        Raises:
            ProviderError: If fetch fails
            LocationNotSupportedError: If location not in coverage
        """
        pass

    @abstractmethod
    def supports_location(self, location: "Location") -> bool:
        """
        Check if provider supports this location.

        Args:
            location: Parsed location information

        Returns:
            True if provider can fetch weather for this location
        """
        pass

    def __repr__(self) -> str:
        return f"<{self.__class__.__name__} priority={self.priority}>"


class SyncWeatherProvider(WeatherProvider):
    """
    Synchronous provider wrapper for simple implementations.

    Override fetch_current() and fetch_forecast() instead
    of the async methods.
    """

    @abstractmethod
    def fetch_current(self, location: "Location") -> "WeatherData":
        """Synchronous fetch implementation."""
        pass

    @abstractmethod
    def fetch_forecast(self, location: "Location", days: int = 3) -> list["WeatherData"]:
        """Synchronous forecast implementation."""
        pass

    async def get_current(self, location: "Location") -> "WeatherData":
        return self.fetch_current(location)

    async def get_forecast(
        self,
        location: "Location",
        days: int = 3
    ) -> list["WeatherData"]:
        return self.fetch_forecast(location, days)
