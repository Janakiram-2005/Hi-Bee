"""
Module 1: Local Voice Activity Detection & Sleep State Controller
=================================================================
Acts as a zero-cost firewall for cloud WebSocket transactions.

States
------
STATE_SLEEPING  – Microphone is monitored locally only; cloud WS is closed ($0 token cost).
STATE_LISTENING – Cloud WS is alive; raw PCM chunks are forwarded to VertexLiveClient.

Wake triggers
-------------
  1. Global hotkey Alt+Space.
  2. Audio energy exceeds RMS_ENERGY_THRESHOLD (or webrtcvad detects speech).

Sleep trigger
-------------
  Inactivity timer: 180 s without a valid tool-call event or agent voice output → clean
  WS close frame + graceful revert to STATE_SLEEPING.

Public API
----------
  gk = VADGatekeeper(on_wake_cb, on_sleep_cb, on_audio_chunk_cb)
  gk.start()            # begin monitoring
  gk.stop()             # clean shutdown
  gk.notify_activity()  # called by VertexLiveClient to reset inactivity timer
"""

import math
import struct
import logging
import threading
import time
from enum import Enum, auto
from typing import Callable, Optional
from utils.status_reporter import report_status

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Optional imports – degrade gracefully when packages are absent
# ---------------------------------------------------------------------------
try:
    import pyaudio
    _PYAUDIO_AVAILABLE = True
except ImportError:
    _PYAUDIO_AVAILABLE = False
    logger.warning("[VADGatekeeper] pyaudio not installed. Audio capture disabled.")

try:
    import webrtcvad
    _WEBRTCVAD_AVAILABLE = True
except ImportError:
    _WEBRTCVAD_AVAILABLE = False
    logger.info("[VADGatekeeper] webrtcvad not installed. Falling back to RMS energy threshold.")

try:
    import keyboard
    _KEYBOARD_AVAILABLE = True
except ImportError:
    _KEYBOARD_AVAILABLE = False
    logger.warning("[VADGatekeeper] keyboard library not installed. Hotkey wake trigger disabled.")


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
SAMPLE_RATE          = 16_000   # Hz — required by webrtcvad & Vertex Live API
CHANNELS             = 1
SAMPLE_WIDTH         = 2        # bytes (16-bit PCM)
FRAME_DURATION_MS    = 30       # ms — webrtcvad accepts 10 / 20 / 30 ms frames
FRAME_SIZE           = int(SAMPLE_RATE * FRAME_DURATION_MS / 1000)  # samples per frame
CHUNK_BYTES          = FRAME_SIZE * SAMPLE_WIDTH

RMS_ENERGY_THRESHOLD = 300      # raw RMS amplitude (~1 % of int16 max); tune per mic
INACTIVITY_TIMEOUT_S = 180      # seconds until forced sleep
WAKE_HOTKEY          = "alt+space"

WEBRTCVAD_AGGRESSIVENESS = 2    # 0 (least) … 3 (most) aggressive speech filtering
SPEECH_FRAMES_TO_WAKE    = 3    # consecutive speech frames required to wake (~90 ms debounce)


# ---------------------------------------------------------------------------
# State enum
# ---------------------------------------------------------------------------
class VADState(Enum):
    SLEEPING  = auto()
    LISTENING = auto()


