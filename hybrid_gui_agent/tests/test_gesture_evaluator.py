import unittest
import sys
import os

# Add src to sys.path
sys.path.append(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

from vision_engine.gesture_engine import (
    calculate_gesture_specificity,
    rank_gestures_by_specificity,
    detect_hand_gestures,
    get_finger_states,
    validate_landmarks,
    validate_hold_threshold,
    matches_finger_states,
    GestureHoldTracker
)

class MockLandmark:
    def __init__(self, x, y, z=0.0):
        self.x = x
        self.y = y
        self.z = z

def create_mock_hand(finger_open_states):
    """
    Creates a 21-point mock hand landmark list where finger states match finger_open_states dict.
    For thumb (landmarks 3, 4, 5, 17):
      orientation: x17 > x5 (right-facing palm), so thumb is open if x4 < x3.
    For fingers (index=8, middle=12, ring=16, pinky=20):
      finger is open if tip.y < pip.y.
    """
    lms = [MockLandmark(0.5, 0.8) for _ in range(21)]
    # Set orientation landmarks
    lms[5] = MockLandmark(0.4, 0.5)
    lms[17] = MockLandmark(0.6, 0.5)

    # Thumb: 3 and 4
    if finger_open_states.get("thumb") == "open":
        lms[3] = MockLandmark(0.35, 0.6)
        lms[4] = MockLandmark(0.25, 0.6) # x4 < x3 -> open
    else:
        lms[3] = MockLandmark(0.35, 0.6)
        lms[4] = MockLandmark(0.45, 0.6) # x4 > x3 -> closed

    # Index: 6 (pip) and 8 (tip)
    if finger_open_states.get("index") == "open":
        lms[6] = MockLandmark(0.4, 0.4)
        lms[8] = MockLandmark(0.4, 0.2) # y8 < y6 -> open
    else:
        lms[6] = MockLandmark(0.4, 0.4)
        lms[8] = MockLandmark(0.4, 0.5) # y8 > y6 -> closed

    # Middle: 10 (pip) and 12 (tip)
    if finger_open_states.get("middle") == "open":
        lms[10] = MockLandmark(0.5, 0.4)
        lms[12] = MockLandmark(0.5, 0.2)
    else:
        lms[10] = MockLandmark(0.5, 0.4)
        lms[12] = MockLandmark(0.5, 0.5)

    # Ring: 14 (pip) and 16 (tip)
    if finger_open_states.get("ring") == "open":
        lms[14] = MockLandmark(0.6, 0.4)
        lms[16] = MockLandmark(0.6, 0.2)
    else:
        lms[14] = MockLandmark(0.6, 0.4)
        lms[16] = MockLandmark(0.6, 0.5)

    # Pinky: 18 (pip) and 20 (tip)
    if finger_open_states.get("pinky") == "open":
        lms[18] = MockLandmark(0.7, 0.4)
        lms[20] = MockLandmark(0.7, 0.2)
    else:
        lms[18] = MockLandmark(0.7, 0.4)
        lms[20] = MockLandmark(0.7, 0.5)

    return lms

class TestGestureEvaluator(unittest.TestCase):

    def test_specificity_calculation(self):
        """Test calculation of gesture specificity score based on explicit constraints."""
        g_all_specific = {
            "name": "L-Shape",
            "fingers": {"thumb": "open", "index": "open", "middle": "closed", "ring": "closed", "pinky": "closed"}
        }
        self.assertEqual(calculate_gesture_specificity(g_all_specific), 5)

        g_partial_wildcard = {
            "name": "Pointing",
            "fingers": {"thumb": "any", "index": "open", "middle": "closed", "ring": "any", "pinky": "any"}
        }
        self.assertEqual(calculate_gesture_specificity(g_partial_wildcard), 2)

        g_broad_wildcard = {
            "name": "Any-Hand",
            "fingers": {"thumb": "any", "index": "any", "middle": "any", "ring": "any", "pinky": "any"}
        }
        self.assertEqual(calculate_gesture_specificity(g_broad_wildcard), 0)

        g_empty = {"name": "Empty"}
        self.assertEqual(calculate_gesture_specificity(g_empty), 0)

    def test_rank_gestures_by_specificity(self):
        """Test that gestures are sorted in descending order of specificity."""
        broad = {"name": "broad", "fingers": {"index": "open", "thumb": "any"}} # spec 1
        specific = {"name": "specific", "fingers": {"thumb": "open", "index": "open", "middle": "closed", "ring": "closed", "pinky": "closed"}} # spec 5
        moderate = {"name": "moderate", "fingers": {"thumb": "open", "index": "open", "middle": "closed"}} # spec 3

        unranked = [broad, specific, moderate]
        ranked = rank_gestures_by_specificity(unranked)

        self.assertEqual([g["name"] for g in ranked], ["specific", "moderate", "broad"])

    def test_unranked_evaluation_swallowing_resolved(self):
        """
        Verify that sequential matching no longer allows a broad wildcard gesture
        earlier in the configuration array to swallow a specific finger trigger.
        """
        # Broad rule earlier in configuration list
        broad_rule = {
            "id": "g-broad",
            "name": "Generic Index Up",
            "action": "generic_action",
            "type": "hand",
            "fingers": {"thumb": "any", "index": "open", "middle": "any", "ring": "any", "pinky": "any"}
        }

        # Specific rule later in configuration list
        specific_rule = {
            "id": "g-lshape",
            "name": "L Shape",
            "action": "volume_up",
            "type": "hand",
            "fingers": {"thumb": "open", "index": "open", "middle": "closed", "ring": "closed", "pinky": "closed"}
        }

        # Configuration array where broad rule is first
        configured_gestures = [broad_rule, specific_rule]

        # Hand pose: L-Shape (thumb open, index open, middle closed, ring closed, pinky closed)
        hand_landmarks = create_mock_hand({
            "thumb": "open",
            "index": "open",
            "middle": "closed",
            "ring": "closed",
            "pinky": "closed"
        })

        matched, states = detect_hand_gestures(hand_landmarks, configured_gestures)

        # Both rules match the physical finger states
        self.assertTrue(matches_finger_states(broad_rule, states))
        self.assertTrue(matches_finger_states(specific_rule, states))

        # Because of specificity ranking, the specific rule MUST be ranked first!
        self.assertGreater(len(matched), 0)
        self.assertEqual(matched[0]["id"], "g-lshape")
        self.assertEqual(matched[0]["action"], "volume_up")

    def test_validate_landmarks_bounds(self):
        """Verify hand landmark validation against coordinate and structure bounds."""
        valid_hand = [MockLandmark(0.5, 0.5) for _ in range(21)]
        self.assertTrue(validate_landmarks(valid_hand))

        # Too few landmarks
        short_hand = [MockLandmark(0.5, 0.5) for _ in range(15)]
        self.assertFalse(validate_landmarks(short_hand))

        # Coordinate out of bounds
        oob_hand = [MockLandmark(0.5, 0.5) for _ in range(21)]
        oob_hand[4] = MockLandmark(2.5, 0.5) # out of range [-0.2, 1.2]
        self.assertFalse(validate_landmarks(oob_hand))

        # NaN coordinates
        nan_hand = [MockLandmark(0.5, 0.5) for _ in range(21)]
        nan_hand[4] = MockLandmark(float('nan'), 0.5)
        self.assertFalse(validate_landmarks(nan_hand))

    def test_validate_hold_threshold(self):
        """Verify validation and clamping of gesture hold thresholds."""
        # Default fallback
        self.assertEqual(validate_hold_threshold({}, default_hold=1.2), 1.2)

        # Valid configured threshold
        self.assertEqual(validate_hold_threshold({"holdTime": 0.8}), 0.8)

        # Clamped to minimum (0.2s)
        self.assertEqual(validate_hold_threshold({"holdTime": 0.05}), 0.2)

        # Clamped to maximum (5.0s)
        self.assertEqual(validate_hold_threshold({"holdTime": 15.0}), 5.0)

        # Invalid type fallback
        self.assertEqual(validate_hold_threshold({"holdTime": "invalid"}, default_hold=1.2), 1.2)

    def test_state_machine_transitions(self):
        """
        Verify state transition boundaries:
        - idle -> holding (progress updates)
        - holding -> triggered (when hold_time >= threshold)
        - triggered -> cooldown (prevents duplicate spamming)
        - holding -> cancelled (when gesture dropped before threshold)
        - immediate retry after cancellation
        """
        tracker = GestureHoldTracker(default_hold_time=1.0, cooldown_time=1.5)

        gesture = {
            "name": "L Shape",
            "action": "volume_up",
            "holdTime": 1.0,
            "fingers": {"thumb": "open", "index": "open", "middle": "closed", "ring": "closed", "pinky": "closed"}
        }

        # T = 0.0: Gesture first detected -> enter HOLDING with progress = 0.0
        events_t0 = tracker.update([gesture], now=0.0)
        self.assertEqual(len(events_t0), 1)
        self.assertEqual(events_t0[0]["state"], "holding")
        self.assertEqual(events_t0[0]["progress"], 0.0)
        self.assertEqual(events_t0[0]["specificity"], 5)

        # T = 0.5: Halfway through hold -> still HOLDING with progress = 0.5
        events_t500 = tracker.update([gesture], now=0.5)
        self.assertEqual(len(events_t500), 1)
        self.assertEqual(events_t500[0]["state"], "holding")
        self.assertAlmostEqual(events_t500[0]["progress"], 0.5, places=2)

        # T = 1.0: Threshold reached -> TRIGGERED
        events_t1000 = tracker.update([gesture], now=1.0)
        self.assertEqual(len(events_t1000), 1)
        self.assertEqual(events_t1000[0]["state"], "triggered")
        self.assertEqual(events_t1000[0]["action"], "volume_up")

        # T = 1.2: Still in cooldown period -> no new trigger event
        events_t1200 = tracker.update([gesture], now=1.2)
        self.assertEqual(len(events_t1200), 0)

        # Drop gesture during cooldown -> cleanup
        tracker.update([], now=3.0)

        # Fallback Scenario: Interrupt gesture before threshold -> CANCELLED
        # T = 10.0: Start new gesture
        tracker.update([gesture], now=10.0)
        # T = 10.4: User interrupts/drops hand before 1.0s threshold
        cancel_events = tracker.update([], now=10.4)
        self.assertEqual(len(cancel_events), 1)
        self.assertEqual(cancel_events[0]["state"], "cancelled")
        self.assertEqual(cancel_events[0]["action"], "volume_up")

        # System allows immediate retry:
        retry_events = tracker.update([gesture], now=10.5)
        self.assertEqual(len(retry_events), 1)
        self.assertEqual(retry_events[0]["state"], "holding")

if __name__ == "__main__":
    unittest.main()
