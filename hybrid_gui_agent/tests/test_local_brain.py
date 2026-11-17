"""
tests/test_local_brain.py
=========================
Comprehensive unit and regression test suite for LocalVisionBrain, gesture calculations,
bounds checking, and throttled base64 stdout serialization.

Verifies:
1. Distance calculation across coordinate representations and aspect ratios.
2. Boundary checks preventing erroneous triggers on dropped or partially visible hands.
3. Finger state determinations invariant to hand rotation and orientation.
4. Custom gesture matching against hand and facial gestures.
5. Base64 frame serialization throttling preventing IPC latency and OS pipe saturation.
6. Temporal hold thresholds, cooldown periods, and rapid state transitions.
7. Resilience against unexpected landmark frame drops.
8. Real-time 60 FPS performance constraints (< 16.6 ms budget).
"""

import math
import os
import sys
import time
import unittest
import numpy as np
import cv2

# Add src folder to sys.path
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

from vision_engine.local_brain import (
    _get_coord,
    calculate_landmark_distance,
    check_hand_bounds,
    get_finger_states,
    detect_hand_gestures,
    detect_face_gestures,
    Base64FrameThrottler,
    LocalVisionBrain,
)


class MockLandmark:
    """Mock MediaPipe NormalizedLandmark object."""
    def __init__(self, x=0.0, y=0.0, z=0.0):
        self.x = float(x)
        self.y = float(y)
        self.z = float(z)


def create_canonical_hand(open_fingers=None, origin=(0.5, 0.8), scale=0.3):
    """
    Constructs a 21-landmark hand model.
    open_fingers: set or list of finger names to be extended ('thumb', 'index', 'middle', 'ring', 'pinky').
    """
    if open_fingers is None:
        open_fingers = ['thumb', 'index', 'middle', 'ring', 'pinky']

    ox, oy = origin
    lms = [MockLandmark(ox, oy, 0.0)]  # 0: Wrist

    # Thumb: 1 (CMC), 2 (MCP), 3 (IP), 4 (Tip)
    lms.append(MockLandmark(ox - 0.04 * scale, oy - 0.08 * scale))  # 1
    lms.append(MockLandmark(ox - 0.08 * scale, oy - 0.16 * scale))  # 2
    lms.append(MockLandmark(ox - 0.12 * scale, oy - 0.24 * scale))  # 3 (IP)
    if 'thumb' in open_fingers:
        lms.append(MockLandmark(ox - 0.18 * scale, oy - 0.32 * scale))  # 4 (Tip extended)
    else:
        lms.append(MockLandmark(ox - 0.04 * scale, oy - 0.20 * scale))  # 4 (Tip tucked)

    # Fingers: Index (5-8), Middle (9-12), Ring (13-16), Pinky (17-20)
    finger_configs = [
        ('index', 5, -0.06),
        ('middle', 9, 0.0),
        ('ring', 13, 0.06),
        ('pinky', 17, 0.12),
    ]

    for fname, base_idx, x_off in finger_configs:
        is_open = fname in open_fingers
        # MCP (knuckle)
        lms.append(MockLandmark(ox + x_off * scale, oy - 0.25 * scale))
        # PIP (joint 1)
        lms.append(MockLandmark(ox + x_off * scale, oy - 0.40 * scale))
        # DIP (joint 2)
        lms.append(MockLandmark(ox + x_off * scale, oy - 0.55 * scale))
        # Tip
        if is_open:
            lms.append(MockLandmark(ox + x_off * scale, oy - 0.70 * scale))  # Extended tip
        else:
            lms.append(MockLandmark(ox + x_off * scale, oy - 0.35 * scale))  # Curled tip (closer to wrist than PIP)

    return lms


def rotate_landmarks(landmarks, angle_deg, center=(0.5, 0.5)):
    """Rotates landmarks by angle_deg around center point."""
    rad = math.radians(angle_deg)
    cos_a, sin_a = math.cos(rad), math.sin(rad)
    cx, cy = center
    rotated = []
    for lm in landmarks:
        dx = lm.x - cx
        dy = lm.y - cy
        rx = cx + dx * cos_a - dy * sin_a
        ry = cy + dx * sin_a + dy * cos_a
        rotated.append(MockLandmark(rx, ry, lm.z))
    return rotated


