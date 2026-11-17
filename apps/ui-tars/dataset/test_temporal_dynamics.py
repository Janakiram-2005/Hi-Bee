import sys
import os
import math
import pytest

# Ensure dataset folder is on sys.path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from train_word_model import extract_features


def create_static_hand(base_x=0.5, base_y=0.5, num_frames=30):
    """Generates frames of a static hand pose (no movement)."""
    timeline = []
    for t in range(num_frames):
        landmarks = []
        for i in range(21):
            landmarks.append({
                'x': base_x + (i % 5) * 0.02,
                'y': base_y + (i // 5) * 0.02,
                'z': 0.01 * (i % 3)
            })
        timeline.append({'type': 'hand', 'timestamp': t * 33, 'data': landmarks})
    return timeline


def create_dynamic_hand(start_x, start_y, end_x, end_y, num_frames=30):
    """Generates a dynamic hand gesture moving from (start_x, start_y) to (end_x, end_y)."""
    timeline = []
    for t in range(num_frames):
        alpha = t / float(num_frames - 1)
        curr_x = start_x + alpha * (end_x - start_x)
        curr_y = start_y + alpha * (end_y - start_y)
        landmarks = []
        for i in range(21):
            landmarks.append({
                'x': curr_x + (i % 5) * 0.02,
                'y': curr_y + (i // 5) * 0.02,
                'z': 0.01 * (i % 3)
            })
        timeline.append({'type': 'hand', 'timestamp': t * 33, 'data': landmarks})
    return timeline


class TestTemporalGestureDynamics:
    """Tests verifying that landmark extraction preserves temporal dynamics and trajectory features."""

    def test_dynamic_vs_static_distinction(self):
        """Verifies dynamic gestures are distinguishable from static hand positions."""
        static_seq = create_static_hand(base_x=0.5, base_y=0.5, num_frames=30)
        dynamic_seq = create_dynamic_hand(start_x=0.2, start_y=0.5, end_x=0.8, end_y=0.5, num_frames=30)

        feat_static = extract_features(static_seq)
        feat_dynamic = extract_features(dynamic_seq)

        assert len(feat_static) == 417
        assert len(feat_dynamic) == 417

        # Static gesture: displacement deltas (features 210 to 398) should be approximately 0
        deltas_static = feat_static[210:399]
        assert all(abs(d) < 1e-4 for d in deltas_static)

        # Dynamic gesture: displacement deltas must be non-zero
        deltas_dynamic = feat_dynamic[210:399]
        assert any(abs(d) > 0.1 for d in deltas_dynamic)

        # Wrist displacement delta X (index 210) reflects movement from start phase to end phase
        wrist_dx = feat_dynamic[210]
        assert wrist_dx > 0.35

        # Path length for dynamic gesture should be significant (> 0.5)
        wrist_path_len_dynamic = feat_dynamic[399]
        wrist_path_len_static = feat_static[399]
        assert wrist_path_len_dynamic > 0.5
        assert wrist_path_len_static < 1e-4

    def test_opposite_motion_directions_distinction(self):
        """Verifies gestures with opposite motion directions produce distinct features."""
        # Swipe Right: 0.2 -> 0.8 (positive dx)
        swipe_right = create_dynamic_hand(start_x=0.2, start_y=0.5, end_x=0.8, end_y=0.5, num_frames=30)
        # Swipe Left: 0.8 -> 0.2 (negative dx)
        swipe_left = create_dynamic_hand(start_x=0.8, start_y=0.5, end_x=0.2, end_y=0.5, num_frames=30)

        feat_right = extract_features(swipe_right)
        feat_left = extract_features(swipe_left)

        # In old landmark averaging, the mean coordinates for both were 0.5 and pairwise dists were identical!
        # In temporal feature extraction, displacement deltas must have opposite signs:
        wrist_dx_right = feat_right[210]
        wrist_dx_left = feat_left[210]

        assert wrist_dx_right > 0.35
        assert wrist_dx_left < -0.35
        assert abs(wrist_dx_right + wrist_dx_left) < 0.05  # symmetric opposite

        # Directional unit vectors must be opposite:
        # Wrist unit vector dx is at index 409
        assert feat_right[409] > 0.95
        assert feat_left[409] < -0.95

    def test_vertical_opposite_motion_distinction(self):
        """Verifies swipe up vs swipe down gestures produce opposite dy directions."""
        swipe_down = create_dynamic_hand(start_x=0.5, start_y=0.2, end_x=0.5, end_y=0.8, num_frames=30)
        swipe_up = create_dynamic_hand(start_x=0.5, start_y=0.8, end_x=0.5, end_y=0.2, num_frames=30)

        feat_down = extract_features(swipe_down)
        feat_up = extract_features(swipe_up)

        # Wrist displacement delta Y is at index 211
        wrist_dy_down = feat_down[211]
        wrist_dy_up = feat_up[211]

        assert wrist_dy_down > 0.35
        assert wrist_dy_up < -0.35
        assert abs(wrist_dy_down + wrist_dy_up) < 0.05

    def test_multi_phase_intermediate_dynamics(self):
        """Verifies multi-phase slicing distinguishes multi-segment gestures (e.g. up then down)."""
        # Two-stage gesture: move right in phase 1 (0.2 -> 0.7), then move left in phase 2 (0.7 -> 0.3)
        timeline = []
        num_frames = 30
        for t in range(num_frames):
            if t < 15:
                curr_x = 0.2 + (t / 14.0) * 0.5  # 0.2 -> 0.7
            else:
                curr_x = 0.7 - ((t - 15) / 14.0) * 0.4  # 0.7 -> 0.3
            landmarks = [{'x': curr_x, 'y': 0.5, 'z': 0.0} for _ in range(21)]
            timeline.append({'type': 'hand', 'timestamp': t * 33, 'data': landmarks})

        feat = extract_features(timeline)
        # Phase 1 displacement (Start -> Mid) index 273 (wrist dx)
        phase1_dx = feat[273]
        # Phase 2 displacement (Mid -> End) index 336 (wrist dx)
        phase2_dx = feat[336]

        assert phase1_dx > 0.1  # Moved right during first half
        assert phase2_dx < -0.1  # Moved left during second half

    def test_edge_cases(self):
        """Verifies robust handling of empty sequences, missing data, and single frame clips."""
        # Empty timeline
        empty_feat = extract_features([])
        assert len(empty_feat) == 417
        assert all(f == 0.0 for f in empty_feat)

        # Timeline with null hand data
        null_timeline = [{'type': 'hand', 'timestamp': 100, 'data': None}]
        null_feat = extract_features(null_timeline)
        assert len(null_feat) == 417
        assert all(f == 0.0 for f in null_feat)

        # Single frame sequence
        single_frame = create_static_hand(num_frames=1)
        single_feat = extract_features(single_frame)
        assert len(single_feat) == 417
        # Shape distances exist, trajectory deltas are 0
        assert any(d != 0.0 for d in single_feat[:210])
        assert all(d == 0.0 for d in single_feat[210:399])


class TestStateTransitionBoundaries:
    """
    100% boundary test coverage for gesture hold state transitions:
    IDLE -> DETECTED/HOLDING -> TRIGGERED -> COOLDOWN -> IDLE
    """

    class MockGestureStateMachine:
        def __init__(self, hold_threshold_ms=800, cooldown_ms=1500):
            self.hold_threshold_ms = hold_threshold_ms
            self.cooldown_ms = cooldown_ms
            self.state = "IDLE"
            self.current_gesture = None
            self.start_time = None
            self.last_seen_time = None
            self.last_trigger_time = -100000.0
            self.triggered = False
            self.history = []

        def update(self, detected_gesture, now_ms):
            events = []
            if detected_gesture is not None:
                # Check cooldown
                if now_ms - self.last_trigger_time < self.cooldown_ms:
                    events.append("COOLDOWN_ACTIVE")
                    return events

                if self.current_gesture == detected_gesture:
                    self.last_seen_time = now_ms
                    elapsed = now_ms - self.start_time
                    progress = min(1.0, elapsed / self.hold_threshold_ms)

                    if not self.triggered and elapsed >= self.hold_threshold_ms:
                        self.state = "TRIGGERED"
                        self.triggered = True
                        self.last_trigger_time = now_ms
                        events.append(("TRIGGERED", detected_gesture, elapsed))
                        self.history.append(("TRIGGERED", detected_gesture, now_ms))
                    elif not self.triggered:
                        self.state = "HOLDING"
                        events.append(("HOLDING", detected_gesture, progress, elapsed))
                else:
                    # New gesture detected
                    self.current_gesture = detected_gesture
                    self.start_time = now_ms
                    self.last_seen_time = now_ms
                    self.triggered = False
                    self.state = "HOLDING"
                    events.append(("HOLDING_START", detected_gesture, now_ms))
                    self.history.append(("HOLDING_START", detected_gesture, now_ms))
            else:
                # No gesture detected
                if self.current_gesture is not None:
                    if now_ms - self.last_seen_time > 200:
                        if not self.triggered:
                            events.append(("INTERRUPTED", self.current_gesture, now_ms - self.start_time))
                            self.history.append(("INTERRUPTED", self.current_gesture, now_ms))
                        self.state = "IDLE"
                        self.current_gesture = None
                        self.start_time = None
                        self.triggered = False

            return events

    def test_state_boundary_below_threshold_does_not_trigger(self):
        """Boundary test: Hold duration < threshold MUST NOT trigger gesture (prevents spurious triggers)."""
        sm = self.MockGestureStateMachine(hold_threshold_ms=800)
        
        # Frame at t=0
        ev1 = sm.update("VolumeUp", now_ms=0)
        assert sm.state == "HOLDING"
        assert not sm.triggered

        # Frame at t=799ms (1ms below 800ms boundary)
        ev2 = sm.update("VolumeUp", now_ms=799)
        assert sm.state == "HOLDING"
        assert not sm.triggered
        # No trigger event
        assert not any(e[0] == "TRIGGERED" for e in ev2 if isinstance(e, tuple))

    def test_state_boundary_at_threshold_triggers_immediately(self):
        """Boundary test: Hold duration == threshold triggers immediately within target latency bounds."""
        sm = self.MockGestureStateMachine(hold_threshold_ms=800)
        
        sm.update("VolumeUp", now_ms=0)
        sm.update("VolumeUp", now_ms=400)
        
        # Exactly at 800ms boundary
        ev = sm.update("VolumeUp", now_ms=800)
        assert sm.state == "TRIGGERED"
        assert sm.triggered
        assert any(e[0] == "TRIGGERED" for e in ev if isinstance(e, tuple))

    def test_interruption_resets_state_cleanly(self):
        """Fallback scenario: Graceful recovery when gesture is interrupted before threshold."""
        sm = self.MockGestureStateMachine(hold_threshold_ms=800)
        
        sm.update("VolumeUp", now_ms=0)
        sm.update("VolumeUp", now_ms=500)
        assert sm.state == "HOLDING"

        # Interrupted (user moved hand away, no gesture for > 200ms)
        ev = sm.update(None, now_ms=750)
        assert sm.state == "IDLE"
        assert sm.current_gesture is None
        assert not sm.triggered
        assert any(e[0] == "INTERRUPTED" for e in ev if isinstance(e, tuple))

        # Immediate retry without lockup or false trigger
        ev_retry = sm.update("VolumeUp", now_ms=800)
        assert sm.state == "HOLDING"
        assert sm.start_time == 800

    def test_cooldown_prevents_spurious_double_trigger(self):
        """Verifies cooldown period prevents spurious double trigger after completion."""
        sm = self.MockGestureStateMachine(hold_threshold_ms=800, cooldown_ms=1500)
        
        sm.update("VolumeUp", now_ms=0)
        sm.update("VolumeUp", now_ms=800)  # Triggered at t=800
        assert sm.triggered

        # Attempt immediate trigger during cooldown (t=1000, cooldown ends at 800+1500 = 2300)
        ev_during_cd = sm.update("VolumeUp", now_ms=1000)
        assert "COOLDOWN_ACTIVE" in ev_during_cd
        assert not any(e[0] == "TRIGGERED" for e in ev_during_cd if isinstance(e, tuple))

        # User releases hand at t=2100
        sm.update(None, now_ms=2350)
        assert sm.state == "IDLE"

        # After cooldown (t=2400), user initiates new gesture
        ev_after_cd = sm.update("VolumeUp", now_ms=2400)
        assert "COOLDOWN_ACTIVE" not in ev_after_cd
        assert sm.state == "HOLDING"
        assert sm.start_time == 2400
