"""
Weather senders package.

Available senders:
- TelegramSender: Telegram Bot API
- (Future) WhatsAppSender: WhatsApp Business API
"""

from .base import WeatherSender, SendResult, SenderError
from .telegram import TelegramSender

__all__ = [
    "WeatherSender",
    "SendResult",
    "SenderError",
    "TelegramSender",
]

def get_telegram_sender(bot_token: str = None, chat_id: str = None):
    """Get Telegram Bot sender."""
    return TelegramSender(bot_token=bot_token, default_chat_id=chat_id)