# ---------------------------------------------------------------------------
# VADGatekeeper
# ---------------------------------------------------------------------------
class VADGatekeeper:
    """
    Local-only voice activity detection firewall.

    Parameters
    ----------
    on_wake_cb : () -> None
        Called when transitioning SLEEPING → LISTENING.
        The caller should open the cloud WebSocket here.
    on_sleep_cb : () -> None
        Called when transitioning LISTENING → SLEEPING.
        The caller should close the cloud WebSocket here.
    on_audio_chunk_cb : (bytes) -> None
        Called for every 30 ms PCM chunk *only* while STATE_LISTENING.
        Forward these bytes directly to the WebSocket audio sender.
    """

    def __init__(
        self,
        on_wake_cb:         Callable[[], None],
        on_sleep_cb:        Callable[[], None],
        on_audio_chunk_cb:  Callable[[bytes], None],
    ):
        self._on_wake         = on_wake_cb
        self._on_sleep        = on_sleep_cb
        self._on_audio_chunk  = on_audio_chunk_cb

        self._state           = VADState.SLEEPING
        self._state_lock      = threading.Lock()

        self._running         = False
        self._monitor_thread: Optional[threading.Thread] = None
        self._inactivity_timer: Optional[threading.Timer] = None

        # VAD back-end selection
        self._vad: Optional["webrtcvad.Vad"] = None
        if _WEBRTCVAD_AVAILABLE:
            self._vad = webrtcvad.Vad(WEBRTCVAD_AGGRESSIVENESS)
            logger.info("[VADGatekeeper] Using webrtcvad (aggressiveness=%d).", WEBRTCVAD_AGGRESSIVENESS)
        else:
            logger.info("[VADGatekeeper] Using RMS energy threshold (%d).", RMS_ENERGY_THRESHOLD)

        # PyAudio stream handle
        self._pa_instance: Optional["pyaudio.PyAudio"] = None
        self._pa_stream:   Optional["pyaudio.Stream"]   = None

    # ------------------------------------------------------------------
    # Public lifecycle
    # ------------------------------------------------------------------

    def start(self) -> None:
        """Begin monitoring. Non-blocking — spins up a daemon thread."""
        if not _PYAUDIO_AVAILABLE:
            logger.error("[VADGatekeeper] Cannot start: pyaudio is not installed.")
            return

        self._running = True
        self._monitor_thread = threading.Thread(
            target=self._audio_monitor_loop,
            name="VAD-Monitor",
            daemon=True,
        )
        self._monitor_thread.start()

        if _KEYBOARD_AVAILABLE:
            keyboard.add_hotkey(WAKE_HOTKEY, self._hotkey_wake_handler, suppress=True)
            logger.info("[VADGatekeeper] Global hotkey '%s' registered for wake trigger.", WAKE_HOTKEY)
        else:
            logger.warning("[VADGatekeeper] Hotkey trigger unavailable (install 'keyboard' package).")

        logger.info("[VADGatekeeper] Started. State: %s.", self._state.name)

    def stop(self) -> None:
        """Cleanly shut down the monitor thread and release all resources."""
        self._running = False

        # Cancel any pending inactivity timer
        self._cancel_inactivity_timer()

        # Remove hotkey
        if _KEYBOARD_AVAILABLE:
            try:
                keyboard.remove_hotkey(WAKE_HOTKEY)
            except Exception:
                pass

        # Close PyAudio stream
        self._close_audio_stream()

        if self._monitor_thread and self._monitor_thread.is_alive():
            self._monitor_thread.join(timeout=3.0)

        logger.info("[VADGatekeeper] Stopped.")

    def notify_activity(self) -> None:
        """
        Reset the inactivity countdown.
        Call this every time a valid tool call or agent voice output is received.
        """
        self._reset_inactivity_timer()
        logger.debug("[VADGatekeeper] Activity notified — inactivity timer reset.")

    # ------------------------------------------------------------------
    # State transitions
    # ------------------------------------------------------------------

    @property
    def state(self) -> VADState:
        with self._state_lock:
            return self._state

    def _transition_to_listening(self) -> None:
        with self._state_lock:
            if self._state == VADState.LISTENING:
                return
            self._state = VADState.LISTENING

        logger.info("[VADGatekeeper] ▶ Transition → STATE_LISTENING. Invoking on_wake callback.")
        try:
            self._on_wake()
        except Exception as exc:
            logger.error("[VADGatekeeper] on_wake_cb raised: %s", exc)

        self._reset_inactivity_timer()
        report_status("vad:wake")

    def _transition_to_sleeping(self) -> None:
        with self._state_lock:
            if self._state == VADState.SLEEPING:
                return
            self._state = VADState.SLEEPING

        logger.info("[VADGatekeeper] ■ Transition → STATE_SLEEPING. Invoking on_sleep callback.")
        self._cancel_inactivity_timer()
        try:
            self._on_sleep()
        except Exception as exc:
            logger.error("[VADGatekeeper] on_sleep_cb raised: %s", exc)
        report_status("vad:sleep")

    # ------------------------------------------------------------------
    # Hotkey handler (called from keyboard library thread)
    # ------------------------------------------------------------------

    def _hotkey_wake_handler(self) -> None:
        logger.info("[VADGatekeeper] Hotkey '%s' pressed — forcing wake.", WAKE_HOTKEY)
        self._transition_to_listening()

    # ------------------------------------------------------------------
    # Inactivity timer helpers
    # ------------------------------------------------------------------

    def _reset_inactivity_timer(self) -> None:
        self._cancel_inactivity_timer()
        self._inactivity_timer = threading.Timer(
            INACTIVITY_TIMEOUT_S,
            self._inactivity_timeout_handler,
        )
        self._inactivity_timer.daemon = True
        self._inactivity_timer.start()

    def _cancel_inactivity_timer(self) -> None:
        if self._inactivity_timer is not None:
            self._inactivity_timer.cancel()
            self._inactivity_timer = None

    def _inactivity_timeout_handler(self) -> None:
        logger.info(
            "[VADGatekeeper] Inactivity timeout (%ds) reached — reverting to STATE_SLEEPING.",
            INACTIVITY_TIMEOUT_S,
        )
        self._transition_to_sleeping()

    # ------------------------------------------------------------------
    # Audio stream lifecycle
    # ------------------------------------------------------------------

    def _open_audio_stream(self) -> bool:
        """Open the PyAudio input stream. Returns True on success."""
        try:
            self._pa_instance = pyaudio.PyAudio()
            self._pa_stream = self._pa_instance.open(
                format=pyaudio.paInt16,
                channels=CHANNELS,
                rate=SAMPLE_RATE,
                input=True,
                frames_per_buffer=FRAME_SIZE,
            )
            logger.info(
                "[VADGatekeeper] PyAudio stream opened: %d Hz, %d-bit, mono, %d ms frames.",
                SAMPLE_RATE, SAMPLE_WIDTH * 8, FRAME_DURATION_MS,
            )
            return True
        except Exception as exc:
            logger.error("[VADGatekeeper] Failed to open audio stream: %s", exc)
            return False

    def _close_audio_stream(self) -> None:
        try:
            if self._pa_stream:
                self._pa_stream.stop_stream()
                self._pa_stream.close()
                self._pa_stream = None
            if self._pa_instance:
                self._pa_instance.terminate()
                self._pa_instance = None
        except Exception as exc:
            logger.warning("[VADGatekeeper] Error closing audio stream: %s", exc)

    # ------------------------------------------------------------------
    # Audio monitor loop (daemon thread)
    # ------------------------------------------------------------------

    def _audio_monitor_loop(self) -> None:
        """
        Continuously reads 30 ms PCM frames from the microphone.

        * Always running (even when SLEEPING) to detect speech energy.
        * Only forwards chunks to on_audio_chunk_cb when STATE_LISTENING.
        * Uses webrtcvad if available; otherwise falls back to RMS energy.
        """
        if not self._open_audio_stream():
            logger.error("[VADGatekeeper] Audio monitor loop aborted — stream open failed.")
            return

        logger.info("[VADGatekeeper] Audio monitor loop started.")
        consecutive_speech_frames = 0

        while self._running:
            try:
                raw_chunk: bytes = self._pa_stream.read(FRAME_SIZE, exception_on_overflow=False)
            except Exception as exc:
                logger.warning("[VADGatekeeper] Audio read error: %s", exc)
                time.sleep(0.05)
                continue

            # ---- Speech / energy detection --------------------------------
            is_speech = self._detect_speech(raw_chunk)

            current_state = self.state

            if current_state == VADState.SLEEPING:
                if is_speech:
                    consecutive_speech_frames += 1
                    if consecutive_speech_frames >= SPEECH_FRAMES_TO_WAKE:
                        logger.info(
                            "[VADGatekeeper] Speech energy detected across %d frames — waking.",
                            consecutive_speech_frames,
                        )
                        consecutive_speech_frames = 0
                        self._transition_to_listening()
                else:
                    consecutive_speech_frames = 0

            elif current_state == VADState.LISTENING:
                consecutive_speech_frames = 0
                # Forward raw PCM to the WebSocket sender
                try:
                    self._on_audio_chunk(raw_chunk)
                except Exception as exc:
                    logger.warning("[VADGatekeeper] on_audio_chunk_cb raised: %s", exc)

        self._close_audio_stream()
        logger.info("[VADGatekeeper] Audio monitor loop exited.")

    def _detect_speech(self, raw_chunk: bytes) -> bool:
        """
        Detect whether the audio frame contains speech.
        Prefers webrtcvad; falls back to RMS energy threshold.
        """
        if self._vad is not None:
            try:
                return self._vad.is_speech(raw_chunk, SAMPLE_RATE)
            except Exception:
                pass  # fall through to RMS

        # RMS energy fallback
        try:
            n_samples = len(raw_chunk) // SAMPLE_WIDTH
            samples   = struct.unpack(f"<{n_samples}h", raw_chunk[:n_samples * SAMPLE_WIDTH])
            rms = math.sqrt(sum(s * s for s in samples) / max(n_samples, 1))
            return rms > RMS_ENERGY_THRESHOLD
        except Exception:
            return False
