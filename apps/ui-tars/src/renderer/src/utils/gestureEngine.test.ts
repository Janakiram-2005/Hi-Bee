import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_THRESHOLDS,
  validateThresholds,
  euclideanDistance,
  computeFingerStates,
  isOpenPalm,
  matchesGesture,
  findMatchingGesture,
  GestureStateMachine,
  GestureConfig,
  HandState,
  LandmarkPoint,
} from './gestureEngine';

describe('Gesture Engine - Threshold Validation', () => {
  it('returns default thresholds when undefined is passed', () => {
    const thresholds = validateThresholds();
    expect(thresholds).toEqual(DEFAULT_THRESHOLDS);
  });

  it('clamps thresholds to defined minimum and maximum bounds', () => {
    const clamped = validateThresholds({
      minConfidence: 0.01, // below min 0.1
      minHoldDurationMs: 10, // below min 50ms
      cooldownDurationMs: 10000, // above max 5000ms
      openPalmToggleHoldMs: 100, // below min 300ms
      fingerMargin: 0.5, // above max 0.1
    });

    expect(clamped.minConfidence).toBe(0.1);
    expect(clamped.minHoldDurationMs).toBe(50);
    expect(clamped.cooldownDurationMs).toBe(5000);
    expect(clamped.openPalmToggleHoldMs).toBe(300);
    expect(clamped.fingerMargin).toBe(0.1);
  });

  it('preserves valid custom threshold bounds', () => {
    const custom = validateThresholds({
      minConfidence: 0.8,
      minHoldDurationMs: 300,
      cooldownDurationMs: 2000,
      openPalmToggleHoldMs: 1200,
      fingerMargin: 0.05,
    });

    expect(custom.minConfidence).toBe(0.8);
    expect(custom.minHoldDurationMs).toBe(300);
    expect(custom.cooldownDurationMs).toBe(2000);
    expect(custom.openPalmToggleHoldMs).toBe(1200);
    expect(custom.fingerMargin).toBe(0.05);
  });
});

describe('Gesture Engine - Euclidean Distance', () => {
  it('computes 2D distance correctly', () => {
    const p1 = { x: 0, y: 0 };
    const p2 = { x: 3, y: 4 };
    expect(euclideanDistance(p1, p2)).toBe(5);
  });
});

describe('Gesture Engine - Finger State Classification', () => {
  const createMockLandmarks = (fingerExtends: boolean[]): LandmarkPoint[] => {
    // 21 landmarks
    const landmarks: LandmarkPoint[] = Array.from({ length: 21 }, () => ({
      x: 0.5,
      y: 0.5,
    }));
    // Wrist at (0.5, 0.9)
    landmarks[0] = { x: 0.5, y: 0.9 };
    // Pinky MCP (17) at (0.3, 0.7)
    landmarks[17] = { x: 0.3, y: 0.7 };

    // Thumb: IP (3) and Tip (4)
    if (fingerExtends[0]) {
      landmarks[3] = { x: 0.5, y: 0.7 }; // dist to pinky MCP = 0.2
      landmarks[4] = { x: 0.8, y: 0.7 }; // dist to pinky MCP = 0.5 (open)
    } else {
      landmarks[3] = { x: 0.4, y: 0.7 }; // dist to pinky MCP = 0.1
      landmarks[4] = { x: 0.35, y: 0.7 }; // dist to pinky MCP = 0.05 (closed)
    }

    // Fingers: [index, middle, ring, pinky] -> indices [8/6, 12/10, 16/14, 20/18]
    const fingerIndices = [
      { tip: 8, pip: 6 },
      { tip: 12, pip: 10 },
      { tip: 16, pip: 14 },
      { tip: 20, pip: 18 },
    ];

    fingerIndices.forEach(({ tip, pip }, idx) => {
      const isExtended = fingerExtends[idx + 1];
      // Wrist is at y = 0.9. Extended tip is at y = 0.2 (further from wrist = 0.7)
      // Closed tip is at y = 0.7 (closer to wrist than PIP at y = 0.5)
      if (isExtended) {
        landmarks[pip] = { x: 0.5, y: 0.5 }; // dist to wrist = 0.4
        landmarks[tip] = { x: 0.5, y: 0.2 }; // dist to wrist = 0.7 (open)
      } else {
        landmarks[pip] = { x: 0.5, y: 0.5 }; // dist to wrist = 0.4
        landmarks[tip] = { x: 0.5, y: 0.6 }; // dist to wrist = 0.3 (closed)
      }
    });

    return landmarks;
  };

  it('returns null if landmarks array is missing or fewer than 21 points', () => {
    expect(computeFingerStates([])).toBeNull();
    expect(computeFingerStates(Array(20).fill({ x: 0, y: 0 }))).toBeNull();
  });

  it('correctly classifies all open fingers (open palm)', () => {
    const landmarks = createMockLandmarks([true, true, true, true, true]);
    const state = computeFingerStates(landmarks);
    expect(state).toEqual({
      thumb: 'open',
      index: 'open',
      middle: 'open',
      ring: 'open',
      pinky: 'open',
    });
    expect(isOpenPalm(state!)).toBe(true);
  });

  it('correctly classifies fist (all fingers closed)', () => {
    const landmarks = createMockLandmarks([false, false, false, false, false]);
    const state = computeFingerStates(landmarks);
    expect(state).toEqual({
      thumb: 'closed',
      index: 'closed',
      middle: 'closed',
      ring: 'closed',
      pinky: 'closed',
    });
    expect(isOpenPalm(state!)).toBe(false);
  });

  it('correctly classifies pointing finger (index open, others closed)', () => {
    const landmarks = createMockLandmarks([false, true, false, false, false]);
    const state = computeFingerStates(landmarks);
    expect(state).toEqual({
      thumb: 'closed',
      index: 'open',
      middle: 'closed',
      ring: 'closed',
      pinky: 'closed',
    });
    expect(isOpenPalm(state!)).toBe(false);
  });
});

