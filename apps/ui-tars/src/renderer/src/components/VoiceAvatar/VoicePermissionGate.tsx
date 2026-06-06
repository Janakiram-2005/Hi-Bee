/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Startup permission gate for the voice window.
 *
 * Strategy:
 *  1. If `micPermissionGranted` is already stored in settings → immediately ready.
 *  2. Otherwise try getUserMedia with retries (the main window already requested
 *     the permission so subsequent calls in child windows succeed).
 *  3. On Windows, OS-level screen-capture / accessibility permissions are always
 *     granted, so we only gate on the microphone.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, RefreshCw } from 'lucide-react';
import { api } from '@renderer/api';

interface VoicePermissionGateProps {
  children: React.ReactNode;
  onReady: () => void;
}

type GateStatus = 'checking' | 'needs-permissions' | 'ready';

/** getUserMedia with up to `maxAttempts` retries and back-off. */
async function tryGetUserMedia(maxAttempts = 5, baseMs = 400): Promise<boolean> {
  if (!navigator.mediaDevices?.getUserMedia) {
    // No API → fall through to SpeechRecognition check
    return (
      typeof (window as any).SpeechRecognition !== 'undefined' ||
      typeof (window as any).webkitSpeechRecognition !== 'undefined'
    );
  }

  for (let i = 1; i <= maxAttempts; i++) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      stream.getTracks().forEach((t) => t.stop());
      console.info(`[VoicePermissionGate] mic acquired on attempt ${i}`);
      return true;
    } catch (err: any) {
      const name: string = err?.name ?? String(err);
      console.warn(`[VoicePermissionGate] getUserMedia attempt ${i} failed:`, name);

      if (i < maxAttempts) {
        await new Promise((r) => setTimeout(r, baseMs * i));
        continue;
      }

      // Final attempt failed — if SpeechRecognition exists Electron may still
      // let it work (main-process handler grants on first real use).
      return (
        typeof (window as any).SpeechRecognition !== 'undefined' ||
        typeof (window as any).webkitSpeechRecognition !== 'undefined'
      );
    }
  }
  return false;
}

export function VoicePermissionGate({ children, onReady }: VoicePermissionGateProps) {
  const [status, setStatus] = useState<GateStatus>('checking');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const notifiedRef = useRef(false);

  const markReady = useCallback(() => {
    setStatus('ready');
    window.electron?.ipcRenderer
      ?.invoke('voice-window:set-ignore-mouse-events', true)
      .catch(() => {});
    if (!notifiedRef.current) {
      notifiedRef.current = true;
      onReady();
    }
  }, [onReady]);

  const evaluate = useCallback(async () => {
    setErrorMsg(null);

    try {
      // ── Fast-path: already granted on a previous launch ────────────────
      const settings = await window.electron?.setting?.getSetting?.();
      if (settings?.micPermissionGranted === true) {
        console.info('[VoicePermissionGate] micPermissionGranted flag found → ready');
        markReady();
        return;
      }
    } catch (_) {
      // setting API unavailable — continue to live check
    }

    // ── Bootstrap OS permissions (always true on Windows) ──────────────
    let osReady = true;
    try {
      const perms = await api.bootstrapPermissions();
      osReady = !!(perms?.screenCapture && perms?.accessibility);
    } catch (_) {
      // On Windows this always returns true; if it throws, assume OK
      osReady = true;
    }

    // ── Try microphone access ───────────────────────────────────────────
    const micOk = await tryGetUserMedia(5, 400);

    if (osReady && micOk) {
      // Persist so future launches skip this check
      window.electron?.setting
        ?.updateSetting({ micPermissionGranted: true })
        .catch(() => {});
      markReady();
    } else {
      setStatus('needs-permissions');
      setErrorMsg(
        micOk
          ? 'Missing OS permissions. Please grant Screen Capture and Accessibility access.'
          : 'Microphone access was denied. Click Retry or check system settings.',
      );
      window.electron?.ipcRenderer
        ?.invoke('voice-window:set-ignore-mouse-events', false)
        .catch(() => {});
    }
  }, [markReady]);

  // Run shortly after mount to let Electron session handlers settle
  useEffect(() => {
    const t = setTimeout(evaluate, 250);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRetry = async () => {
    setRetrying(true);
    setStatus('checking');
    await evaluate();
    setRetrying(false);
  };

  if (status === 'ready') return <>{children}</>;

  return (
    <div className="voice-permission-gate">
      <div className="voice-permission-card">
        {status === 'checking' ? (
          <>
            <RefreshCw size={26} className="voice-permission-icon spinning" />
            <h3>Checking permissions…</h3>
            <p>Requesting microphone access, please wait.</p>
          </>
        ) : (
          <>
            <Mic size={26} className="voice-permission-icon" style={{ color: '#f97316' }} />
            <h3>Microphone needed</h3>
            <p>{errorMsg ?? 'Hi-Bee needs microphone access to listen to your voice.'}</p>
            <button
              type="button"
              className="voice-permission-btn"
              onClick={handleRetry}
              disabled={retrying}
            >
              <RefreshCw size={14} />
              {retrying ? 'Retrying…' : 'Retry'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
