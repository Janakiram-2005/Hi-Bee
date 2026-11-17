import { describe, it, expect } from 'vitest';
import {
  isValidCoordinate,
  isValidLandmark,
  validateAndSanitizeLandmarks,
  euclideanDistance2D,
  euclideanDistance3D,
  computeFingerStates,
  isOpenPalmState,
  extractSanitizedHandLandmarks,
  extractSanitizedFingers,
  extractFeaturesFromTimeline,
  validateAndSanitizeFaceLandmarks,
  computeFaceState,
  NormalizedLandmark,
} from './gestureState';

// Helper to generate a mock hand landmark frame (21 points)
function generateMockHand(
  pose: 'open_palm' | 'fist' | 'l_shape' | 'pointing',
): NormalizedLandmark[] {
  // Base wrist at (0.5, 0.9, 0.0)
  const wrist: NormalizedLandmark = { x: 0.5, y: 0.9, z: 0.0 };
  const landmarks: NormalizedLandmark[] = new Array(21)
    .fill(null)
    .map(() => ({ x: 0.5, y: 0.5, z: 0.0 }));
  landmarks[0] = wrist;

  // Pinky MCP (17)
  landmarks[17] = { x: 0.6, y: 0.7, z: 0.0 };

  if (pose === 'open_palm') {
    // Thumb: IP (3), Tip (4) extended far from pinky MCP
    landmarks[3] = { x: 0.35, y: 0.75, z: 0.0 };
    landmarks[4] = { x: 0.25, y: 0.7, z: 0.0 };

    // Index: PIP (6), Tip (8) extended away from wrist
    landmarks[6] = { x: 0.45, y: 0.6, z: 0.0 };
    landmarks[8] = { x: 0.45, y: 0.3, z: 0.0 };

    // Middle: PIP (10), Tip (12) extended
    landmarks[10] = { x: 0.5, y: 0.6, z: 0.0 };
    landmarks[12] = { x: 0.5, y: 0.25, z: 0.0 };

    // Ring: PIP (14), Tip (16) extended
    landmarks[14] = { x: 0.55, y: 0.6, z: 0.0 };
    landmarks[16] = { x: 0.55, y: 0.3, z: 0.0 };

    // Pinky: PIP (18), Tip (20) extended
    landmarks[18] = { x: 0.6, y: 0.65, z: 0.0 };
    landmarks[20] = { x: 0.6, y: 0.35, z: 0.0 };
  } else if (pose === 'fist') {
    // Thumb folded in: tip closer to pinky MCP than IP
    landmarks[3] = { x: 0.4, y: 0.7, z: 0.0 };
    landmarks[4] = { x: 0.5, y: 0.72, z: 0.0 }; // closer to 17 (0.6, 0.7)

    // Fingers curled towards wrist: tip closer to wrist (y=0.9) than PIP
    landmarks[6] = { x: 0.45, y: 0.65, z: 0.0 };
    landmarks[8] = { x: 0.45, y: 0.75, z: 0.0 }; // closer to wrist than PIP

    landmarks[10] = { x: 0.5, y: 0.65, z: 0.0 };
    landmarks[12] = { x: 0.5, y: 0.75, z: 0.0 };

    landmarks[14] = { x: 0.55, y: 0.65, z: 0.0 };
    landmarks[16] = { x: 0.55, y: 0.75, z: 0.0 };

    landmarks[18] = { x: 0.6, y: 0.68, z: 0.0 };
    landmarks[20] = { x: 0.6, y: 0.78, z: 0.0 };
  } else if (pose === 'l_shape') {
    // Thumb open
    landmarks[3] = { x: 0.35, y: 0.75, z: 0.0 };
    landmarks[4] = { x: 0.25, y: 0.7, z: 0.0 };

    // Index open
    landmarks[6] = { x: 0.45, y: 0.6, z: 0.0 };
    landmarks[8] = { x: 0.45, y: 0.3, z: 0.0 };

    // Others closed
    landmarks[10] = { x: 0.5, y: 0.65, z: 0.0 };
    landmarks[12] = { x: 0.5, y: 0.75, z: 0.0 };

    landmarks[14] = { x: 0.55, y: 0.65, z: 0.0 };
    landmarks[16] = { x: 0.55, y: 0.75, z: 0.0 };

    landmarks[18] = { x: 0.6, y: 0.68, z: 0.0 };
    landmarks[20] = { x: 0.6, y: 0.78, z: 0.0 };
  } else if (pose === 'pointing') {
    // Thumb closed
    landmarks[3] = { x: 0.4, y: 0.7, z: 0.0 };
    landmarks[4] = { x: 0.5, y: 0.72, z: 0.0 };

    // Index open
    landmarks[6] = { x: 0.45, y: 0.6, z: 0.0 };
    landmarks[8] = { x: 0.45, y: 0.3, z: 0.0 };

    // Others closed
    landmarks[10] = { x: 0.5, y: 0.65, z: 0.0 };
    landmarks[12] = { x: 0.5, y: 0.75, z: 0.0 };

    landmarks[14] = { x: 0.55, y: 0.65, z: 0.0 };
    landmarks[16] = { x: 0.55, y: 0.75, z: 0.0 };

    landmarks[18] = { x: 0.6, y: 0.68, z: 0.0 };
    landmarks[20] = { x: 0.6, y: 0.78, z: 0.0 };
  }

  return landmarks;
}

