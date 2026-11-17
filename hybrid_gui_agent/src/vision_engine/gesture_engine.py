import time
import math
from typing import Dict, List, Optional, Tuple, Any

FINGER_NAMES = ("thumb", "index", "middle", "ring", "pinky")

def validate_landmarks(landmarks: List[Any]) -> bool:
    """Validate hand landmarks for structure and coordinate bounds."""
    if not landmarks or len(landmarks) < 21:
        return False
    for lm in landmarks:
        x = getattr(lm, 'x', None) if not isinstance(lm, dict) else lm.get('x')
        y = getattr(lm, 'y', None) if not isinstance(lm, dict) else lm.get('y')
        if x is None or y is None:
            return False
        if math.isnan(x) or math.isnan(y):
            return False
        # Normalized coordinates should be within reasonable bounds [-0.2, 1.2]
        if not (-0.2 <= x <= 1.2 and -0.2 <= y <= 1.2):
            return False
    return True

def get_finger_states(hand_landmarks: List[Any]) -> Dict[str, str]:
    """Calculate open/closed state for each finger from landmarks."""
    def get_pt(idx: int):
        lm = hand_landmarks[idx]
        if isinstance(lm, dict):
            return lm.get('x', 0.0), lm.get('y', 0.0)
        return getattr(lm, 'x', 0.0), getattr(lm, 'y', 0.0)

    x4, y4 = get_pt(4)
    x3, y3 = get_pt(3)
    x5, _ = get_pt(5)
    x17, _ = get_pt(17)

    # Thumb: compare x relative to hand orientation
    thumb_open = x4 < x3 if x17 > x5 else x4 > x3

    _, y8 = get_pt(8)
    _, y6 = get_pt(6)
    index_open = y8 < y6

    _, y12 = get_pt(12)
    _, y10 = get_pt(10)
    middle_open = y12 < y10

    _, y16 = get_pt(16)
    _, y14 = get_pt(14)
    ring_open = y16 < y14

    _, y20 = get_pt(20)
    _, y18 = get_pt(18)
    pinky_open = y20 < y18

    return {
        "thumb": "open" if thumb_open else "closed",
        "index": "open" if index_open else "closed",
        "middle": "open" if middle_open else "closed",
        "ring": "open" if ring_open else "closed",
        "pinky": "open" if pinky_open else "closed"
    }

def calculate_gesture_specificity(gesture: Dict[str, Any]) -> int:
    """
    Calculate the specificity score of a hand gesture.
    Each explicitly specified finger state ('open' or 'closed') adds 1 point.
    Wildcard ('any') or omitted finger requirements contribute 0 points.
    Maximum specificity is 5 (all fingers explicitly defined).
    """
    fingers = gesture.get('fingers')
    if not isinstance(fingers, dict):
        return 0
    score = 0
    for finger in FINGER_NAMES:
        req = fingers.get(finger)
        if req in ('open', 'closed'):
            score += 1
    return score

def rank_gestures_by_specificity(gestures: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Sort gestures in descending order of specificity score.
    Maintains stable ordering for gestures with identical specificity.
    """
    if not gestures:
        return []
    # Stable sort by specificity descending
    return sorted(gestures, key=calculate_gesture_specificity, reverse=True)

def validate_hold_threshold(gesture: Dict[str, Any], default_hold: float = 1.2, min_hold: float = 0.2, max_hold: float = 5.0) -> float:
    """Validate and clamp the gesture's configured hold threshold duration."""
    threshold = gesture.get('holdTime') or gesture.get('holdDuration') or gesture.get('threshold')
    if threshold is None:
        return default_hold
    try:
        val = float(threshold)
        if math.isnan(val) or val <= 0:
            return default_hold
        return max(min_hold, min(max_hold, val))
    except (ValueError, TypeError):
        return default_hold

def matches_finger_states(gesture: Dict[str, Any], states: Dict[str, str]) -> bool:
    """Check if states satisfy a gesture's finger constraints."""
    fingers = gesture.get('fingers')
    if not isinstance(fingers, dict):
        return False
    for finger in FINGER_NAMES:
        req = fingers.get(finger, 'any')
        if req != 'any' and states.get(finger) != req:
            return False
    return True

def detect_hand_gestures(hand_landmarks: List[Any], custom_gestures: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], Dict[str, str]]:
    """
    Detect matching gestures for a hand, ranking by specificity descending.
    Specific finger triggers are evaluated before broad wildcard rules,
    preventing broad rules from hijacking or swallowing specific gestures.
    """
    states = get_finger_states(hand_landmarks)
    if not custom_gestures:
        return [], states

    # Filter hand gestures and rank them by specificity descending
    hand_gestures = [g for g in custom_gestures if g.get('type', 'hand') == 'hand']
    ranked_gestures = rank_gestures_by_specificity(hand_gestures)

    matched = []
    for g in ranked_gestures:
        if matches_finger_states(g, states):
            matched.append(g)

    return matched, states

