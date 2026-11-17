export type FingerState = 'open' | 'closed';

export interface HandState {
  thumb: FingerState;
  index: FingerState;
  middle: FingerState;
  ring: FingerState;
  pinky: FingerState;
}

export interface LandmarkPoint {
  x: number;
  y: number;
  z?: number;
}

export interface GestureConfig {
  id: string;
  name?: string;
  label?: string;
  action?: string;
  actionArg?: string;
  type?: 'hand' | 'eye' | 'head';
  fingers?: {
    thumb?: string;
    index?: string;
    middle?: string;
    ring?: string;
    pinky?: string;
  };
  [key: string]: any;
}

export type GestureEngineState = 'IDLE' | 'HOLDING' | 'TRIGGERED' | 'COOLDOWN';

export interface GestureThresholds {
  minConfidence: number; // Bounds: 0.1 to 1.0 (default 0.5)
  minHoldDurationMs: number; // Bounds: 50ms to 2000ms (default 250ms)
  cooldownDurationMs: number; // Bounds: 200ms to 5000ms (default 1500ms)
  openPalmToggleHoldMs: number; // Bounds: 300ms to 3000ms (default 1000ms)
  fingerMargin: number; // Bounds: 0.0 to 0.1 (default 0.0)
}

export const DEFAULT_THRESHOLDS: GestureThresholds = {
  minConfidence: 0.5,
  minHoldDurationMs: 250,
  cooldownDurationMs: 1500,
  openPalmToggleHoldMs: 1000,
  fingerMargin: 0.0,
};

/**
 * Validates and clamps gesture threshold configuration to safe bounds.
 */
export function validateThresholds(
  thresholds?: Partial<GestureThresholds>,
): GestureThresholds {
  if (!thresholds) return { ...DEFAULT_THRESHOLDS };

  const clamp = (
    val: number | undefined,
    min: number,
    max: number,
    fallback: number,
  ) => {
    if (val === undefined || isNaN(val)) return fallback;
    return Math.max(min, Math.min(max, val));
  };

  return {
    minConfidence: clamp(
      thresholds.minConfidence,
      0.1,
      1.0,
      DEFAULT_THRESHOLDS.minConfidence,
    ),
    minHoldDurationMs: clamp(
      thresholds.minHoldDurationMs,
      50,
      2000,
      DEFAULT_THRESHOLDS.minHoldDurationMs,
    ),
    cooldownDurationMs: clamp(
      thresholds.cooldownDurationMs,
      200,
      5000,
      DEFAULT_THRESHOLDS.cooldownDurationMs,
    ),
    openPalmToggleHoldMs: clamp(
      thresholds.openPalmToggleHoldMs,
      300,
      3000,
      DEFAULT_THRESHOLDS.openPalmToggleHoldMs,
    ),
    fingerMargin: clamp(
      thresholds.fingerMargin,
      0.0,
      0.1,
      DEFAULT_THRESHOLDS.fingerMargin,
    ),
  };
}

/**
 * Computes 2D distance between two landmarks.
 */
export function euclideanDistance(
  p1: LandmarkPoint,
  p2: LandmarkPoint,
): number {
  return Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));
}

/**
 * Computes finger extension states from MediaPipe 21 hand landmarks.
 */
export function computeFingerStates(
  landmarks: LandmarkPoint[],
  margin: number = 0.0,
): HandState | null {
  if (!landmarks || landmarks.length < 21) {
    return null;
  }

  const wrist = landmarks[0];
  const pinkyMcp = landmarks[17];

  // Helper: Finger is open if tip distance to wrist exceeds PIP distance to wrist + margin
  const isFingerOpen = (tipIdx: number, pipIdx: number) =>
    euclideanDistance(landmarks[tipIdx], wrist) >
    euclideanDistance(landmarks[pipIdx], wrist) + margin;

  // Thumb: Tip (4) distance to Pinky MCP (17) vs Thumb IP (3) distance to Pinky MCP (17)
  const isThumbOpen =
    euclideanDistance(landmarks[4], pinkyMcp) >
    euclideanDistance(landmarks[3], pinkyMcp) + margin;

  return {
    thumb: isThumbOpen ? 'open' : 'closed',
    index: isFingerOpen(8, 6) ? 'open' : 'closed',
    middle: isFingerOpen(12, 10) ? 'open' : 'closed',
    ring: isFingerOpen(16, 14) ? 'open' : 'closed',
    pinky: isFingerOpen(20, 18) ? 'open' : 'closed',
  };
}

/**
 * Checks whether the current hand state matches an open palm (all 5 fingers open).
 */
export function isOpenPalm(state: HandState): boolean {
  return (
    state.thumb === 'open' &&
    state.index === 'open' &&
    state.middle === 'open' &&
    state.ring === 'open' &&
    state.pinky === 'open'
  );
}

/**
 * Matches a detected hand state against a configured gesture rule.
 */
export function matchesGesture(
  currentState: HandState,
  gesture: GestureConfig,
): boolean {
  if (!gesture.fingers) return false;
  const fingers: (keyof HandState)[] = [
    'thumb',
    'index',
    'middle',
    'ring',
    'pinky',
  ];
  return fingers.every((f) => {
    const required = gesture.fingers?.[f];
    return !required || required === 'any' || required === currentState[f];
  });
}

/**
 * Identifies the first matching gesture from an array of configured gestures.
 */
export function findMatchingGesture(
  currentState: HandState,
  gestures: GestureConfig[],
): GestureConfig | null {
  for (const g of gestures) {
    if (matchesGesture(currentState, g)) {
      return g;
    }
  }
  return null;
}