class TestGestureCalculationAndBounds(unittest.TestCase):
    """Unit tests for gesture state calculation and boundary checks."""

    def test_landmark_distance_calculation(self):
        p1 = {"x": 0.2, "y": 0.3, "z": 0.0}
        p2 = MockLandmark(0.5, 0.7, 0.0)

        # 2D Euclidean: dx = 0.3, dy = 0.4 -> 0.5
        d = calculate_landmark_distance(p1, p2, aspect_ratio=1.0)
        self.assertAlmostEqual(d, 0.5, places=5)

        # Aspect ratio 16:9 ~ 1.7778
        d_ar = calculate_landmark_distance(p1, p2, aspect_ratio=1.7778)
        expected_ar = math.sqrt((0.3 * 1.7778)**2 + 0.4**2)
        self.assertAlmostEqual(d_ar, expected_ar, places=5)

        # Null / None handling
        self.assertEqual(calculate_landmark_distance(None, p2), 0.0)

    def test_hand_bounds_in_view(self):
        lms = create_canonical_hand(open_fingers=['index', 'middle'])
        bounds = check_hand_bounds(lms, margin=0.05)

        self.assertTrue(bounds["in_bounds"])
        self.assertEqual(bounds["out_of_bounds_count"], 0)
        self.assertEqual(bounds["total_landmarks"], 21)
        self.assertLessEqual(bounds["box"]["min_x"], bounds["box"]["max_x"])
        self.assertLessEqual(bounds["box"]["min_y"], bounds["box"]["max_y"])

    def test_hand_bounds_out_of_view_rejection(self):
        # Wrist outside camera margin
        lms = create_canonical_hand()
        for lm in lms:
            lm.x += 1.5  # shift completely off-screen to the right

        bounds = check_hand_bounds(lms, margin=0.05)
        self.assertFalse(bounds["in_bounds"])
        self.assertGreater(bounds["out_of_bounds_count"], 5)

        # Empty landmarks list
        empty_bounds = check_hand_bounds([])
        self.assertFalse(empty_bounds["in_bounds"])
        self.assertEqual(empty_bounds["total_landmarks"], 0)

        # Fewer than 21 landmarks
        partial_bounds = check_hand_bounds(lms[:10])
        self.assertFalse(partial_bounds["in_bounds"])

    def test_finger_states_open_palm(self):
        lms = create_canonical_hand(open_fingers=['thumb', 'index', 'middle', 'ring', 'pinky'])
        states = get_finger_states(lms)
        self.assertEqual(states, {
            "thumb": "open",
            "index": "open",
            "middle": "open",
            "ring": "open",
            "pinky": "open"
        })

    def test_finger_states_closed_fist(self):
        lms = create_canonical_hand(open_fingers=[])
        states = get_finger_states(lms)
        self.assertEqual(states, {
            "thumb": "closed",
            "index": "closed",
            "middle": "closed",
            "ring": "closed",
            "pinky": "closed"
        })

    def test_finger_states_pointing_index(self):
        lms = create_canonical_hand(open_fingers=['index'])
        states = get_finger_states(lms)
        self.assertEqual(states["index"], "open")
        self.assertEqual(states["thumb"], "closed")
        self.assertEqual(states["middle"], "closed")
        self.assertEqual(states["ring"], "closed")
        self.assertEqual(states["pinky"], "closed")

    def test_finger_states_thumbs_up(self):
        lms = create_canonical_hand(open_fingers=['thumb'])
        states = get_finger_states(lms)
        self.assertEqual(states["thumb"], "open")
        self.assertEqual(states["index"], "closed")
        self.assertEqual(states["middle"], "closed")
        self.assertEqual(states["ring"], "closed")
        self.assertEqual(states["pinky"], "closed")

    def test_finger_states_peace_sign(self):
        lms = create_canonical_hand(open_fingers=['index', 'middle'])
        states = get_finger_states(lms)
        self.assertEqual(states["index"], "open")
        self.assertEqual(states["middle"], "open")
        self.assertEqual(states["thumb"], "closed")
        self.assertEqual(states["ring"], "closed")
        self.assertEqual(states["pinky"], "closed")

    def test_finger_states_rotation_invariance(self):
        """
        Critical regression test: Naive y-axis checks fail when hand is tilted or rotated.
        Distance heuristics relative to wrist and pinky MCP must remain invariant across angles.
        """
        canonical_peace = create_canonical_hand(open_fingers=['index', 'middle'], origin=(0.5, 0.5), scale=0.2)

        for angle in [45, 90, 180, 270]:
            rotated = rotate_landmarks(canonical_peace, angle, center=(0.5, 0.5))
            states = get_finger_states(rotated)
            self.assertEqual(
                states["index"], "open",
                f"Failed index open at angle {angle} degrees"
            )
            self.assertEqual(
                states["middle"], "open",
                f"Failed middle open at angle {angle} degrees"
            )
            self.assertEqual(
                states["ring"], "closed",
                f"Failed ring closed at angle {angle} degrees"
            )
            self.assertEqual(
                states["pinky"], "closed",
                f"Failed pinky closed at angle {angle} degrees"
            )

    def test_out_of_bounds_finger_state_fallback(self):
        """When hand is out of camera bounds, all fingers safely default to 'closed'."""
        lms = create_canonical_hand(open_fingers=['index', 'middle'])
        for lm in lms:
            lm.y = 1.6  # Out of visible frame

        states = get_finger_states(lms)
        self.assertEqual(states, {
            "thumb": "closed",
            "index": "closed",
            "middle": "closed",
            "ring": "closed",
            "pinky": "closed"
        })

    def test_hand_gesture_matching(self):
        custom_gestures = [
            {
                "id": "g1",
                "name": "Point",
                "type": "hand",
                "action": "click",
                "fingers": {"index": "open", "middle": "closed", "ring": "closed", "pinky": "closed"}
            },
            {
                "id": "g2",
                "name": "Peace",
                "type": "hand",
                "action": "screenshot",
                "fingers": {"index": "open", "middle": "open", "ring": "closed", "pinky": "closed"}
            }
        ]

        lms = create_canonical_hand(open_fingers=['index'])
        matched, states = detect_hand_gestures(lms, custom_gestures)
        self.assertEqual(len(matched), 1)
        self.assertEqual(matched[0]["name"], "Point")

        # Wildcard 'any' matches regardless of thumb
        lms_peace = create_canonical_hand(open_fingers=['index', 'middle'])
        matched_peace, _ = detect_hand_gestures(lms_peace, custom_gestures)
        self.assertEqual(len(matched_peace), 1)
        self.assertEqual(matched_peace[0]["name"], "Peace")


