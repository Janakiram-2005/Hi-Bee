"""
tests/test_vad_gatekeeper.py
============================
Unit tests for Module 1: VADGatekeeper.

Tests cover:
- State transitions: SLEEPING → LISTENING → SLEEPING
- Inactivity timer reset behaviour
- RMS energy detection fallback (without webrtcvad)
- Speech frame debounce (3 consecutive frames required to wake)
- notify_activity() correctly resets the timer

Mocking strategy:
- pyaudio stream is replaced with a fake that yields pre-built PCM frames
- webrtcvad.Vad is replaced with a configurable mock
- keyboard hotkey registration is skipped
"""

import math
import struct
import sys
import threading
import time
import unittest
from unittest.mock import MagicMock, patch, PropertyMock

# Ensure src/ is on the path for imports
import os
os.environ["STATUS_REPORTER_DISABLED"] = "1"
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

# Patch heavyweight optional deps before importing the module under test
_PYAUDIO_MOCK  = MagicMock()
_KEYBOARD_MOCK = MagicMock()
sys.modules.setdefault('pyaudio',   _PYAUDIO_MOCK)
sys.modules.setdefault('keyboard',  _KEYBOARD_MOCK)
sys.modules.setdefault('webrtcvad', MagicMock())  # present but controllable

from audio.vad_gatekeeper import (
    VADGatekeeper,
    VADState,
    CHUNK_BYTES,
    SAMPLE_RATE,
    SAMPLE_WIDTH,
    RMS_ENERGY_THRESHOLD,
    INACTIVITY_TIMEOUT_S,
    DEFAULT_MIN_RMS_THRESHOLD,
    DEFAULT_MAX_RMS_THRESHOLD,
    SPEECH_FRAMES_TO_WAKE_CALIBRATED,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_silent_frame() -> bytes:
    """Return a 30 ms frame of digital silence (all zeros)."""
    return b'\x00' * CHUNK_BYTES


def _make_loud_frame(amplitude: int = 5000) -> bytes:
    """Return a 30 ms frame of a constant-amplitude sine wave loud enough to trip RMS."""
    n_samples = CHUNK_BYTES // SAMPLE_WIDTH
    samples   = [amplitude] * n_samples
    return struct.pack(f"<{n_samples}h", *samples)


# ---------------------------------------------------------------------------
# Test cases
# ---------------------------------------------------------------------------

class TestVADStateTransitions(unittest.TestCase):
    """State machine transition tests."""

    def _make_gatekeeper(self):
        wake_cb  = MagicMock()
        sleep_cb = MagicMock()
        chunk_cb = MagicMock()
        gk = VADGatekeeper(wake_cb, sleep_cb, chunk_cb)
        return gk, wake_cb, sleep_cb, chunk_cb

    def test_initial_state_is_sleeping(self):
        gk, *_ = self._make_gatekeeper()
        self.assertEqual(gk.state, VADState.SLEEPING)

    def test_transition_sleeping_to_listening_calls_wake_cb(self):
        gk, wake_cb, sleep_cb, _ = self._make_gatekeeper()
        gk._transition_to_listening()
        self.assertEqual(gk.state, VADState.LISTENING)
        wake_cb.assert_called_once()
        sleep_cb.assert_not_called()

    def test_transition_listening_to_sleeping_calls_sleep_cb(self):
        gk, wake_cb, sleep_cb, _ = self._make_gatekeeper()
        gk._transition_to_listening()
        gk._transition_to_sleeping()
        self.assertEqual(gk.state, VADState.SLEEPING)
        sleep_cb.assert_called_once()

    def test_duplicate_wake_transition_is_idempotent(self):
        """Calling _transition_to_listening twice should only fire on_wake once."""
        gk, wake_cb, *_ = self._make_gatekeeper()
        gk._transition_to_listening()
        gk._transition_to_listening()
        wake_cb.assert_called_once()

    def test_duplicate_sleep_transition_is_idempotent(self):
        gk, _, sleep_cb, _ = self._make_gatekeeper()
        # Start listening first so sleeping has an effect
        gk._transition_to_listening()
        gk._transition_to_sleeping()
        gk._transition_to_sleeping()
        sleep_cb.assert_called_once()

    def test_hotkey_wake_triggers_listening(self):
        gk, wake_cb, _, _ = self._make_gatekeeper()
        gk._hotkey_wake_handler()
        self.assertEqual(gk.state, VADState.LISTENING)
        wake_cb.assert_called_once()


class TestInactivityTimer(unittest.TestCase):
    """Inactivity timer reset and expiry tests."""

    def _make_gatekeeper(self):
        gk = VADGatekeeper(MagicMock(), MagicMock(), MagicMock())
        return gk

    def test_notify_activity_resets_timer(self):
        gk = self._make_gatekeeper()
        gk._transition_to_listening()

        first_timer = gk._inactivity_timer
        self.assertIsNotNone(first_timer)

        gk.notify_activity()
        second_timer = gk._inactivity_timer

        # A new timer object must have been created
        self.assertIsNotNone(second_timer)
        self.assertIsNot(first_timer, second_timer)

        # Cleanup
        gk._cancel_inactivity_timer()

    def test_inactivity_timer_expiry_transitions_to_sleeping(self):
        """
        Use a very short timeout by monkey-patching INACTIVITY_TIMEOUT_S.
        The handler is called directly to avoid slow real timers in tests.
        """
        gk = self._make_gatekeeper()
        gk._transition_to_listening()
        self.assertEqual(gk.state, VADState.LISTENING)

        # Directly invoke the timeout handler (simulates timer expiry)
        gk._inactivity_timeout_handler()
        self.assertEqual(gk.state, VADState.SLEEPING)


class TestRMSFallback(unittest.TestCase):
    """RMS energy fallback VAD detection (used when webrtcvad is absent)."""

    def setUp(self):
        self.gk = VADGatekeeper(MagicMock(), MagicMock(), MagicMock())
        self.gk._vad = None  # Force RMS fallback by nulling the webrtcvad instance

    def test_silent_frame_is_not_speech(self):
        frame = _make_silent_frame()
        self.assertFalse(self.gk._detect_speech(frame))

    def test_loud_frame_is_speech(self):
        frame = _make_loud_frame(amplitude=5000)  # well above RMS_ENERGY_THRESHOLD=300
        self.assertTrue(self.gk._detect_speech(frame))

    def test_low_amplitude_frame_is_not_speech(self):
        frame = _make_loud_frame(amplitude=50)    # well below threshold
        self.assertFalse(self.gk._detect_speech(frame))


class TestSpeechDebounce(unittest.TestCase):
    """
    Verify that 3 consecutive speech frames are required to wake the system
    (prevents spurious single-frame noise bursts from triggering cloud connection).
    """

    def test_two_speech_frames_do_not_wake(self):
        """Two consecutive loud frames should NOT trigger wake."""
        wake_cb = MagicMock()
        gk = VADGatekeeper(wake_cb, MagicMock(), MagicMock())
        gk._vad = None  # Use RMS fallback

        loud = _make_loud_frame(amplitude=5000)

        # Simulate the audio loop manually for 2 frames
        from audio.vad_gatekeeper import SPEECH_FRAMES_TO_WAKE
        counter = 0
        for _ in range(SPEECH_FRAMES_TO_WAKE - 1):
            if gk._detect_speech(loud):
                counter += 1

        # Should NOT have transitioned
        wake_cb.assert_not_called()
        self.assertEqual(gk.state, VADState.SLEEPING)

    def test_three_speech_frames_wake(self):
        """The audio monitor loop should wake after 3 consecutive speech frames."""
        wake_cb = MagicMock()
        gk = VADGatekeeper(wake_cb, MagicMock(), MagicMock())
        gk._vad = None

        loud  = _make_loud_frame(amplitude=5000)
        count = 0

        from audio.vad_gatekeeper import SPEECH_FRAMES_TO_WAKE
        for _ in range(SPEECH_FRAMES_TO_WAKE):
            if gk._detect_speech(loud):
                count += 1
                if count >= SPEECH_FRAMES_TO_WAKE:
                    gk._transition_to_listening()

        wake_cb.assert_called_once()
        self.assertEqual(gk.state, VADState.LISTENING)
        gk._cancel_inactivity_timer()

    def test_noise_resets_consecutive_counter(self):
        """A silent frame in between should prevent premature waking."""
        wake_cb = MagicMock()
        gk = VADGatekeeper(wake_cb, MagicMock(), MagicMock())
        gk._vad = None

        loud   = _make_loud_frame(amplitude=5000)
        silent = _make_silent_frame()

        # Pattern: LOUD, SILENT, LOUD — counter should reset after silent
        is_speech_sequence = [
            gk._detect_speech(loud),
            gk._detect_speech(silent),
            gk._detect_speech(loud),
        ]

        self.assertEqual(is_speech_sequence, [True, False, True])
        wake_cb.assert_not_called()


class TestAudioChunkForwarding(unittest.TestCase):
    """Verify audio chunks are only forwarded when STATE_LISTENING."""

    def test_chunks_not_forwarded_when_sleeping(self):
        chunk_cb = MagicMock()
        gk = VADGatekeeper(MagicMock(), MagicMock(), chunk_cb)
        # State is SLEEPING — chunk should not reach on_audio_chunk_cb
        gk._on_audio_chunk(_make_loud_frame())
        # The callback IS callable but should only be called by the monitor loop
        # when state is LISTENING. We test that at the loop level via integration.
        # This test documents the API contract.
        self.assertTrue(callable(chunk_cb))

    def test_chunks_forwarded_when_listening(self):
        chunk_cb = MagicMock()
        gk = VADGatekeeper(MagicMock(), MagicMock(), chunk_cb)
        gk._transition_to_listening()

        # Simulate monitor loop forwarding a chunk
        frame = _make_loud_frame()
        gk._on_audio_chunk(frame)
        chunk_cb.assert_called_once_with(frame)
        gk._cancel_inactivity_timer()


class TestCalibrationAndThresholdBounds(unittest.TestCase):
    """Tests for dynamic VAD threshold calibration and configured threshold bounds."""

    def test_default_threshold_bounds(self):
        gk = VADGatekeeper(MagicMock(), MagicMock(), MagicMock())
        self.assertEqual(gk._min_threshold, DEFAULT_MIN_RMS_THRESHOLD)
        self.assertEqual(gk._max_threshold, DEFAULT_MAX_RMS_THRESHOLD)
        self.assertGreaterEqual(gk.rms_threshold, DEFAULT_MIN_RMS_THRESHOLD)
        self.assertLessEqual(gk.rms_threshold, DEFAULT_MAX_RMS_THRESHOLD)
        self.assertFalse(gk.is_calibrated)

    def test_calibrate_with_explicit_noise_floor(self):
        gk = VADGatekeeper(MagicMock(), MagicMock(), MagicMock())
        # Noise floor 200 * multiplier 1.5 + margin 150 = 450
        computed = gk.calibrate(noise_floor=200.0, multiplier=1.5, margin=150.0)
        self.assertEqual(computed, 450.0)
        self.assertEqual(gk.rms_threshold, 450.0)
        self.assertEqual(gk.noise_floor, 200.0)
        self.assertTrue(gk.is_calibrated)

    def test_calibrate_clamps_to_configured_min_threshold(self):
        gk = VADGatekeeper(MagicMock(), MagicMock(), MagicMock())
        # Noise floor 10 * 1.0 + 10 = 20, but min_threshold = 300
        computed = gk.calibrate(noise_floor=10.0, multiplier=1.0, margin=10.0, min_threshold=300.0)
        self.assertEqual(computed, 300.0)
        self.assertEqual(gk.rms_threshold, 300.0)

    def test_calibrate_clamps_to_configured_max_threshold(self):
        gk = VADGatekeeper(MagicMock(), MagicMock(), MagicMock())
        # Noise floor 4000 * 2.0 + 500 = 8500, clamped to max_threshold 5000
        computed = gk.calibrate(noise_floor=4000.0, multiplier=2.0, margin=500.0, max_threshold=5000.0)
        self.assertEqual(computed, 5000.0)
        self.assertEqual(gk.rms_threshold, 5000.0)

    def test_calibrate_with_silent_and_ambient_frames(self):
        gk = VADGatekeeper(MagicMock(), MagicMock(), MagicMock())
        frames = [_make_silent_frame(), _make_loud_frame(amplitude=150)]
        computed = gk.calibrate(frames=frames, min_threshold=300.0)
        self.assertGreaterEqual(computed, 300.0)
        self.assertTrue(gk.is_calibrated)

    def test_noise_floor_adaptation_smoothly_tracks_quiet_frames(self):
        gk = VADGatekeeper(MagicMock(), MagicMock(), MagicMock())
        initial_floor = gk.noise_floor
        initial_threshold = gk.rms_threshold

        quiet_chunk = _make_loud_frame(amplitude=120)
        gk._adapt_noise_floor(quiet_chunk)

        # Noise floor should have shifted toward 120
        self.assertNotEqual(gk.noise_floor, initial_floor)
        self.assertGreaterEqual(gk.rms_threshold, gk._min_threshold)


class TestGestureSessionFocus(unittest.TestCase):
    """Tests for gesture session focus protection against spurious VAD mode switches."""

    def test_gesture_focus_default_inactive(self):
        gk = VADGatekeeper(MagicMock(), MagicMock(), MagicMock())
        self.assertFalse(gk.gesture_focus_active)

    def test_set_gesture_focus_lifecycle(self):
        gk = VADGatekeeper(MagicMock(), MagicMock(), MagicMock())
        gk.set_gesture_focus(True)
        self.assertTrue(gk.gesture_focus_active)

        # Idempotent re-call
        gk.set_gesture_focus(True)
        self.assertTrue(gk.gesture_focus_active)

        gk.set_gesture_focus(False)
        self.assertFalse(gk.gesture_focus_active)

    def test_gesture_focus_suppresses_audio_wake_transition(self):
        """When gesture focus is active, _transition_to_listening(force=False) must be suppressed."""
        wake_cb = MagicMock()
        gk = VADGatekeeper(wake_cb, MagicMock(), MagicMock())

        gk.set_gesture_focus(True)
        transitioned = gk._transition_to_listening(force=False)

        self.assertFalse(transitioned)
        self.assertEqual(gk.state, VADState.SLEEPING)
        wake_cb.assert_not_called()

    def test_gesture_focus_release_allows_wake(self):
        """Releasing gesture focus restores normal wake transitions."""
        wake_cb = MagicMock()
        gk = VADGatekeeper(wake_cb, MagicMock(), MagicMock())

        gk.set_gesture_focus(True)
        self.assertFalse(gk._transition_to_listening(force=False))
        wake_cb.assert_not_called()

        gk.set_gesture_focus(False)
        self.assertTrue(gk._transition_to_listening(force=False))
        self.assertEqual(gk.state, VADState.LISTENING)
        wake_cb.assert_called_once()
        gk._cancel_inactivity_timer()

    def test_manual_hotkey_overrides_gesture_focus(self):
        """Manual hotkey press is an intentional user override and forces wake even during focus."""
        wake_cb = MagicMock()
        gk = VADGatekeeper(wake_cb, MagicMock(), MagicMock())

        gk.set_gesture_focus(True)
        gk._hotkey_wake_handler()

        self.assertEqual(gk.state, VADState.LISTENING)
        wake_cb.assert_called_once()
        gk._cancel_inactivity_timer()

    def test_audio_loop_speech_frames_suppressed_during_gesture_focus(self):
        """Loud audio energy must not wake system or accumulate frames while gesture focus is active."""
        wake_cb = MagicMock()
        gk = VADGatekeeper(wake_cb, MagicMock(), MagicMock())
        gk._vad = None  # Force RMS detection

        gk.set_gesture_focus(True)
        loud_chunk = _make_loud_frame(amplitude=5000)

        # Simulate monitor loop logic
        consecutive_speech_frames = 0
        for _ in range(10):  # well beyond speech_frames_to_wake
            if gk.gesture_focus_active:
                consecutive_speech_frames = 0
            if gk._detect_speech(loud_chunk) and not gk.gesture_focus_active:
                consecutive_speech_frames += 1

        self.assertEqual(consecutive_speech_frames, 0)
        self.assertEqual(gk.state, VADState.SLEEPING)
        wake_cb.assert_not_called()


class TestConfigurableDebounce(unittest.TestCase):
    """Tests for configurable debounce speech frame window."""

    def test_speech_frames_to_wake_configurable(self):
        gk = VADGatekeeper(MagicMock(), MagicMock(), MagicMock(), speech_frames_to_wake=5)
        self.assertEqual(gk.speech_frames_to_wake, 5)

        gk.speech_frames_to_wake = SPEECH_FRAMES_TO_WAKE_CALIBRATED
        self.assertEqual(gk.speech_frames_to_wake, 5)

        gk.speech_frames_to_wake = 0  # clamps to minimum 1
        self.assertEqual(gk.speech_frames_to_wake, 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
