"""
Bootstrap factory for WeatherSkill.

Builds a fully-configured WeatherSkill instance with all available
providers, formatters, and senders registered based on environment
configuration.
"""

import os
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .skill import WeatherSkill


def build_default_skill(**overrides) -> "WeatherSkill":
    """
    Build a fully-configured WeatherSkill instance.

    Registers all available providers, formatters, and senders
    based on environment variables. Accepts optional overrides
    for testing or custom configuration.

    Args:
        **overrides: Optional overrides for testing:
            - providers: list[WeatherProvider] -- override default providers
            - formatters: dict[str, WeatherFormatter] -- override default formatters
            - senders: dict[str, WeatherSender] -- override default senders

    Returns:
        Configured WeatherSkill instance
    """
    from .skill import WeatherSkill

    providers = overrides.pop("providers", None)
    if providers is None:
        providers = _build_providers()

    formatters = overrides.pop("formatters", None)
    if formatters is None:
        formatters = _build_formatters()

    senders = overrides.pop("senders", None)
    if senders is None:
        senders = _build_senders()

    return WeatherSkill(
        providers=providers,
        formatters=formatters,
        senders=senders,
    )


def _build_providers():
    """Build the default provider list from environment."""
    from .providers.base import WeatherProvider
    from .providers.hko import HKOProvider
    from .providers.sg_nea import SGNEAProvider
    from .providers.jma import JMAProvider
    from .providers.au_bom import BOMProvider
    from .providers.nz_metservice import MetServiceProvider
    from .providers.us_nws import NWSProvider
    from .providers.id_bmkg import BMKGProvider
    from .providers.de_dwd import DWDProvider

    providers: list[WeatherProvider] = [
        HKOProvider(),
        SGNEAProvider(),
        JMAProvider(),
        BOMProvider(),
        MetServiceProvider(),
        NWSProvider(),
        BMKGProvider(),
        DWDProvider(),
    ]

    # Key-required providers (only when env var is set)
    if os.environ.get("CWA_API_KEY"):
        from .providers.tw_cwa import CWAProvider
        providers.append(CWAProvider())

    if os.environ.get("METOFFICE_API_KEY"):
        from .providers.uk_metoffice import UKMetOfficeProvider
        providers.append(UKMetOfficeProvider())

    if os.environ.get("KMA_SERVICE_KEY"):
        from .providers.kr_kma import KMAProvider
        providers.append(KMAProvider())

    if os.environ.get("TMD_API_TOKEN"):
        from .providers.th_tmd import TMDProvider
        providers.append(TMDProvider())

    owm_key = os.environ.get("OPENWEATHERMAP_API_KEY")
    if owm_key:
        from .providers.openweathermap import OpenWeatherMapProvider
        providers.append(OpenWeatherMapProvider(api_key=owm_key))

    return providers


def _build_formatters():
    """Build the default formatter dict."""
    from .formatters.cli_text import CliTextFormatter
    from .formatters.telegram import TelegramFormatter
    from .formatters.whatsapp import WhatsAppFormatter

    return {
        "text": CliTextFormatter(),
        "telegram": TelegramFormatter(),
        "whatsapp": WhatsAppFormatter(),
    }


def _build_senders():
    """Build the default sender dict from environment."""
    senders = {}

    if os.environ.get("TELEGRAM_BOT_TOKEN"):
        from .senders.telegram import TelegramSender
        senders["telegram"] = TelegramSender()

    return senders
