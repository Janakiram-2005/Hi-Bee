/**
 * Utility functions for MediaPipe landmark validation, bounds checking,
 * robust finger state calculation, and timeline extraction.
 */

export type FingerState = 'open' | 'closed';

export interface FingerConfig {
  thumb: FingerState | 'any';
  index: FingerState | 'any';
  middle: FingerState | 'any';
  ring: FingerState | 'any';
  pinky: FingerState | 'any';
}

export interface StrictFingerConfig {
  thumb: FingerState;
  index: FingerState;
  middle: FingerState;
  ring: FingerState;
  pinky: FingerState;
}

export interface NormalizedLandmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

export interface HandStateEventDetail {
  thumb: FingerState;
  index: FingerState;
  middle: FingerState;
  ring: FingerState;
  pinky: FingerState;
  fingers: StrictFingerConfig;
  landmarks: NormalizedLandmark[] | null;
  coordinates: NormalizedLandmark[] | null;
  isValid: boolean;
  isFrameDrop: boolean;
}

export interface FaceState {
  blink: boolean;
  lookLeft: boolean;
  lookRight: boolean;
  nodUp: boolean;
  nodDown: boolean;
  turnLeft: boolean;
  turnRight: boolean;
}

export interface FaceStateEventDetail extends FaceState {
  faceState: FaceState;
  landmarks: NormalizedLandmark[] | null;
  isValid: boolean;
  isFrameDrop: boolean;
}

/**
 * Validates that a numeric coordinate is finite and within reasonable normalized bounds.
 * Allows a small margin beyond [0, 1] (e.g. [-1.0, 2.0]) to accommodate natural off-screen motion
 * while strictly rejecting NaN, Infinity, and malformed data.
 */
export function isValidCoordinate(
  val: unknown,
  min = -1.0,
  max = 2.0,
): boolean {
  return (
    typeof val === 'number' && Number.isFinite(val) && val >= min && val <= max
  );
}

/**
 * Validates a single landmark point.
 */
export function isValidLandmark(lm: unknown): lm is NormalizedLandmark {
  if (!lm || typeof lm !== 'object') return false;
  const l = lm as Record<string, unknown>;
  return (
    isValidCoordinate(l.x) &&
    isValidCoordinate(l.y) &&
    typeof l.z === 'number' &&
    Number.isFinite(l.z)
  );
}

/**
 * Validates and sanitizes a complete 21-point MediaPipe hand landmark frame.
 * Returns null if the frame is corrupted, has missing landmarks, or contains non-finite coordinates.
 */
export function validateAndSanitizeLandmarks(
  landmarks: unknown,
): NormalizedLandmark[] | null {
  if (!Array.isArray(landmarks)) return null;
  if (landmarks.length !== 21) return null;

  const sanitized: NormalizedLandmark[] = [];
  for (let i = 0; i < 21; i++) {
    const lm = landmarks[i];
    if (!isValidLandmark(lm)) {
      return null;
    }
    sanitized.push({
      x: lm.x,
      y: lm.y,
      z: lm.z,
      visibility:
        typeof lm.visibility === 'number' && Number.isFinite(lm.visibility)
          ? lm.visibility
          : 0,
    });
  }
  return sanitized;
}

/**
 * Calculates 2D Euclidean distance between two landmark points.
 */
