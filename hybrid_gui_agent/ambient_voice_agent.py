"""
ambient_voice_agent.py — Root Entry Point
==========================================
Wires all four ambient voice assistant modules into a single,
persistent background process.

Pipeline
--------
  VADGatekeeper ──[wake]──► VertexLiveClient.connect()
                             │  VertexLiveClient feeds audio from VADGatekeeper
                             │  VertexLiveClient tool calls ──► VerifiedQueue.enqueue_action()
                            [sleep]──► VertexLiveClient.disconnect()
  VerifiedQueue worker ──► DOMDriver (type_text / launch_app)

Usage
-----
  python ambient_voice_agent.py [--debug]

Environment Variables (required)
---------------------------------
  VERTEX_PROJECT_ID          — Your GCP project ID
  VERTEX_LOCATION            — e.g. us-central1 (default)
  VERTEX_LIVE_MODEL          — e.g. gemini-2.0-flash-live-001 (default)
  GOOGLE_APPLICATION_CREDENTIALS — path to SA key JSON (optional; uses ADC if absent)

Press Ctrl+C to stop gracefully.
"""

import argparse
import asyncio
import logging
import os
import signal
import sys
import threading

# Ensure src/ is on the Python path regardless of CWD
_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
_SRC_DIR  = os.path.join(_BASE_DIR, "src")
if _SRC_DIR not in sys.path:
    sys.path.insert(0, _SRC_DIR)

from audio.vad_gatekeeper      import VADGatekeeper
from orchestrator.vertex_client import VertexLiveClient
from orchestrator.verified_queue import VerifiedQueue
from os_dom_engine.dom_driver   import DOMDriver


# ---------------------------------------------------------------------------
# Logging configuration
# ---------------------------------------------------------------------------

def configure_logging(debug: bool = False) -> None:
    level = logging.DEBUG if debug else logging.INFO
    fmt   = "[%(asctime)s] [%(levelname)-5s] %(name)s: %(message)s"
    logging.basicConfig(
        level=level,
        format=fmt,
        datefmt="%H:%M:%S",
        handlers=[logging.StreamHandler(sys.stdout)],
    )


# ---------------------------------------------------------------------------
# AmbientVoiceAgent — top-level orchestrator
# ---------------------------------------------------------------------------

