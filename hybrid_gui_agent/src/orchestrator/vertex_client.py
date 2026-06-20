"""
Module 2: Vertex AI Multimodal Live WebSocket Client
=====================================================
Implements a full-duplex bidirectional connection to the Vertex AI
Multimodal Live API using the BidiGenerateContent WebSocket protocol.

Key responsibilities
--------------------
1. Open / close the authenticated WSS connection on demand.
2. Transmit raw PCM audio chunks from the VAD gatekeeper.
3. Parse server messages and extract tool-call function calls.
4. Implement audio echo-safety lock: pause mic capture during TTS playback.
5. Forward parsed tool calls to the VerifiedQueue.

Environment variables
---------------------
  VERTEX_PROJECT_ID    — GCP project ID (required)
  VERTEX_LOCATION      — GCP region (default: us-central1)
  VERTEX_LIVE_MODEL    — Live API model (default: gemini-2.0-flash-live-001)
  GOOGLE_APPLICATION_CREDENTIALS — path to service-account JSON (optional; ADC used if absent)

Protocol notes
--------------
  Endpoint  : wss://{location}-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1beta1
               .LlmBidiService/BidiGenerateContent
  Auth      : Bearer token via google.auth (short-lived; refreshed before each connect)
  Message encoding: JSON over the WebSocket text frame channel.
"""

import asyncio
import base64
import json
import logging
import os
import threading
import time
from typing import Callable, Optional
from utils.status_reporter import report_status

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Optional imports
# ---------------------------------------------------------------------------
try:
    import websockets
    import websockets.exceptions
    _WEBSOCKETS_AVAILABLE = True
except ImportError:
    _WEBSOCKETS_AVAILABLE = False
    logger.error("[VertexLiveClient] 'websockets' package not installed. pip install websockets>=12.0")

try:
    import google.auth
    import google.auth.transport.requests
    _GOOGLE_AUTH_AVAILABLE = True
except ImportError:
    _GOOGLE_AUTH_AVAILABLE = False
    logger.error("[VertexLiveClient] 'google-auth' package not installed. pip install google-auth>=2.28.0")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
DEFAULT_LOCATION   = "us-central1"
DEFAULT_LIVE_MODEL = "gemini-2.0-flash-live-001"

# Audio format that matches VADGatekeeper output (must stay in sync)
AUDIO_SAMPLE_RATE  = 16_000   # Hz
AUDIO_CHANNELS     = 1
AUDIO_ENCODING     = "LINEAR16"

# Selective Attention System Instruction — the agent's core identity constraint
SYSTEM_INSTRUCTION = (
    "You are a native OS desktop caregiver assistant. "
    "You are listening to a continuous live audio stream. "
    "The user may be having casual conversations with friends or family in English, "
    "Telugu, Tamil, Kannada, or Hindi with various regional accents. "
    "CRITICAL RULE: DO NOT RESPOND to casual human-to-human conversation. "
    "Remain completely silent. "
    "ONLY respond or execute a tool if the user issues a direct imperative command "
    "explicitly meant for the computer (e.g., 'Open Notepad', 'Close Chrome', "
    "'Type this configuration'). "
    "If a direct command is identified, translate the intent instantly and execute "
    "the corresponding function call."
)

# Tool schemas advertised to the model
TOOL_DECLARATIONS = [
    {
        "name": "launch_application",
        "description": (
            "Launch a named application on the Windows desktop. "
            "Use when the user says 'Open X', 'Launch X', or 'Start X'."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "app_name": {
                    "type": "string",
                    "description": "The name of the application to launch (e.g., 'notepad', 'chrome', 'calculator').",
                }
            },
            "required": ["app_name"],
        },
    },
    {
        "name": "type_text_in_focused_window",
        "description": (
            "Type a string of text into the currently focused OS window. "
            "Use when the user says 'Type X', 'Write X', or 'Enter X'."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "text_to_type": {
                    "type": "string",
                    "description": "The exact text string to type into the active window.",
                }
            },
            "required": ["text_to_type"],
        },
    },
]