export function euclideanDistance2D(
  p1: NormalizedLandmark,
  p2: NormalizedLandmark,
): number {
  if (!isValidLandmark(p1) || !isValidLandmark(p2)) return 0;
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Calculates 3D Euclidean distance between two landmark points.
 */
export function euclideanDistance3D(
  p1: NormalizedLandmark,
  p2: NormalizedLandmark,
): number {
  if (!isValidLandmark(p1) || !isValidLandmark(p2)) return 0;
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  const dz = p1.z - p2.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Computes discrete finger open/closed states from 21 MediaPipe hand landmarks with bounds checks.
 * Heuristics:
 * - Fingers (index, middle, ring, pinky): Open if fingertip is further from wrist (0) than PIP joint.
 * - Thumb: Open if thumb tip (4) is further from pinky MCP (17) than thumb IP (3) is from pinky MCP (17).
 */
export function computeFingerStates(
  landmarks: NormalizedLandmark[],
): StrictFingerConfig {
  if (!Array.isArray(landmarks) || landmarks.length < 21) {
    return {
      thumb: 'closed',
      index: 'closed',
      middle: 'closed',
      ring: 'closed',
      pinky: 'closed',
    };
  }

  const wrist = landmarks[0];
  const pinkyMcp = landmarks[17];
  const thumbIp = landmarks[3];
  const thumbTip = landmarks[4];

  if (
    !isValidLandmark(wrist) ||
    !isValidLandmark(pinkyMcp) ||
    !isValidLandmark(thumbIp) ||
    !isValidLandmark(thumbTip)
  ) {
    return {
      thumb: 'closed',
      index: 'closed',
      middle: 'closed',
      ring: 'closed',
      pinky: 'closed',
    };
  }

  const isFingerOpen = (tipIdx: number, pipIdx: number): boolean => {
    const tip = landmarks[tipIdx];
    const pip = landmarks[pipIdx];
    if (!isValidLandmark(tip) || !isValidLandmark(pip)) return false;
    return euclideanDistance2D(tip, wrist) > euclideanDistance2D(pip, wrist);
  };

  const isThumbOpen =
    euclideanDistance2D(thumbTip, pinkyMcp) >
    euclideanDistance2D(thumbIp, pinkyMcp);

  return {
    thumb: isThumbOpen ? 'open' : 'closed',
    index: isFingerOpen(8, 6) ? 'open' : 'closed',
    middle: isFingerOpen(12, 10) ? 'open' : 'closed',
    ring: isFingerOpen(16, 14) ? 'open' : 'closed',
    pinky: isFingerOpen(20, 18) ? 'open' : 'closed',
  };
}

/**
 * Checks whether the current finger state represents an Open Palm gesture (all 5 fingers open).
 */
export function isOpenPalmState(
  state: StrictFingerConfig | FingerConfig | null | undefined,
): boolean {
  if (!state) return false;
  return (
    state.thumb === 'open' &&
    state.index === 'open' &&
    state.middle === 'open' &&
    state.ring === 'open' &&
    state.pinky === 'open'
  );
}

/**
 * Extracts and sanitizes hand landmarks from an incoming vision event detail.
 * Handles diverse payload formats (raw array, { landmarks }, { coordinates }, { data }, or frame drops).
 */
export function extractSanitizedHandLandmarks(
  detail: unknown,
): NormalizedLandmark[] | null {
  if (!detail) return null;

  if (Array.isArray(detail)) {
    return validateAndSanitizeLandmarks(detail);
  }

  if (typeof detail === 'object') {
    const obj = detail as Record<string, unknown>;
    if (obj.isFrameDrop === true) {
      return null;
    }
    if (Array.isArray(obj.landmarks)) {
      return validateAndSanitizeLandmarks(obj.landmarks);
    }
    if (Array.isArray(obj.coordinates)) {
      return validateAndSanitizeLandmarks(obj.coordinates);
    }
    if (Array.isArray(obj.data)) {
      return validateAndSanitizeLandmarks(obj.data);
    }
  }

  return null;
}

/**
 * Safely extracts finger states from an event detail or calculates them from landmark data.
 */
export function extractSanitizedFingers(
  detail: unknown,
): StrictFingerConfig | null {
  if (!detail || typeof detail !== 'object') return null;

  const obj = detail as Record<string, unknown>;
  if (obj.isFrameDrop === true) return null;

  const source = (
    obj.fingers && typeof obj.fingers === 'object' ? obj.fingers : obj
  ) as Record<string, unknown>;

  const parseState = (val: unknown): FingerState =>
    val === 'open' ? 'open' : 'closed';

  if (
    'thumb' in source ||
    'index' in source ||
    'middle' in source ||
    'ring' in source ||
    'pinky' in source
  ) {
    return {
      thumb: parseState(source.thumb),
      index: parseState(source.index),
      middle: parseState(source.middle),
      ring: parseState(source.ring),
      pinky: parseState(source.pinky),
    };
  }

  const sanitizedLms = extractSanitizedHandLandmarks(detail);
  if (sanitizedLms) {
    return computeFingerStates(sanitizedLms);
  }

  return null;
}

/**
 * Extracts 210 pairwise 3D distance features from a timeline of recorded hand frames.
 * Filters out corrupted frames and NaN values to prevent model training crashes.
 */
export function extractFeaturesFromTimeline(timelineData: unknown[]): number[] {
  if (!Array.isArray(timelineData) || timelineData.length === 0) {
    return new Array(210).fill(0.0);
  }

  const handStates: NormalizedLandmark[][] = [];

  for (const item of timelineData) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    if (entry.type !== 'hand' || !entry.data) continue;

    const sanitized = validateAndSanitizeLandmarks(entry.data);
    if (sanitized && sanitized.length === 21) {
      handStates.push(sanitized);
    }
  }

  if (handStates.length === 0) {
    return new Array(210).fill(0.0);
  }

  const avgLandmarks: NormalizedLandmark[] = [];
  for (let i = 0; i < 21; i++) {
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    let count = 0;
    for (const frame of handStates) {
      const lm = frame[i];
      if (
        lm &&
        Number.isFinite(lm.x) &&
        Number.isFinite(lm.y) &&
        Number.isFinite(lm.z)
      ) {
        sumX += lm.x;
        sumY += lm.y;
        sumZ += lm.z;
        count++;
      }
    }
    if (count > 0) {
      avgLandmarks.push({ x: sumX / count, y: sumY / count, z: sumZ / count });
    } else {
      avgLandmarks.push({ x: 0, y: 0, z: 0 });
    }
  }

  if (
    avgLandmarks.length === 21 &&
    avgLandmarks.some((lm) => lm.x !== 0 || lm.y !== 0 || lm.z !== 0)
  ) {
    const dists: number[] = [];
    for (let i = 0; i < 21; i++) {
      for (let j = i + 1; j < 21; j++) {
        const dx = avgLandmarks[i].x - avgLandmarks[j].x;
        const dy = avgLandmarks[i].y - avgLandmarks[j].y;
        const dz = avgLandmarks[i].z - avgLandmarks[j].z;
        dists.push(Math.sqrt(dx * dx + dy * dy + dz * dz));
      }
    }
    const maxDist = Math.max(...dists, 1.0);
    const validMax = Number.isFinite(maxDist) && maxDist > 0 ? maxDist : 1.0;
    return dists.map((d) => (Number.isFinite(d) ? d / validMax : 0.0));
  }

  return new Array(210).fill(0.0);
}

/**
 * Validates and sanitizes face landmarks.
 */
export function validateAndSanitizeFaceLandmarks(
  landmarks: unknown,
): NormalizedLandmark[] | null {
  if (!Array.isArray(landmarks) || landmarks.length < 455) return null;
  const sanitized: NormalizedLandmark[] = [];
  for (let i = 0; i < landmarks.length; i++) {
    const lm = landmarks[i];
    if (!isValidLandmark(lm)) return null;
    sanitized.push({
      x: lm.x,
      y: lm.y,
      z: lm.z,
    });
  }
  return sanitized;
}

/**
 * Computes face state with bounds and division-by-zero checks.
 */
export function computeFaceState(
  categories: Array<{ categoryName: string; score: number }> | null | undefined,
  faceLandmarks: NormalizedLandmark[] | null | undefined,
): FaceState {
  const cats = Array.isArray(categories) ? categories : [];
  const blinkLeft =
    cats.find((b) => b.categoryName === 'eyeBlinkLeft')?.score || 0;
  const blinkRight =
    cats.find((b) => b.categoryName === 'eyeBlinkRight')?.score || 0;
  const eyeLookInLeft =
    cats.find((b) => b.categoryName === 'eyeLookInLeft')?.score || 0;
  const eyeLookOutLeft =
    cats.find((b) => b.categoryName === 'eyeLookOutLeft')?.score || 0;

  const isBlink = blinkLeft > 0.6 && blinkRight > 0.6;
  const isLookLeft = eyeLookOutLeft > 0.5;
  const isLookRight = eyeLookInLeft > 0.5;

  let isNodUp = false;
  let isNodDown = false;
  let isTurnLeft = false;
  let isTurnRight = false;

  if (Array.isArray(faceLandmarks) && faceLandmarks.length > 454) {
    const nose = faceLandmarks[1];
    const leftCheek = faceLandmarks[234];
    const rightCheek = faceLandmarks[454];
    const top = faceLandmarks[10];
    const bottom = faceLandmarks[152];

    if (
      isValidLandmark(nose) &&
      isValidLandmark(leftCheek) &&
      isValidLandmark(rightCheek) &&
      isValidLandmark(top) &&
      isValidLandmark(bottom)
    ) {
      const leftDist = Math.abs(nose.x - leftCheek.x);
      const rightDist = Math.abs(rightCheek.x - nose.x);
      const yawDenom = rightDist + 0.0001;
      const yawRatio = leftDist / yawDenom;

      if (Number.isFinite(yawRatio)) {
        if (yawRatio > 2.0) isTurnRight = true;
        if (yawRatio < 0.5) isTurnLeft = true;
      }

      const topDist = Math.abs(nose.y - top.y);
      const bottomDist = Math.abs(bottom.y - nose.y);
      const pitchDenom = bottomDist + 0.0001;
      const pitchRatio = topDist / pitchDenom;

      if (Number.isFinite(pitchRatio)) {
        if (pitchRatio > 1.5) isNodDown = true;
        if (pitchRatio < 0.7) isNodUp = true;
      }
    }
  }

  return {
    blink: isBlink,
    lookLeft: isLookLeft,
    lookRight: isLookRight,
    nodUp: isNodUp,
    nodDown: isNodDown,
    turnLeft: isTurnLeft,
    turnRight: isTurnRight,
  };
}
