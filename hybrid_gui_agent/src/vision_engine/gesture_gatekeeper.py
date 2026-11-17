"""
vision_engine/gesture_gatekeeper.py
====================================
Explicit engagement gating and threshold validation for camera-based gesture tracking.

Solves the continuous ungated gesture tracking problem by enforcing an explicit
engagement state machine between the vision engine and UI/action execution layers.

States:
-------
- DISENGAGED (Gated / Standby):
  Navigation gestures and GUI commands are strictly gated/blocked.
  Monitors for deliberate user engagement (e.g. sustained gaze fixated on screen
  within configured target threshold bounds). Casual posture shifts or conversations
  trigger zero spurious actions.
- ENGAGING:
  User is holding the engagement condition. Progress tracks 0.0 -> 1.0.
  If the condition drops before threshold, smoothly recovers back to DISENGAGED.
  Upon reaching threshold, transitions to ENGAGED.
- ENGAGED (Active / Gating Open):
  Gate is open for deliberate navigation gestures. Gestures are validated against
  configured hold duration thresholds and bounds. Real-time hold progress is reported
  each frame for immediate feedback. When hold duration is achieved, the action is
  triggered and enters a brief COOLDOWN debounce window.
- COOLDOWN:
  Temporary refractory window following a triggered gesture to prevent duplicate
  triggering while retaining engaged navigation state.
- INACTIVITY_TIMEOUT:
  Automatic graceful fallback to DISENGAGED after a period of inactivity.
"""

from enum import Enum, auto
import logging
import time
from typing import Optional, Dict, Any, Tuple

logger = logging.getLogger("GestureGatekeeper")


class EngagementState(Enum):
    DISENGAGED = "DISENGAGED"
    ENGAGING   = "ENGAGING"
    ENGAGED    = "ENGAGED"
    COOLDOWN   = "COOLDOWN"


