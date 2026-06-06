/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { useCallback, useEffect, useState } from 'react';

export type MicPermissionState = 'unknown' | 'granted' | 'denied' | 'prompt';

/**
 * acquireMicStream
 *
 * Fast-path: if `micPermissionGranted` is already in settings, return true
 * immediately without calling getUserMedia (which can fail in transparent windows).
 *
 * Otherwise retry getUserMedia up to `maxRetries` times with back-off.
 */
export async function acquireMicStream(maxRetries = 4, baseDelayMs = 400): Promise<boolean> {
  // ── Fast-path: check persisted flag ───────────────────────────────────
  try {
    const settings = await (window as any).electron?.setting?.getSetting?.();
    if (settings?.micPermissionGranted === true) {
      return true;
    }
  } catch (_) {
    // settings API unavailable — fall through to getUserMedia
  }

  // ── No getUserMedia API ────────────────────────────────────────────────
  if (!navigator.mediaDevices?.getUserMedia) {
    return (
      typeof (window as any).SpeechRecognition !== 'undefined' ||
      typeof (window as any).webkitSpeechRecognition !== 'undefined'
    );
  }

  // ── Try getUserMedia with retries ──────────────────────────────────────
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      stream.getTracks().forEach((track) => track.stop());
      return true;
    } catch (err: any) {
      const errName: string = err?.name ?? String(err);
      console.warn(`[useMicPermission] attempt ${attempt}/${maxRetries} failed:`, errName);

      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, baseDelayMs * attempt));
        continue;
      }

      // Final attempt — fall back to SpeechRecognition availability check
      return (
        typeof (window as any).SpeechRecognition !== 'undefined' ||
        typeof (window as any).webkitSpeechRecognition !== 'undefined'
      );
    }
  }
  return false;
}

export function releaseMicStream() {
  // Stream is released immediately in acquireMicStream — nothing to do here.
}

export function useMicPermission() {
  const [micState, setMicState] = useState<MicPermissionState>('unknown');

  const requestMic = useCallback(async (): Promise<boolean> => {
    const granted = await acquireMicStream();
    setMicState(granted ? 'granted' : 'denied');
    return granted;
  }, []);

  useEffect(() => {
    // First check the persisted flag for instant state
    (window as any).electron?.setting?.getSetting?.()
      .then((s: any) => {
        if (s?.micPermissionGranted === true) {
          setMicState('granted');
          return;
        }
        // Fall back to Permissions API
        if (!navigator.permissions?.query) return;
        navigator.permissions
          .query({ name: 'microphone' as PermissionName })
          .then((status) => {
            setMicState(status.state as MicPermissionState);
            status.onchange = () => setMicState(status.state as MicPermissionState);
          })
          .catch(() => {});
      })
      .catch(() => {
        if (!navigator.permissions?.query) return;
        navigator.permissions
          .query({ name: 'microphone' as PermissionName })
          .then((status) => {
            setMicState(status.state as MicPermissionState);
            status.onchange = () => setMicState(status.state as MicPermissionState);
          })
          .catch(() => {});
      });
  }, []);

  return {
    micState,
    micGranted: micState === 'granted',
    requestMic,
  };
}
