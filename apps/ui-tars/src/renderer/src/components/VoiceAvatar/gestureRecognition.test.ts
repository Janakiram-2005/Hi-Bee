import { describe, it } from 'vitest';
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

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertEqual(actual: any, expected: any, message: string) {
  if (actual !== expected) {
    throw new Error(
      `Assertion failed: ${message} (Expected ${expected}, got ${actual})`,
    );
  }
}

describe('gestureRecognition', () => {
  it('runs gesture recognition unit tests', () => {
    console.log('--- Running Gesture Recognition Unit Tests ---');

    // Test 1: Specificity calculation
    {
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
      assertEqual(
        calculateGestureSpecificity(specific5),
        5,
        '5 defined fingers should have specificity 5',
      );

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
      assertEqual(
        calculateGestureSpecificity(partial2),
        2,
        '2 defined fingers should have specificity 2',
      );

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
      assertEqual(
        calculateGestureSpecificity(wildcard0),
        0,
        'All wildcards should have specificity 0',
      );

      assertEqual(
        calculateGestureSpecificity(null),
        0,
        'Null gesture should have specificity 0',
      );
      assertEqual(
        calculateGestureSpecificity({ name: 'empty', action: 'none' }),
        0,
        'No fingers object should have specificity 0',
      );
      console.log('✓ Specificity calculation tests passed');
    }

    // Test 2: Specificity ranking
    {
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
      assertEqual(names[0], 'Specific', 'Rank 0 should be Specific (spec 5)');
      assertEqual(names[1], 'Moderate', 'Rank 1 should be Moderate (spec 3)');
      assertEqual(names[2], 'Tie1', 'Tie1 should retain position before Tie2');
      assertEqual(names[3], 'Tie2', 'Tie2 should retain position after Tie1');
      assertEqual(names[4], 'Broad', 'Rank 4 should be Broad (spec 1)');
      console.log('✓ Specificity ranking tests passed');
    }

    // Test 3: Unranked evaluation swallowing resolved
    {
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

      // Both match, but specificRule MUST be selected!
      assertEqual(rankedMatches.length, 2, 'Both rules match hand states');
      assert(matchedGesture !== null, 'A matching gesture should be found');
      assertEqual(
        matchedGesture?.id,
        'g-lshape',
        'Specific gesture should NOT be swallowed by broad rule',
      );
      assertEqual(
        matchedGesture?.action,
        'volume_up',
        'Matched action should be volume_up',
      );
      assertEqual(specificity, 5, 'Reported specificity should be 5');
      console.log('✓ Unranked evaluation swallowing resolved tests passed');
    }

    // Test 4: Threshold bounds validation
    {
      assertEqual(
        validateGestureThreshold(null, 1000),
        1000,
        'Null gesture returns default threshold',
      );
      assertEqual(
        validateGestureThreshold({ name: 'g', action: 'a', threshold: 800 }),
        800,
        'Direct ms threshold used',
      );
      assertEqual(
        validateGestureThreshold({ name: 'g', action: 'a', holdTime: 1.2 }),
        1200,
        'Seconds converted to ms',
      );
      assertEqual(
        validateGestureThreshold({ name: 'g', action: 'a', threshold: 50 }),
        200,
        'Clamped to min 200ms',
      );
      assertEqual(
        validateGestureThreshold({ name: 'g', action: 'a', threshold: 90000 }),
        5000,
        'Clamped to max 5000ms',
      );

      const validLandmarks = Array.from({ length: 21 }, () => ({
        x: 0.5,
        y: 0.5,
      }));
      assertEqual(
        validateLandmarkBounds(validLandmarks),
        true,
        'Valid landmarks pass',
      );

      const shortLandmarks = Array.from({ length: 10 }, () => ({
        x: 0.5,
        y: 0.5,
      }));
      assertEqual(
        validateLandmarkBounds(shortLandmarks),
        false,
        'Too few landmarks fail',
      );

      const oobLandmarks = Array.from({ length: 21 }, () => ({
        x: 0.5,
        y: 0.5,
      }));
      oobLandmarks[4] = { x: 3.0, y: 0.5 };
      assertEqual(
        validateLandmarkBounds(oobLandmarks),
        false,
        'Out of bounds landmarks fail',
      );

      const nanLandmarks = Array.from({ length: 21 }, () => ({
        x: 0.5,
        y: 0.5,
      }));
      nanLandmarks[4] = { x: NaN, y: 0.5 };
      assertEqual(
        validateLandmarkBounds(nanLandmarks),
        false,
        'NaN landmarks fail',
      );
      console.log('✓ Threshold bounds validation tests passed');
    }

    // Test 5: State Machine Lifecycle and Transition Boundaries
    {
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
      assert(ev0 !== null, 'Event expected at start');
      assertEqual(ev0?.state, 'holding', 'State should be holding');
      assertEqual(ev0?.progress, 0, 'Progress should be 0');
      assertEqual(ev0?.specificity, 5, 'Specificity should be 5');

      // T = 500ms: Halfway -> holding with progress 0.5
      const ev500 = sm.update(gesture, 10500);
      assertEqual(ev500?.state, 'holding', 'State should still be holding');
      assert(
        Math.abs((ev500?.progress ?? 0) - 0.5) < 0.01,
        'Progress should be approx 0.5',
      );

      // T = 1000ms: Threshold reached -> triggered
      const ev1000 = sm.update(gesture, 11000);
      assertEqual(ev1000?.state, 'triggered', 'State should be triggered');
      assertEqual(ev1000?.progress, 1.0, 'Progress should be 1.0');

      // T = 1200ms: Cooldown active -> no new trigger
      const ev1200 = sm.update(gesture, 11200);
      assertEqual(ev1200?.state, 'cooldown', 'State should be cooldown');

      // T = 13000ms: Cooldown expired and hand dropped -> idle
      sm.update(null, 13000);
      assertEqual(sm.getState(), 'idle', 'State should return to idle');

      // Interruption scenario (Fallback recovery):
      // T = 20000ms: Start hold
      sm.update(gesture, 20000);
      assertEqual(sm.getState(), 'holding', 'Holding started');

      // T = 20400ms: User drops gesture early (< 1000ms)
      const cancelEv = sm.update(null, 20400);
      assertEqual(
        cancelEv?.state,
        'cancelled',
        'Interrupted hold should emit cancelled event',
      );
      assertEqual(sm.getState(), 'idle', 'State should reset to idle');

      // Immediate retry:
      const retryEv = sm.update(gesture, 20500);
      assertEqual(
        retryEv?.state,
        'holding',
        'Immediate retry should start holding cleanly',
      );

      console.log(
        '✓ State machine lifecycle and transition boundary tests passed',
      );
    }

    console.log('All frontend gesture recognition tests passed successfully!');
  });
});
