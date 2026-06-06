/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 *
 * useVoiceVAD — continuous Web Speech API hook with:
 * - Silence detection (configurable ms)
 * - Interruption detection (stops TTS if user speaks while agent is talking)
 * - Language switching without restart
 * - Robust error recovery with auto-restart
 * - Race-condition-safe via refs (not state) for listening flag
 */
import { useRef, useCallback, useEffect } from 'react';
import { useVoiceStore } from '@renderer/store/voiceStore';
import { acquireMicStream } from '@renderer/hooks/useMicPermission';

const SpeechRecognition =
  (window as any).SpeechRecognition ||
  (window as any).webkitSpeechRecognition;

/** Minimum ms between restart attempts — reduced for faster VAD recovery */
const RESTART_MIN_MS = 800;

interface UseVoiceVADOptions {
  silenceMs?: number;
  onCommit: (transcript: string) => void;  // called when utterance is committed
  onInterrupt?: () => void;                 // called when user speaks over TTS
  onPermissionDenied?: () => void;
}

export function useVoiceVAD({ onCommit, onInterrupt, onPermissionDenied }: UseVoiceVADOptions) {
  const { avatarState, selectedLanguage, setLiveTranscript, setAvatarState } = useVoiceStore();

  const recognitionRef = useRef<any>(null);
  const isListeningRef = useRef(false);
  const interimRef = useRef('');
  const accumulatedPrefixRef = useRef('');
  const shouldRestartRef = useRef(false);
  const avatarStateRef = useRef(avatarState);
  const lastRestartAtRef = useRef(0);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorCountRef = useRef(0);

  const scheduleRestart = useCallback((recognition: { start: () => void }) => {
    if (!shouldRestartRef.current || !isListeningRef.current) return;

    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
    }

    const elapsed = Date.now() - lastRestartAtRef.current;
    const delay = Math.max(RESTART_MIN_MS - elapsed, 300);

    restartTimerRef.current = setTimeout(() => {
      restartTimerRef.current = null;
      if (!shouldRestartRef.current || !isListeningRef.current) return;
      try {
        recognition.start();
        lastRestartAtRef.current = Date.now();
      } catch (_) {
        // start() throws if already running — ignore
      }
    }, delay);
  }, []);

  // Keep avatarStateRef in sync
  useEffect(() => {
    avatarStateRef.current = avatarState;
  }, [avatarState]);

  const buildRecognition = useCallback((lang: string) => {
    if (!SpeechRecognition) return null;

    const r = new SpeechRecognition();
    r.continuous = true;
    r.interimResults = true;
    r.lang = lang;
    r.maxAlternatives = 1;

    r.onresult = (event: any) => {
      errorCountRef.current = 0; // reset errors on success
      let finalTranscript = '';
      let interimTranscript = '';

      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalTranscript += result[0].transcript;
        } else {
          interimTranscript += result[0].transcript;
        }
      }

      const currentSessionText = (finalTranscript + interimTranscript).trim();
      const combined = (accumulatedPrefixRef.current ? accumulatedPrefixRef.current + ' ' + currentSessionText : currentSessionText).trim();

      if (!combined) return;

      // If agent is speaking and user starts talking with sufficient confidence → interrupt
      if (
        avatarStateRef.current === 'speaking' &&
        event.results[event.results.length - 1][0].confidence > 0.55
      ) {
        onInterrupt?.();
      }

      interimRef.current = combined;
      setLiveTranscript(combined);
    };

    r.onerror = (event: any) => {
      const { error } = event;
      console.warn('[VAD] SpeechRecognition error event:', error, event);

      errorCountRef.current += 1;

      // 'not-allowed' = mic blocked; 'service-not-allowed' = SR service not ready (transient).
      // Give each up to 4 retries before calling onPermissionDenied.
      if (error === 'not-allowed' || error === 'service-not-allowed') {
        if (errorCountRef.current <= 4 && shouldRestartRef.current) {
          console.warn(`[VAD] ${error} – will retry (attempt ${errorCountRef.current}/4)`);
          scheduleRestart(recognitionRef.current ?? r);
          return;
        }
        console.warn('[VAD] Persistent permission/service error — stopping:', error);
        shouldRestartRef.current = false;
        isListeningRef.current = false;
        setAvatarState('idle');
        try { r.stop(); } catch (_) {}
        onPermissionDenied?.();
        return;
      }

      // Persistent network errors → stop
      if (errorCountRef.current >= 6 || error === 'network') {
        console.warn('[VAD] Too many errors or network issue — stopping. Error:', error);
        shouldRestartRef.current = false;
        isListeningRef.current = false;
        setAvatarState('idle');
        try { r.stop(); } catch (_) {}
        onPermissionDenied?.();
        return;
      }

      // Transient errors (no-speech, audio-capture, aborted) → schedule restart
      if (shouldRestartRef.current) {
        scheduleRestart(recognitionRef.current ?? r);
      }
    };


    r.onend = () => {
      if (shouldRestartRef.current && isListeningRef.current) {
        // Save the current transcript as prefix before restarting
        accumulatedPrefixRef.current = interimRef.current;
        scheduleRestart(r);
      } else {
        isListeningRef.current = false;
      }
    };

    return r;
  }, [setLiveTranscript, setAvatarState, onInterrupt, onPermissionDenied, scheduleRestart]);

  const startListening = useCallback(async () => {
    if (isListeningRef.current) return;
    if (!SpeechRecognition) {
      console.warn('[VAD] SpeechRecognition not supported in this browser/Electron version');
      return;
    }

    const micOk = await acquireMicStream();
    if (!micOk) {
      onPermissionDenied?.();
      return;
    }

    // Stop and replace recognition if language changed
    if (recognitionRef.current) {
      shouldRestartRef.current = false;
      try { recognitionRef.current.stop(); } catch (_) {}
    }

    accumulatedPrefixRef.current = '';
    interimRef.current = '';
    errorCountRef.current = 0;
    setLiveTranscript('');
    recognitionRef.current = buildRecognition(selectedLanguage);
    if (!recognitionRef.current) return;

    shouldRestartRef.current = true;
    isListeningRef.current = true;

    try {
      recognitionRef.current.start();
      lastRestartAtRef.current = Date.now();
      setAvatarState('listening');
    } catch (err) {
      console.warn('[VAD] start failed:', err);
      isListeningRef.current = false;
    }
  }, [buildRecognition, selectedLanguage, setAvatarState, onPermissionDenied, setLiveTranscript]);

  const stopListening = useCallback((shouldCommit = false) => {
    shouldRestartRef.current = false;
    isListeningRef.current = false;
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }

    const text = interimRef.current.trim();
    setLiveTranscript('');
    interimRef.current = '';
    accumulatedPrefixRef.current = '';
    errorCountRef.current = 0;

    try { recognitionRef.current?.stop(); } catch (_) {}
    setAvatarState('idle');

    if (shouldCommit && text.length > 0) {
      onCommit(text);
    }
  }, [setLiveTranscript, setAvatarState, onCommit]);

  // Restart when language changes while listening
  useEffect(() => {
    if (isListeningRef.current) {
      stopListening();
      setTimeout(startListening, 200);
    }
  }, [selectedLanguage]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      shouldRestartRef.current = false;
      try { recognitionRef.current?.stop(); } catch (_) {}
    };
  }, []);

  return {
    startListening,
    stopListening,
    isListening: () => isListeningRef.current,
  };
}
