"""
Weather formatters package.

Available formatters:
- TelegramFormatter: Telegram MarkdownV2 format
- WhatsAppFormatter: WhatsApp formatting (*bold*, _italic_)
- CliTextFormatter: Plain text for CLI output
"""

from .base import WeatherFormatter, FormatterError
from .telegram import TelegramFormatter
from .whatsapp import WhatsAppFormatter
from .cli_text import CliTextFormatter

__all__ = [
    "WeatherFormatter",
    "FormatterError",
    "TelegramFormatter",
    "WhatsAppFormatter",
    "CliTextFormatter",
]

def get_telegram_formatter():
    """Get Telegram MarkdownV2 formatter."""
    return TelegramFormatter()

def get_whatsapp_formatter():
    """Get WhatsApp formatter."""
    return WhatsAppFormatter()
