import { describe, it, expect } from 'vitest';
import {
  getWebcamCropMetrics,
  correctHandLandmarks,
  checkHandBounds,
  calculateAspectCorrectedDistance,
  computeFingerStates,
  GestureStateSmoother,
  Point3D,
} from '../src/utils/gestureLandmarks';

describe('gestureLandmarks - Webcam Crop & Distortion Correction', () => {
  describe('getWebcamCropMetrics', () => {
    it('calculates crop metrics for 4:3 webcam displayed in 16:9 container', () => {
      // 640x480 (4:3) in 16:9 container: taller than container, vertical crop
      const metrics = getWebcamCropMetrics(640, 480, 16 / 9);
      expect(metrics.videoAspectRatio).toBeCloseTo(4 / 3);
      expect(metrics.targetAspectRatio).toBeCloseTo(16 / 9);
      expect(metrics.cropX).toBe(0);
      // Visible height: 640 / (16/9) = 360. Crop: (480 - 360) / 2 = 60px. cropY = 60 / 480 = 0.125
      expect(metrics.cropY).toBeCloseTo(0.125);
      expect(metrics.scaleX).toBe(1);
      expect(metrics.scaleY).toBeCloseTo(1 / (1 - 0.25)); // 1 / 0.75 = 1.3333
    });

    it('calculates crop metrics for 16:9 webcam displayed in 4:3 container', () => {
      // 1280x720 (16:9) in 4:3 container: wider than container, horizontal crop
      const metrics = getWebcamCropMetrics(1280, 720, 4 / 3);
      expect(metrics.cropY).toBe(0);
      // Visible width: 720 * (4/3) = 960. Crop: (1280 - 960) / 2 = 160px. cropX = 160 / 1280 = 0.125
      expect(metrics.cropX).toBeCloseTo(0.125);
      expect(metrics.scaleY).toBe(1);
      expect(metrics.scaleX).toBeCloseTo(1 / (1 - 0.25));
    });

    it('returns 0 crop when video aspect ratio matches target', () => {
      const metrics = getWebcamCropMetrics(1920, 1080, 16 / 9);
      expect(metrics.cropX).toBe(0);
      expect(metrics.cropY).toBe(0);
      expect(metrics.scaleX).toBe(1);
      expect(metrics.scaleY).toBe(1);
    });

    it('handles invalid or zero dimensions gracefully', () => {
      const metrics = getWebcamCropMetrics(0, 0, 16 / 9);
      expect(metrics.cropX).toBe(0);
      expect(metrics.cropY).toBe(0);
      expect(metrics.scaleX).toBe(1);
      expect(metrics.scaleY).toBe(1);
    });
  });

  describe('correctHandLandmarks', () => {
    it('maps landmarks from cropped region to [0, 1] range', () => {
      const cropMetrics = getWebcamCropMetrics(640, 480, 16 / 9); // cropY = 0.125, cropX = 0
      const rawLandmarks: Point3D[] = [
        { x: 0.5, y: 0.125, z: 0 }, // At the top visible crop edge
        { x: 0.5, y: 0.5, z: 0 }, // At the center
        { x: 0.5, y: 0.875, z: 0 }, // At the bottom visible crop edge
      ];

      const corrected = correctHandLandmarks(rawLandmarks, cropMetrics);
      expect(corrected[0].y).toBeCloseTo(0.0);
      expect(corrected[1].y).toBeCloseTo(0.5);
      expect(corrected[2].y).toBeCloseTo(1.0);
      expect(corrected[0].x).toBeCloseTo(0.5);
    });

    it('handles empty landmark array', () => {
      const cropMetrics = getWebcamCropMetrics(640, 480, 16 / 9);
      expect(correctHandLandmarks([], cropMetrics)).toEqual([]);
    });
  });

  describe('checkHandBounds', () => {
    it('returns inBounds=true when hand landmarks are centered inside visible frame', () => {
      const landmarks: Point3D[] = Array.from({ length: 21 }, (_, i) => ({
        x: 0.5 + (i % 5) * 0.05,
        y: 0.5 + Math.floor(i / 5) * 0.05,
        z: 0,
      }));

      const res = checkHandBounds(landmarks);
      expect(res.inBounds).toBe(true);
      expect(res.outOfBoundsCount).toBe(0);
    });

    it('returns inBounds=false when wrist or multiple key landmarks are out of bounds', () => {
      // Wrist out of bounds at y = -0.15 (cropped out of frame)
      const landmarks: Point3D[] = Array.from({ length: 21 }, (_, i) => ({
        x: 0.5,
        y: i === 0 ? -0.15 : 0.4,
        z: 0,
      }));

      const res = checkHandBounds(landmarks);
      expect(res.inBounds).toBe(false);
    });

    it('returns inBounds=false for empty landmarks', () => {
      const res = checkHandBounds([]);
      expect(res.inBounds).toBe(false);
    });
  });

  describe('calculateAspectCorrectedDistance', () => {
    it('corrects distance skew caused by 16:9 aspect ratio', () => {
      // In normalized coordinates [0, 1], 0.1 along X is 0.1 * 16 = 1.6 units
      // while 0.1 along Y is 0.1 * 9 = 0.9 units
      // Aspect-corrected distance scales delta X by aspect ratio
      const p1: Point3D = { x: 0.5, y: 0.5 };
      const pHorizontal: Point3D = { x: 0.6, y: 0.5 }; // dx = 0.1, dy = 0
      const pVertical: Point3D = { x: 0.5, y: 0.6 }; // dx = 0, dy = 0.1

      const ar = 16 / 9;
      const distH = calculateAspectCorrectedDistance(p1, pHorizontal, ar);
      const distV = calculateAspectCorrectedDistance(p1, pVertical, ar);

      expect(distH).toBeCloseTo(0.1 * (16 / 9));
      expect(distV).toBeCloseTo(0.1);
      // Horizontal metric distance reflects true camera sensor geometry
      expect(distH).toBeGreaterThan(distV);
    });

    it('yields isotropic distance when aspect ratio is 1.0', () => {
      const p1: Point3D = { x: 0.2, y: 0.2 };
      const p2: Point3D = { x: 0.5, y: 0.6 }; // dx = 0.3, dy = 0.4 -> dist = 0.5
      const dist = calculateAspectCorrectedDistance(p1, p2, 1.0);
      expect(dist).toBeCloseTo(0.5);
    });
  });

  describe('computeFingerStates', () => {
    const createMockHand = (openFingers: {
      thumb?: boolean;
      index?: boolean;
      middle?: boolean;
      ring?: boolean;
      pinky?: boolean;
    }): Point3D[] => {
      const lms: Point3D[] = Array.from({ length: 21 }, () => ({
        x: 0.5,
        y: 0.8,
        z: 0,
      }));
      // Wrist
      lms[0] = { x: 0.5, y: 0.9, z: 0 };
      // Pinky MCP (17)
      lms[17] = { x: 0.65, y: 0.6, z: 0 };

      // Thumb: 3 (IP), 4 (Tip)
      lms[3] = { x: 0.45, y: 0.7, z: 0 };
      lms[4] = openFingers.thumb
        ? { x: 0.3, y: 0.6, z: 0 }
        : { x: 0.48, y: 0.72, z: 0 };

      // Index: 6 (PIP), 8 (Tip)
      lms[6] = { x: 0.45, y: 0.6, z: 0 };
      lms[8] = openFingers.index
        ? { x: 0.45, y: 0.3, z: 0 }
        : { x: 0.45, y: 0.7, z: 0 };

      // Middle: 10 (PIP), 12 (Tip)
      lms[10] = { x: 0.5, y: 0.58, z: 0 };
      lms[12] = openFingers.middle
        ? { x: 0.5, y: 0.28, z: 0 }
        : { x: 0.5, y: 0.7, z: 0 };

      // Ring: 14 (PIP), 16 (Tip)
      lms[14] = { x: 0.55, y: 0.6, z: 0 };
      lms[16] = openFingers.ring
        ? { x: 0.55, y: 0.3, z: 0 }
        : { x: 0.55, y: 0.72, z: 0 };

      // Pinky: 18 (PIP), 20 (Tip)
      lms[18] = { x: 0.62, y: 0.62, z: 0 };
      lms[20] = openFingers.pinky
        ? { x: 0.62, y: 0.35, z: 0 }
        : { x: 0.62, y: 0.72, z: 0 };

      return lms;
    };

    it('correctly detects open palm gesture across test frame', () => {
      const openPalmHand = createMockHand({
        thumb: true,
        index: true,
        middle: true,
        ring: true,
        pinky: true,
      });

      const states = computeFingerStates(openPalmHand, 16 / 9);
      expect(states).toEqual({
        thumb: 'open',
        index: 'open',
        middle: 'open',
        ring: 'open',
        pinky: 'open',
      });
    });

    it('correctly detects closed fist gesture', () => {
      const closedFistHand = createMockHand({
        thumb: false,
        index: false,
        middle: false,
        ring: false,
        pinky: false,
      });

      const states = computeFingerStates(closedFistHand, 16 / 9);
      expect(states).toEqual({
        thumb: 'closed',
        index: 'closed',
        middle: 'closed',
        ring: 'closed',
        pinky: 'closed',
      });
    });

    it('correctly detects L-shape gesture (thumb and index open, others closed)', () => {
      const lShapeHand = createMockHand({
        thumb: true,
        index: true,
        middle: false,
        ring: false,
        pinky: false,
      });

      const states = computeFingerStates(lShapeHand, 16 / 9);
      expect(states).toEqual({
        thumb: 'open',
        index: 'open',
        middle: 'closed',
        ring: 'closed',
        pinky: 'closed',
      });
    });

    it('handles unexpected frame drops / empty landmarks without crashing', () => {
      const states = computeFingerStates([], 16 / 9);
      expect(states).toEqual({
        thumb: 'closed',
        index: 'closed',
        middle: 'closed',
        ring: 'closed',
        pinky: 'closed',
      });
    });
  });

  describe('GestureStateSmoother (Rapid Transitions and Landmark Frame Drops)', () => {
    it('holds valid state across brief frame drops (up to maxAllowedDrops)', () => {
      const smoother = new GestureStateSmoother(2, 3);
      const openState = {
        thumb: 'open',
        index: 'open',
        middle: 'open',
        ring: 'open',
        pinky: 'open',
      } as const;

      // 2 consecutive stable frames
      smoother.update(openState, true);
      const resStable = smoother.update(openState, true);
      expect(resStable.stable).toBe(true);
      expect(resStable.state).toEqual(openState);

      // Frame drop 1 (null landmarks)
      const drop1 = smoother.update(null, false);
      expect(drop1.dropped).toBe(true);
      expect(drop1.state).toEqual(openState); // Maintained last valid state

      // Frame drop 2
      const drop2 = smoother.update(null, false);
      expect(drop2.dropped).toBe(true);
      expect(drop2.state).toEqual(openState);

      // Frame drop 3
      const drop3 = smoother.update(null, false);
      expect(drop3.dropped).toBe(true);
      expect(drop3.state).toEqual(openState);

      // Frame drop 4 (exceeds maxAllowedDrops=3)
      const drop4 = smoother.update(null, false);
      expect(drop4.state).toBeNull();
    });

    it('requires multiple frames to confirm rapid state transition to prevent jitter', () => {
      const smoother = new GestureStateSmoother(2, 3);
      const openState = {
        thumb: 'open',
        index: 'open',
        middle: 'open',
        ring: 'open',
        pinky: 'open',
      } as const;
      const fistState = {
        thumb: 'closed',
        index: 'closed',
        middle: 'closed',
        ring: 'closed',
        pinky: 'closed',
      } as const;

      // Stabilize on openState
      smoother.update(openState, true);
      smoother.update(openState, true);

      // Single anomalous/flicker frame of fist
      const jitterFrame = smoother.update(fistState, true);
      expect(jitterFrame.stable).toBe(false);
      expect(jitterFrame.state).toEqual(openState); // Retains openState

      // Second confirmed fist frame stabilizes transition
      const confirmedFrame = smoother.update(fistState, true);
      expect(confirmedFrame.stable).toBe(true);
      expect(confirmedFrame.state).toEqual(fistState);
    });
  });
});
