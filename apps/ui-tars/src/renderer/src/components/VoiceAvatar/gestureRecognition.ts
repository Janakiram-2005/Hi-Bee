/**
 * Gesture recognition and specificity-ranking engine for VoiceAvatar.
 * Prevents broad wildcard rules from hijacking specific finger triggers,
 * validates threshold bounds, and manages hold state transitions.
 */

export type FingerName = 'thumb' | 'index' | 'middle' | 'ring' | 'pinky';
export type FingerState = 'open' | 'closed';
export type FingerRequirement = 'open' | 'closed' | 'any';

export interface FingerConfig {
  thumb?: FingerRequirement;
  index?: FingerRequirement;
  middle?: FingerRequirement;
  ring?: FingerRequirement;
  pinky?: FingerRequirement;
}

export type GestureType = 'hand' | 'eye' | 'head';

export interface Gesture {
  id?: string;
  name: string;
  type?: GestureType;
  action: string;
  actionArg?: string;
  fingers?: FingerConfig;
  holdTime?: number;
  holdDuration?: number;
  threshold?: number;
  eyeAction?: string;
  headAction?: string;
}

export type GestureState =
  | 'idle'
  | 'holding'
  | 'triggered'
  | 'cooldown'
  | 'cancelled';

export interface GestureHoldProgress {
  gesture: Gesture;
  state: GestureState;
  progress: number; // 0.0 to 1.0
  elapsed: number; // in milliseconds
  threshold: number; // in milliseconds
  specificity: number;
}

export const FINGER_NAMES: readonly FingerName[] = [
  'thumb',
  'index',
  'middle',
  'ring',
  'pinky',
] as const;

/**
 * Validates normalized landmark coordinates.
 */
export function validateLandmarkBounds(
  landmarks: Array<{ x: number; y: number }>,
): boolean {
  if (!landmarks || landmarks.length < 21) {
    return false;
  }
  for (const lm of landmarks) {
    if (lm == null || typeof lm.x !== 'number' || typeof lm.y !== 'number') {
      return false;
    }
    if (isNaN(lm.x) || isNaN(lm.y)) {
      return false;
    }
    // Normalized coordinates should fall within reasonable bounds
    if (lm.x < -0.2 || lm.x > 1.2 || lm.y < -0.2 || lm.y > 1.2) {
      return false;
    }
  }
  return true;
}

/**
 * Calculate the specificity score of a hand gesture.
 * Specificity is the count of explicitly defined finger constraints ('open' or 'closed').
 * Wildcards ('any') or unspecified fingers score 0.
 * A gesture with all 5 fingers defined scores 5; a gesture with 1 finger defined scores 1.
 */
export function calculateGestureSpecificity(
  gesture: Gesture | null | undefined,
): number {
  if (!gesture || !gesture.fingers || typeof gesture.fingers !== 'object') {
    return 0;
  }
  let score = 0;
  for (const finger of FINGER_NAMES) {
    const req = gesture.fingers[finger];
    if (req === 'open' || req === 'closed') {
      score += 1;
    }
  }
  return score;
}

/**
 * Sort gestures in descending order of specificity score.
 * Stable sort: preserves array position for gestures with identical specificity.
 */
export function rankGesturesBySpecificity(gestures: Gesture[]): Gesture[] {
  if (!gestures || gestures.length === 0) {
    return [];
  }
  return [...gestures].sort((a, b) => {
    return calculateGestureSpecificity(b) - calculateGestureSpecificity(a);
  });
}

/**
 * Validate and clamp configured hold duration threshold.
 * Clamped between minHold (default 200ms) and maxHold (default 5000ms).
 */
export function validateGestureThreshold(
  gesture: Gesture | null | undefined,
  defaultHoldMs: number = 1000,
  minHoldMs: number = 200,
  maxHoldMs: number = 5000,
): number {
  if (!gesture) return defaultHoldMs;

  const raw = gesture.threshold ?? gesture.holdDuration ?? gesture.holdTime;
  if (raw == null) return defaultHoldMs;

  // If provided in seconds (< 15), convert to milliseconds
  const val = Number(raw);
  if (isNaN(val) || val <= 0) return defaultHoldMs;

  const msVal = val <= 15 ? val * 1000 : val;
  return Math.max(minHoldMs, Math.min(maxHoldMs, msVal));
}

/**
 * Checks if current finger states satisfy a gesture's constraints.
 */
export function matchesFingerStates(
  gesture: Gesture,
  currentState: Record<FingerName, FingerState>,
): boolean {
  if (!gesture.fingers) return false;
  return FINGER_NAMES.every((finger) => {
    const req = gesture.fingers?.[finger];
    return req == null || req === 'any' || req === currentState[finger];
  });
}

/**
 * Evaluates current finger states against configured gestures,
 * ranking candidates by specificity to prevent broad wildcard rules
 * from hijacking triggers intended for specific gestures.
 */
