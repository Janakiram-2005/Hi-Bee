/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SignLanguageBufferManager } from './bufferManager';

describe('SignLanguageBufferManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Initialization & Configuration Bounds', () => {
    it('initializes with default threshold bounds', () => {
      const manager = new SignLanguageBufferManager();
      expect(manager.getMinConfidence()).toBe(0.6);
      expect(manager.getCooldownMs()).toBe(1000);
      expect(manager.getIdleFlushTimeoutMs()).toBe(3000);
      expect(manager.getMaxBufferSize()).toBe(50);
      expect(manager.getBuffer()).toEqual([]);
      expect(manager.getLastProcessedTime()).toBe(0);
      expect(manager.hasActiveTimer()).toBe(false);
    });

    it('initializes with custom configured threshold bounds', () => {
      const manager = new SignLanguageBufferManager({
        minConfidence: 0.8,
        cooldownMs: 1500,
        idleFlushTimeoutMs: 5000,
        maxBufferSize: 20,
      });
      expect(manager.getMinConfidence()).toBe(0.8);
      expect(manager.getCooldownMs()).toBe(1500);
      expect(manager.getIdleFlushTimeoutMs()).toBe(5000);
      expect(manager.getMaxBufferSize()).toBe(20);
    });
  });

  describe('Confidence Score & Category Validation', () => {
    it('rejects gestures with confidence score below threshold', () => {
      const manager = new SignLanguageBufferManager({ minConfidence: 0.7 });
      const result = manager.processGesture({
        categoryName: 'hello',
        score: 0.69,
      });
      expect(result.action).toBe('ignored_confidence');
      expect(manager.getBuffer()).toEqual([]);
    });

    it('accepts gestures with confidence score equal or above threshold', () => {
      const manager = new SignLanguageBufferManager({ minConfidence: 0.7 });
      const result = manager.processGesture({
        categoryName: 'hello',
        score: 0.7,
      });
      expect(result.action).toBe('accepted');
      expect(manager.getBuffer()).toEqual(['hello']);
    });

    it('ignores "none" gesture case-insensitively', () => {
      const manager = new SignLanguageBufferManager();
      const res1 = manager.processGesture({ categoryName: 'None', score: 0.9 });
      const res2 = manager.processGesture({ categoryName: 'none', score: 0.9 });
      expect(res1.action).toBe('ignored_none');
      expect(res2.action).toBe('ignored_none');
      expect(manager.getBuffer()).toEqual([]);
    });

    it('ignores empty category name or whitespace', () => {
      const manager = new SignLanguageBufferManager();
      const res = manager.processGesture({ categoryName: '   ', score: 0.9 });
      expect(res.action).toBe('ignored_none');
      expect(manager.getBuffer()).toEqual([]);
    });

    it('uses translated word mapping when provided', () => {
      const manager = new SignLanguageBufferManager();
      const result = manager.processGesture(
        { categoryName: 'thumb_up', score: 0.9 },
        'Good',
      );
      expect(result.action).toBe('accepted');
      expect(result.word).toBe('Good');
      expect(manager.getBuffer()).toEqual(['Good']);
    });
  });

  describe('Synchronous Cooldown & Consecutive Frame Spam Suppression', () => {
    it('synchronously suppresses frames within cooldown window', () => {
      const manager = new SignLanguageBufferManager({ cooldownMs: 1000 });
      const t0 = 10000;

      // Frame 1 (t0): accepted
      const res1 = manager.processGesture(
        { categoryName: 'hello', score: 0.9 },
        'hello',
        t0,
      );
      expect(res1.action).toBe('accepted');
      expect(manager.getLastProcessedTime()).toBe(t0);

      // Frame 2 (t0 + 16ms, simulating 60 FPS consecutive frame): suppressed
      const res2 = manager.processGesture(
        { categoryName: 'world', score: 0.9 },
        'world',
        t0 + 16,
      );
      expect(res2.action).toBe('ignored_cooldown');

      // Frame 3 (t0 + 500ms): suppressed
      const res3 = manager.processGesture(
        { categoryName: 'world', score: 0.9 },
        'world',
        t0 + 500,
      );
      expect(res3.action).toBe('ignored_cooldown');

      // Frame 4 (t0 + 1000ms): exactly at cooldown boundary -> suppressed
      const res4 = manager.processGesture(
        { categoryName: 'world', score: 0.9 },
        'world',
        t0 + 1000,
      );
      expect(res4.action).toBe('ignored_cooldown');

      // Frame 5 (t0 + 1001ms): after cooldown -> accepted
      const res5 = manager.processGesture(
        { categoryName: 'world', score: 0.9 },
        'world',
        t0 + 1001,
      );
      expect(res5.action).toBe('accepted');
      expect(manager.getLastProcessedTime()).toBe(t0 + 1001);
      expect(manager.getBuffer()).toEqual(['hello', 'world']);
    });

    it('suppresses immediate duplicate sign words outside cooldown', () => {
      const manager = new SignLanguageBufferManager({ cooldownMs: 1000 });
      manager.processGesture(
        { categoryName: 'apple', score: 0.9 },
        'apple',
        1000,
      );

      // After cooldown, same word repeated
      const res = manager.processGesture(
        { categoryName: 'apple', score: 0.9 },
        'Apple',
        2500,
      );
      expect(res.action).toBe('ignored_duplicate');
      expect(manager.getBuffer()).toEqual(['apple']);
    });
  });

  describe('Inactivity Timeout & Idle Flush Mechanism', () => {
    it('schedules idle flush timer when gesture is added', () => {
      const onTimerStateChange = vi.fn();
      const manager = new SignLanguageBufferManager(
        { idleFlushTimeoutMs: 3000 },
        { onTimerStateChange },
      );

      expect(manager.hasActiveTimer()).toBe(false);
      manager.processGesture(
        { categoryName: 'open', score: 0.9 },
        'open',
        1000,
      );
      expect(manager.hasActiveTimer()).toBe(true);
      expect(onTimerStateChange).toHaveBeenCalledWith(true);
    });

    it('flushes buffer automatically after idleFlushTimeoutMs of inactivity', () => {
      const onFlush = vi.fn();
      const onBufferChange = vi.fn();
      const manager = new SignLanguageBufferManager(
        { idleFlushTimeoutMs: 3000, cooldownMs: 500 },
        { onFlush, onBufferChange },
      );

      manager.processGesture(
        { categoryName: 'open', score: 0.9 },
        'open',
        1000,
      );
      manager.processGesture(
        { categoryName: 'browser', score: 0.9 },
        'browser',
        1600,
      );

      expect(manager.getBuffer()).toEqual(['open', 'browser']);
      expect(onFlush).not.toHaveBeenCalled();

      // Fast forward 2999ms (not yet timed out)
      vi.advanceTimersByTime(2999);
      expect(onFlush).not.toHaveBeenCalled();
      expect(manager.getBuffer()).toEqual(['open', 'browser']);

      // Advance by remaining 1ms (hits 3000ms idle)
      vi.advanceTimersByTime(1);
      expect(onFlush).toHaveBeenCalledTimes(1);
      expect(onFlush).toHaveBeenCalledWith(['open', 'browser'], 'inactivity');
      expect(manager.getBuffer()).toEqual([]);
      expect(manager.hasActiveTimer()).toBe(false);
    });

    it('resets the idle timeout on each new accepted gesture', () => {
      const onFlush = vi.fn();
      const manager = new SignLanguageBufferManager(
        { idleFlushTimeoutMs: 3000, cooldownMs: 1000 },
        { onFlush },
      );

      manager.processGesture(
        { categoryName: 'search', score: 0.9 },
        'search',
        1000,
      );
      vi.advanceTimersByTime(2000); // 2000ms elapsed

      // New gesture arrives -> resets the 3000ms timer
      manager.processGesture(
        { categoryName: 'youtube', score: 0.9 },
        'youtube',
        3100,
      );
      vi.advanceTimersByTime(2000); // only 2000ms elapsed since second gesture
      expect(onFlush).not.toHaveBeenCalled();

      // Advance another 1000ms (3000ms total since second gesture)
      vi.advanceTimersByTime(1000);
      expect(onFlush).toHaveBeenCalledTimes(1);
      expect(onFlush).toHaveBeenCalledWith(['search', 'youtube'], 'inactivity');
    });
  });

  describe('Terminator Gestures', () => {
    it.each(['stop', 'end', 'end_sign', 'STOP', 'End'])(
      'immediately flushes buffer on terminator gesture "%s" and cancels idle timer',
      (term) => {
        const onFlush = vi.fn();
        const manager = new SignLanguageBufferManager(
          { idleFlushTimeoutMs: 3000, cooldownMs: 500 },
          { onFlush },
        );

        manager.processGesture(
          { categoryName: 'hello', score: 0.9 },
          'hello',
          1000,
        );
        manager.processGesture(
          { categoryName: 'friend', score: 0.9 },
          'friend',
          1600,
        );
        expect(manager.hasActiveTimer()).toBe(true);

        // Send terminator
        const res = manager.processGesture(
          { categoryName: term, score: 0.9 },
          term,
          2200,
        );
        expect(res.action).toBe('flushed_terminator');
        expect(res.flushedSigns).toEqual(['hello', 'friend']);
        expect(onFlush).toHaveBeenCalledTimes(1);
        expect(onFlush).toHaveBeenCalledWith(['hello', 'friend'], 'terminator');
        expect(manager.getBuffer()).toEqual([]);
        expect(manager.hasActiveTimer()).toBe(false);

        // Ensure timer callback does not fire later
        vi.advanceTimersByTime(5000);
        expect(onFlush).toHaveBeenCalledTimes(1);
      },
    );

    it('correctly identifies terminator words', () => {
      const manager = new SignLanguageBufferManager();
      expect(manager.isTerminator('stop')).toBe(true);
      expect(manager.isTerminator('STOP')).toBe(true);
      expect(manager.isTerminator('end')).toBe(true);
      expect(manager.isTerminator('end_sign')).toBe(true);
      expect(manager.isTerminator('hello')).toBe(false);
      expect(manager.isTerminator('')).toBe(false);
    });
  });

  describe('Buffer Bounds Protection', () => {
    it('forces flush when maxBufferSize is reached', () => {
      const onFlush = vi.fn();
      const manager = new SignLanguageBufferManager(
        { maxBufferSize: 3, cooldownMs: 100 },
        { onFlush },
      );

      manager.processGesture({ categoryName: 'a', score: 0.9 }, 'a', 100);
      manager.processGesture({ categoryName: 'b', score: 0.9 }, 'b', 250);
      expect(onFlush).not.toHaveBeenCalled();

      // Third gesture reaches maxBufferSize = 3 -> triggers flush
      const res = manager.processGesture(
        { categoryName: 'c', score: 0.9 },
        'c',
        400,
      );
      expect(res.action).toBe('flushed_max_buffer');
      expect(res.flushedSigns).toEqual(['a', 'b', 'c']);
      expect(onFlush).toHaveBeenCalledWith(['a', 'b', 'c'], 'max_buffer');
      expect(manager.getBuffer()).toEqual([]);
    });
  });

  describe('Manual Fallback & Cleanup', () => {
    it('clears buffer and cancels timer on clear() without calling onFlush', () => {
      const onFlush = vi.fn();
      const onBufferChange = vi.fn();
      const manager = new SignLanguageBufferManager(
        { idleFlushTimeoutMs: 3000 },
        { onFlush, onBufferChange },
      );

      manager.processGesture(
        { categoryName: 'wrong_gesture', score: 0.9 },
        'wrong_gesture',
        1000,
      );
      expect(manager.getBuffer()).toEqual(['wrong_gesture']);
      expect(manager.hasActiveTimer()).toBe(true);

      manager.clear();
      expect(manager.getBuffer()).toEqual([]);
      expect(manager.hasActiveTimer()).toBe(false);
      expect(onFlush).not.toHaveBeenCalled();

      // Timer does not fire after clear
      vi.advanceTimersByTime(5000);
      expect(onFlush).not.toHaveBeenCalled();
    });

    it('flushes manually when flush("manual") is called', () => {
      const onFlush = vi.fn();
      const manager = new SignLanguageBufferManager({}, { onFlush });

      manager.processGesture(
        { categoryName: 'send', score: 0.9 },
        'send',
        1000,
      );
      const flushed = manager.flush('manual');
      expect(flushed).toEqual(['send']);
      expect(onFlush).toHaveBeenCalledWith(['send'], 'manual');
      expect(manager.getBuffer()).toEqual([]);
    });

    it('cancels timer on destroy()', () => {
      const onFlush = vi.fn();
      const manager = new SignLanguageBufferManager(
        { idleFlushTimeoutMs: 3000 },
        { onFlush },
      );

      manager.processGesture(
        { categoryName: 'test', score: 0.9 },
        'test',
        1000,
      );
      expect(manager.hasActiveTimer()).toBe(true);

      manager.destroy();
      expect(manager.hasActiveTimer()).toBe(false);

      vi.advanceTimersByTime(5000);
      expect(onFlush).not.toHaveBeenCalled();
    });
  });
});
