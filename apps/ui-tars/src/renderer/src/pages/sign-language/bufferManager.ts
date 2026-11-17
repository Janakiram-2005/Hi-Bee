/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

export interface BufferThresholdOptions {
  /** Minimum MediaPipe confidence score required to accept gesture (default: 0.6) */
  minConfidence?: number;
  /** Milliseconds cooldown between gestures to prevent duplicate video frame spam (default: 1000ms) */
  cooldownMs?: number;
  /** Milliseconds of idle inactivity before buffer automatically flushes (default: 3000ms) */
  idleFlushTimeoutMs?: number;
  /** Maximum items buffer can hold before forced flush (default: 50) */
  maxBufferSize?: number;
}

export type GestureProcessAction =
  | 'accepted'
  | 'ignored_confidence'
  | 'ignored_none'
  | 'ignored_cooldown'
  | 'ignored_duplicate'
  | 'flushed_terminator'
  | 'flushed_max_buffer';

export interface GestureResult {
  action: GestureProcessAction;
  word?: string;
  flushedSigns?: string[];
}

export class SignLanguageBufferManager {
  private buffer: string[] = [];
  private lastProcessedTime = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly minConfidence: number;
  private readonly cooldownMs: number;
  private readonly idleFlushTimeoutMs: number;
  private readonly maxBufferSize: number;
  private readonly onFlush?: (
    signs: string[],
    reason: 'inactivity' | 'terminator' | 'max_buffer' | 'manual',
  ) => void;
  private readonly onBufferChange?: (signs: string[]) => void;
  private readonly onTimerStateChange?: (active: boolean) => void;

  constructor(
    options: BufferThresholdOptions = {},
    callbacks?: {
      onFlush?: (
        signs: string[],
        reason: 'inactivity' | 'terminator' | 'max_buffer' | 'manual',
      ) => void;
      onBufferChange?: (signs: string[]) => void;
      onTimerStateChange?: (active: boolean) => void;
    },
  ) {
    this.minConfidence = options.minConfidence ?? 0.6;
    this.cooldownMs = options.cooldownMs ?? 1000;
    this.idleFlushTimeoutMs = options.idleFlushTimeoutMs ?? 3000;
    this.maxBufferSize = options.maxBufferSize ?? 50;
    this.onFlush = callbacks?.onFlush;
    this.onBufferChange = callbacks?.onBufferChange;
    this.onTimerStateChange = callbacks?.onTimerStateChange;
  }

  public getMinConfidence(): number {
    return this.minConfidence;
  }

  public getCooldownMs(): number {
    return this.cooldownMs;
  }

  public getIdleFlushTimeoutMs(): number {
    return this.idleFlushTimeoutMs;
  }

  public getMaxBufferSize(): number {
    return this.maxBufferSize;
  }

  public getBuffer(): string[] {
    return [...this.buffer];
  }

  public getLastProcessedTime(): number {
    return this.lastProcessedTime;
  }

  public hasActiveTimer(): boolean {
    return this.idleTimer !== null;
  }

  public isTerminator(word: string): boolean {
    const lower = word.toLowerCase().trim();
    return lower === 'stop' || lower === 'end' || lower === 'end_sign';
  }

  public clearTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
      this.onTimerStateChange?.(false);
    }
  }

  private resetIdleTimer(): void {
    this.clearTimer();
    this.onTimerStateChange?.(true);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.onTimerStateChange?.(false);
      if (this.buffer.length > 0) {
        console.log(
          `[SignLanguage] Inactivity timeout reached (${this.idleFlushTimeoutMs}ms idle), auto-flushing buffer:`,
          this.buffer,
        );
        this.flush('inactivity');
      }
    }, this.idleFlushTimeoutMs);
  }

  /**
   * Process a single gesture frame synchronously.
   */
  public processGesture(
    rawGesture: { categoryName: string; score: number },
    translatedWord?: string,
    timestamp: number = Date.now(),
  ): GestureResult {
    // 1. Validate confidence score against configured bounds
    if (rawGesture.score < this.minConfidence) {
      return { action: 'ignored_confidence' };
    }

    const word = (translatedWord || rawGesture.categoryName || '').trim();
    if (!word || word.toLowerCase() === 'none') {
      return { action: 'ignored_none' };
    }

    // 2. Validate cooldown against synchronous lastProcessedTime
    if (
      this.lastProcessedTime > 0 &&
      timestamp - this.lastProcessedTime <= this.cooldownMs
    ) {
      return { action: 'ignored_cooldown', word };
    }

    // 3. Check for terminator gestures
    if (this.isTerminator(word)) {
      this.lastProcessedTime = timestamp;
      console.log(
        `[SignLanguage] Terminator sign "${word}" detected. Flushing buffer:`,
        this.buffer,
      );
      const flushedSigns = this.flush('terminator');
      return { action: 'flushed_terminator', word, flushedSigns };
    }

    // 4. Suppress immediate duplicate word
    if (
      this.buffer.length > 0 &&
      this.buffer[this.buffer.length - 1].toLowerCase() === word.toLowerCase()
    ) {
      return { action: 'ignored_duplicate', word };
    }

    this.lastProcessedTime = timestamp;

    // 5. Add gesture to buffer
    this.buffer.push(word);
    console.log(
      `[SignLanguage] Gesture added to buffer: "${word}". Buffer:`,
      this.buffer,
    );
    this.onBufferChange?.(this.getBuffer());

    // 6. Check max buffer bounds
    if (this.buffer.length >= this.maxBufferSize) {
      console.warn(
        `[SignLanguage] Buffer reached maximum bound (${this.maxBufferSize}), forcing flush.`,
      );
      const flushedSigns = this.flush('max_buffer');
      return { action: 'flushed_max_buffer', word, flushedSigns };
    }

    // 7. Reset idle flush timer
    this.resetIdleTimer();

    return { action: 'accepted', word };
  }

  /**
   * Flush current buffer and reset timers
   */
  public flush(
    reason: 'inactivity' | 'terminator' | 'max_buffer' | 'manual' = 'manual',
  ): string[] {
    this.clearTimer();
    const signsToFlush = [...this.buffer];
    this.buffer = [];
    this.onBufferChange?.([]);
    if (signsToFlush.length > 0) {
      this.onFlush?.(signsToFlush, reason);
    }
    return signsToFlush;
  }

  /**
   * Clear buffer without invoking onFlush
   */
  public clear(): void {
    this.clearTimer();
    this.buffer = [];
    this.onBufferChange?.([]);
    console.log('[SignLanguage] Buffer manually cleared.');
  }

  /**
   * Teardown on unmount
   */
  public destroy(): void {
    this.clearTimer();
  }
}
