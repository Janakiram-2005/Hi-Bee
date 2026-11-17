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

# Calibrated VAD threshold bounds and noise adaptation defaults
DEFAULT_MIN_RMS_THRESHOLD       = 300.0   # minimum valid threshold
DEFAULT_MAX_RMS_THRESHOLD       = 5000.0  # maximum safe threshold
DEFAULT_CALIBRATION_MARGIN      = 150.0   # headroom above ambient noise floor
DEFAULT_CALIBRATION_MULTIPLIER  = 1.5     # safety multiplier for noise floor
SPEECH_FRAMES_TO_WAKE_CALIBRATED = 5      # debounced 150 ms window for calibrated environments


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
    Local-only voice activity detection firewall with dynamic noise floor
    calibration and gesture session focus protection.

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
    min_threshold : float, optional
        Lower bound for RMS speech threshold (default 300.0).
    max_threshold : float, optional
        Upper bound for RMS speech threshold (default 5000.0).
    speech_frames_to_wake : int, optional
        Consecutive speech frames required to wake (default SPEECH_FRAMES_TO_WAKE).
    """

    def __init__(
        self,
        on_wake_cb:         Callable[[], None],
        on_sleep_cb:        Callable[[], None],
        on_audio_chunk_cb:  Callable[[bytes], None],
        min_threshold:      float = DEFAULT_MIN_RMS_THRESHOLD,
        max_threshold:      float = DEFAULT_MAX_RMS_THRESHOLD,
        speech_frames_to_wake: int = SPEECH_FRAMES_TO_WAKE,
    ):
        self._on_wake         = on_wake_cb
        self._on_sleep        = on_sleep_cb
        self._on_audio_chunk  = on_audio_chunk_cb

        self._state           = VADState.SLEEPING
        self._state_lock      = threading.Lock()

        self._running         = False
        self._monitor_thread: Optional[threading.Thread] = None
        self._inactivity_timer: Optional[threading.Timer] = None

        # Calibration & threshold bounds configuration
        self._min_threshold: float = float(min_threshold)
        self._max_threshold: float = float(max_threshold)
        self._calibration_margin: float = DEFAULT_CALIBRATION_MARGIN
        self._calibration_multiplier: float = DEFAULT_CALIBRATION_MULTIPLIER
        self._noise_floor: float = 100.0  # initial ambient baseline
        self._rms_threshold: float = float(RMS_ENERGY_THRESHOLD)
        self._speech_frames_to_wake: int = max(1, int(speech_frames_to_wake))
        self._is_calibrated: bool = False

        # Gesture session focus lock
        self._gesture_focus_active: bool = False

        # VAD back-end selection
        self._vad: Optional["webrtcvad.Vad"] = None
        if _WEBRTCVAD_AVAILABLE:
            self._vad = webrtcvad.Vad(WEBRTCVAD_AGGRESSIVENESS)
            logger.info("[VADGatekeeper] Using webrtcvad (aggressiveness=%d).", WEBRTCVAD_AGGRESSIVENESS)
        else:
            logger.info("[VADGatekeeper] Using RMS energy threshold (%.1f).", self._rms_threshold)

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
    # Calibration & Gesture Session Focus API
    # ------------------------------------------------------------------

    @property
    def rms_threshold(self) -> float:
        """Currently configured or calibrated RMS speech threshold."""
        return self._rms_threshold

    @property
    def noise_floor(self) -> float:
        """Estimated or measured ambient background noise floor RMS."""
        return self._noise_floor

    @property
    def is_calibrated(self) -> bool:
        """Whether a formal ambient noise calibration has been executed."""
        return self._is_calibrated

    @property
    def speech_frames_to_wake(self) -> int:
        """Consecutive speech frames required to trigger wake."""
        return self._speech_frames_to_wake

    @speech_frames_to_wake.setter
    def speech_frames_to_wake(self, val: int) -> None:
        self._speech_frames_to_wake = max(1, int(val))

    @property
    def gesture_focus_active(self) -> bool:
        """Whether an active gesture navigation session currently holds input focus."""
        with self._state_lock:
            return self._gesture_focus_active

    def set_gesture_focus(self, active: bool) -> None:
        """
        Acquire or release gesture session focus.

        When active, VAD suppresses wake state transitions from speech/noise
        energy to prevent disruption and input instability during gesture sessions.
        """
        with self._state_lock:
            if self._gesture_focus_active == active:
                return
            self._gesture_focus_active = bool(active)

        logger.info(
            "[VADGatekeeper] Gesture session focus %s.",
            "ACQUIRED — VAD audio wake suppressed" if active else "RELEASED",
        )
        report_status("vad:gesture_focus", {"active": self._gesture_focus_active})

    def calibrate(
        self,
        samples: Optional[list[float]] = None,
        frames: Optional[list[bytes]] = None,
        noise_floor: Optional[float] = None,
        multiplier: Optional[float] = None,
        margin: Optional[float] = None,
        min_threshold: Optional[float] = None,
        max_threshold: Optional[float] = None,
    ) -> float:
        """
        Calibrate speech threshold bounds based on ambient background noise.

        Validates configured threshold bounds and prevents spurious state transitions
        caused by ambient background noise.
        """
        if min_threshold is not None:
            self._min_threshold = max(50.0, float(min_threshold))
        if max_threshold is not None:
            self._max_threshold = max(self._min_threshold, float(max_threshold))
        if multiplier is not None:
            self._calibration_multiplier = max(1.0, float(multiplier))
        if margin is not None:
            self._calibration_margin = max(0.0, float(margin))

        # Compute noise floor from provided frames, samples, or explicit value
        if noise_floor is not None:
            self._noise_floor = max(0.0, float(noise_floor))
        elif frames:
            rms_list = [self._compute_rms(f) for f in frames]
            valid = [r for r in rms_list if r is not None]
            if valid:
                self._noise_floor = float(sum(valid) / len(valid))
        elif samples:
            self._noise_floor = float(sum(samples) / max(len(samples), 1))

        # Enforce threshold calculation within configured bounds
        computed = (self._noise_floor * self._calibration_multiplier) + self._calibration_margin
        self._rms_threshold = max(self._min_threshold, min(self._max_threshold, computed))
        self._is_calibrated = True

        logger.info(
            "[VADGatekeeper] Calibrated: noise_floor=%.2f, rms_threshold=%.2f (bounds: [%.1f, %.1f]).",
            self._noise_floor,
            self._rms_threshold,
            self._min_threshold,
            self._max_threshold,
        )
        report_status("vad:calibrated", {
            "noise_floor": self._noise_floor,
            "threshold": self._rms_threshold,
            "min_threshold": self._min_threshold,
            "max_threshold": self._max_threshold,
        })
        return self._rms_threshold

    def _adapt_noise_floor(self, raw_chunk: bytes) -> None:
        """Smoothly track background noise floor during sleeping frames."""
        rms = self._compute_rms(raw_chunk)
        if rms is None or rms <= 0:
            return
        # Only adapt if chunk is reasonably quiet (below 80% of current threshold)
        if rms < self._rms_threshold * 0.8:
            alpha = 0.05
            self._noise_floor = (1.0 - alpha) * self._noise_floor + alpha * rms
            computed = (self._noise_floor * self._calibration_multiplier) + self._calibration_margin
            self._rms_threshold = max(self._min_threshold, min(self._max_threshold, computed))

    # ------------------------------------------------------------------
    # State transitions
    # ------------------------------------------------------------------

    @property
    def state(self) -> VADState:
        with self._state_lock:
            return self._state

    def _transition_to_listening(self, force: bool = False) -> bool:
        """
        Transition SLEEPING → LISTENING.

        Parameters
        ----------
        force : bool
            If True (e.g. manual hotkey), overrides active gesture session focus.
            If False (e.g. audio monitor loop), wake is suppressed while
            gesture session focus is active.

        Returns
        -------
        bool: True if transition occurred or already listening; False if suppressed.
        """
        with self._state_lock:
            if self._gesture_focus_active and not force:
                logger.info(
                    "[VADGatekeeper] ▶ Wake transition suppressed — active gesture session in focus."
                )
                report_status("vad:wake_suppressed", {"reason": "gesture_session_focus"})
                return False

            if self._state == VADState.LISTENING:
                return True
            self._state = VADState.LISTENING

        logger.info("[VADGatekeeper] ▶ Transition → STATE_LISTENING. Invoking on_wake callback.")
        try:
            self._on_wake()
        except Exception as exc:
            logger.error("[VADGatekeeper] on_wake_cb raised: %s", exc)

        self._reset_inactivity_timer()
        report_status("vad:wake")
        return True

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
        self._transition_to_listening(force=True)

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

            # Check if gesture session currently holds focus
            gesture_in_focus = self.gesture_focus_active
            if gesture_in_focus:
                consecutive_speech_frames = 0

            # ---- Speech / energy detection --------------------------------
            is_speech = self._detect_speech(raw_chunk)

            current_state = self.state

            if current_state == VADState.SLEEPING:
                if is_speech and not gesture_in_focus:
                    consecutive_speech_frames += 1
                    if consecutive_speech_frames >= self._speech_frames_to_wake:
                        logger.info(
                            "[VADGatekeeper] Speech energy detected across %d frames — waking.",
                            consecutive_speech_frames,
                        )
                        consecutive_speech_frames = 0
                        self._transition_to_listening(force=False)
                else:
                    consecutive_speech_frames = 0
                    if not is_speech:
                        self._adapt_noise_floor(raw_chunk)

            elif current_state == VADState.LISTENING:
                consecutive_speech_frames = 0
                # Forward raw PCM to the WebSocket sender
                try:
                    self._on_audio_chunk(raw_chunk)
                except Exception as exc:
                    logger.warning("[VADGatekeeper] on_audio_chunk_cb raised: %s", exc)

        self._close_audio_stream()
        logger.info("[VADGatekeeper] Audio monitor loop exited.")

    def _compute_rms(self, raw_chunk: bytes) -> Optional[float]:
        """Compute root-mean-square amplitude of 16-bit mono PCM bytes."""
        try:
            n_samples = len(raw_chunk) // SAMPLE_WIDTH
            if n_samples == 0:
                return 0.0
            samples = struct.unpack(f"<{n_samples}h", raw_chunk[:n_samples * SAMPLE_WIDTH])
            return math.sqrt(sum(s * s for s in samples) / max(n_samples, 1))
        except Exception:
            return None

    def _detect_speech(self, raw_chunk: bytes) -> bool:
        """
        Detect whether the audio frame contains speech.
        Prefers webrtcvad validated against calibrated noise floor; falls back to calibrated RMS energy threshold.
        """
        rms = self._compute_rms(raw_chunk)
        if rms is None:
            return False

        if self._vad is not None:
            try:
                vad_speech = self._vad.is_speech(raw_chunk, SAMPLE_RATE)
                if vad_speech and (not self._is_calibrated or rms > (self._noise_floor + 40.0)):
                    return True
                return False
            except Exception:
                pass  # fall through to RMS

        # Calibrated RMS energy fallback
        return rms > self._rms_threshold