class AmbientVoiceAgent:
    """
    Wires VADGatekeeper ↔ VertexLiveClient ↔ VerifiedQueue ↔ DOMDriver.
    Manages lifecycle: start, stop, and clean shutdown on Ctrl+C / SIGTERM.
    """

    def __init__(self):
        self._logger = logging.getLogger("AmbientVoiceAgent")

        # Instantiate the execution stack bottom-up
        self._dom_driver      = DOMDriver()
        self._verified_queue  = VerifiedQueue(dom_driver=self._dom_driver)

        # VertexLiveClient callbacks
        self._vertex_client   = VertexLiveClient(
            on_tool_call_cb  = self._on_tool_call,
            on_activity_cb   = self._on_activity,
        )

        # VADGatekeeper callbacks
        self._gatekeeper      = VADGatekeeper(
            on_wake_cb        = self._on_wake,
            on_sleep_cb       = self._on_sleep,
            on_audio_chunk_cb = self._on_audio_chunk,
        )

        self._running = False

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self) -> None:
        self._running = True
        self._logger.info("=" * 60)
        self._logger.info("  Ambient Voice Assistant — Starting")
        self._logger.info("  Project : %s", os.environ.get("VERTEX_PROJECT_ID", "<not set>"))
        self._logger.info("  Region  : %s", os.environ.get("VERTEX_LOCATION", "us-central1"))
        self._logger.info("  Model   : %s", os.environ.get("VERTEX_LIVE_MODEL", "gemini-2.0-flash-live-001"))
        self._logger.info("=" * 60)
        self._logger.info("  Wake trigger : Alt+Space  |  Speech energy threshold")
        self._logger.info("  Sleep trigger: 180s inactivity")
        self._logger.info("  Press Ctrl+C to stop.")
        self._logger.info("=" * 60)

        # Start the VAD monitor — this spins up the microphone daemon thread
        self._gatekeeper.start()
        self._logger.info("[Agent] VAD Gatekeeper active. Currently SLEEPING — monitoring locally.")

    def stop(self) -> None:
        self._logger.info("[Agent] Shutting down...")
        self._running = False

        # Stop gatekeeper first — stops audio monitor
        self._gatekeeper.stop()

        # Disconnect WebSocket if still connected
        self._vertex_client.disconnect()

        # Stop the VerifiedQueue worker
        self._verified_queue.stop_worker()

        self._logger.info("[Agent] Clean shutdown complete.")

    def wait(self) -> None:
        """Block the main thread until a SIGINT/SIGTERM is received."""
        stop_event = threading.Event()

        def _signal_handler(sig, frame):
            self._logger.info("\n[Agent] Signal %s received. Stopping...", sig)
            stop_event.set()

        signal.signal(signal.SIGINT,  _signal_handler)
        signal.signal(signal.SIGTERM, _signal_handler)

        stop_event.wait()   # blocks until Ctrl+C
        self.stop()

    # ------------------------------------------------------------------
    # VADGatekeeper callbacks
    # ------------------------------------------------------------------

    def _on_wake(self) -> None:
        """Called when gatekeeper transitions SLEEPING → LISTENING."""
        self._logger.info("[Agent] ▶ WAKE — Opening Vertex AI WebSocket...")
        self._vertex_client.connect()
        # The VerifiedQueue worker is started inside the VertexLiveClient's event loop.
        # We schedule it via the client's internal loop reference after it is running.
        # Give the loop a brief moment to start before registering the queue worker.
        threading.Timer(0.5, self._register_queue_worker).start()

    def _on_sleep(self) -> None:
        """Called when gatekeeper transitions LISTENING → SLEEPING."""
        self._logger.info("[Agent] ■ SLEEP — Closing Vertex AI WebSocket...")
        self._verified_queue.stop_worker()
        self._vertex_client.disconnect()

    def _on_audio_chunk(self, pcm_bytes: bytes) -> None:
        """Called for every 30 ms microphone frame while STATE_LISTENING."""
        self._vertex_client.send_audio_chunk(pcm_bytes)

    # ------------------------------------------------------------------
    # VertexLiveClient callbacks
    # ------------------------------------------------------------------

    def _on_tool_call(self, name: str, args: dict) -> None:
        """
        Called by VertexLiveClient when the model emits a function call.
        Immediately enqueues the action — never blocks the network reader.
        """
        self._logger.info("[Agent] Tool call received → %s(%s)", name, args)
        self._verified_queue.enqueue_action(name, args)

    def _on_activity(self) -> None:
        """Called by VertexLiveClient on any valid tool call or audio output."""
        self._gatekeeper.notify_activity()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _register_queue_worker(self) -> None:
        """
        Register the VerifiedQueue consumer inside the VertexLiveClient's asyncio loop.
        Called 0.5 s after wake to give the event loop time to start.
        """
        loop = self._vertex_client._loop
        if loop and loop.is_running():
            self._verified_queue.start_worker(loop)
            self._logger.info("[Agent] VerifiedQueue worker registered in event loop.")
        else:
            self._logger.warning(
                "[Agent] Could not register VerifiedQueue worker — event loop not ready yet."
            )


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Ambient Voice Desktop Assistant — Vertex AI Multimodal Live API"
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Enable verbose DEBUG logging.",
    )
    args = parser.parse_args()

    configure_logging(debug=args.debug)

    # Validate essential environment
    if not os.environ.get("VERTEX_PROJECT_ID"):
        logging.warning(
            "[Startup] VERTEX_PROJECT_ID not set. "
            "Set this env var or ensure Application Default Credentials are configured."
        )

    agent = AmbientVoiceAgent()
    agent.start()
    agent.wait()   # blocks until Ctrl+C / SIGTERM


if __name__ == "__main__":
    main()
