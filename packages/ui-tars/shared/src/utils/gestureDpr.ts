/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

export interface Point3D {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
}

export interface CanvasDprMetrics {
  cssWidth: number;
  cssHeight: number;
  dpr: number;
  bufferWidth: number;
  bufferHeight: number;
  aspectRatio: number;
  scaleX: number;
  scaleY: number;
}

export interface GesturePreviewCoordinate {
  normalized: { x: number; y: number; z?: number };
  css: { x: number; y: number };
  canvas: { x: number; y: number };
  mirroredCss: { x: number; y: number };
  mirroredCanvas: { x: number; y: number };
}

export interface HandBoundsCheckResult {
  inBounds: boolean;
  outOfBoundsCount: number;
  totalLandmarks: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface FingerConfigState {
  thumb: 'open' | 'closed';
  index: 'open' | 'closed';
  middle: 'open' | 'closed';
  ring: 'open' | 'closed';
  pinky: 'open' | 'closed';
}

/**
 * Calculates canvas buffer metrics accounting for display DPR scaling.
 */
export function getCanvasDprMetrics(
  cssWidth: number,
  cssHeight: number,
  dpr: number = 1,
): CanvasDprMetrics {
  const safeWidth = cssWidth && cssWidth > 0 ? cssWidth : 320;
  const safeHeight = cssHeight && cssHeight > 0 ? cssHeight : 240;
  const safeDpr = Math.max(1, Number(dpr) || 1);

  const bufferWidth = Math.round(safeWidth * safeDpr);
  const bufferHeight = Math.round(safeHeight * safeDpr);
  const aspectRatio = safeWidth / safeHeight;

  return {
    cssWidth: safeWidth,
    cssHeight: safeHeight,
    dpr: safeDpr,
    bufferWidth,
    bufferHeight,
    aspectRatio,
    scaleX: safeDpr,
    scaleY: safeDpr,
  };
}

/**
 * Maps normalized MediaPipe landmarks [0, 1] to both logical CSS coordinates
 * and physical canvas buffer coordinates without double-scaling under DPR scaling.
 */
export function calculateDprPreviewCoordinates(
  landmarks: Point3D[],
  metrics: CanvasDprMetrics,
): GesturePreviewCoordinate[] {
  if (!landmarks || landmarks.length === 0) {
    return [];
  }

  return landmarks.map((lm) => {
    const normX = Math.max(0, Math.min(1, lm.x));
    const normY = Math.max(0, Math.min(1, lm.y));

    // Logical CSS coordinates
    const cssX = normX * metrics.cssWidth;
    const cssY = normY * metrics.cssHeight;

    // Physical canvas buffer coordinates
    const canvasX = normX * metrics.bufferWidth;
    const canvasY = normY * metrics.bufferHeight;

    // Mirrored coordinates for live webcam mirror view
    const mirroredCssX = (1 - normX) * metrics.cssWidth;
    const mirroredCssY = cssY;

    const mirroredCanvasX = (1 - normX) * metrics.bufferWidth;
    const mirroredCanvasY = canvasY;

    return {
      normalized: { x: normX, y: normY, z: lm.z },
      css: { x: cssX, y: cssY },
      canvas: { x: canvasX, y: canvasY },
      mirroredCss: { x: mirroredCssX, y: mirroredCssY },
      mirroredCanvas: { x: mirroredCanvasX, y: mirroredCanvasY },
    };
  });
}

/**
 * Validates whether hand landmarks are within visible bounds.
 */
export function checkGestureBounds(
  landmarks: Point3D[],
  marginThreshold: number = 0.0,
): HandBoundsCheckResult {
  if (!landmarks || landmarks.length === 0) {
    return {
      inBounds: false,
      outOfBoundsCount: 0,
      totalLandmarks: 0,
      minX: 0,
      maxX: 0,
      minY: 0,
      maxY: 0,
    };
  }

  const minBound = marginThreshold;
  const maxBound = 1.0 - marginThreshold;

  let outOfBoundsCount = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < landmarks.length; i++) {
    const pt = landmarks[i];
    if (pt.x < minX) minX = pt.x;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.y > maxY) maxY = pt.y;

    if (
      pt.x < minBound ||
      pt.x > maxBound ||
      pt.y < minBound ||
      pt.y > maxBound
    ) {
      outOfBoundsCount++;
    }
  }

  // Critical landmark checks: Wrist (0) must strictly be within bounds
  const wrist = landmarks[0];
  const isWristValid =
    wrist &&
    wrist.x >= minBound &&
    wrist.x <= maxBound &&
    wrist.y >= minBound &&
    wrist.y <= maxBound;

  // In-bounds if wrist is valid and no more than 3 landmarks exceed the threshold
  const inBounds = isWristValid && outOfBoundsCount <= 3;

  return {
    inBounds,
    outOfBoundsCount,
    totalLandmarks: landmarks.length,
    minX: minX === Infinity ? 0 : minX,
    maxX: maxX === -Infinity ? 0 : maxX,
    minY: minY === Infinity ? 0 : minY,
    maxY: maxY === -Infinity ? 0 : maxY,
  };
}