export interface GestureStateUpdate {
  state: GestureEngineState;
  candidateGesture: GestureConfig | null;
  triggeredGesture: GestureConfig | null;
  holdProgress: number; // 0.0 to 1.0 (immediate feedback during hold)
  elapsedHoldMs: number;
  message?: string;
}

/**
 * State machine managing gesture detection, hold threshold validation,
 * immediate feedback, and spurious trigger prevention.
 */
export class GestureStateMachine {
  private _state: GestureEngineState = 'IDLE';
  private _candidate: GestureConfig | null = null;
  private _holdStartTime: number = 0;
  private _lastTriggerTime: number = 0;
  private _thresholds: GestureThresholds;

  constructor(thresholds?: Partial<GestureThresholds>) {
    this._thresholds = validateThresholds(thresholds);
  }

  get state(): GestureEngineState {
    return this._state;
  }

  get candidate(): GestureConfig | null {
    return this._candidate;
  }

  get thresholds(): GestureThresholds {
    return this._thresholds;
  }

  public setThresholds(thresholds: Partial<GestureThresholds>): void {
    this._thresholds = validateThresholds({
      ...this._thresholds,
      ...thresholds,
    });
  }

  public reset(): void {
    this._state = 'IDLE';
    this._candidate = null;
    this._holdStartTime = 0;
  }

  /**
   * Processes a new frame's candidate gesture at a given timestamp.
   * Enforces transition boundaries:
   * - IDLE -> HOLDING
   * - HOLDING -> TRIGGERED (if held >= minHoldDurationMs)
   * - HOLDING -> IDLE (if interrupted or mismatched, zero false triggers)
   * - TRIGGERED -> COOLDOWN
   * - COOLDOWN -> IDLE (when cooldown expired)
   */
  public update(
    detectedGesture: GestureConfig | null,
    now: number = Date.now(),
  ): GestureStateUpdate {
    // 1. Handle COOLDOWN expiration
    if (this._state === 'COOLDOWN') {
      const elapsedCooldown = now - this._lastTriggerTime;
      if (elapsedCooldown < this._thresholds.cooldownDurationMs) {
        return {
          state: 'COOLDOWN',
          candidateGesture: null,
          triggeredGesture: null,
          holdProgress: 0,
          elapsedHoldMs: 0,
          message: `In cooldown (${Math.round(this._thresholds.cooldownDurationMs - elapsedCooldown)}ms remaining)`,
        };
      }
      // Cooldown expired, transition to IDLE
      this._state = 'IDLE';
      this._candidate = null;
      this._holdStartTime = 0;
    }

    // 2. Handle IDLE state
    if (this._state === 'IDLE') {
      if (!detectedGesture) {
        return {
          state: 'IDLE',
          candidateGesture: null,
          triggeredGesture: null,
          holdProgress: 0,
          elapsedHoldMs: 0,
        };
      }

      // Transition to HOLDING on candidate detection
      this._state = 'HOLDING';
      this._candidate = detectedGesture;
      this._holdStartTime = now;

      return {
        state: 'HOLDING',
        candidateGesture: detectedGesture,
        triggeredGesture: null,
        holdProgress: 0,
        elapsedHoldMs: 0,
        message: `Candidate detected: ${detectedGesture.name || detectedGesture.id}. Validating hold threshold...`,
      };
    }

    // 3. Handle HOLDING state
    if (this._state === 'HOLDING') {
      // If gesture interrupted, lost, or candidate switched:
      if (!detectedGesture || detectedGesture.id !== this._candidate?.id) {
        // Interrupted before hold threshold: reset to IDLE without spurious trigger
        this._state = 'IDLE';
        this._candidate = null;
        this._holdStartTime = 0;

        return {
          state: 'IDLE',
          candidateGesture: null,
          triggeredGesture: null,
          holdProgress: 0,
          elapsedHoldMs: 0,
          message: 'Hold interrupted. State reset to IDLE.',
        };
      }

      const elapsed = Math.max(0, now - this._holdStartTime);
      const progress = Math.min(
        1.0,
        elapsed / this._thresholds.minHoldDurationMs,
      );

      // Check if hold duration exceeds threshold bound
      if (elapsed >= this._thresholds.minHoldDurationMs) {
        this._state = 'TRIGGERED';
        this._lastTriggerTime = now;
        const triggered = this._candidate;

        return {
          state: 'TRIGGERED',
          candidateGesture: triggered,
          triggeredGesture: triggered,
          holdProgress: 1.0,
          elapsedHoldMs: elapsed,
          message: `Gesture triggered: ${triggered.name || triggered.id}`,
        };
      }

      // Still holding, provide immediate feedback
      return {
        state: 'HOLDING',
        candidateGesture: this._candidate,
        triggeredGesture: null,
        holdProgress: progress,
        elapsedHoldMs: elapsed,
        message: `Holding: ${Math.round(progress * 100)}%`,
      };
    }

    // 4. Handle TRIGGERED state: Next frame automatically enters COOLDOWN
    if (this._state === 'TRIGGERED') {
      this._state = 'COOLDOWN';
      this._candidate = null;
      this._holdStartTime = 0;

      return {
        state: 'COOLDOWN',
        candidateGesture: null,
        triggeredGesture: null,
        holdProgress: 0,
        elapsedHoldMs: 0,
        message:
          'Entering cooldown lockout to prevent spurious repeat triggers.',
      };
    }

    return {
      state: 'IDLE',
      candidateGesture: null,
      triggeredGesture: null,
      holdProgress: 0,
      elapsedHoldMs: 0,
    };
  }
}