# ---------------------------------------------------------------------------
# VertexLiveClient
# ---------------------------------------------------------------------------
class VertexLiveClient:
    """
    Bidirectional Vertex AI Multimodal Live WebSocket client.

    Lifecycle
    ---------
    connect()   — Open WSS, send setup payload, begin reader/sender loops.
    disconnect()— Send clean close frame, cancel all tasks, nullify websocket.
    send_audio_chunk(bytes) — Thread-safe; enqueues 30 ms PCM chunk for async send.

    Callbacks
    ---------
    on_tool_call_cb(name: str, args: dict) -> None
        Fired for each tool-call function received from the model.
    on_activity_cb() -> None
        Fired whenever a valid tool call or audio output is received.
        Should call VADGatekeeper.notify_activity() to reset the idle timer.
    """

    def __init__(
        self,
        on_tool_call_cb:  Callable[[str, dict], None],
        on_activity_cb:   Callable[[], None],
        project_id:       Optional[str] = None,
        location:         Optional[str] = None,
        model_name:       Optional[str] = None,
    ):
        self._on_tool_call  = on_tool_call_cb
        self._on_activity   = on_activity_cb

        self._project_id    = project_id  or os.environ.get("VERTEX_PROJECT_ID", "")
        self._location      = location    or os.environ.get("VERTEX_LOCATION", DEFAULT_LOCATION)
        self._model_name    = model_name  or os.environ.get("VERTEX_LIVE_MODEL", DEFAULT_LIVE_MODEL)

        # Async internals
        self._loop:         Optional[asyncio.AbstractEventLoop] = None
        self._loop_thread:  Optional[threading.Thread]          = None
        self._ws:           Optional["websockets.WebSocketClientProtocol"] = None
        self._audio_queue:  Optional[asyncio.Queue]             = None
        self._reader_task:  Optional[asyncio.Task]              = None
        self._sender_task:  Optional[asyncio.Task]              = None

        # Echo safety lock — True while the model's TTS audio is playing back
        self._mic_paused    = False
        self._mic_pause_lock = threading.Lock()

        self._connected     = False

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def connect(self) -> None:
        """
        Open the WebSocket connection and begin streaming.
        Non-blocking: starts a dedicated asyncio event loop in a daemon thread.
        """
        if not _WEBSOCKETS_AVAILABLE or not _GOOGLE_AUTH_AVAILABLE:
            logger.error("[VertexLiveClient] Required packages missing. Cannot connect.")
            return

        if self._connected:
            logger.warning("[VertexLiveClient] Already connected. Ignoring connect() call.")
            return

        # Spin up an isolated event loop in a dedicated thread
        self._loop = asyncio.new_event_loop()
        self._loop_thread = threading.Thread(
            target=self._run_event_loop,
            name="VertexLive-EventLoop",
            daemon=True,
        )
        self._loop_thread.start()
        logger.info("[VertexLiveClient] Event loop thread started.")

    def disconnect(self) -> None:
        """
        Send a clean WebSocket close frame and stop all background tasks.
        """
        if not self._connected and self._loop is None:
            return

        logger.info("[VertexLiveClient] Initiating clean disconnect...")
        if self._loop and self._loop.is_running():
            future = asyncio.run_coroutine_threadsafe(self._async_disconnect(), self._loop)
            try:
                future.result(timeout=5.0)
            except Exception as exc:
                logger.warning("[VertexLiveClient] Disconnect future error: %s", exc)

        # Stop the event loop
        if self._loop:
            self._loop.call_soon_threadsafe(self._loop.stop)

        if self._loop_thread and self._loop_thread.is_alive():
            self._loop_thread.join(timeout=5.0)

        self._loop        = None
        self._loop_thread = None
        self._connected   = False
        logger.info("[VertexLiveClient] Disconnected.")

    def send_audio_chunk(self, pcm_bytes: bytes) -> None:
        """
        Thread-safe audio chunk submission.
        Call this from the VADGatekeeper's on_audio_chunk_cb.
        Drops the chunk silently if echo-safety lock is active.
        """
        with self._mic_pause_lock:
            if self._mic_paused:
                return  # Drop chunk — model is speaking, avoid echo

        if self._loop and self._loop.is_running() and self._audio_queue is not None:
            asyncio.run_coroutine_threadsafe(
                self._audio_queue.put(pcm_bytes),
                self._loop,
            )

    def notify_playback_complete(self) -> None:
        """Call this after the TTS audio output has finished playing to resume mic capture."""
        with self._mic_pause_lock:
            self._mic_paused = False
        logger.debug("[VertexLiveClient] Echo lock released — mic capture resumed.")
        report_status("ws:echo-lock", {"locked": False})

    # ------------------------------------------------------------------
    # Event loop runner
    # ------------------------------------------------------------------

    def _run_event_loop(self) -> None:
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._async_main())
        except Exception as exc:
            logger.error("[VertexLiveClient] Event loop error: %s", exc)
        finally:
            self._loop.close()
            logger.info("[VertexLiveClient] Event loop closed.")

    # ------------------------------------------------------------------
    # Async core
    # ------------------------------------------------------------------

    async def _async_main(self) -> None:
        """Connect, set up, and run reader + sender until disconnect is requested."""
        ws_uri  = self._build_ws_uri()
        headers = await self._build_auth_headers()

        logger.info("[VertexLiveClient] Connecting to: %s", ws_uri)
        had_connected = False
        try:
            async with websockets.connect(
                ws_uri,
                additional_headers=headers,
                max_size=None,          # allow large audio frames
                ping_interval=20,
                ping_timeout=10,
            ) as ws:
                self._ws         = ws
                self._connected  = True
                self._audio_queue = asyncio.Queue(maxsize=200)

                logger.info("[VertexLiveClient] WebSocket connected. Sending setup payload...")
                await self._send_setup(ws)
                had_connected = True
                report_status("ws:connected", {"model": self._model_name})

                # Launch concurrent reader and sender coroutines
                self._reader_task = asyncio.create_task(self._reader_loop(ws))
                self._sender_task = asyncio.create_task(self._sender_loop(ws))

                done, pending = await asyncio.wait(
                    [self._reader_task, self._sender_task],
                    return_when=asyncio.FIRST_EXCEPTION,
                )

                for task in pending:
                    task.cancel()
                    try:
                        await task
                    except asyncio.CancelledError:
                        pass

                # Surface any unhandled exception from completed tasks
                for task in done:
                    if task.exception():
                        logger.error("[VertexLiveClient] Task ended with exception: %s", task.exception())

        except websockets.exceptions.ConnectionClosed as exc:
            logger.warning("[VertexLiveClient] Connection closed: %s", exc)
            if had_connected:
                report_status("ws:closed")
                had_connected = False
        except Exception as exc:
            logger.error("[VertexLiveClient] WebSocket connection failed: %s", exc)
            report_status("ws:error", {"error": str(exc)})
        finally:
            if self._connected or had_connected:
                report_status("ws:closed")
            self._ws        = None
            self._connected = False

    async def _async_disconnect(self) -> None:
        """Cancel tasks and close the WebSocket from within the event loop."""
        for task in (self._reader_task, self._sender_task):
            if task and not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

        if self._ws and not self._ws.closed:
            await self._ws.close()

    # ------------------------------------------------------------------
    # Setup payload
    # ------------------------------------------------------------------

    async def _send_setup(self, ws: "websockets.WebSocketClientProtocol") -> None:
        """
        Send the BidiGenerateContentSetup message as the first frame.
        Includes the system instruction and declared tool schemas.
        """
        setup_payload = {
            "setup": {
                "model": f"publishers/google/models/{self._model_name}",
                "generation_config": {
                    "response_modalities": ["AUDIO", "TEXT"],
                    "speech_config": {
                        "voice_config": {
                            "prebuilt_voice_config": {
                                "voice_name": "Aoede"
                            }
                        }
                    }
                },
                "system_instruction": {
                    "parts": [{"text": SYSTEM_INSTRUCTION}]
                },
                "tools": [{"function_declarations": TOOL_DECLARATIONS}],
                "input_audio_transcription": {},
                "output_audio_transcription": {},
                "realtime_input_config": {
                    "automatic_activity_detection": {
                        "disabled": True   # We handle VAD ourselves via VADGatekeeper
                    }
                }
            }
        }
        await ws.send(json.dumps(setup_payload))
        logger.info("[VertexLiveClient] Setup payload sent.")

        # Wait for setupComplete acknowledgement
        ack_raw = await asyncio.wait_for(ws.recv(), timeout=10.0)
        ack = json.loads(ack_raw)
        if "setupComplete" in ack:
            logger.info("[VertexLiveClient] Setup acknowledged by server.")
        else:
            logger.warning("[VertexLiveClient] Unexpected first server message: %s", ack_raw[:200])

    # ------------------------------------------------------------------
    # Sender loop — audio chunks → WebSocket
    # ------------------------------------------------------------------

    async def _sender_loop(self, ws: "websockets.WebSocketClientProtocol") -> None:
        """
        Continuously dequeues raw PCM chunks and sends them as base64-encoded
        BidiGenerateContentClientContent messages.
        """
        logger.info("[VertexLiveClient] Audio sender loop started.")
        while True:
            try:
                pcm_bytes: bytes = await self._audio_queue.get()
                b64_audio = base64.b64encode(pcm_bytes).decode("utf-8")

                message = {
                    "realtimeInput": {
                        "mediaChunks": [
                            {
                                "mimeType": f"audio/pcm;rate={AUDIO_SAMPLE_RATE}",
                                "data": b64_audio,
                            }
                        ]
                    }
                }
                await ws.send(json.dumps(message))

            except asyncio.CancelledError:
                logger.info("[VertexLiveClient] Sender loop cancelled.")
                raise
            except Exception as exc:
                logger.error("[VertexLiveClient] Sender loop error: %s", exc)
                await asyncio.sleep(0.1)

    # ------------------------------------------------------------------
    # Reader loop — server messages → tool calls / audio output
    # ------------------------------------------------------------------

    async def _reader_loop(self, ws: "websockets.WebSocketClientProtocol") -> None:
        """
        Continuously receives server messages and dispatches:
        - Tool call function calls → on_tool_call_cb
        - Audio output chunks     → echo-safety lock + playback
        - Text turns              → logged
        """
        logger.info("[VertexLiveClient] Server reader loop started.")
        while True:
            try:
                raw = await ws.recv()
                await self._handle_server_message(json.loads(raw))

            except asyncio.CancelledError:
                logger.info("[VertexLiveClient] Reader loop cancelled.")
                raise
            except websockets.exceptions.ConnectionClosed:
                logger.warning("[VertexLiveClient] Server closed connection.")
                raise
            except json.JSONDecodeError as exc:
                logger.warning("[VertexLiveClient] JSON decode error: %s", exc)
            except Exception as exc:
                logger.error("[VertexLiveClient] Reader loop error: %s", exc)
                await asyncio.sleep(0.05)

    async def _handle_server_message(self, msg: dict) -> None:
        """
        Route a parsed server message to the appropriate handler.

        Vertex Live API server message shapes:
        - serverContent.modelTurn.parts[].functionCall  → tool invocation
        - serverContent.modelTurn.parts[].inlineData    → audio output chunk
        - serverContent.modelTurn.parts[].text          → text response
        - toolCallCancellation                          → cancelled pending calls
        """
        server_content = msg.get("serverContent")
        if not server_content:
            # Could be a setupComplete or other control message
            return

        model_turn = server_content.get("modelTurn", {})
        parts      = model_turn.get("parts", [])

        for part in parts:
            # ---- Tool / function call ----------------------------------------
            func_call = part.get("functionCall")
            if func_call:
                name = func_call.get("name", "")
                args = func_call.get("args", {})
                logger.info(
                    "[VertexLiveClient] Tool call received: %s(%s)", name, json.dumps(args)
                )
                # Notify activity to reset inactivity timer in VADGatekeeper
                try:
                    self._on_activity()
                except Exception:
                    pass
                # Forward to execution queue
                try:
                    self._on_tool_call(name, args)
                except Exception as exc:
                    logger.error("[VertexLiveClient] on_tool_call_cb error: %s", exc)
                continue

            # ---- Audio output (TTS from model) ---------------------------------
            inline_data = part.get("inlineData")
            if inline_data and inline_data.get("mimeType", "").startswith("audio/"):
                audio_b64 = inline_data.get("data", "")
                if audio_b64:
                    # Engage echo-safety lock before handing off to playback
                    with self._mic_pause_lock:
                        self._mic_paused = True
                    logger.debug("[VertexLiveClient] Echo lock engaged — model audio output received.")
                    report_status("ws:echo-lock", {"locked": True})
                    try:
                        self._on_activity()
                    except Exception:
                        pass
                    # Decode and play (fire-and-forget in background thread)
                    audio_bytes = base64.b64decode(audio_b64)
                    threading.Thread(
                        target=self._play_audio_and_release_lock,
                        args=(audio_bytes,),
                        daemon=True,
                    ).start()
                continue

            # ---- Text output ---------------------------------------------------
            text = part.get("text")
            if text:
                logger.info("[VertexLiveClient] Model text output: %s", text.strip()[:200])

    # ------------------------------------------------------------------
    # Audio playback (echo-safety)
    # ------------------------------------------------------------------

    def _play_audio_and_release_lock(self, audio_bytes: bytes) -> None:
        """
        Play TTS audio bytes through the default output device.
        Releases the echo-safety mic pause lock when complete.
        """
        try:
            import pyaudio  # imported here to avoid circular dependency at module level
            pa = pyaudio.PyAudio()
            # Vertex Live returns audio/pcm;rate=24000 for output
            OUTPUT_RATE = 24_000
            stream = pa.open(
                format=pyaudio.paInt16,
                channels=1,
                rate=OUTPUT_RATE,
                output=True,
            )
            CHUNK = 1024
            offset = 0
            while offset < len(audio_bytes):
                chunk = audio_bytes[offset:offset + CHUNK]
                stream.write(chunk)
                offset += CHUNK
            stream.stop_stream()
            stream.close()
            pa.terminate()
        except Exception as exc:
            logger.warning("[VertexLiveClient] Audio playback error: %s", exc)
        finally:
            self.notify_playback_complete()

    # ------------------------------------------------------------------
    # Auth helpers
    # ------------------------------------------------------------------

    def _build_ws_uri(self) -> str:
        return (
            f"wss://{self._location}-aiplatform.googleapis.com"
            "/ws/google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent"
        )

    async def _build_auth_headers(self) -> dict:
        """
        Obtain a short-lived Bearer token using Google Application Default Credentials
        or a service-account JSON key (GOOGLE_APPLICATION_CREDENTIALS).
        """
        if not _GOOGLE_AUTH_AVAILABLE:
            raise RuntimeError("google-auth is not installed.")

        try:
            credentials, _ = google.auth.default(
                scopes=["https://www.googleapis.com/auth/cloud-platform"]
            )
            # Refresh synchronously (acceptable at connection time, not in hot path)
            request = google.auth.transport.requests.Request()
            credentials.refresh(request)
            token = credentials.token
            return {
                "Authorization": f"Bearer {token}",
                "x-goog-user-project": self._project_id,
            }
        except Exception as exc:
            raise RuntimeError(f"[VertexLiveClient] Auth failed: {exc}") from exc
