/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

export interface NormalizedLandmark {
  x: number;
  y: number;
  z?: number;
}

export interface HandCategory {
  categoryName?: string;
  displayName?: string;
  score?: number;
  index?: number;
}

export interface HandLandmarkerResults {
  landmarks?: NormalizedLandmark[][];
  handedness?: HandCategory[][];
}

export interface FingerState {
  thumb: 'open' | 'closed';
  index: 'open' | 'closed';
  middle: 'open' | 'closed';
  ring: 'open' | 'closed';
  pinky: 'open' | 'closed';
}

export interface MultiHandHoldTrackerOptions {
  /** Hold duration in ms required to trigger toggle (default: 1000) */
  holdDurationMs?: number;
  /** Cooldown in ms after trigger before another hold can activate (default: 2000) */
  cooldownMs?: number;
  /** Extension ratio multiplier for finger open heuristic (default: 1.0) */
  fingerExtensionRatio?: number;
  /** Allowed grace period in ms for momentary landmark loss or frame drops (default: 150) */
  frameDropGraceMs?: number;
  /** Optional callback invoked when hold completes */
  onTrigger?: (handKey: string, timestamp: number) => void;
  /** Optional logging callback or defaults to console.log */
  logger?: (message: string) => void;
}

export interface HandHoldState {
  handKey: string;
  handedness: string;
  holdStartTime: number;
  lastSeenTime: number;
  isOpenPalm: boolean;
  progress: number;
  fingerStates: FingerState;
}

export interface FrameProcessingResult {
  isHolding: boolean;
  activeHoldProgress: number;
  activeHandKey: string | null;
  triggered: boolean;
  inCooldown: boolean;
  hands: HandHoldState[];
  primaryFingerState: FingerState | null;
}

const MIN_HOLD_DURATION_MS = 200;
const MAX_HOLD_DURATION_MS = 5000;
const MIN_COOLDOWN_MS = 500;
const MAX_COOLDOWN_MS = 10000;
const MIN_EXTENSION_RATIO = 0.8;
const MAX_EXTENSION_RATIO = 1.5;

export class MultiHandHoldTracker {
  private holdDurationMs: number;
  private cooldownMs: number;
  private fingerExtensionRatio: number;
  private frameDropGraceMs: number;
  private onTrigger?: (handKey: string, timestamp: number) => void;
  private logger: (message: string) => void;

  private handStates: Map<string, HandHoldState> = new Map();
  private cooldownUntil: number = 0;

  constructor(options: MultiHandHoldTrackerOptions = {}) {
    const validated = this.validateOptions(options);
    this.holdDurationMs = validated.holdDurationMs;
    this.cooldownMs = validated.cooldownMs;
    this.fingerExtensionRatio = validated.fingerExtensionRatio;
    this.frameDropGraceMs = validated.frameDropGraceMs;
    this.onTrigger = options.onTrigger;
    this.logger =
      options.logger || ((msg: string) => console.log(`[VisionWake] ${msg}`));
  }

  /**
   * Validate and clamp configured threshold bounds.
   */
  public validateOptions(options: MultiHandHoldTrackerOptions) {
    let holdDurationMs = options.holdDurationMs ?? 1000;
    if (
      isNaN(holdDurationMs) ||
      holdDurationMs < MIN_HOLD_DURATION_MS ||
      holdDurationMs > MAX_HOLD_DURATION_MS
    ) {
      holdDurationMs = Math.min(
        Math.max(holdDurationMs || 1000, MIN_HOLD_DURATION_MS),
        MAX_HOLD_DURATION_MS,
      );
    }

    let cooldownMs = options.cooldownMs ?? 2000;
    if (
      isNaN(cooldownMs) ||
      cooldownMs < MIN_COOLDOWN_MS ||
      cooldownMs > MAX_COOLDOWN_MS
    ) {
      cooldownMs = Math.min(
        Math.max(cooldownMs || 2000, MIN_COOLDOWN_MS),
        MAX_COOLDOWN_MS,
      );
    }

    let fingerExtensionRatio = options.fingerExtensionRatio ?? 1.0;
    if (
      isNaN(fingerExtensionRatio) ||
      fingerExtensionRatio < MIN_EXTENSION_RATIO ||
      fingerExtensionRatio > MAX_EXTENSION_RATIO
    ) {
      fingerExtensionRatio = Math.min(
        Math.max(fingerExtensionRatio || 1.0, MIN_EXTENSION_RATIO),
        MAX_EXTENSION_RATIO,
      );
    }

    let frameDropGraceMs = options.frameDropGraceMs ?? 150;
    if (
      isNaN(frameDropGraceMs) ||
      frameDropGraceMs < 0 ||
      frameDropGraceMs > 500
    ) {
      frameDropGraceMs = Math.min(Math.max(frameDropGraceMs || 150, 0), 500);
    }

    return {
      holdDurationMs,
      cooldownMs,
      fingerExtensionRatio,
      frameDropGraceMs,
    };
  }

