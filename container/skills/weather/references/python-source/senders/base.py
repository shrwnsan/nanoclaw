"""
Base weather sender interface.

"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Optional


class SenderError(Exception):
    """Message delivery failed."""
    pass


@dataclass
class SendResult:
    """Result of a send operation."""
    success: bool
    message_id: Optional[str] = None
    error: Optional[str] = None
    metadata: Optional[dict[str, Any]] = field(default=None)

    def __bool__(self) -> bool:
        return self.success


class WeatherSender(ABC):
    """
    Abstract base class for message delivery.

    Senders handle the actual delivery of formatted messages
    to various platforms (Telegram, WhatsApp, etc.).
    """

    # Default timeout for send operations
    timeout: int = 30

    @property
    @abstractmethod
    def channel(self) -> str:
        """Channel/destination name for logging."""
        pass

    @abstractmethod
    async def send(
        self,
        message: str,
        *,
        chat_id: Optional[str] = None,
        **kwargs
    ) -> SendResult:
        """
        Send formatted message to destination.

        Args:
            message: Formatted message to send
            chat_id: Override default chat/destination
            **kwargs: Platform-specific options

        Returns:
            SendResult with success status and metadata

        Raises:
            SenderError: If delivery fails
        """
        pass

    async def send_with_retry(
        self,
        message: str,
        max_retries: int = 3,
        **kwargs
    ) -> SendResult:
        """
        Send with automatic retry on failure.

        Args:
            message: Formatted message to send
            max_retries: Maximum retry attempts
            **kwargs: Passed to send()

        Returns:
            SendResult from last attempt
        """
        import asyncio

        last_error = None
        for attempt in range(max_retries):
            try:
                result = await self.send(message, **kwargs)
                if result.success:
                    return result
                last_error = result.error
            except SenderError as e:
                last_error = str(e)

            if attempt < max_retries - 1:
                await asyncio.sleep(2 ** attempt)  # Exponential backoff

        return SendResult(success=False, error=last_error)

    def __repr__(self) -> str:
        return f"<{self.__class__.__name__} channel={self.channel}>"
