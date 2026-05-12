"""
Weather Skill package.

This package provides a platform-agnostic way to fetch weather data
from multiple providers and format it for different messaging platforms.
"""

from .skill import WeatherSkill

__all__ = [
    "WeatherSkill",
]