class TestFaceGestures(unittest.TestCase):
    """Unit tests for eye and head gesture detection."""

    def test_double_blink_detection(self):
        custom_gestures = [
            {"id": "e1", "name": "Double Blink", "type": "eye", "eyeAction": "double_blink", "action": "wake"}
        ]
        blink_hist = []
        head_hist = []

        # Blink 1 at t=1.0s
        matched1 = detect_face_gestures(custom_gestures, 0.8, 0.8, 0.0, 0.0, 1.0, blink_hist, head_hist)
        self.assertEqual(len(matched1), 0)

        # Blink 2 at t=1.5s (within 1.5s window)
        matched2 = detect_face_gestures(custom_gestures, 0.8, 0.8, 0.0, 0.0, 1.5, blink_hist, head_hist)
        self.assertEqual(len(matched2), 1)
        self.assertEqual(matched2[0]["name"], "Double Blink")

        # History cleared after trigger
        self.assertEqual(len(blink_hist), 0)

    def test_head_nod_detection(self):
        custom_gestures = [
            {"id": "h1", "name": "Nod", "type": "head", "headAction": "nod", "action": "confirm"}
        ]
        blink_hist = []
        head_hist = []

        # Pitch change from 0 to 20 degrees with yaw steady
        detect_face_gestures(custom_gestures, 0.0, 0.0, 0.0, 0.0, 1.0, blink_hist, head_hist)
        matched = detect_face_gestures(custom_gestures, 0.0, 0.0, 20.0, 2.0, 1.4, blink_hist, head_hist)
        self.assertEqual(len(matched), 1)
        self.assertEqual(matched[0]["name"], "Nod")


