"""
Weather Skill orchestrator.


Main entry point that coordinates providers, formatters, and senders.
"""

from pathlib import Path
from typing import Optional, TYPE_CHECKING

from .models import WeatherData, Location, normalize_location
from .providers.base import WeatherProvider, ProviderError
from .formatters.base import WeatherFormatter
from .senders.base import WeatherSender, SendResult

if TYPE_CHECKING:
    from .providers.hko import HKOProvider
    from .providers.openweathermap import OpenWeatherMapProvider


class NoProviderError(Exception):
    """No provider available for location."""
    pass


class WeatherSkill:
    """
    Main weather skill orchestrator.

    Coordinates provider chain, formatters, and senders to
    deliver weather information across platforms.

    Example:
        skill = WeatherSkill()

        # Get current weather
        data = await skill.get_current("Hong Kong")

        # Format for Telegram
        message = skill.format(data, platform="telegram")

        # Send to configured channel
        await skill.send(message)
    """

    def __init__(
        self,
        config_path: Optional[Path] = None,
        providers: Optional[list[WeatherProvider]] = None,
        formatters: Optional[dict[str, WeatherFormatter]] = None,
        senders: Optional[dict[str, WeatherSender]] = None,
    ):
        """
        Initialize weather skill.

        Args:
            config_path: Path to YAML config file
            providers: Custom provider list (overrides config)
            formatters: Custom formatter dict (overrides config)
            senders: Custom sender dict (overrides config)
        """
        self._providers: list[WeatherProvider] = providers or []
        self._formatters: dict[str, WeatherFormatter] = formatters or {}
        self._senders: dict[str, WeatherSender] = senders or {}
        self._default_location = "Hong Kong"

        # Load config if provided
        if config_path and config_path.exists():
            self._load_config(config_path)

        # Sort providers by priority
        self._providers.sort(key=lambda p: p.priority)

    def _load_config(self, config_path: Path) -> None:
        """Load configuration from YAML file."""
        # TODO: Implement YAML config loading
        # For now, providers are added programmatically
        pass

    def add_provider(self, provider: WeatherProvider) -> None:
        """Add a weather provider to the chain."""
        self._providers.append(provider)
        self._providers.sort(key=lambda p: p.priority)

    def add_formatter(self, platform: str, formatter: WeatherFormatter) -> None:
        """Add a formatter for a platform."""
        self._formatters[platform] = formatter

    def add_sender(self, channel: str, sender: WeatherSender) -> None:
        """Add a sender for a channel."""
        self._senders[channel] = sender

    def parse_location(self, location_str: str) -> Location:
        """
        Parse location string into Location object.

        Args:
            location_str: Raw location input (e.g., "Hong Kong", "hk")

        Returns:
            Parsed Location object
        """
        normalized = normalize_location(location_str)
        return Location(
            raw=location_str,
            normalized=normalized,
        )

    async def get_current(
        self,
        location: str,
        provider_name: Optional[str] = None
    ) -> WeatherData:
        """
        Get current weather for location.

        Tries providers in priority order until one succeeds.

        Args:
            location: Location string (e.g., "Hong Kong")
            provider_name: Specific provider to use (optional)

        Returns:
            WeatherData with current conditions

        Raises:
            NoProviderError: No provider supports location
            ProviderError: All providers failed
        """
        loc = self.parse_location(location)

        # Use specific provider if requested
        if provider_name:
            provider = next(
                (p for p in self._providers if p.name == provider_name),
                None
            )
            if not provider:
                raise NoProviderError(f"Provider not found: {provider_name}")
            data = await provider.get_current(loc)
            data.provider_name = provider.name
            return data

        # Try providers in priority order
        errors = []
        for provider in self._providers:
            if not provider.supports_location(loc):
                continue
            try:
                data = await provider.get_current(loc)
                data.provider_name = provider.name
                return data
            except ProviderError as e:
                errors.append(f"{provider.name}: {e}")
                continue

        if errors:
            raise ProviderError(f"All providers failed: {'; '.join(errors)}")
        raise NoProviderError(f"No provider supports location: {location}")

    async def get_forecast(
        self,
        location: str,
        days: int = 3,
        provider_name: Optional[str] = None
    ) -> list[WeatherData]:
        """
        Get weather forecast for location.

        Args:
            location: Location string
            days: Number of forecast days
            provider_name: Specific provider to use

        Returns:
            List of WeatherData, one per day
        """
        loc = self.parse_location(location)

        if provider_name:
            provider = next(
                (p for p in self._providers if p.name == provider_name),
                None
            )
            if not provider:
                raise NoProviderError(f"Provider not found: {provider_name}")
            data = await provider.get_forecast(loc, days)
            for d in data:
                d.provider_name = provider.name
            return data

        for provider in self._providers:
            if not provider.supports_location(loc):
                continue
            if not provider.supports_forecast:
                continue
            try:
                data = await provider.get_forecast(loc, days)
                for d in data:
                    d.provider_name = provider.name
                return data
            except ProviderError:
                continue

        raise NoProviderError(f"No provider supports location: {location}")

    def format(
        self,
        data: WeatherData | list[WeatherData],
        platform: str = "telegram"
    ) -> str:
        """
        Format weather data for a platform.

        Args:
            data: Weather data to format
            platform: Target platform

        Returns:
            Formatted message string
        """
        formatter = self._formatters.get(platform)
        if not formatter:
            # Fallback to simple text
            return self._format_simple(data)

        return formatter.format(data)

    def _format_simple(self, data: WeatherData | list[WeatherData]) -> str:
        """Simple text fallback formatter."""
        if isinstance(data, list):
            lines = ["📊 Weather Forecast\n"]
            for d in data:
                lines.append(f"{d.forecast_date}: {d.emoji} {d.temp_range_str}")
            return "\n".join(lines)

        return (
            f"🌤️ Weather for {data.location}\n"
            f"{data.emoji} {data.condition.value.title()}\n"
            f"🌡️ {data.temperature:.0f}°C\n"
            f"💧 Humidity: {data.humidity_str}\n"
            f"💨 Wind: {data.wind_str}"
        )

    async def send(
        self,
        message: str,
        channel: str = "telegram",
        **kwargs
    ) -> SendResult:
        """
        Send message via configured sender.

        Args:
            message: Formatted message to send
            channel: Channel to send to
            **kwargs: Platform-specific options

        Returns:
            SendResult with success status
        """
        sender = self._senders.get(channel)
        if not sender:
            return SendResult(
                success=False,
                error=f"No sender configured for channel: {channel}"
            )

        return await sender.send(message, **kwargs)

    async def fetch_and_send(
        self,
        location: str,
        channel: str = "telegram",
        platform: str = "telegram",
        forecast: bool = False,
        days: int = 3,
    ) -> SendResult:
        """
        Convenience method: fetch weather, format, and send.

        Args:
            location: Location to fetch weather for
            channel: Channel to send to
            platform: Format platform
            forecast: Fetch forecast instead of current
            days: Forecast days

        Returns:
            SendResult with success status
        """
        try:
            if forecast:
                data = await self.get_forecast(location, days)
            else:
                data = await self.get_current(location)

            message = self.format(data, platform=platform)
            return await self.send(message, channel=channel)

        except (NoProviderError, ProviderError) as e:
            return SendResult(success=False, error=str(e))

    @property
    def providers(self) -> list[WeatherProvider]:
        """List of configured providers."""
        return self._providers.copy()

    @property
    def platforms(self) -> list[str]:
        """List of supported formatting platforms."""
        return list(self._formatters.keys())

    @property
    def channels(self) -> list[str]:
        """List of configured send channels."""
        return list(self._senders.keys())
