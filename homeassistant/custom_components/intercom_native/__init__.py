"""Intercom Native integration for Home Assistant.

This integration provides native TCP-based audio streaming between
Home Assistant and ESP32 devices running the intercom_api ESPHome component.

Unlike WebRTC/go2rtc approaches, this uses a simple TCP protocol on port 6054
which is more reliable across NAT/firewall scenarios.
"""

import logging

from homeassistant.core import HomeAssistant
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform

from .const import DOMAIN
from .websocket_api import async_register_websocket_api

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[Platform] = []


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Set up Intercom Native from configuration.yaml."""
    hass.data.setdefault(DOMAIN, {})

    # Register WebSocket API commands
    async_register_websocket_api(hass)

    _LOGGER.info("Intercom Native integration loaded")
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Intercom Native from a config entry."""
    hass.data.setdefault(DOMAIN, {})

    # Register WebSocket API if not already done
    async_register_websocket_api(hass)

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    return True