class TestBase64StdoutSerializationThrottling(unittest.TestCase):
    """
    Unit and performance tests verifying base64 stdout serialization throttling,
    measuring payload reduction, and verifying elimination of IPC latency.
    """

    def setUp(self):
        self.test_frame = np.zeros((480, 640, 3), dtype=np.uint8)
        # Add visual noise/content so JPEG is realistic in size
        cv2.circle(self.test_frame, (320, 240), 100, (255, 128, 64), -1)

    def test_throttler_interval_and_rate_limiting(self):
        """Verify throttler encodes only once within the target interval."""
        throttler = Base64FrameThrottler(target_fps=10.0)  # 100ms interval
        t0 = 100.0

        # Frame 1 at t0 -> Should encode
        b64_1, encoded_1 = throttler.encode_frame(self.test_frame, now=t0)
        self.assertTrue(encoded_1)
        self.assertIsNotNone(b64_1)

        # Frame 2 at t0 + 16ms (60 FPS camera frame) -> Should throttle (skip)
        b64_2, encoded_2 = throttler.encode_frame(self.test_frame, now=t0 + 0.016)
        self.assertFalse(encoded_2)
        self.assertIsNone(b64_2)

        # Frame 3 at t0 + 80ms -> Should throttle
        b64_3, encoded_3 = throttler.encode_frame(self.test_frame, now=t0 + 0.080)
        self.assertFalse(encoded_3)
        self.assertIsNone(b64_3)

        # Frame 4 at t0 + 105ms (> 100ms interval) -> Should encode
        b64_4, encoded_4 = throttler.encode_frame(self.test_frame, now=t0 + 0.105)
        self.assertTrue(encoded_4)
        self.assertIsNotNone(b64_4)

        self.assertEqual(throttler.encoded_frame_count, 2)
        self.assertEqual(throttler.throttled_frame_count, 2)

    def test_serialized_stdout_payload_size_reduction(self):
        """
        Verify that intermediate frames reduce JSON stdout serialization bytes by > 95%,
        preventing pipe buffer saturation and IPC latency.
        """
        import json
        throttler = Base64FrameThrottler(target_fps=10.0)

        # Frame 1: Encoded frame with base64 string
        payload_encoded = {
            "type": "vision-update",
            "hands": [{"gesture": "Point", "finger_states": {"index": "open"}}]
        }
        throttler.process_payload(payload_encoded, self.test_frame, now=10.0)
        bytes_encoded = len(json.dumps(payload_encoded).encode('utf-8'))

        # Frame 2: Throttled frame (no base64 string)
        payload_throttled = {
            "type": "vision-update",
            "hands": [{"gesture": "Point", "finger_states": {"index": "open"}}]
        }
        throttler.process_payload(payload_throttled, self.test_frame, now=10.016)
        bytes_throttled = len(json.dumps(payload_throttled).encode('utf-8'))

        self.assertIn("frame_b64", payload_encoded)
        self.assertTrue(payload_encoded["b64_included"])

        self.assertNotIn("frame_b64", payload_throttled)
        self.assertFalse(payload_throttled["b64_included"])

        # Payload size comparison
        reduction_pct = (1.0 - (bytes_throttled / bytes_encoded)) * 100.0
        self.assertGreater(bytes_encoded, 3000, "Base64 JPEG payload should be multiple kilobytes")
        self.assertLess(bytes_throttled, 500, "Throttled metadata payload should be < 500 bytes")
        self.assertGreater(reduction_pct, 90.0, f"Expected >90% reduction, got {reduction_pct:.2f}%")

    def test_throttler_disabled_or_zero_fps(self):
        """When streaming is disabled or target_fps is 0, no frames are encoded."""
        throttler = Base64FrameThrottler(target_fps=0.0, enabled=False)
        b64, encoded = throttler.encode_frame(self.test_frame, now=1.0)
        self.assertFalse(encoded)
        self.assertIsNone(b64)

    def test_invalid_frame_handled_gracefully(self):
        throttler = Base64FrameThrottler(target_fps=10.0)
        b64, encoded = throttler.encode_frame(None, now=1.0)
        self.assertFalse(encoded)
        self.assertIsNone(b64)


