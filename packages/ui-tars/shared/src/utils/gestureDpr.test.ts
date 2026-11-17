import { describe, it, expect } from 'vitest';
import {
  getCanvasDprMetrics,
  calculateDprPreviewCoordinates,
  checkGestureBounds,
  calculateDprAspectCorrectedDistance,
  computeDprFingerStates,
  DprGestureStateSmoother,
  Point3D,
} from './gestureDpr';

describe('gestureDpr - Canvas DPR Scaling & Gesture Preview Coordinates', () => {
  describe('getCanvasDprMetrics', () => {
    it('calculates metrics correctly for standard DPR 1.0', () => {
      const metrics = getCanvasDprMetrics(320, 240, 1.0);
      expect(metrics.cssWidth).toBe(320);
      expect(metrics.cssHeight).toBe(240);
      expect(metrics.dpr).toBe(1.0);
      expect(metrics.bufferWidth).toBe(320);
      expect(metrics.bufferHeight).toBe(240);
      expect(metrics.aspectRatio).toBeCloseTo(4 / 3);
    });

    it('calculates metrics correctly for high-DPI Retina DPR 2.0', () => {
      const metrics = getCanvasDprMetrics(320, 240, 2.0);
      expect(metrics.cssWidth).toBe(320);
      expect(metrics.cssHeight).toBe(240);
      expect(metrics.dpr).toBe(2.0);
      expect(metrics.bufferWidth).toBe(640);
      expect(metrics.bufferHeight).toBe(480);
      expect(metrics.aspectRatio).toBeCloseTo(4 / 3);
    });

    it('calculates metrics correctly for high-DPI DPR 1.5 and 3.0', () => {
      const metrics15 = getCanvasDprMetrics(320, 240, 1.5);
      expect(metrics15.bufferWidth).toBe(480);
      expect(metrics15.bufferHeight).toBe(360);

      const metrics30 = getCanvasDprMetrics(320, 240, 3.0);
      expect(metrics30.bufferWidth).toBe(960);
      expect(metrics30.bufferHeight).toBe(720);
    });

    it('handles zero, negative, or invalid dimensions and DPR safely', () => {
      const metrics = getCanvasDprMetrics(0, -10, 0);
      expect(metrics.cssWidth).toBe(320);
      expect(metrics.cssHeight).toBe(240);
      expect(metrics.dpr).toBe(1.0);
      expect(metrics.bufferWidth).toBe(320);
      expect(metrics.bufferHeight).toBe(240);
    });
  });

  describe('calculateDprPreviewCoordinates', () => {
    it('maps normalized coordinates to logical and physical coordinates without double scaling', () => {
      const metrics = getCanvasDprMetrics(320, 240, 2.0); // buffer is 640x480
      const landmarks: Point3D[] = [
        { x: 0.25, y: 0.5, z: 0 },
        { x: 0.75, y: 0.5, z: 0 },
      ];

      const coords = calculateDprPreviewCoordinates(landmarks, metrics);
      expect(coords).toHaveLength(2);

      // Logical CSS coordinates
      expect(coords[0].css.x).toBeCloseTo(80); // 0.25 * 320
      expect(coords[0].css.y).toBeCloseTo(120); // 0.5 * 240

      // Physical canvas buffer coordinates (1x DPR scaled, NOT double-scaled)
      expect(coords[0].canvas.x).toBeCloseTo(160); // 0.25 * 640
      expect(coords[0].canvas.y).toBeCloseTo(240); // 0.5 * 480
      expect(coords[0].canvas.x).toBeCloseTo(coords[0].css.x * metrics.dpr);

      // Mirrored CSS coordinates (for live webcam mirror preview)
      expect(coords[0].mirroredCss.x).toBeCloseTo(240); // (1 - 0.25) * 320
      expect(coords[0].mirroredCss.y).toBeCloseTo(120);

      // Mirrored Canvas buffer coordinates
      expect(coords[0].mirroredCanvas.x).toBeCloseTo(480); // (1 - 0.25) * 640
      expect(coords[0].mirroredCanvas.y).toBeCloseTo(240);
    });

    it('clamps normalized inputs that exceed boundary margins', () => {
      const metrics = getCanvasDprMetrics(320, 240, 2.0);
      const outOfBounds: Point3D[] = [{ x: -0.1, y: 1.2, z: 0 }];

      const coords = calculateDprPreviewCoordinates(outOfBounds, metrics);
      expect(coords[0].normalized.x).toBe(0);
      expect(coords[0].normalized.y).toBe(1);
      expect(coords[0].css.x).toBe(0);
      expect(coords[0].css.y).toBe(240);
    });

    it('returns empty array when landmarks are empty', () => {
      const metrics = getCanvasDprMetrics(320, 240, 2.0);
      expect(calculateDprPreviewCoordinates([], metrics)).toEqual([]);
    });
  });

  describe('checkGestureBounds', () => {
    it('returns inBounds=true for well-centered hand landmarks', () => {
      const landmarks: Point3D[] = Array.from({ length: 21 }, (_, i) => ({
        x: 0.4 + (i % 5) * 0.04,
        y: 0.4 + Math.floor(i / 5) * 0.04,
        z: 0,
      }));

      const res = checkGestureBounds(landmarks);
      expect(res.inBounds).toBe(true);
      expect(res.outOfBoundsCount).toBe(0);
      expect(res.totalLandmarks).toBe(21);
    });

    it('returns inBounds=false when wrist (landmark 0) is out of bounds', () => {
      const landmarks: Point3D[] = Array.from({ length: 21 }, (_, i) => ({
        x: 0.5,
        y: i === 0 ? -0.1 : 0.5,
        z: 0,
      }));

      const res = checkGestureBounds(landmarks);
      expect(res.inBounds).toBe(false);
    });

    it('returns inBounds=false when too many landmarks are outside bounds', () => {
      // 5 fingertips out of bounds at bottom
      const landmarks: Point3D[] = Array.from({ length: 21 }, (_, i) => ({
        x: 0.5,
        y: [4, 8, 12, 16, 20].includes(i) ? 1.05 : 0.5,
        z: 0,
      }));

      const res = checkGestureBounds(landmarks);
      expect(res.inBounds).toBe(false);
      expect(res.outOfBoundsCount).toBe(5);
    });

    it('returns inBounds=false for empty landmarks', () => {
      const res = checkGestureBounds([]);
      expect(res.inBounds).toBe(false);
      expect(res.totalLandmarks).toBe(0);
    });
  });

  describe('calculateDprAspectCorrectedDistance', () => {
    it('corrects distance calculation for non-square aspect ratios', () => {
      const p1: Point3D = { x: 0.5, y: 0.5 };
      const pHoriz: Point3D = { x: 0.6, y: 0.5 }; // dx = 0.1, dy = 0
      const pVert: Point3D = { x: 0.5, y: 0.6 }; // dx = 0, dy = 0.1

      const ar = 4 / 3;
      const distH = calculateDprAspectCorrectedDistance(p1, pHoriz, ar);
      const distV = calculateDprAspectCorrectedDistance(p1, pVert, ar);

      expect(distH).toBeCloseTo(0.1 * (4 / 3));
      expect(distV).toBeCloseTo(0.1);
      expect(distH).toBeGreaterThan(distV);
    });

    it('calculates isotropic Euclidean distance when aspect ratio is 1.0', () => {
      const p1: Point3D = { x: 0.2, y: 0.2 };
      const p2: Point3D = { x: 0.5, y: 0.6 }; // dx=0.3, dy=0.4 -> dist=0.5
      expect(calculateDprAspectCorrectedDistance(p1, p2, 1.0)).toBeCloseTo(0.5);
    });
  });

  describe('computeDprFingerStates', () => {
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

    it('correctly detects open palm gesture (all fingers open)', () => {
      const hand = createMockHand({
        thumb: true,
        index: true,
        middle: true,
        ring: true,
        pinky: true,
      });

      const states = computeDprFingerStates(hand, 4 / 3);
      expect(states).toEqual({
        thumb: 'open',
        index: 'open',
        middle: 'open',
        ring: 'open',
        pinky: 'open',
      });
    });

    it('correctly detects closed fist gesture (all fingers closed)', () => {
      const hand = createMockHand({
        thumb: false,
        index: false,
        middle: false,
        ring: false,
        pinky: false,
      });

      const states = computeDprFingerStates(hand, 4 / 3);
      expect(states).toEqual({
        thumb: 'closed',
        index: 'closed',
        middle: 'closed',
        ring: 'closed',
        pinky: 'closed',
      });
    });

    it('correctly detects L-shape gesture (thumb and index open)', () => {
      const hand = createMockHand({
        thumb: true,
        index: true,
        middle: false,
        ring: false,
        pinky: false,
      });

      const states = computeDprFingerStates(hand, 4 / 3);
      expect(states).toEqual({
        thumb: 'open',
        index: 'open',
        middle: 'closed',
        ring: 'closed',
        pinky: 'closed',
      });
    });

    it('correctly detects peace sign (index and middle open)', () => {
      const hand = createMockHand({
        thumb: false,
        index: true,
        middle: true,
        ring: false,
        pinky: false,
      });

      const states = computeDprFingerStates(hand, 4 / 3);
      expect(states).toEqual({
        thumb: 'closed',
        index: 'open',
        middle: 'open',
        ring: 'closed',
        pinky: 'closed',
      });
    });

    it('returns all closed for empty landmarks without throwing', () => {
      const states = computeDprFingerStates([]);
      expect(states).toEqual({
        thumb: 'closed',
        index: 'closed',
        middle: 'closed',
        ring: 'closed',
        pinky: 'closed',
      });
    });
  });

  describe('DprGestureStateSmoother', () => {
    it('holds valid state across brief frame drops (up to maxAllowedDrops)', () => {
      const smoother = new DprGestureStateSmoother(2, 3);
      const openPalm = {
        thumb: 'open',
        index: 'open',
        middle: 'open',
        ring: 'open',
        pinky: 'open',
      } as const;

      // 2 frames to stabilize
      smoother.update(openPalm, true);
      const stable = smoother.update(openPalm, true);
      expect(stable.stable).toBe(true);
      expect(stable.state).toEqual(openPalm);

      // Frame drop 1 (null input)
      const drop1 = smoother.update(null, false);
      expect(drop1.dropped).toBe(true);
      expect(drop1.state).toEqual(openPalm);

      // Frame drop 2
      const drop2 = smoother.update(null, false);
      expect(drop2.dropped).toBe(true);
      expect(drop2.state).toEqual(openPalm);

      // Frame drop 3
      const drop3 = smoother.update(null, false);
      expect(drop3.dropped).toBe(true);
      expect(drop3.state).toEqual(openPalm);

      // Frame drop 4 (exceeds max 3 drops)
      const drop4 = smoother.update(null, false);
      expect(drop4.state).toBeNull();
    });

    it('requires multiple frames to confirm rapid state transition to prevent jitter', () => {
      const smoother = new DprGestureStateSmoother(2, 3);
      const openPalm = {
        thumb: 'open',
        index: 'open',
        middle: 'open',
        ring: 'open',
        pinky: 'open',
      } as const;
      const fist = {
        thumb: 'closed',
        index: 'closed',
        middle: 'closed',
        ring: 'closed',
        pinky: 'closed',
      } as const;

      // Stabilize on openPalm
      smoother.update(openPalm, true);
      smoother.update(openPalm, true);

      // 1 jitter frame of fist
      const jitter = smoother.update(fist, true);
      expect(jitter.stable).toBe(false);
      expect(jitter.state).toEqual(openPalm); // Held openPalm

      // 2nd confirmed frame of fist confirms transition
      const confirmed = smoother.update(fist, true);
      expect(confirmed.stable).toBe(true);
      expect(confirmed.state).toEqual(fist);
    });

    it('resets state cleanly on reset()', () => {
      const smoother = new DprGestureStateSmoother(2, 3);
      const openPalm = {
        thumb: 'open',
        index: 'open',
        middle: 'open',
        ring: 'open',
        pinky: 'open',
      } as const;

      smoother.update(openPalm, true);
      smoother.update(openPalm, true);
      smoother.reset();

      const afterReset = smoother.update(null, false);
      expect(afterReset.state).toBeNull();
    });
  });
});
