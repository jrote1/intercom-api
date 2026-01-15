"""Async TCP client for Intercom Native protocol."""

import asyncio
import logging
import struct
from typing import Callable, Optional

from .const import (
    INTERCOM_PORT,
    HEADER_SIZE,
    MSG_AUDIO,
    MSG_START,
    MSG_STOP,
    MSG_PING,
    MSG_PONG,
    MSG_ERROR,
    FLAG_NONE,
    CONNECT_TIMEOUT,
    PING_INTERVAL,
    AUDIO_CHUNK_SIZE,
)

_LOGGER = logging.getLogger(__name__)


class IntercomTcpClient:
    """Async TCP client for ESP intercom communication."""

    def __init__(
        self,
        host: str,
        port: int = INTERCOM_PORT,
        on_audio: Optional[Callable[[bytes], None]] = None,
        on_connected: Optional[Callable[[], None]] = None,
        on_disconnected: Optional[Callable[[], None]] = None,
    ):
        """Initialize the client."""
        self.host = host
        self.port = port
        self._on_audio = on_audio
        self._on_connected = on_connected
        self._on_disconnected = on_disconnected

        self._reader: Optional[asyncio.StreamReader] = None
        self._writer: Optional[asyncio.StreamWriter] = None
        self._connected = False
        self._streaming = False
        self._receive_task: Optional[asyncio.Task] = None
        self._ping_task: Optional[asyncio.Task] = None
        self._lock = asyncio.Lock()

    @property
    def connected(self) -> bool:
        """Return connection status."""
        return self._connected

    @property
    def streaming(self) -> bool:
        """Return streaming status."""
        return self._streaming

    async def connect(self) -> bool:
        """Connect to the ESP device."""
        if self._connected:
            return True

        try:
            _LOGGER.debug("Connecting to %s:%d", self.host, self.port)
            self._reader, self._writer = await asyncio.wait_for(
                asyncio.open_connection(self.host, self.port),
                timeout=CONNECT_TIMEOUT,
            )
            self._connected = True
            _LOGGER.info("Connected to %s:%d", self.host, self.port)

            # Start receive task
            self._receive_task = asyncio.create_task(self._receive_loop())

            # Start ping task
            self._ping_task = asyncio.create_task(self._ping_loop())

            if self._on_connected:
                self._on_connected()

            return True

        except asyncio.TimeoutError:
            _LOGGER.error("Connection timeout to %s:%d", self.host, self.port)
            return False
        except OSError as err:
            _LOGGER.error("Connection error to %s:%d: %s", self.host, self.port, err)
            return False

    async def disconnect(self) -> None:
        """Disconnect from the ESP device."""
        if not self._connected:
            return

        _LOGGER.debug("Disconnecting from %s:%d", self.host, self.port)

        # Cancel tasks
        if self._receive_task:
            self._receive_task.cancel()
            try:
                await self._receive_task
            except asyncio.CancelledError:
                pass
            self._receive_task = None

        if self._ping_task:
            self._ping_task.cancel()
            try:
                await self._ping_task
            except asyncio.CancelledError:
                pass
            self._ping_task = None

        # Close connection
        if self._writer:
            try:
                self._writer.close()
                await self._writer.wait_closed()
            except Exception:
                pass
            self._writer = None
            self._reader = None

        self._connected = False
        self._streaming = False

        if self._on_disconnected:
            self._on_disconnected()

        _LOGGER.info("Disconnected from %s:%d", self.host, self.port)

    async def start_stream(self) -> bool:
        """Start audio streaming."""
        if not self._connected:
            if not await self.connect():
                return False

        async with self._lock:
            if await self._send_message(MSG_START):
                self._streaming = True
                return True
            return False

    async def stop_stream(self) -> None:
        """Stop audio streaming."""
        if self._streaming:
            async with self._lock:
                await self._send_message(MSG_STOP)
                self._streaming = False

    async def send_audio(self, data: bytes) -> bool:
        """Send audio data to ESP."""
        if not self._connected or not self._streaming:
            return False

        async with self._lock:
            return await self._send_message(MSG_AUDIO, data)

    async def _send_message(
        self, msg_type: int, data: bytes = b"", flags: int = FLAG_NONE
    ) -> bool:
        """Send a protocol message."""
        if not self._writer:
            return False

        try:
            # Build header: type (1) + flags (1) + length (2 LE)
            header = struct.pack("<BBH", msg_type, flags, len(data))
            self._writer.write(header + data)
            await self._writer.drain()
            return True
        except Exception as err:
            _LOGGER.error("Send error: %s", err)
            await self.disconnect()
            return False

    async def _receive_loop(self) -> None:
        """Receive messages from ESP."""
        try:
            while self._connected and self._reader:
                # Read header
                header_data = await self._reader.readexactly(HEADER_SIZE)
                msg_type, flags, length = struct.unpack("<BBH", header_data)

                # Read payload
                payload = b""
                if length > 0:
                    payload = await self._reader.readexactly(length)

                # Handle message
                await self._handle_message(msg_type, flags, payload)

        except asyncio.IncompleteReadError:
            _LOGGER.debug("Connection closed by peer")
        except asyncio.CancelledError:
            raise
        except Exception as err:
            _LOGGER.error("Receive error: %s", err)
        finally:
            if self._connected:
                await self.disconnect()

    async def _handle_message(
        self, msg_type: int, flags: int, payload: bytes
    ) -> None:
        """Handle received message."""
        if msg_type == MSG_AUDIO:
            if self._on_audio:
                self._on_audio(payload)

        elif msg_type == MSG_PONG:
            _LOGGER.debug("Received PONG")

        elif msg_type == MSG_STOP:
            _LOGGER.info("Received STOP from ESP")
            self._streaming = False

        elif msg_type == MSG_ERROR:
            if payload:
                _LOGGER.error("Received ERROR: %d", payload[0])
            else:
                _LOGGER.error("Received ERROR")

        elif msg_type == MSG_PING:
            await self._send_message(MSG_PONG)

        else:
            _LOGGER.warning("Unknown message type: 0x%02X", msg_type)

    async def _ping_loop(self) -> None:
        """Send periodic pings."""
        try:
            while self._connected:
                await asyncio.sleep(PING_INTERVAL)
                if self._connected:
                    async with self._lock:
                        await self._send_message(MSG_PING)
        except asyncio.CancelledError:
            raise
        except Exception as err:
            _LOGGER.error("Ping error: %s", err)