describe('Gesture Engine - Gesture Matching', () => {
  const handState: HandState = {
    thumb: 'closed',
    index: 'open',
    middle: 'closed',
    ring: 'closed',
    pinky: 'closed',
  };

  it('matches exact gesture rules', () => {
    const gesture: GestureConfig = {
      id: 'point',
      fingers: {
        thumb: 'closed',
        index: 'open',
        middle: 'closed',
        ring: 'closed',
        pinky: 'closed',
      },
    };
    expect(matchesGesture(handState, gesture)).toBe(true);
  });

  it('matches wildcard "any" finger rules', () => {
    const gesture: GestureConfig = {
      id: 'any-thumb',
      fingers: {
        thumb: 'any',
        index: 'open',
        middle: 'closed',
        ring: 'any',
        pinky: 'closed',
      },
    };
    expect(matchesGesture(handState, gesture)).toBe(true);
  });

  it('rejects mismatched gesture rules', () => {
    const gesture: GestureConfig = {
      id: 'peace',
      fingers: {
        thumb: 'closed',
        index: 'open',
        middle: 'open',
        ring: 'closed',
        pinky: 'closed',
      },
    };
    expect(matchesGesture(handState, gesture)).toBe(false);
  });

  it('finds the matching gesture from a library', () => {
    const gestures: GestureConfig[] = [
      {
        id: 'thumbs_up',
        fingers: {
          thumb: 'open',
          index: 'closed',
          middle: 'closed',
          ring: 'closed',
          pinky: 'closed',
        },
      },
      {
        id: 'point',
        fingers: {
          thumb: 'closed',
          index: 'open',
          middle: 'closed',
          ring: 'closed',
          pinky: 'closed',
        },
      },
    ];
    const match = findMatchingGesture(handState, gestures);
    expect(match?.id).toBe('point');
  });
});

