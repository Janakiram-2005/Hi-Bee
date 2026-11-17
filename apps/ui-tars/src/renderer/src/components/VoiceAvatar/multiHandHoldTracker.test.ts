/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MultiHandHoldTracker,
  NormalizedLandmark,
  HandLandmarkerResults,
} from './multiHandHoldTracker';

/**
 * Helper to generate synthetic 21 landmarks for an open hand or closed fist.
 */
function createMockLandmarks(
  isOpen: boolean,
  wristX: number = 0.5,
): NormalizedLandmark[] {
  const landmarks: NormalizedLandmark[] = [];
  // Wrist at (wristX, 0.8)
  landmarks.push({ x: wristX, y: 0.8, z: 0 });

  // 1: Thumb CMC, 2: Thumb MCP, 3: Thumb IP, 4: Thumb Tip
  landmarks.push({ x: wristX - 0.05, y: 0.7, z: 0 });
  landmarks.push({ x: wristX - 0.1, y: 0.6, z: 0 });
  landmarks.push({ x: wristX - 0.12, y: 0.5, z: 0 }); // 3: Thumb IP
  landmarks.push({
    x: isOpen ? wristX - 0.25 : wristX - 0.05,
    y: isOpen ? 0.4 : 0.65,
    z: 0,
  }); // 4: Thumb Tip

  // 5: Index MCP, 6: Index PIP, 7: Index DIP, 8: Index Tip
  landmarks.push({ x: wristX - 0.06, y: 0.5, z: 0 });
  landmarks.push({ x: wristX - 0.06, y: 0.45, z: 0 }); // 6: Index PIP
  landmarks.push({ x: wristX - 0.06, y: 0.35, z: 0 });
  landmarks.push({ x: wristX - 0.06, y: isOpen ? 0.2 : 0.6, z: 0 }); // 8: Index Tip

  // 9: Middle MCP, 10: Middle PIP, 11: Middle DIP, 12: Middle Tip
  landmarks.push({ x: wristX, y: 0.5, z: 0 });
  landmarks.push({ x: wristX, y: 0.43, z: 0 }); // 10: Middle PIP
  landmarks.push({ x: wristX, y: 0.33, z: 0 });
  landmarks.push({ x: wristX, y: isOpen ? 0.18 : 0.6, z: 0 }); // 12: Middle Tip

  // 13: Ring MCP, 14: Ring PIP, 15: Ring DIP, 16: Ring Tip
  landmarks.push({ x: wristX + 0.06, y: 0.5, z: 0 });
  landmarks.push({ x: wristX + 0.06, y: 0.45, z: 0 }); // 14: Ring PIP
  landmarks.push({ x: wristX + 0.06, y: 0.35, z: 0 });
  landmarks.push({ x: wristX + 0.06, y: isOpen ? 0.22 : 0.6, z: 0 }); // 16: Ring Tip

  // 17: Pinky MCP, 18: Pinky PIP, 19: Pinky DIP, 20: Pinky Tip
  landmarks.push({ x: wristX + 0.12, y: 0.55, z: 0 }); // 17: Pinky MCP
  landmarks.push({ x: wristX + 0.12, y: 0.48, z: 0 }); // 18: Pinky PIP
  landmarks.push({ x: wristX + 0.12, y: 0.4, z: 0 });
  landmarks.push({ x: wristX + 0.12, y: isOpen ? 0.25 : 0.62, z: 0 }); // 20: Pinky Tip

  return landmarks;
}