class GestureHoldTracker:
    """
    Manages state transitions for hold gestures with threshold validation
    and structured state logging.
    States: IDLE -> HOLDING -> TRIGGERED -> COOLDOWN -> IDLE
            HOLDING -> CANCELLED -> IDLE
    """
    STATE_IDLE = "idle"
    STATE_HOLDING = "holding"
    STATE_TRIGGERED = "triggered"
    STATE_COOLDOWN = "cooldown"
    STATE_CANCELLED = "cancelled"

    def __init__(self, default_hold_time: float = 1.2, cooldown_time: float = 1.5):
        self.default_hold_time = default_hold_time
        self.cooldown_time = cooldown_time
        # Map: action -> {"start_time": float, "state": str, "cooldown_until": float, "gesture": dict, "threshold": float}
        self.action_states: Dict[str, Dict[str, Any]] = {}

    def update(self, current_gestures: List[Dict[str, Any]], now: Optional[float] = None) -> List[Dict[str, Any]]:
        """
        Update tracker with currently active gestures.
        Returns a list of state transition events.
        """
        if now is None:
            now = time.time()

        events = []
        active_actions = {g['action']: g for g in current_gestures if 'action' in g}

        # Check existing tracked actions
        for action in list(self.action_states.keys()):
            entry = self.action_states[action]
            state = entry['state']

            if action in active_actions:
                # Action is actively held
                g = active_actions[action]
                threshold = entry['threshold']

                if state == self.STATE_HOLDING:
                    elapsed = now - entry['start_time']
                    progress = min(1.0, elapsed / threshold) if threshold > 0 else 1.0

                    if elapsed >= threshold:
                        # Transition to TRIGGERED
                        entry['state'] = self.STATE_TRIGGERED
                        entry['cooldown_until'] = now + self.cooldown_time
                        events.append({
                            "type": "gesture-state",
                            "state": self.STATE_TRIGGERED,
                            "gesture": g.get('name', action),
                            "action": action,
                            "actionArg": g.get('actionArg'),
                            "held_time": elapsed,
                            "threshold": threshold,
                            "specificity": calculate_gesture_specificity(g)
                        })
                    else:
                        # Progress update while holding
                        events.append({
                            "type": "gesture-state",
                            "state": self.STATE_HOLDING,
                            "gesture": g.get('name', action),
                            "action": action,
                            "progress": progress,
                            "elapsed": elapsed,
                            "threshold": threshold,
                            "specificity": calculate_gesture_specificity(g)
                        })

                elif state == self.STATE_TRIGGERED:
                    # Transition to COOLDOWN
                    entry['state'] = self.STATE_COOLDOWN

                elif state == self.STATE_COOLDOWN:
                    if now >= entry['cooldown_until']:
                        # Cooldown complete while still held; allow re-holding
                        entry['state'] = self.STATE_HOLDING
                        entry['start_time'] = now

            else:
                # Action is no longer detected / interrupted
                if state == self.STATE_HOLDING:
                    elapsed = now - entry['start_time']
                    events.append({
                        "type": "gesture-state",
                        "state": self.STATE_CANCELLED,
                        "gesture": entry['gesture'].get('name', action),
                        "action": action,
                        "held_time": elapsed,
                        "threshold": entry['threshold']
                    })
                    del self.action_states[action]
                elif state in (self.STATE_TRIGGERED, self.STATE_COOLDOWN):
                    if now >= entry.get('cooldown_until', 0):
                        del self.action_states[action]

        # Start tracking newly active actions
        for action, g in active_actions.items():
            if action not in self.action_states:
                threshold = validate_hold_threshold(g, default_hold=self.default_hold_time)
                self.action_states[action] = {
                    "start_time": now,
                    "state": self.STATE_HOLDING,
                    "cooldown_until": 0.0,
                    "gesture": g,
                    "threshold": threshold
                }
                events.append({
                    "type": "gesture-state",
                    "state": self.STATE_HOLDING,
                    "gesture": g.get('name', action),
                    "action": action,
                    "progress": 0.0,
                    "elapsed": 0.0,
                    "threshold": threshold,
                    "specificity": calculate_gesture_specificity(g)
                })

        return events