class GestureGatekeeper:
    """
    Manages engagement gating, threshold validation, and hold confirmation
    for hands-free computer control gestures.
    """

    def __init__(
        self,
        target_min: float = 0.40,
        target_max: float = 0.60,
        engagement_hold_time_s: float = 0.8,
        gesture_hold_time_s: float = 1.0,
        inactivity_timeout_s: float = 3.0,
        cooldown_s: float = 1.2,
        on_state_change: Optional[Any] = None,
        on_action_triggered: Optional[Any] = None,
    ):
        # Configured threshold bounds
        self.target_min = target_min
        self.target_max = target_max
        self.engagement_hold_time_s = engagement_hold_time_s
        self.gesture_hold_time_s = gesture_hold_time_s
        self.inactivity_timeout_s = inactivity_timeout_s
        self.cooldown_s = cooldown_s

        # Callbacks
        self.on_state_change = on_state_change
        self.on_action_triggered = on_action_triggered

        # State machine variables
        self.state: EngagementState = EngagementState.DISENGAGED
        self.engagement_start_time: Optional[float] = None
        self.last_activity_time: float = time.time()
        self.cooldown_until: float = 0.0

        # Gesture hold tracking
        self.active_candidate_gesture: Optional[Dict[str, Any]] = None
        self.candidate_hold_start: Optional[float] = None
        self.last_triggered_action: Optional[str] = None

    def _transition(self, new_state: EngagementState, reason: str = "") -> None:
        """Execute a state transition with consistent logging and callback."""
        if self.state == new_state:
            return

        old_state = self.state
        self.state = new_state
        logger.info(
            f"[GestureGatekeeper] State transition: {old_state.value} -> {new_state.value} "
            f"({reason})"
        )

        if self.on_state_change:
            try:
                self.on_state_change(old_state, new_state, reason)
            except Exception as e:
                logger.error(f"[GestureGatekeeper] on_state_change callback error: {e}")

    def is_gated(self) -> bool:
        """Returns True if actions are currently gated/blocked."""
        return self.state != EngagementState.ENGAGED and self.state != EngagementState.COOLDOWN

    def validate_gaze_bounds(self, relative_position: Optional[float]) -> bool:
        """
        Validate whether the user's iris relative position falls within
        the configured target threshold bounds.
        """
        if relative_position is None:
            return False
        return self.target_min <= relative_position <= self.target_max

    def set_engaged(
        self,
        engaged: bool,
        reason: str = "manual_override",
        now: Optional[float] = None,
    ) -> None:
        """Manual engagement toggle (e.g. from UI or external wake signal)."""
        if now is None:
            now = time.time()
        if engaged:
            self.last_activity_time = now
            self.engagement_start_time = None
            self._transition(EngagementState.ENGAGED, reason=reason)
        else:
            self.engagement_start_time = None
            self.active_candidate_gesture = None
            self.candidate_hold_start = None
            self._transition(EngagementState.DISENGAGED, reason=reason)

    def process_frame(
        self,
        gaze_position: Optional[float],
        matched_gestures: Optional[list] = None,
        face_present: bool = False,
        now: Optional[float] = None,
    ) -> Dict[str, Any]:
        """
        Process a single vision frame against the engagement gatekeeper.
        Operates well within 60 FPS constraints (< 0.1ms compute).

        Returns:
            Dict containing:
            - state: str ('DISENGAGED', 'ENGAGING', 'ENGAGED', 'COOLDOWN')
            - gated: bool (True if gesture actions are blocked)
            - engagement_progress: float (0.0 to 1.0)
            - hold_progress: float (0.0 to 1.0)
            - active_gesture: Optional[str]
            - triggered_action: Optional[Dict[str, Any]] (if gesture met hold criteria)
        """
        if now is None:
            now = time.time()

        if matched_gestures is None:
            matched_gestures = []

        is_gaze_valid = self.validate_gaze_bounds(gaze_position)
        engagement_progress = 0.0
        hold_progress = 0.0
        triggered_action: Optional[Dict[str, Any]] = None

        # Check cooldown expiration
        if self.state == EngagementState.COOLDOWN and now >= self.cooldown_until:
            self._transition(EngagementState.ENGAGED, reason="cooldown_expired")

        # -------------------------------------------------------------
        # STATE: DISENGAGED
        # -------------------------------------------------------------
        if self.state == EngagementState.DISENGAGED:
            # When disengaged, gesture actions are gated.
            # Evaluate engagement criteria (user looking attentively within bounds)
            if is_gaze_valid:
                self.engagement_start_time = now
                self._transition(EngagementState.ENGAGING, reason="gaze_target_acquired")
                engagement_progress = 0.0
            else:
                self.engagement_start_time = None

        # -------------------------------------------------------------
        # STATE: ENGAGING
        # -------------------------------------------------------------
        elif self.state == EngagementState.ENGAGING:
            if is_gaze_valid and self.engagement_start_time is not None:
                elapsed = now - self.engagement_start_time
                engagement_progress = min(1.0, elapsed / self.engagement_hold_time_s)

                if elapsed >= self.engagement_hold_time_s:
                    self.last_activity_time = now
                    self.engagement_start_time = None
                    self._transition(EngagementState.ENGAGED, reason="engagement_threshold_achieved")
                    engagement_progress = 1.0
            else:
                # Interrupted / lost gaze before threshold -> Graceful fallback
                self.engagement_start_time = None
                self._transition(EngagementState.DISENGAGED, reason="engagement_interrupted")
                engagement_progress = 0.0

        # -------------------------------------------------------------
        # STATE: ENGAGED or COOLDOWN
        # -------------------------------------------------------------
        if self.state in (EngagementState.ENGAGED, EngagementState.COOLDOWN):
            engagement_progress = 1.0

            # Any valid gaze or gesture maintains engagement activity
            has_activity = is_gaze_valid or len(matched_gestures) > 0
            if has_activity:
                self.last_activity_time = now

            # Check inactivity timeout
            if now - self.last_activity_time >= self.inactivity_timeout_s:
                self.active_candidate_gesture = None
                self.candidate_hold_start = None
                self._transition(
                    EngagementState.DISENGAGED,
                    reason=f"inactivity_timeout_exceeded_{self.inactivity_timeout_s}s"
                )
                return {
                    "state": self.state.value,
                    "gated": True,
                    "engagement_progress": 0.0,
                    "hold_progress": 0.0,
                    "active_gesture": None,
                    "triggered_action": None,
                }

            # If currently in cooldown, ignore candidate triggers
            if self.state == EngagementState.COOLDOWN:
                self.active_candidate_gesture = None
                self.candidate_hold_start = None
                hold_progress = 0.0
            else:
                # Process candidate gestures
                if matched_gestures:
                    current_candidate = matched_gestures[0]
                    cand_action = current_candidate.get("action")

                    # Check if continuing same candidate gesture
                    if (
                        self.active_candidate_gesture is not None
                        and self.active_candidate_gesture.get("action") == cand_action
                    ):
                        elapsed_hold = now - (self.candidate_hold_start or now)
                        hold_progress = min(1.0, elapsed_hold / self.gesture_hold_time_s)

                        # Threshold achieved -> Trigger deliberate action!
                        if elapsed_hold >= self.gesture_hold_time_s:
                            triggered_action = {
                                "type": "vision-gesture",
                                "gesture": current_candidate.get("name", "gesture"),
                                "action": cand_action,
                                "actionArg": current_candidate.get("actionArg"),
                            }
                            self.last_triggered_action = cand_action
                            self.cooldown_until = now + self.cooldown_s
                            self._transition(
                                EngagementState.COOLDOWN,
                                reason=f"gesture_triggered_{cand_action}"
                            )

                            if self.on_action_triggered:
                                try:
                                    self.on_action_triggered(triggered_action)
                                except Exception as e:
                                    logger.error(f"[GestureGatekeeper] on_action_triggered error: {e}")

                            # Reset candidate hold
                            self.active_candidate_gesture = None
                            self.candidate_hold_start = None
                            hold_progress = 0.0
                    else:
                        # New candidate gesture detected -> start hold
                        self.active_candidate_gesture = current_candidate
                        self.candidate_hold_start = now
                        hold_progress = 0.0
                else:
                    # No gesture matched in this frame -> Graceful fallback reset
                    # Allows immediate retry without state lockup
                    self.active_candidate_gesture = None
                    self.candidate_hold_start = None
                    hold_progress = 0.0

        active_gesture_name = (
            self.active_candidate_gesture.get("name")
            if self.active_candidate_gesture
            else None
        )

        return {
            "state": self.state.value,
            "gated": self.is_gated(),
            "engagement_progress": round(engagement_progress, 3),
            "hold_progress": round(hold_progress, 3),
            "active_gesture": active_gesture_name,
            "triggered_action": triggered_action,
        }
