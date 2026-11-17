import { describe, it, expect } from 'vitest';
import {
  calculateGestureSpecificity,
  rankGesturesBySpecificity,
  matchHandGesture,
  validateLandmarkBounds,
  validateGestureThreshold,
  GestureHoldStateMachine,
  Gesture,
  FingerName,
  FingerState,
} from './gestureRecognition';

describe('Gesture Recognition', () => {
  it('calculates gesture specificity', () => {
    const specific5: Gesture = {
      name: 'L-Shape',
      action: 'volume_up',
      fingers: {
        thumb: 'open',
        index: 'open',
        middle: 'closed',
        ring: 'closed',
        pinky: 'closed',
      },
    };
    expect(calculateGestureSpecificity(specific5)).toBe(5);

    const partial2: Gesture = {
      name: 'Pointing',
      action: 'click',
      fingers: {
        thumb: 'any',
        index: 'open',
        middle: 'closed',
        ring: 'any',
        pinky: 'any',
      },
    };
    expect(calculateGestureSpecificity(partial2)).toBe(2);

    const wildcard0: Gesture = {
      name: 'Wildcard',
      action: 'noop',
      fingers: {
        thumb: 'any',
        index: 'any',
        middle: 'any',
        ring: 'any',
        pinky: 'any',
      },
    };
    expect(calculateGestureSpecificity(wildcard0)).toBe(0);

    expect(calculateGestureSpecificity(null)).toBe(0);
    expect(calculateGestureSpecificity({ name: 'empty', action: 'none' })).toBe(
      0,
    );
  });

  it('ranks gestures by specificity', () => {
    const g1: Gesture = {
      name: 'Broad',
      action: 'a1',
      fingers: { index: 'open' },
    }; // spec 1
    const g2: Gesture = {
      name: 'Specific',
      action: 'a2',
      fingers: {
        thumb: 'open',
        index: 'open',
        middle: 'closed',
        ring: 'closed',
        pinky: 'closed',
      },
    }; // spec 5
    const g3: Gesture = {
      name: 'Moderate',
      action: 'a3',
      fingers: { thumb: 'open', index: 'open', middle: 'closed' },
    }; // spec 3
    const g4: Gesture = {
      name: 'Tie1',
      action: 'a4',
      fingers: { thumb: 'closed', index: 'closed' },
    }; // spec 2
    const g5: Gesture = {
      name: 'Tie2',
      action: 'a5',
      fingers: { middle: 'closed', ring: 'closed' },
    }; // spec 2

    const ranked = rankGesturesBySpecificity([g1, g4, g5, g2, g3]);
    const names = ranked.map((g) => g.name);
    expect(names[0]).toBe('Specific');
    expect(names[1]).toBe('Moderate');
    expect(names[2]).toBe('Tie1');
    expect(names[3]).toBe('Tie2');
    expect(names[4]).toBe('Broad');
  });

  it('resolves unranked evaluation swallowing', () => {
    const broadRule: Gesture = {
      id: 'g-broad',
      name: 'Broad Rule',
      action: 'generic_scroll',
      fingers: {
        thumb: 'any',
        index: 'open',
        middle: 'any',
        ring: 'any',
        pinky: 'any',
      },
    };

    const specificRule: Gesture = {
      id: 'g-lshape',
      name: 'L-Shape',
      action: 'volume_up',
      fingers: {
        thumb: 'open',
        index: 'open',
        middle: 'closed',
        ring: 'closed',
        pinky: 'closed',
      },
    };

    // Broad rule placed FIRST in configured array
    const configuredGestures = [broadRule, specificRule];

    const currentStates: Record<FingerName, FingerState> = {
      thumb: 'open',
      index: 'open',
      middle: 'closed',
      ring: 'closed',
      pinky: 'closed',
    };

    const { matchedGesture, specificity, rankedMatches } = matchHandGesture(
      currentStates,
      configuredGestures,
    );

    expect(rankedMatches.length).toBe(2);
    expect(matchedGesture).not.toBeNull();
    expect(matchedGesture?.id).toBe('g-lshape');
    expect(matchedGesture?.action).toBe('volume_up');
    expect(specificity).toBe(5);
  });

  it('validates threshold bounds', () => {
    expect(validateGestureThreshold(null, 1000)).toBe(1000);
    expect(
      validateGestureThreshold({ name: 'g', action: 'a', threshold: 800 }),
    ).toBe(800);
    expect(
      validateGestureThreshold({ name: 'g', action: 'a', holdTime: 1.2 }),
    ).toBe(1200);
    expect(
      validateGestureThreshold({ name: 'g', action: 'a', threshold: 50 }),
    ).toBe(200);
    expect(
      validateGestureThreshold({ name: 'g', action: 'a', threshold: 90000 }),
    ).toBe(5000);

    const validLandmarks = Array.from({ length: 21 }, () => ({
      x: 0.5,
      y: 0.5,
    }));
    expect(validateLandmarkBounds(validLandmarks)).toBe(true);

    const shortLandmarks = Array.from({ length: 10 }, () => ({
      x: 0.5,
      y: 0.5,
    }));
    expect(validateLandmarkBounds(shortLandmarks)).toBe(false);

    const oobLandmarks = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5 }));
    oobLandmarks[4] = { x: 3.0, y: 0.5 };
    expect(validateLandmarkBounds(oobLandmarks)).toBe(false);

    const nanLandmarks = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5 }));
    nanLandmarks[4] = { x: NaN, y: 0.5 };
    expect(validateLandmarkBounds(nanLandmarks)).toBe(false);
  });

  it('handles state machine lifecycle and transition boundaries', () => {
    const sm = new GestureHoldStateMachine(1000, 1500);

    const gesture: Gesture = {
      id: 'g-test',
      name: 'Test Gesture',
      action: 'test_action',
      holdTime: 1.0,
      fingers: {
        thumb: 'open',
        index: 'open',
        middle: 'closed',
        ring: 'closed',
        pinky: 'closed',
      },
    };

    // T = 0ms: First detected -> transitions to holding with progress 0
    const ev0 = sm.update(gesture, 10000);
    expect(ev0).not.toBeNull();
    expect(ev0?.state).toBe('holding');
    expect(ev0?.progress).toBe(0);
    expect(ev0?.specificity).toBe(5);

    // T = 500ms: Halfway -> holding with progress 0.5
    const ev500 = sm.update(gesture, 10500);
    expect(ev500?.state).toBe('holding');
    expect(Math.abs((ev500?.progress ?? 0) - 0.5)).toBeLessThan(0.01);

    // T = 1000ms: Threshold reached -> triggered
    const ev1000 = sm.update(gesture, 11000);
    expect(ev1000?.state).toBe('triggered');
    expect(ev1000?.progress).toBe(1.0);

    // T = 1200ms: Cooldown active -> no new trigger
    const ev1200 = sm.update(gesture, 11200);
    expect(ev1200?.state).toBe('cooldown');

    // T = 13000ms: Cooldown expired and hand dropped -> idle
    sm.update(null, 13000);
    expect(sm.getState()).toBe('idle');

    // Interruption scenario (Fallback recovery):
    // T = 20000ms: Start hold
    sm.update(gesture, 20000);
    expect(sm.getState()).toBe('holding');

    // T = 20400ms: User drops gesture early (< 1000ms)
    const cancelEv = sm.update(null, 20400);
    expect(cancelEv?.state).toBe('cancelled');
    expect(sm.getState()).toBe('idle');

    // Immediate retry:
    const retryEv = sm.update(gesture, 20500);
    expect(retryEv?.state).toBe('holding');
  });
});