export function matchHandGesture(
  currentState: Record<FingerName, FingerState>,
  gestures: Gesture[],
): {
  matchedGesture: Gesture | null;
  specificity: number;
  rankedMatches: Gesture[];
} {
  if (!gestures || gestures.length === 0) {
    return { matchedGesture: null, specificity: 0, rankedMatches: [] };
  }

  // Filter to hand gestures
  const handGestures = gestures.filter((g) => !g.type || g.type === 'hand');
  const rankedCandidates = rankGesturesBySpecificity(handGestures);

  const rankedMatches: Gesture[] = [];
  for (const g of rankedCandidates) {
    if (matchesFingerStates(g, currentState)) {
      rankedMatches.push(g);
    }
  }

  const topMatch = rankedMatches.length > 0 ? rankedMatches[0] : null;
  const specificity = topMatch ? calculateGestureSpecificity(topMatch) : 0;

  return {
    matchedGesture: topMatch,
    specificity,
    rankedMatches,
  };
}

/**
 * State machine managing hold state transitions and timing.
 * States: IDLE -> HOLDING -> TRIGGERED -> COOLDOWN -> IDLE
 *         HOLDING -> CANCELLED -> IDLE
 */
export class GestureHoldStateMachine {
  private currentState: GestureState = 'idle';
  private activeGesture: Gesture | null = null;
  private holdStartTime: number = 0;
  private cooldownUntil: number = 0;
  private currentThresholdMs: number = 1000;

  constructor(
    private defaultHoldMs: number = 1000,
    private cooldownMs: number = 1500,
  ) {}

  public getState(): GestureState {
    return this.currentState;
  }

  public getActiveGesture(): Gesture | null {
    return this.activeGesture;
  }

  public reset(): void {
    this.currentState = 'idle';
    this.activeGesture = null;
    this.holdStartTime = 0;
    this.cooldownUntil = 0;
  }

  /**
   * Update the state machine on every frame.
   * Returns a progress descriptor or null if idle without active events.
   */
  public update(
    detectedGesture: Gesture | null,
    now: number = Date.now(),
  ): GestureHoldProgress | null {
    const gestureKey = (g: Gesture | null) =>
      g ? g.id || g.name || g.action : null;
    const activeKey = gestureKey(this.activeGesture);
    const detectedKey = gestureKey(detectedGesture);

    // Case 1: In COOLDOWN state
    if (this.currentState === 'cooldown') {
      if (now >= this.cooldownUntil) {
        this.currentState = 'idle';
        this.activeGesture = null;
      } else {
        // Still cooling down
        return {
          gesture: this.activeGesture!,
          state: 'cooldown',
          progress: 1.0,
          elapsed: now - this.holdStartTime,
          threshold: this.currentThresholdMs,
          specificity: calculateGestureSpecificity(this.activeGesture),
        };
      }
    }

    // Case 2: No gesture detected or gesture changed while holding
    if (!detectedGesture || (activeKey && detectedKey !== activeKey)) {
      if (this.currentState === 'holding' && this.activeGesture) {
        // Interrupted before threshold -> CANCELLED
        const cancelledGesture = this.activeGesture;
        const elapsed = now - this.holdStartTime;
        this.currentState = 'idle';
        this.activeGesture = null;
        this.holdStartTime = 0;

        return {
          gesture: cancelledGesture,
          state: 'cancelled',
          progress: 0.0,
          elapsed,
          threshold: this.currentThresholdMs,
          specificity: calculateGestureSpecificity(cancelledGesture),
        };
      }
      this.currentState = 'idle';
      this.activeGesture = null;
      return null;
    }

    // Case 3: Gesture detected
    const threshold = validateGestureThreshold(
      detectedGesture,
      this.defaultHoldMs,
    );

    if (this.currentState === 'idle' || !this.activeGesture) {
      // Transition from IDLE to HOLDING
      this.currentState = 'holding';
      this.activeGesture = detectedGesture;
      this.holdStartTime = now;
      this.currentThresholdMs = threshold;

      return {
        gesture: detectedGesture,
        state: 'holding',
        progress: 0.0,
        elapsed: 0,
        threshold,
        specificity: calculateGestureSpecificity(detectedGesture),
      };
    }

    if (this.currentState === 'holding') {
      const elapsed = now - this.holdStartTime;
      const progress = Math.min(1.0, elapsed / threshold);

      if (elapsed >= threshold) {
        // Threshold reached -> TRIGGERED
        this.currentState = 'cooldown';
        this.cooldownUntil = now + this.cooldownMs;

        return {
          gesture: detectedGesture,
          state: 'triggered',
          progress: 1.0,
          elapsed,
          threshold,
          specificity: calculateGestureSpecificity(detectedGesture),
        };
      }

      // Still holding, report progress
      return {
        gesture: detectedGesture,
        state: 'holding',
        progress,
        elapsed,
        threshold,
        specificity: calculateGestureSpecificity(detectedGesture),
      };
    }

    return null;
  }
}