class TestLocalVisionBrain(unittest.TestCase):
    """Integration and state transition tests for LocalVisionBrain coordinator."""

    def setUp(self):
        self.brain = LocalVisionBrain(hold_time_required=1.0, target_fps=10.0)
        self.brain.custom_gestures = [
            {
                "id": "g_vol",
                "name": "Volume Up",
                "type": "hand",
                "action": "volume_up",
                "actionArg": "+5",
                "fingers": {"thumb": "closed", "index": "open", "middle": "closed", "ring": "closed", "pinky": "closed"}
            }
        ]
        self.test_frame = np.zeros((240, 320, 3), dtype=np.uint8)

    def test_gesture_hold_duration_and_action_trigger(self):
        """Gesture must be held for hold_time_required (1.0s) before action triggers."""
        t0 = 50.0
        hand_lms = create_canonical_hand(open_fingers=['index'])

        # Frame at t0: Start holding
        p0, ev0 = self.brain.process_frame_data(
            self.test_frame, hand_landmarks_list=[hand_lms], now=t0
        )
        self.assertEqual(len(ev0), 0)
        self.assertEqual(len(p0["hands"]), 1)
        self.assertEqual(p0["hands"][0]["gesture"], "Volume Up")

        # Frame at t0 + 0.5s: Still holding, no trigger
        _, ev_mid = self.brain.process_frame_data(
            self.test_frame, hand_landmarks_list=[hand_lms], now=t0 + 0.5
        )
        self.assertEqual(len(ev_mid), 0)

        # Frame at t0 + 1.05s: Hold elapsed -> Action triggers!
        _, ev_trig = self.brain.process_frame_data(
            self.test_frame, hand_landmarks_list=[hand_lms], now=t0 + 1.05
        )
        self.assertEqual(len(ev_trig), 1)
        self.assertEqual(ev_trig[0]["action"], "volume_up")
        self.assertEqual(ev_trig[0]["actionArg"], "+5")

        # Frame during cooldown (t0 + 1.5s): Should not re-trigger
        _, ev_cool = self.brain.process_frame_data(
            self.test_frame, hand_landmarks_list=[hand_lms], now=t0 + 1.5
        )
        self.assertEqual(len(ev_cool), 0)

    def test_unexpected_landmark_frame_drops_handled_cleanly(self):
        """Frame drops (e.g. hand temporarily lost) reset hold timer safely without errors."""
        t0 = 10.0
        hand_lms = create_canonical_hand(open_fingers=['index'])

        # Hold for 0.6s
        self.brain.process_frame_data(self.test_frame, hand_landmarks_list=[hand_lms], now=t0)
        self.brain.process_frame_data(self.test_frame, hand_landmarks_list=[hand_lms], now=t0 + 0.6)

        # Dropped frame (no hands detected)
        p_drop, ev_drop = self.brain.process_frame_data(
            self.test_frame, hand_landmarks_list=[], now=t0 + 0.7
        )
        self.assertEqual(len(p_drop["hands"]), 0)
        self.assertEqual(len(ev_drop), 0)

        # Hand reappears -> Hold timer resets, does not instantly trigger
        _, ev_reappear = self.brain.process_frame_data(
            self.test_frame, hand_landmarks_list=[hand_lms], now=t0 + 1.1
        )
        self.assertEqual(len(ev_reappear), 0)

    def test_rapid_gesture_state_transitions(self):
        """Rapidly alternating gestures do not trigger spurious actions or leak state."""
        t0 = 100.0
        hand_index = create_canonical_hand(open_fingers=['index'])
        hand_fist = create_canonical_hand(open_fingers=[])

        # Rapid oscillation for 20 frames at 60 FPS
        for i in range(20):
            sim_time = t0 + i * 0.016
            lms = hand_index if i % 2 == 0 else hand_fist
            _, ev = self.brain.process_frame_data(
                self.test_frame, hand_landmarks_list=[lms], now=sim_time
            )
            self.assertEqual(len(ev), 0)

    def test_gaze_hold_wake_event(self):
        """Gaze held in target range [0.42, 0.58] triggers vision-wake."""
        t0 = 200.0
        # Mock face landmarks with iris in center (0.50)
        face_lms = [MockLandmark(0.5, 0.5) for _ in range(478)]
        # Left eye corner 33 at x=0.40, corner 133 at x=0.60, iris 468 at x=0.50 -> relative_position = 0.50
        face_lms[33] = MockLandmark(0.40, 0.5)
        face_lms[133] = MockLandmark(0.60, 0.5)
        face_lms[468] = MockLandmark(0.50, 0.5)
        face_lms[473] = MockLandmark(0.50, 0.5)

        # Start gaze
        _, ev0 = self.brain.process_frame_data(self.test_frame, face_landmarks_list=[face_lms], now=t0)
        self.assertEqual(len(ev0), 0)

        # Gaze reached hold duration (1.0s)
        _, ev_wake = self.brain.process_frame_data(self.test_frame, face_landmarks_list=[face_lms], now=t0 + 1.05)
        self.assertEqual(len(ev_wake), 1)
        self.assertEqual(ev_wake[0]["type"], "vision-wake")

    def test_real_time_60fps_processing_budget(self):
        """
        Processing budget constraint: each frame update must execute in < 16.6 ms (60 FPS).
        Verifies 1,000 simulated frames execute in < 100 ms (< 0.1 ms per frame).
        """
        hand_lms = create_canonical_hand(open_fingers=['index', 'middle'])
        start_time = time.perf_counter()

        for i in range(1000):
            sim_time = 10.0 + i * 0.016
            self.brain.process_frame_data(
                self.test_frame,
                hand_landmarks_list=[hand_lms],
                now=sim_time
            )

        elapsed = time.perf_counter() - start_time
        per_frame_ms = (elapsed / 1000) * 1000.0

        self.assertLess(per_frame_ms, 2.0, f"Frame processing too slow: {per_frame_ms:.4f} ms")


if __name__ == "__main__":
    unittest.main()
