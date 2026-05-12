"""
Weather providers package.

Available providers:
- HKOProvider: Hong Kong Observatory (priority 1, HK only)
- SGNEAProvider: Singapore NEA (priority 2, Singapore only)
- JMAProvider: Japan Meteorological Agency (priority 3, Japan only)
- CWAProvider: Taiwan Central Weather Administration (priority 4, Taiwan only)
- UKMetOfficeProvider: UK Met Office (priority 5, UK only)
- BOMProvider: Australian Bureau of Meteorology (priority 6, AU only)
- MetServiceProvider: New Zealand MetService (priority 7, NZ only)
- NWSProvider: US National Weather Service (priority 7, US only)
- BMKGProvider: Indonesia BMKG (priority 8, Indonesia only)
- DWDProvider: Germany DWD via Bright Sky (priority 8, Germany only)
- KMAProvider: South Korea KMA (priority 9, Korea only, requires API key)
- TMDProvider: Thailand TMD (priority 9, Thailand only, requires API key)
- OpenWeatherMapProvider: Global fallback (priority 10, requires API key)
"""

from .base import (
    WeatherProvider,
    SyncWeatherProvider,
    ProviderError,
    LocationNotSupportedError,
)

from .hko import HKOProvider
from .sg_nea import SGNEAProvider
from .jma import JMAProvider
from .tw_cwa import CWAProvider
from .uk_metoffice import UKMetOfficeProvider
from .au_bom import BOMProvider
from .nz_metservice import MetServiceProvider
from .us_nws import NWSProvider
from .id_bmkg import BMKGProvider
from .de_dwd import DWDProvider
from .kr_kma import KMAProvider
from .th_tmd import TMDProvider
from .openweathermap import OpenWeatherMapProvider

__all__ = [
    "WeatherProvider",
    "SyncWeatherProvider",
    "ProviderError",
    "LocationNotSupportedError",
    "HKOProvider",
    "SGNEAProvider",
    "JMAProvider",
    "CWAProvider",
    "UKMetOfficeProvider",
    "BOMProvider",
    "MetServiceProvider",
    "NWSProvider",
    "BMKGProvider",
    "DWDProvider",
    "KMAProvider",
    "TMDProvider",
    "OpenWeatherMapProvider",
]


# Lazy imports for providers
def get_hko_provider():
    """Get HK Observatory provider."""
    from .hko import HKOProvider

    return HKOProvider()


def get_sg_nea_provider():
    """Get Singapore NEA provider."""
    from .sg_nea import SGNEAProvider

    return SGNEAProvider()


def get_jma_provider():
    """Get Japan Meteorological Agency provider."""
    from .jma import JMAProvider

    return JMAProvider()


def get_cwa_provider(api_key: str = ""):
    """Get Taiwan CWA provider."""
    from .tw_cwa import CWAProvider

    return CWAProvider(api_key)


def get_metoffice_provider(api_key: str = ""):
    """Get UK Met Office provider."""
    from .uk_metoffice import UKMetOfficeProvider

    return UKMetOfficeProvider(api_key)


def get_bmkg_provider():
    """Get Indonesia BMKG provider."""
    from .id_bmkg import BMKGProvider

    return BMKGProvider()


def get_dwd_provider():
    """Get Germany DWD provider via Bright Sky."""
    from .de_dwd import DWDProvider

    return DWDProvider()


def get_kma_provider(api_key: str = ""):
    """Get South Korea KMA provider."""
    from .kr_kma import KMAProvider

    return KMAProvider(api_key)


def get_tmd_provider(api_key: str = ""):
    """Get Thailand TMD provider."""
    from .th_tmd import TMDProvider

    return TMDProvider(api_key)


def get_openweathermap_provider(api_key: str):
    """Get OpenWeatherMap provider."""
    from .openweathermap import OpenWeatherMapProvider

    return OpenWeatherMapProvider(api_key)