  public getHoldDurationMs(): number {
    return this.holdDurationMs;
  }

  public getCooldownMs(): number {
    return this.cooldownMs;
  }

  public isCooldownActive(now: number = Date.now()): boolean {
    return now < this.cooldownUntil;
  }

  /**
   * Validates landmark array integrity (21 landmarks, valid finite numbers).
   */
  public validateLandmarks(landmarks: NormalizedLandmark[]): boolean {
    if (!Array.isArray(landmarks) || landmarks.length < 21) {
      return false;
    }
    for (let i = 0; i < 21; i++) {
      const pt = landmarks[i];
      if (
        !pt ||
        typeof pt.x !== 'number' ||
        typeof pt.y !== 'number' ||
        !isFinite(pt.x) ||
        !isFinite(pt.y)
      ) {
        return false;
      }
    }
    return true;
  }

  /**
   * Euclidean distance between two 2D points.
   */
  public dist(p1: NormalizedLandmark, p2: NormalizedLandmark): number {
    return Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));
  }

  /**
   * Computes open/closed state for each finger based on landmarks.
   */
  public evaluateFingers(landmarks: NormalizedLandmark[]): FingerState {
    const wrist = landmarks[0];
    const pinkyMcp = landmarks[17];
    const thumbIp = landmarks[3];
    const thumbTip = landmarks[4];

    // For fingers 8 (index), 12 (middle), 16 (ring), 20 (pinky):
    // Tip distance to wrist must exceed PIP (joint) distance to wrist by ratio
    const isFingerOpen = (tipIdx: number, pipIdx: number) => {
      const tipDist = this.dist(landmarks[tipIdx], wrist);
      const pipDist = this.dist(landmarks[pipIdx], wrist);
      return tipDist > pipDist * this.fingerExtensionRatio;
    };

    // For thumb: Tip (4) distance to Pinky MCP (17) vs Thumb IP (3) to Pinky MCP (17)
    const isThumbOpen =
      this.dist(thumbTip, pinkyMcp) >
      this.dist(thumbIp, pinkyMcp) * this.fingerExtensionRatio;

    return {
      thumb: isThumbOpen ? 'open' : 'closed',
      index: isFingerOpen(8, 6) ? 'open' : 'closed',
      middle: isFingerOpen(12, 10) ? 'open' : 'closed',
      ring: isFingerOpen(16, 14) ? 'open' : 'closed',
      pinky: isFingerOpen(20, 18) ? 'open' : 'closed',
    };
  }

  /**
   * Checks if all 5 fingers are open (Open Palm pose).
   */
  public isOpenPalm(fingerState: FingerState): boolean {
    return (
      fingerState.thumb === 'open' &&
      fingerState.index === 'open' &&
      fingerState.middle === 'open' &&
      fingerState.ring === 'open' &&
      fingerState.pinky === 'open'
    );
  }

  /**
   * Generates a stable key for each detected hand using handedness and spatial position.
   */
  public getHandKey(
    handedness: string,
    landmarks: NormalizedLandmark[],
    isUniqueHandedness: boolean,
    isLeftmostDuplicate: boolean = false,
  ): string {
    if (isUniqueHandedness && handedness) {
      return handedness;
    }
    const wristX = landmarks[0]?.x ?? 0;
    const side = isLeftmostDuplicate ? 'L' : wristX < 0.5 ? 'L' : 'R';
    return `${handedness || 'Hand'}_${side}`;
  }

  /**
   * Processes a video frame containing detected hands.
   */
  public processFrame(
    results: HandLandmarkerResults | null | undefined,
    now: number = Date.now(),
  ): FrameProcessingResult {
    const landmarksList = results?.landmarks || [];
    const handednessList = results?.handedness || [];
    const validHands: {
      key: string;
      handedness: string;
      landmarks: NormalizedLandmark[];
    }[] = [];

    // Count occurrences of handedness to detect duplicates
    const handednessCount = new Map<string, number>();
    for (let i = 0; i < landmarksList.length; i++) {
      const handCat = handednessList[i]?.[0];
      const handedness =
        handCat?.displayName ||
        handCat?.categoryName ||
        (landmarksList.length === 1 ? 'Hand' : `Hand_${i}`);
      handednessCount.set(
        handedness,
        (handednessCount.get(handedness) || 0) + 1,
      );
    }

    // Collect and validate detected hands in this frame
    for (let i = 0; i < landmarksList.length; i++) {
      const landmarks = landmarksList[i];
      if (!this.validateLandmarks(landmarks)) {
        continue;
      }
      const handCat = handednessList[i]?.[0];
      const handedness =
        handCat?.displayName ||
        handCat?.categoryName ||
        (landmarksList.length === 1 ? 'Hand' : `Hand_${i}`);
      const isUnique = (handednessCount.get(handedness) || 0) <= 1;
      const handKey = this.getHandKey(handedness, landmarks, isUnique, i === 0);
      validHands.push({ key: handKey, handedness, landmarks });
    }

    const seenKeys = new Set<string>();
    let triggered = false;
    let triggeredHandKey: string | null = null;
    const inCooldown = now < this.cooldownUntil;

    // Process each valid hand detected in this frame
    for (const hand of validHands) {
      seenKeys.add(hand.key);
      const fingerState = this.evaluateFingers(hand.landmarks);
      const isPalm = this.isOpenPalm(fingerState);

      let existing = this.handStates.get(hand.key);

      if (isPalm && !inCooldown) {
        if (!existing || existing.holdStartTime === 0) {
          // Started holding
          this.logger(`Hand ${hand.key} started open palm hold at ${now}`);
          existing = {
            handKey: hand.key,
            handedness: hand.handedness,
            holdStartTime: now,
            lastSeenTime: now,
            isOpenPalm: true,
            progress: 0,
            fingerStates: fingerState,
          };
        } else {
          // Continuing hold
          const elapsed = now - existing.holdStartTime;
          const progress = Math.min(1.0, elapsed / this.holdDurationMs);
          existing.lastSeenTime = now;
          existing.isOpenPalm = true;
          existing.progress = progress;
          existing.fingerStates = fingerState;

          if (elapsed >= this.holdDurationMs && !triggered) {
            // Trigger threshold reached!
            triggered = true;
            triggeredHandKey = hand.key;
            this.cooldownUntil = now + this.cooldownMs;
            existing.holdStartTime = 0;
            existing.progress = 0;
            this.logger(
              `Hand ${hand.key} hold completed (${elapsed}ms). Triggering toggle and entering cooldown until ${this.cooldownUntil}`,
            );
          }
        }
      } else {
        // Not open palm or in cooldown
        if (existing) {
          if (existing.holdStartTime > 0) {
            this.logger(
              `Hand ${hand.key} hold reset (pose changed or in cooldown)`,
            );
          }
          existing.holdStartTime = 0;
          existing.progress = 0;
          existing.isOpenPalm = false;
          existing.lastSeenTime = now;
          existing.fingerStates = fingerState;
        } else {
          existing = {
            handKey: hand.key,
            handedness: hand.handedness,
            holdStartTime: 0,
            lastSeenTime: now,
            isOpenPalm: false,
            progress: 0,
            fingerStates: fingerState,
          };
        }
      }

      this.handStates.set(hand.key, existing);
    }

    // Clean up hands that disappeared past grace period
    for (const [key, state] of this.handStates.entries()) {
      if (!seenKeys.has(key)) {
        const timeSinceSeen = now - state.lastSeenTime;
        if (timeSinceSeen > this.frameDropGraceMs) {
          if (state.holdStartTime > 0) {
            this.logger(
              `Hand ${key} lost past grace period (${timeSinceSeen}ms > ${this.frameDropGraceMs}ms). Resetting hold.`,
            );
          }
          this.handStates.delete(key);
        }
      }
    }

    // Find active holding hand with highest progress
    let maxProgress = 0;
    let activeHandKey: string | null = null;
    let isHolding = false;
    let primaryFingerState: FingerState | null = null;

    for (const [key, state] of this.handStates.entries()) {
      if (state.holdStartTime > 0 && state.isOpenPalm && !inCooldown) {
        isHolding = true;
        if (state.progress >= maxProgress) {
          maxProgress = state.progress;
          activeHandKey = key;
          primaryFingerState = state.fingerStates;
        }
      }
    }

    // If no holding hand, pick the most recently seen hand for primary finger state
    if (!primaryFingerState && validHands.length > 0) {
      const firstHandState = this.handStates.get(validHands[0].key);
      if (firstHandState) {
        primaryFingerState = firstHandState.fingerStates;
      }
    }

    if (triggered && triggeredHandKey && this.onTrigger) {
      this.onTrigger(triggeredHandKey, now);
    }

    return {
      isHolding,
      activeHoldProgress: maxProgress,
      activeHandKey,
      triggered,
      inCooldown,
      hands: Array.from(this.handStates.values()),
      primaryFingerState,
    };
  }

  /**
   * Force reset all tracked hands and cooldown state.
   */
  public reset(): void {
    this.handStates.clear();
    this.cooldownUntil = 0;
    this.logger('MultiHandHoldTracker state reset');
  }
}