describe('MultiHandHoldTracker', () => {
  describe('Options & Bounds Validation', () => {
    it('uses safe defaults for valid options', () => {
      const tracker = new MultiHandHoldTracker({
        holdDurationMs: 1000,
        cooldownMs: 2000,
        fingerExtensionRatio: 1.0,
        frameDropGraceMs: 150,
      });
      expect(tracker.getHoldDurationMs()).toBe(1000);
      expect(tracker.getCooldownMs()).toBe(2000);
    });

    it('clamps out-of-bounds holdDurationMs and cooldownMs', () => {
      const tracker = new MultiHandHoldTracker({
        holdDurationMs: 50, // below MIN 200
        cooldownMs: 999999, // above MAX 10000
        fingerExtensionRatio: 0.1, // below MIN 0.8
        frameDropGraceMs: -10, // below MIN 0
      });
      expect(tracker.getHoldDurationMs()).toBe(200);
      expect(tracker.getCooldownMs()).toBe(10000);
    });

    it('handles NaN or missing options gracefully', () => {
      const tracker = new MultiHandHoldTracker({
        holdDurationMs: NaN,
        cooldownMs: undefined,
      });
      expect(tracker.getHoldDurationMs()).toBe(1000);
      expect(tracker.getCooldownMs()).toBe(2000);
    });
  });

  describe('Landmark Integrity & Pose Evaluation', () => {
    it('validates 21-point landmark array and rejects malformed inputs', () => {
      const tracker = new MultiHandHoldTracker();
      expect(tracker.validateLandmarks([])).toBe(false);
      expect(
        tracker.validateLandmarks(new Array(20).fill({ x: 0, y: 0 })),
      ).toBe(false);
      expect(
        tracker.validateLandmarks(new Array(21).fill({ x: NaN, y: 0 })),
      ).toBe(false);

      const validOpen = createMockLandmarks(true);
      expect(tracker.validateLandmarks(validOpen)).toBe(true);
    });

    it('correctly evaluates open palm vs closed fist poses', () => {
      const tracker = new MultiHandHoldTracker();
      const openLandmarks = createMockLandmarks(true);
      const closedLandmarks = createMockLandmarks(false);

      const openState = tracker.evaluateFingers(openLandmarks);
      expect(openState).toEqual({
        thumb: 'open',
        index: 'open',
        middle: 'open',
        ring: 'open',
        pinky: 'open',
      });
      expect(tracker.isOpenPalm(openState)).toBe(true);

      const closedState = tracker.evaluateFingers(closedLandmarks);
      expect(closedState).toEqual({
        thumb: 'closed',
        index: 'closed',
        middle: 'closed',
        ring: 'closed',
        pinky: 'closed',
      });
      expect(tracker.isOpenPalm(closedState)).toBe(false);
    });
  });

  describe('State Machine & Single-Hand State Transitions', () => {
    it('transitions IDLE -> HOLDING -> TRIGGERED -> COOLDOWN -> IDLE', () => {
      const onTrigger = vi.fn();
      const tracker = new MultiHandHoldTracker({
        holdDurationMs: 1000,
        cooldownMs: 2000,
        onTrigger,
      });

      const openLandmarks = createMockLandmarks(true);
      const frameInput: HandLandmarkerResults = {
        landmarks: [openLandmarks],
        handedness: [[{ categoryName: 'Right' }]],
      };

      // Frame 1 at t=1000: IDLE -> HOLDING
      let result = tracker.processFrame(frameInput, 1000);
      expect(result.isHolding).toBe(true);
      expect(result.activeHoldProgress).toBe(0);
      expect(result.triggered).toBe(false);
      expect(result.inCooldown).toBe(false);
      expect(onTrigger).not.toHaveBeenCalled();

      // Frame 2 at t=1500: HOLDING (50% progress)
      result = tracker.processFrame(frameInput, 1500);
      expect(result.isHolding).toBe(true);
      expect(result.activeHoldProgress).toBeCloseTo(0.5, 2);
      expect(result.triggered).toBe(false);

      // Frame 3 at t=2000: HOLDING -> TRIGGERED
      result = tracker.processFrame(frameInput, 2000);
      expect(result.triggered).toBe(true);
      expect(onTrigger).toHaveBeenCalledTimes(1);
      expect(tracker.isCooldownActive(2000)).toBe(true);

      // Frame 4 at t=2100: TRIGGERED -> COOLDOWN (open palm does not accumulate)
      result = tracker.processFrame(frameInput, 2100);
      expect(result.isHolding).toBe(false);
      expect(result.triggered).toBe(false);
      expect(result.inCooldown).toBe(true);

      // Frame 5 at t=4500: COOLDOWN -> IDLE (cooldown expired at 4000, starts fresh hold)
      result = tracker.processFrame(frameInput, 4500);
      expect(result.inCooldown).toBe(false);
      expect(result.isHolding).toBe(true);
      expect(result.activeHoldProgress).toBe(0);
    });

    it('abruptly resets hold if user closes hand before hold duration completes', () => {
      const onTrigger = vi.fn();
      const tracker = new MultiHandHoldTracker({
        holdDurationMs: 1000,
        onTrigger,
      });

      const openLandmarks = createMockLandmarks(true);
      const closedLandmarks = createMockLandmarks(false);

      // Start hold at t=1000
      tracker.processFrame(
        {
          landmarks: [openLandmarks],
          handedness: [[{ categoryName: 'Right' }]],
        },
        1000,
      );
      // Progress at t=1600
      let res = tracker.processFrame(
        {
          landmarks: [openLandmarks],
          handedness: [[{ categoryName: 'Right' }]],
        },
        1600,
      );
      expect(res.activeHoldProgress).toBeCloseTo(0.6, 2);

      // Closes hand at t=1700
      res = tracker.processFrame(
        {
          landmarks: [closedLandmarks],
          handedness: [[{ categoryName: 'Right' }]],
        },
        1700,
      );
      expect(res.isHolding).toBe(false);
      expect(res.activeHoldProgress).toBe(0);
      expect(res.triggered).toBe(false);
      expect(onTrigger).not.toHaveBeenCalled();
    });
  });

  describe('Multi-Hand Hold Resilience (Bug Resolution)', () => {
    it('ensures Hand 1 (closed fist) does NOT reset Hand 0 (open palm) active hold timer', () => {
      const onTrigger = vi.fn();
      const tracker = new MultiHandHoldTracker({
        holdDurationMs: 1000,
        onTrigger,
      });

      const openLandmarks = createMockLandmarks(true, 0.3);
      const closedLandmarks = createMockLandmarks(false, 0.7);

      // Multi-hand frame: Hand 0 is open, Hand 1 is closed
      const multiHandFrame: HandLandmarkerResults = {
        landmarks: [openLandmarks, closedLandmarks],
        handedness: [[{ categoryName: 'Right' }], [{ categoryName: 'Left' }]],
      };

      // Frame 1 at t=1000: Hand 0 starts hold
      let res = tracker.processFrame(multiHandFrame, 1000);
      expect(res.isHolding).toBe(true);
      expect(res.activeHoldProgress).toBe(0);
      expect(res.triggered).toBe(false);

      // Frame 2 at t=1500: Hand 0 accumulates 50%, Hand 1 is closed
      res = tracker.processFrame(multiHandFrame, 1500);
      expect(res.isHolding).toBe(true);
      expect(res.activeHoldProgress).toBeCloseTo(0.5, 2);
      expect(res.triggered).toBe(false);

      // Frame 3 at t=2000: Hand 0 reaches 1000ms and triggers, regardless of Hand 1!
      res = tracker.processFrame(multiHandFrame, 2000);
      expect(res.triggered).toBe(true);
      expect(onTrigger).toHaveBeenCalledTimes(1);
    });

    it('ensures Hand 0 (closed fist) does NOT prevent Hand 1 (open palm) from triggering', () => {
      const onTrigger = vi.fn();
      const tracker = new MultiHandHoldTracker({
        holdDurationMs: 1000,
        onTrigger,
      });

      const closedLandmarks = createMockLandmarks(false, 0.3);
      const openLandmarks = createMockLandmarks(true, 0.7);

      // Hand 0 closed, Hand 1 open
      const multiHandFrame: HandLandmarkerResults = {
        landmarks: [closedLandmarks, openLandmarks],
        handedness: [[{ categoryName: 'Left' }], [{ categoryName: 'Right' }]],
      };

      tracker.processFrame(multiHandFrame, 1000);
      const midRes = tracker.processFrame(multiHandFrame, 1600);
      expect(midRes.isHolding).toBe(true);
      expect(midRes.activeHoldProgress).toBeCloseTo(0.6, 2);

      const finalRes = tracker.processFrame(multiHandFrame, 2000);
      expect(finalRes.triggered).toBe(true);
      expect(onTrigger).toHaveBeenCalledTimes(1);
    });

    it('handles hand order swapping between frames without resetting active hold', () => {
      const onTrigger = vi.fn();
      const tracker = new MultiHandHoldTracker({
        holdDurationMs: 1000,
        onTrigger,
      });

      const openRight = createMockLandmarks(true, 0.7);
      const closedLeft = createMockLandmarks(false, 0.2);

      // Frame 1: index 0 = Right (open), index 1 = Left (closed)
      tracker.processFrame(
        {
          landmarks: [openRight, closedLeft],
          handedness: [[{ categoryName: 'Right' }], [{ categoryName: 'Left' }]],
        },
        1000,
      );

      // Frame 2: index 0 = Left (closed), index 1 = Right (open) -> swapped order!
      const midRes = tracker.processFrame(
        {
          landmarks: [closedLeft, openRight],
          handedness: [[{ categoryName: 'Left' }], [{ categoryName: 'Right' }]],
        },
        1500,
      );
      expect(midRes.isHolding).toBe(true);
      expect(midRes.activeHoldProgress).toBeCloseTo(0.5, 2);

      // Frame 3: reaches trigger
      const finalRes = tracker.processFrame(
        {
          landmarks: [closedLeft, openRight],
          handedness: [[{ categoryName: 'Left' }], [{ categoryName: 'Right' }]],
        },
        2000,
      );
      expect(finalRes.triggered).toBe(true);
      expect(onTrigger).toHaveBeenCalledTimes(1);
    });

    it('triggers only once when both hands are held open simultaneously', () => {
      const onTrigger = vi.fn();
      const tracker = new MultiHandHoldTracker({
        holdDurationMs: 1000,
        cooldownMs: 2000,
        onTrigger,
      });

      const openLeft = createMockLandmarks(true, 0.2);
      const openRight = createMockLandmarks(true, 0.8);

      const bothOpenFrame: HandLandmarkerResults = {
        landmarks: [openLeft, openRight],
        handedness: [[{ categoryName: 'Left' }], [{ categoryName: 'Right' }]],
      };

      tracker.processFrame(bothOpenFrame, 1000);
      tracker.processFrame(bothOpenFrame, 1500);
      const finalRes = tracker.processFrame(bothOpenFrame, 2000);

      expect(finalRes.triggered).toBe(true);
      expect(onTrigger).toHaveBeenCalledTimes(1);

      // In the next frame, both hands are in cooldown and do not double trigger
      const nextRes = tracker.processFrame(bothOpenFrame, 2050);
      expect(nextRes.triggered).toBe(false);
      expect(nextRes.inCooldown).toBe(true);
      expect(onTrigger).toHaveBeenCalledTimes(1);
    });
  });

  describe('Grace Period for Momentary Frame Drops', () => {
    it('tolerates momentary dropped frames within grace period', () => {
      const onTrigger = vi.fn();
      const tracker = new MultiHandHoldTracker({
        holdDurationMs: 1000,
        frameDropGraceMs: 150,
        onTrigger,
      });

      const openLandmarks = createMockLandmarks(true);
      const frameInput: HandLandmarkerResults = {
        landmarks: [openLandmarks],
        handedness: [[{ categoryName: 'Right' }]],
      };

      // Frame 1 at t=1000: start hold
      tracker.processFrame(frameInput, 1000);

      // Frame 2 at t=1050: camera drops a frame (empty landmarks)
      tracker.processFrame({ landmarks: [] }, 1050);

      // Frame 3 at t=1100 (100ms after last seen <= 150ms grace): hand returns
      const res = tracker.processFrame(frameInput, 1100);
      expect(res.isHolding).toBe(true);
      expect(res.activeHoldProgress).toBeCloseTo(0.1, 2);

      // Frame 4 at t=2000: triggers!
      const finalRes = tracker.processFrame(frameInput, 2000);
      expect(finalRes.triggered).toBe(true);
      expect(onTrigger).toHaveBeenCalledTimes(1);
    });

    it('resets hold when hand disappears for longer than grace period', () => {
      const tracker = new MultiHandHoldTracker({
        holdDurationMs: 1000,
        frameDropGraceMs: 150,
      });

      const openLandmarks = createMockLandmarks(true);
      const frameInput: HandLandmarkerResults = {
        landmarks: [openLandmarks],
        handedness: [[{ categoryName: 'Right' }]],
      };

      tracker.processFrame(frameInput, 1000);
      // Hand missing for 200ms (> 150ms)
      tracker.processFrame({ landmarks: [] }, 1250);

      // Hand returns at t=1300 -> starts new hold from 0
      const res = tracker.processFrame(frameInput, 1300);
      expect(res.isHolding).toBe(true);
      expect(res.activeHoldProgress).toBe(0);
    });
  });

  describe('Primary Finger State Extraction', () => {
    it('returns primary finger state matching legacy structure', () => {
      const tracker = new MultiHandHoldTracker();
      const openLandmarks = createMockLandmarks(true);

      const res = tracker.processFrame(
        {
          landmarks: [openLandmarks],
          handedness: [[{ categoryName: 'Right' }]],
        },
        1000,
      );

      expect(res.primaryFingerState).toEqual({
        thumb: 'open',
        index: 'open',
        middle: 'open',
        ring: 'open',
        pinky: 'open',
      });
    });
  });
});
