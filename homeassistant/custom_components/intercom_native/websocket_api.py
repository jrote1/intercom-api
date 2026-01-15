"""WebSocket API for Intercom Native integration."""

import asyncio
import logging
from typing import Any, Dict, Optional

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from .const import (
    DOMAIN,
    WS_TYPE_START,
    WS_TYPE_STOP,
    WS_TYPE_LIST,
    INTERCOM_PORT,
)
from .tcp_client import IntercomTcpClient

_LOGGER = logging.getLogger(__name__)

# Active sessions: device_id -> IntercomSession
_sessions: Dict[str, "IntercomSession"] = {}


class IntercomSession:
    """Manages a single intercom session between browser and ESP."""

    def __init__(
        self,
        hass: HomeAssistant,
        connection: websocket_api.ActiveConnection,
        device_id: str,
        host: str,
        binary_handler_id: int,
    ):
        """Initialize session."""
        self.hass = hass
        self.connection = connection
        self.device_id = device_id
        self.host = host
        self.binary_handler_id = binary_handler_id

        self._tcp_client: Optional[IntercomTcpClient] = None
        self._active = False

    async def start(self) -> bool:
        """Start the intercom session."""
        if self._active:
            return True

        def on_audio(data: bytes) -> None:
            """Handle audio from ESP."""
            if self._active:
                # Send to browser via binary handler
                self.connection.send_message(
                    websocket_api.messages.binary_message(
                        self.binary_handler_id, data
                    )
                )

        def on_connected() -> None:
            """Handle connection established."""
            _LOGGER.info("Intercom connected to %s", self.host)

        def on_disconnected() -> None:
            """Handle disconnection."""
            _LOGGER.info("Intercom disconnected from %s", self.host)
            self._active = False

        self._tcp_client = IntercomTcpClient(
            host=self.host,
            port=INTERCOM_PORT,
            on_audio=on_audio,
            on_connected=on_connected,
            on_disconnected=on_disconnected,
        )

        if await self._tcp_client.connect():
            if await self._tcp_client.start_stream():
                self._active = True
                return True
            else:
                await self._tcp_client.disconnect()

        return False

    async def stop(self) -> None:
        """Stop the intercom session."""
        if not self._active:
            return

        self._active = False

        if self._tcp_client:
            await self._tcp_client.stop_stream()
            await self._tcp_client.disconnect()
            self._tcp_client = None

    async def handle_audio(self, data: bytes) -> None:
        """Handle audio from browser."""
        if self._active and self._tcp_client:
            await self._tcp_client.send_audio(data)


def async_register_websocket_api(hass: HomeAssistant) -> None:
    """Register WebSocket API commands."""
    websocket_api.async_register_command(hass, websocket_start)
    websocket_api.async_register_command(hass, websocket_stop)
    websocket_api.async_register_command(hass, websocket_list_devices)


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_TYPE_START,
        vol.Required("device_id"): str,
        vol.Required("host"): str,
    }
)
@websocket_api.async_response
async def websocket_start(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: Dict[str, Any],
) -> None:
    """Start intercom session."""
    device_id = msg["device_id"]
    host = msg["host"]

    _LOGGER.info("Starting intercom session for device %s at %s", device_id, host)

    # Check if session already exists
    if device_id in _sessions:
        connection.send_error(
            msg["id"], "already_active", f"Session already active for {device_id}"
        )
        return

    # Register binary handler for audio from browser
    def handle_binary(data: bytes) -> None:
        """Handle binary audio data from browser."""
        session = _sessions.get(device_id)
        if session:
            asyncio.create_task(session.handle_audio(data))

    binary_handler_id = connection.async_register_binary_handler(handle_binary)

    # Create and start session
    session = IntercomSession(
        hass=hass,
        connection=connection,
        device_id=device_id,
        host=host,
        binary_handler_id=binary_handler_id,
    )

    if await session.start():
        _sessions[device_id] = session
        connection.send_result(
            msg["id"],
            {
                "success": True,
                "binary_handler_id": binary_handler_id,
            },
        )
    else:
        connection.async_unregister_binary_handler(binary_handler_id)
        connection.send_error(
            msg["id"], "connection_failed", f"Failed to connect to {host}"
        )


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_TYPE_STOP,
        vol.Required("device_id"): str,
    }
)
@websocket_api.async_response
async def websocket_stop(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: Dict[str, Any],
) -> None:
    """Stop intercom session."""
    device_id = msg["device_id"]

    _LOGGER.info("Stopping intercom session for device %s", device_id)

    session = _sessions.pop(device_id, None)
    if session:
        # Unregister binary handler
        connection.async_unregister_binary_handler(session.binary_handler_id)
        await session.stop()
        connection.send_result(msg["id"], {"success": True})
    else:
        connection.send_error(
            msg["id"], "not_found", f"No active session for {device_id}"
        )


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_TYPE_LIST,
    }
)
@callback
def websocket_list_devices(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: Dict[str, Any],
) -> None:
    """List devices with intercom_api capability."""
    # Find ESPHome devices with intercom_api switch
    devices = []

    # Get all entities and find intercom_api switches
    entity_registry = hass.helpers.entity_registry.async_get(hass)
    device_registry = hass.helpers.device_registry.async_get(hass)

    for entity in entity_registry.entities.values():
        # Look for switch entities that match intercom_api pattern
        if entity.domain == "switch" and "intercom_api" in entity.entity_id:
            device = device_registry.async_get(entity.device_id)
            if device:
                # Get device IP from ESPHome
                # This is simplified - in practice we'd need to query ESPHome
                devices.append(
                    {
                        "device_id": entity.device_id,
                        "name": device.name,
                        "entity_id": entity.entity_id,
                    }
                )

    connection.send_result(msg["id"], {"devices": devices})