describe('Gesture State & Landmark Validation', () => {
  describe('isValidCoordinate', () => {
    it('accepts normalized coordinates within valid range', () => {
      expect(isValidCoordinate(0.5)).toBe(true);
      expect(isValidCoordinate(0.0)).toBe(true);
      expect(isValidCoordinate(1.0)).toBe(true);
      expect(isValidCoordinate(1.2)).toBe(true); // natural off-screen margin
      expect(isValidCoordinate(-0.3)).toBe(true);
    });

    it('rejects out of bounds and non-finite values', () => {
      expect(isValidCoordinate(NaN)).toBe(false);
      expect(isValidCoordinate(Infinity)).toBe(false);
      expect(isValidCoordinate(-Infinity)).toBe(false);
      expect(isValidCoordinate(500.0)).toBe(false);
      expect(isValidCoordinate(-100.0)).toBe(false);
      expect(isValidCoordinate('0.5')).toBe(false);
      expect(isValidCoordinate(null)).toBe(false);
      expect(isValidCoordinate(undefined)).toBe(false);
    });
  });

  describe('isValidLandmark', () => {
    it('accepts valid 3D landmark points', () => {
      expect(isValidLandmark({ x: 0.1, y: 0.2, z: -0.05 })).toBe(true);
      expect(isValidLandmark({ x: 0.1, y: 0.2, z: 0, visibility: 0.9 })).toBe(
        true,
      );
    });

    it('rejects corrupted or incomplete landmarks', () => {
      expect(isValidLandmark(null)).toBe(false);
      expect(isValidLandmark(undefined)).toBe(false);
      expect(isValidLandmark({ x: 0.1, y: 0.2 })).toBe(false); // missing z
      expect(isValidLandmark({ x: NaN, y: 0.2, z: 0 })).toBe(false);
      expect(isValidLandmark({ x: 0.1, y: Infinity, z: 0 })).toBe(false);
      expect(isValidLandmark({ x: '0.1', y: 0.2, z: 0 })).toBe(false);
    });
  });

  describe('validateAndSanitizeLandmarks', () => {
    it('sanitizes valid 21-point hand landmark arrays', () => {
      const mockHand = generateMockHand('open_palm');
      const sanitized = validateAndSanitizeLandmarks(mockHand);
      expect(sanitized).not.toBeNull();
      expect(sanitized?.length).toBe(21);
      expect(sanitized?.[0].x).toBe(0.5);
    });

    it('rejects non-arrays and arrays with wrong landmark counts', () => {
      expect(validateAndSanitizeLandmarks(null)).toBeNull();
      expect(validateAndSanitizeLandmarks({})).toBeNull();
      expect(validateAndSanitizeLandmarks([])).toBeNull();
      expect(
        validateAndSanitizeLandmarks(new Array(20).fill({ x: 0, y: 0, z: 0 })),
      ).toBeNull();
      expect(
        validateAndSanitizeLandmarks(new Array(22).fill({ x: 0, y: 0, z: 0 })),
      ).toBeNull();
    });

    it('rejects frames with any corrupted landmark point', () => {
      const mockHand = generateMockHand('open_palm');
      mockHand[8] = { x: NaN, y: 0.5, z: 0.0 }; // Corrupted index tip
      expect(validateAndSanitizeLandmarks(mockHand)).toBeNull();
    });
  });

  describe('computeFingerStates', () => {
    it('accurately identifies Open Palm pose', () => {
      const palm = generateMockHand('open_palm');
      const state = computeFingerStates(palm);
      expect(state).toEqual({
        thumb: 'open',
        index: 'open',
        middle: 'open',
        ring: 'open',
        pinky: 'open',
      });
      expect(isOpenPalmState(state)).toBe(true);
    });

    it('accurately identifies Closed Fist pose', () => {
      const fist = generateMockHand('fist');
      const state = computeFingerStates(fist);
      expect(state).toEqual({
        thumb: 'closed',
        index: 'closed',
        middle: 'closed',
        ring: 'closed',
        pinky: 'closed',
      });
      expect(isOpenPalmState(state)).toBe(false);
    });

    it('accurately identifies L-Shape pose', () => {
      const lShape = generateMockHand('l_shape');
      const state = computeFingerStates(lShape);
      expect(state).toEqual({
        thumb: 'open',
        index: 'open',
        middle: 'closed',
        ring: 'closed',
        pinky: 'closed',
      });
      expect(isOpenPalmState(state)).toBe(false);
    });

    it('accurately identifies Pointing pose', () => {
      const pointing = generateMockHand('pointing');
      const state = computeFingerStates(pointing);
      expect(state).toEqual({
        thumb: 'closed',
        index: 'open',
        middle: 'closed',
        ring: 'closed',
        pinky: 'closed',
      });
    });

    it('handles rapid gesture transitions across consecutive frames', () => {
      const poses: Array<'fist' | 'pointing' | 'l_shape' | 'open_palm'> = [
        'fist',
        'pointing',
        'l_shape',
        'open_palm',
      ];
      const states = poses.map((p) => computeFingerStates(generateMockHand(p)));

      expect(states[0].index).toBe('closed');
      expect(states[1].index).toBe('open');
      expect(states[1].thumb).toBe('closed');
      expect(states[2].thumb).toBe('open');
      expect(states[3].middle).toBe('open');
    });

    it('gracefully falls back on corrupted or empty landmark inputs', () => {
      const emptyState = computeFingerStates([] as any);
      expect(emptyState).toEqual({
        thumb: 'closed',
        index: 'closed',
        middle: 'closed',
        ring: 'closed',
        pinky: 'closed',
      });
    });
  });

  describe('extractSanitizedHandLandmarks & Downstream Propagation', () => {
    it('extracts landmarks from wrapped event details ({ landmarks })', () => {
      const mockHand = generateMockHand('l_shape');
      const detail = {
        thumb: 'open',
        index: 'open',
        fingers: {
          thumb: 'open',
          index: 'open',
          middle: 'closed',
          ring: 'closed',
          pinky: 'closed',
        },
        landmarks: mockHand,
        isValid: true,
      };
      const extracted = extractSanitizedHandLandmarks(detail);
      expect(extracted).not.toBeNull();
      expect(extracted?.length).toBe(21);
    });

    it('extracts landmarks from direct arrays', () => {
      const mockHand = generateMockHand('open_palm');
      const extracted = extractSanitizedHandLandmarks(mockHand);
      expect(extracted?.length).toBe(21);
    });

    it('handles frame drop signals cleanly (returns null)', () => {
      const frameDropDetail = {
        landmarks: null,
        fingers: null,
        isFrameDrop: true,
        isValid: false,
      };
      expect(extractSanitizedHandLandmarks(frameDropDetail)).toBeNull();
    });

    it('extracts finger states safely via extractSanitizedFingers', () => {
      const detailWithFingers = {
        fingers: {
          thumb: 'open',
          index: 'open',
          middle: 'closed',
          ring: 'closed',
          pinky: 'closed',
        },
      };
      const fingers = extractSanitizedFingers(detailWithFingers);
      expect(fingers?.thumb).toBe('open');
      expect(fingers?.middle).toBe('closed');
    });

    it('derives finger states from landmarks when fingers property is missing', () => {
      const mockHand = generateMockHand('open_palm');
      const detailWithOnlyLandmarks = {
        landmarks: mockHand,
      };
      const fingers = extractSanitizedFingers(detailWithOnlyLandmarks);
      expect(fingers?.thumb).toBe('open');
      expect(fingers?.index).toBe('open');
    });
  });

  describe('extractFeaturesFromTimeline', () => {
    it('extracts 210 scale-invariant features for valid timeline recording', () => {
      const mockHand = generateMockHand('open_palm');
      const timeline = [
        { type: 'hand', timestamp: 1000, data: mockHand },
        { type: 'hand', timestamp: 1050, data: mockHand },
        { type: 'hand', timestamp: 1100, data: mockHand },
      ];
      const features = extractFeaturesFromTimeline(timeline);
      expect(features.length).toBe(210);
      expect(
        features.every((f) => Number.isFinite(f) && f >= 0.0 && f <= 1.0),
      ).toBe(true);
      expect(features.some((f) => f > 0.0)).toBe(true);
    });

    it('gracefully handles corrupted landmark events and frame drops in timeline', () => {
      const validHand = generateMockHand('open_palm');
      const corruptedHand = [{ x: NaN, y: 0.5, z: 0.0 }]; // wrong length and NaN
      const timelineWithCorruption = [
        { type: 'hand', timestamp: 1000, data: null }, // frame drop
        { type: 'hand', timestamp: 1050, data: corruptedHand }, // corrupted event
        { type: 'hand', timestamp: 1100, data: validHand }, // valid frame
        { type: 'face', timestamp: 1120, data: { blink: false } }, // non-hand event
        { type: 'hand', timestamp: 1150, data: { thumb: 'open' } }, // legacy object event
        { type: 'hand', timestamp: 1200, data: validHand }, // valid frame
      ];

      const features = extractFeaturesFromTimeline(timelineWithCorruption);
      expect(features.length).toBe(210);
      expect(features.every((f) => Number.isFinite(f))).toBe(true);
      expect(features.some((f) => f > 0.0)).toBe(true);
    });

    it('returns zero vector without error if all frames are corrupted or dropped', () => {
      const emptyTimeline = [
        { type: 'hand', timestamp: 1000, data: null },
        { type: 'hand', timestamp: 1050, data: [] },
      ];
      const features = extractFeaturesFromTimeline(emptyTimeline);
      expect(features.length).toBe(210);
      expect(features.every((f) => f === 0.0)).toBe(true);
    });
  });

  describe('Face Landmark & State Bounds Checks', () => {
    it('computes face state with bounds checks without division-by-zero', () => {
      const blendshapes = [
        { categoryName: 'eyeBlinkLeft', score: 0.8 },
        { categoryName: 'eyeBlinkRight', score: 0.85 },
      ];
      const state = computeFaceState(blendshapes, null);
      expect(state.blink).toBe(true);
      expect(state.lookLeft).toBe(false);
      expect(state.nodUp).toBe(false);
    });

    it('handles face landmarks with yaw and pitch calculations', () => {
      // 455 dummy face landmarks
      const faceLandmarks = new Array(460)
        .fill(null)
        .map(() => ({ x: 0.5, y: 0.5, z: 0.0 }));
      faceLandmarks[1] = { x: 0.45, y: 0.5, z: 0.0 }; // nose
      faceLandmarks[234] = { x: 0.2, y: 0.5, z: 0.0 }; // left cheek
      faceLandmarks[454] = { x: 0.8, y: 0.5, z: 0.0 }; // right cheek
      faceLandmarks[10] = { x: 0.45, y: 0.2, z: 0.0 }; // top
      faceLandmarks[152] = { x: 0.45, y: 0.8, z: 0.0 }; // bottom

      const state = computeFaceState([], faceLandmarks);
      expect(typeof state.turnLeft).toBe('boolean');
      expect(typeof state.nodDown).toBe('boolean');
    });
  });
});
