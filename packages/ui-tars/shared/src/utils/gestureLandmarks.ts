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

export interface WebcamCropMetrics {
  videoWidth: number;
  videoHeight: number;
  videoAspectRatio: number;
  targetAspectRatio: number;
  cropX: number;
  cropY: number;
  scaleX: number;
  scaleY: number;
}

export interface HandBoundsResult {
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
 * Calculates crop metrics when displaying video inside a container
 * with a target aspect ratio (default 16:9) using `object-fit: cover`.
 */
export function getWebcamCropMetrics(
  videoWidth: number,
  videoHeight: number,
  targetAspectRatio: number = 16 / 9,
): WebcamCropMetrics {
  if (!videoWidth || !videoHeight || videoWidth <= 0 || videoHeight <= 0) {
    return {
      videoWidth: 1280,
      videoHeight: 720,
      videoAspectRatio: targetAspectRatio,
      targetAspectRatio,
      cropX: 0,
      cropY: 0,
      scaleX: 1,
      scaleY: 1,
    };
  }

  const videoAspectRatio = videoWidth / videoHeight;

  let cropX = 0;
  let cropY = 0;

  if (videoAspectRatio < targetAspectRatio) {
    // Video is taller than target (e.g. 4:3 video in 16:9 container)
    // Vertical crop at top and bottom
    const visibleHeight = videoWidth / targetAspectRatio;
    const cropPixelsY = (videoHeight - visibleHeight) / 2;
    cropY = cropPixelsY / videoHeight;
  } else if (videoAspectRatio > targetAspectRatio) {
    // Video is wider than target (e.g. 16:9 video in 4:3 container)
    // Horizontal crop at left and right
    const visibleWidth = videoHeight * targetAspectRatio;
    const cropPixelsX = (videoWidth - visibleWidth) / 2;
    cropX = cropPixelsX / videoWidth;
  }

  // Guard against numeric edge cases
  cropX = Math.max(0, Math.min(0.49, cropX));
  cropY = Math.max(0, Math.min(0.49, cropY));

  const scaleX = 1 / (1 - 2 * cropX);
  const scaleY = 1 / (1 - 2 * cropY);

  return {
    videoWidth,
    videoHeight,
    videoAspectRatio,
    targetAspectRatio,
    cropX,
    cropY,
    scaleX,
    scaleY,
  };
}

/**
 * Maps landmarks from raw normalized video coordinates into the cropped visible frame coordinates.
 */
export function correctHandLandmarks(
  landmarks: Point3D[],
  cropMetrics: WebcamCropMetrics,
): Point3D[] {
  if (!landmarks || landmarks.length === 0) return [];
  const { cropX, cropY, scaleX, scaleY } = cropMetrics;
  return landmarks.map((lm) => ({
    ...lm,
    x: Math.max(0, Math.min(1, (lm.x - cropX) * scaleX)),
    y: Math.max(0, Math.min(1, (lm.y - cropY) * scaleY)),
    z: lm.z !== undefined ? lm.z * scaleX : 0,
    visibility: lm.visibility,
  }));
}

/**
 * Checks whether hand landmarks are within visible bounds of the cropped webcam feed.
 */
export function checkHandBounds(
  landmarks: Point3D[],
  margin = 0.05,
): HandBoundsResult {
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

  const keyIndices = [0, 4, 8, 12, 16, 20];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  let outOfBoundsCount = 0;
  for (let i = 0; i < landmarks.length; i++) {
    const p = landmarks[i];
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;

    if (
      p.x < -margin ||
      p.x > 1 + margin ||
      p.y < -margin ||
      p.y > 1 + margin
    ) {
      outOfBoundsCount++;
    }
  }

  const wrist = landmarks[0];
  const wristInBounds =
    wrist &&
    wrist.x >= -margin &&
    wrist.x <= 1 + margin &&
    wrist.y >= -margin &&
    wrist.y <= 1 + margin;

  let keyOutOfBounds = 0;
  for (const idx of keyIndices) {
    const kp = landmarks[idx];
    if (
      !kp ||
      kp.x < -margin ||
      kp.x > 1 + margin ||
      kp.y < -margin ||
      kp.y > 1 + margin
    ) {
      keyOutOfBounds++;
    }
  }

  const inBounds = Boolean(
    wristInBounds && keyOutOfBounds <= 1 && outOfBoundsCount <= 4,
  );

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
 * Calculates Euclidean distance with aspect-ratio correction to eliminate coordinate distortion.
 */
export function calculateAspectCorrectedDistance(
  p1: Point3D,
  p2: Point3D,
  aspectRatio: number = 1.0,
  includeZ: boolean = false,
): number {
  const dx = (p1.x - p2.x) * aspectRatio;
  const dy = p1.y - p2.y;
  if (includeZ && p1.z !== undefined && p2.z !== undefined) {
    const dz = (p1.z - p2.z) * aspectRatio;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Computes individual finger open/closed states using aspect-corrected distance metrics.
 */
export function computeFingerStates(
  landmarks: Point3D[],
  aspectRatio: number = 1.0,
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
    calculateAspectCorrectedDistance(p1, p2, aspectRatio);

  // For fingers: Tip should be further from wrist (0) than PIP (joint)
  const isFingerOpen = (tipIdx: number, pipIdx: number) =>
    dist(landmarks[tipIdx], landmarks[0]) >
    dist(landmarks[pipIdx], landmarks[0]);

  // For thumb: Tip (4) should be further from Pinky MCP (17) than the Thumb IP (3) is from Pinky MCP (17)
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
 * Smoothes rapid gesture transitions and bridges unexpected landmark frame drops.
 */
export class GestureStateSmoother {
  private lastValidState: FingerConfigState | null = null;
  private consecutiveDrops = 0;
  private maxAllowedDrops: number;
  private stateHoldCount = 0;
  private requiredHoldFrames: number;
  private candidateState: FingerConfigState | null = null;

  constructor(requiredHoldFrames = 2, maxAllowedDrops = 3) {
    this.requiredHoldFrames = requiredHoldFrames;
    this.maxAllowedDrops = maxAllowedDrops;
  }

  public update(
    currentState: FingerConfigState | null,
    inBounds: boolean,
  ): { state: FingerConfigState | null; stable: boolean; dropped: boolean } {
    if (!currentState || !inBounds) {
      this.consecutiveDrops++;
      if (
        this.consecutiveDrops <= this.maxAllowedDrops &&
        this.lastValidState
      ) {
        return { state: this.lastValidState, stable: true, dropped: true };
      }
      return { state: null, stable: false, dropped: true };
    }

    this.consecutiveDrops = 0;

    const isSameAsCandidate =
      this.candidateState &&
      (['thumb', 'index', 'middle', 'ring', 'pinky'] as const).every(
        (f) => this.candidateState![f] === currentState[f],
      );

    if (isSameAsCandidate) {
      this.stateHoldCount++;
      if (this.stateHoldCount >= this.requiredHoldFrames) {
        this.lastValidState = currentState;
        return { state: currentState, stable: true, dropped: false };
      }
    } else {
      this.candidateState = currentState;
      this.stateHoldCount = 1;
    }

    return {
      state: this.lastValidState || currentState,
      stable: this.stateHoldCount >= this.requiredHoldFrames,
      dropped: false,
    };
  }

  public reset(): void {
    this.lastValidState = null;
    this.consecutiveDrops = 0;
    this.stateHoldCount = 0;
    this.candidateState = null;
  }
}