describe('Gesture Engine - State Machine Transition Boundaries (100% Coverage)', () => {
  let sm: GestureStateMachine;
  const mockGesture: GestureConfig = {
    id: 'test-gesture-1',
    name: 'Test Point',
    action: 'volume_up',
  };
  const otherGesture: GestureConfig = {
    id: 'test-gesture-2',
    name: 'Test Peace',
    action: 'volume_down',
  };

  beforeEach(() => {
    sm = new GestureStateMachine({
      minHoldDurationMs: 200,
      cooldownDurationMs: 1000,
    });
  });

  it('Boundary 1: Starts in IDLE and remains IDLE when no gesture is detected', () => {
    expect(sm.state).toBe('IDLE');
    expect(sm.candidate).toBeNull();

    const update = sm.update(null, 1000);
    expect(update.state).toBe('IDLE');
    expect(update.triggeredGesture).toBeNull();
    expect(update.holdProgress).toBe(0);
  });

  it('Boundary 2: Transitions IDLE -> HOLDING immediately upon candidate detection with 0 progress', () => {
    const update = sm.update(mockGesture, 1000);
    expect(update.state).toBe('HOLDING');
    expect(update.candidateGesture?.id).toBe('test-gesture-1');
    expect(update.triggeredGesture).toBeNull();
    expect(update.holdProgress).toBe(0);
    expect(sm.state).toBe('HOLDING');
  });

  it('Boundary 3: HOLDING emits immediate feedback (proportional progress) within latency bounds', () => {
    sm.update(mockGesture, 1000); // start at t=1000
    const halfWay = sm.update(mockGesture, 1100); // 100ms into 200ms threshold
    expect(halfWay.state).toBe('HOLDING');
    expect(halfWay.holdProgress).toBe(0.5);
    expect(halfWay.elapsedHoldMs).toBe(100);
    expect(halfWay.triggeredGesture).toBeNull();
  });

  it('Boundary 4: Transitions HOLDING -> TRIGGERED when hold duration reaches threshold bound', () => {
    sm.update(mockGesture, 1000);
    sm.update(mockGesture, 1150);
    const triggered = sm.update(mockGesture, 1200); // exactly 200ms
    expect(triggered.state).toBe('TRIGGERED');
    expect(triggered.triggeredGesture?.id).toBe('test-gesture-1');
    expect(triggered.holdProgress).toBe(1.0);
    expect(sm.state).toBe('TRIGGERED');
  });

  it('Boundary 5: Zero spurious triggers: HOLDING -> IDLE when gesture is lost or changed before threshold', () => {
    sm.update(mockGesture, 1000);
    // Transient glitch lasting 80ms then lost
    const lostUpdate = sm.update(null, 1080);
    expect(lostUpdate.state).toBe('IDLE');
    expect(lostUpdate.triggeredGesture).toBeNull();
    expect(sm.state).toBe('IDLE');
    expect(sm.candidate).toBeNull();

    // Switched gesture before threshold also resets without false trigger
    sm.update(mockGesture, 1200);
    const switchedUpdate = sm.update(otherGesture, 1250);
    expect(switchedUpdate.state).toBe('IDLE');
    expect(switchedUpdate.triggeredGesture).toBeNull();
  });

  it('Boundary 6: Transitions TRIGGERED -> COOLDOWN on subsequent frame', () => {
    sm.update(mockGesture, 1000);
    sm.update(mockGesture, 1200); // triggers
    expect(sm.state).toBe('TRIGGERED');

    const cooldownUpdate = sm.update(mockGesture, 1216); // next frame 16ms later
    expect(cooldownUpdate.state).toBe('COOLDOWN');
    expect(cooldownUpdate.triggeredGesture).toBeNull();
    expect(sm.state).toBe('COOLDOWN');
  });

  it('Boundary 7: COOLDOWN suppresses triggers during lockout period', () => {
    sm.update(mockGesture, 1000);
    sm.update(mockGesture, 1200); // triggered at 1200, cooldown until 2200
    sm.update(mockGesture, 1216); // in cooldown

    const inCooldown = sm.update(mockGesture, 1800);
    expect(inCooldown.state).toBe('COOLDOWN');
    expect(inCooldown.triggeredGesture).toBeNull();
  });

  it('Boundary 8: Transitions COOLDOWN -> IDLE after cooldown period expires and allows immediate retry', () => {
    sm.update(mockGesture, 1000);
    sm.update(mockGesture, 1200); // triggered at 1200, cooldown is 1000ms (until 2200)
    sm.update(mockGesture, 1216);

    // After cooldown expires at 2201 with no gesture:
    const expiredEmpty = sm.update(null, 2205);
    expect(expiredEmpty.state).toBe('IDLE');
    expect(sm.state).toBe('IDLE');

    // Immediate retry with a new gesture now successfully starts HOLDING
    const retryUpdate = sm.update(otherGesture, 2250);
    expect(retryUpdate.state).toBe('HOLDING');
    expect(retryUpdate.candidateGesture?.id).toBe('test-gesture-2');
  });

  it('Boundary 9: Manual reset returns state machine to clean IDLE state', () => {
    sm.update(mockGesture, 1000);
    expect(sm.state).toBe('HOLDING');
    sm.reset();
    expect(sm.state).toBe('IDLE');
    expect(sm.candidate).toBeNull();
  });

  it('Boundary 10: Dynamic threshold updates modify bounds', () => {
    sm.setThresholds({ minHoldDurationMs: 400 });
    expect(sm.thresholds.minHoldDurationMs).toBe(400);

    sm.update(mockGesture, 1000);
    // At 250ms, with previous 200ms threshold it would trigger; with 400ms it remains HOLDING
    const update = sm.update(mockGesture, 1250);
    expect(update.state).toBe('HOLDING');
    expect(update.holdProgress).toBe(250 / 400);
  });
});