/**
 * Calculates isotropic Euclidean distance between two points in aspect-corrected space.
 */
export function calculateDprAspectCorrectedDistance(
  p1: Point3D,
  p2: Point3D,
  aspectRatio: number = 1.0,
): number {
  const ar = aspectRatio > 0 ? aspectRatio : 1.0;
  const dx = (p1.x - p2.x) * ar;
  const dy = p1.y - p2.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Computes finger open/closed state using invariant distance heuristics.
 */
export function computeDprFingerStates(
  landmarks: Point3D[],
  aspectRatio: number = 4 / 3,
): FingerConfigState {
  if (!landmarks || landmarks.length < 21) {
    return {
      thumb: 'closed',
      index: 'closed',
      middle: 'closed',
      ring: 'closed',
      pinky: 'closed',
    };
  }

  const dist = (p1: Point3D, p2: Point3D) =>
    calculateDprAspectCorrectedDistance(p1, p2, aspectRatio);

  // For fingers (index, middle, ring, pinky):
  // Tip should be further from wrist (0) than PIP (second joint)
  const isFingerOpen = (tipIdx: number, pipIdx: number) =>
    dist(landmarks[tipIdx], landmarks[0]) >
    dist(landmarks[pipIdx], landmarks[0]);

  // For thumb:
  // Tip (4) should be further from Pinky MCP (17) than the Thumb IP (3) is from Pinky MCP (17)
  const isThumbOpen =
    dist(landmarks[4], landmarks[17]) > dist(landmarks[3], landmarks[17]);

  return {
    thumb: isThumbOpen ? 'open' : 'closed',
    index: isFingerOpen(8, 6) ? 'open' : 'closed',
    middle: isFingerOpen(12, 10) ? 'open' : 'closed',
    ring: isFingerOpen(16, 14) ? 'open' : 'closed',
    pinky: isFingerOpen(20, 18) ? 'open' : 'closed',
  };
}

/**
 * State smoother that bridges unexpected landmark frame drops and
 * requires multi-frame confirmation to prevent rapid transition jitter.
 */
export class DprGestureStateSmoother {
  private confirmationFrames: number;
  private maxAllowedDrops: number;
  private lastValidState: FingerConfigState | null = null;
  private candidateState: FingerConfigState | null = null;
  private candidateCount: number = 0;
  private dropCount: number = 0;

  constructor(confirmationFrames: number = 2, maxAllowedDrops: number = 3) {
    this.confirmationFrames = confirmationFrames;
    this.maxAllowedDrops = maxAllowedDrops;
  }

  public update(
    state: FingerConfigState | null,
    inBounds: boolean = true,
  ): {
    state: FingerConfigState | null;
    stable: boolean;
    dropped: boolean;
  } {
    if (!state || !inBounds) {
      if (this.lastValidState && this.dropCount < this.maxAllowedDrops) {
        this.dropCount++;
        return {
          state: this.lastValidState,
          stable: true,
          dropped: true,
        };
      }
      this.lastValidState = null;
      this.candidateState = null;
      this.candidateCount = 0;
      return {
        state: null,
        stable: false,
        dropped: true,
      };
    }

    this.dropCount = 0;

    if (this.areStatesEqual(state, this.candidateState)) {
      this.candidateCount++;
    } else {
      this.candidateState = state;
      this.candidateCount = 1;
    }

    if (this.candidateCount >= this.confirmationFrames) {
      this.lastValidState = state;
      return {
        state: this.lastValidState,
        stable: true,
        dropped: false,
      };
    }

    return {
      state: this.lastValidState || state,
      stable: false,
      dropped: false,
    };
  }

  public reset(): void {
    this.lastValidState = null;
    this.candidateState = null;
    this.candidateCount = 0;
    this.dropCount = 0;
  }

  private areStatesEqual(
    s1: FingerConfigState | null,
    s2: FingerConfigState | null,
  ): boolean {
    if (!s1 || !s2) return false;
    return (
      s1.thumb === s2.thumb &&
      s1.index === s2.index &&
      s1.middle === s2.middle &&
      s1.ring === s2.ring &&
      s1.pinky === s2.pinky
    );
  }
}
