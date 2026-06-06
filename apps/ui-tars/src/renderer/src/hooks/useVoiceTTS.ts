/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 *
 * useVoiceTTS — multi-language, multi-accent TTS hook.
 *
 * Backend priority:
 *   1. GCP Cloud TTS (Neural2/Wavenet voices) — correct regional accents for
 *      Indian languages (Telugu, Hindi, Tamil, Kannada, Malayalam, Bengali, etc.)
 *   2. Browser Web Speech API — fallback when GCP key/API is unavailable
 *
 * Language detection: uses selectedLanguage from the store (user's chosen BCP-47)
 * as primary, then falls back to Unicode script detection for mixed/unknown text.
 */
import { useCallback, useEffect, useRef } from 'react';
import { useVoiceStore } from '@renderer/store/voiceStore';
import { useSetting } from '@renderer/hooks/useSetting';
import { api } from '@renderer/api';

/** Detect language from Unicode script in text (only used as a fallback) */
function detectLanguageFromScript(text: string, defaultLang: string): string {
  if (/[\u0c00-\u0c7f]/.test(text)) return 'te-IN'; // Telugu
  if (/[\u0900-\u097f]/.test(text)) return 'hi-IN'; // Hindi (Devanagari)
  if (/[\u0b80-\u0bff]/.test(text)) return 'ta-IN'; // Tamil
  if (/[\u0c80-\u0cff]/.test(text)) return 'kn-IN'; // Kannada
  if (/[\u0d00-\u0d7f]/.test(text)) return 'ml-IN'; // Malayalam
  if (/[\u0980-\u09ff]/.test(text)) return 'bn-IN'; // Bengali
  if (/[\u0a80-\u0aff]/.test(text)) return 'gu-IN'; // Gujarati
  if (/[\u0a00-\u0a7f]/.test(text)) return 'pa-IN'; // Punjabi
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh-CN'; // Chinese
  if (/[\u3040-\u30ff\u31f0-\u31ff]/.test(text)) return 'ja-JP'; // Japanese
  if (/[\uac00-\ud7af]/.test(text)) return 'ko-KR'; // Korean
  return defaultLang;
}

/** Detect the effective language for TTS: prefer selectedLanguage, fall back to script detection */
function detectLanguage(text: string, selectedLang: string): string {
  // If the user selected a non-English language explicitly, use it
  if (selectedLang && selectedLang !== 'en-US') {
    // Check if text contains native script; if so, let script detection override
    const scriptDetected = detectLanguageFromScript(text, selectedLang);
    return scriptDetected;
  }
  // For English mode, only override if non-Latin script found
  return detectLanguageFromScript(text, selectedLang);
}

export function useVoiceTTS() {
  const {
    isMuted,
    selectedLanguage,
    selectedVoiceURI,
    setAvatarState,
    setAvailableVoices,
    pendingConfirmText,
    volume,
    setIsPaused,
  } = useVoiceStore();

  const { settings } = useSetting();

  const isSpeakingRef = useRef(false);
  const utteranceQueueRef = useRef<SpeechSynthesisUtterance[]>([]);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);

  const pendingConfirmTextRef = useRef(pendingConfirmText);
  const settingsRef = useRef(settings);
  const selectedLanguageRef = useRef(selectedLanguage);

  // Keep refs in sync
  useEffect(() => { pendingConfirmTextRef.current = pendingConfirmText; }, [pendingConfirmText]);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  useEffect(() => { selectedLanguageRef.current = selectedLanguage; }, [selectedLanguage]);

  // Sync volume with active audio element dynamically
  useEffect(() => {
    if (currentAudioRef.current) {
      currentAudioRef.current.volume = volume;
    }
  }, [volume]);

  // ─── Load available browser voices ─────────────────────────────────────────
  useEffect(() => {
    const loadVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length > 0) {
        setAvailableVoices(voices);
      }
    };
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
    return () => { window.speechSynthesis.onvoiceschanged = null; };
  }, [setAvailableVoices]);

  // ─── Pick the best matching browser voice ──────────────────────────────────
  const pickVoice = useCallback(
    (lang: string, preferredURI: string): SpeechSynthesisVoice | null => {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length === 0) return null;

      if (preferredURI) {
        const exact = voices.find((v) => v.voiceURI === preferredURI);
        if (exact) return exact;
      }

      const exactLang = voices.find((v) => v.lang === lang || v.lang.replace('_', '-') === lang);
      if (exactLang) return exactLang;

      // Indian languages — fall back to en-IN for browser synthesis
      if (lang.endsWith('-IN') || lang.endsWith('_IN')) {
        const regionalIn = voices.find((v) => v.lang === 'en-IN' || v.lang === 'en_IN');
        if (regionalIn) return regionalIn;
      }

      if (lang.startsWith('es-') || lang.startsWith('es_')) {
        const esDefault = voices.find((v) => v.lang.startsWith('es'));
        if (esDefault) return esDefault;
      }

      if (lang.startsWith('zh-') || lang.startsWith('zh_')) {
        const zhDefault = voices.find((v) => v.lang.startsWith('zh'));
        if (zhDefault) return zhDefault;
      }

      const prefix = lang.split('-')[0];
      const prefixMatch = voices.find((v) => v.lang.startsWith(prefix));
      if (prefixMatch) return prefixMatch;

      return voices[0] ?? null;
    },
    [],
  );

  // ─── Split text into sentence chunks for lower latency ──────────────────────
  const splitIntoChunks = useCallback((text: string): string[] => {
    const raw = text.match(/[^.!?,;]+[.!?,;]+/g) || [text];
    return raw
      .map((s) => s.trim())
      .filter((s) => /\p{L}|\p{N}/u.test(s));
  }, []);

  // ─── Core speak function ─────────────────────────────────────────────────────
  const speak = useCallback(
    async (text: string) => {
      const nextState = pendingConfirmTextRef.current ? 'confirming' : 'listening';
      if (!text?.trim() || isMuted) {
        setAvatarState(nextState);
        return;
      }

      setIsPaused(false);

      // Cancel any ongoing speech
      if (currentAudioRef.current) {
        currentAudioRef.current.pause();
        currentAudioRef.current = null;
      }
      window.speechSynthesis.cancel();
      utteranceQueueRef.current = [];
      if (typeof window !== 'undefined') {
        (window as any)._activeUtterances = [];
      }

      // Detect target language: prefer selectedLanguage, then Unicode fallback
      const targetLang = detectLanguage(text, selectedLanguageRef.current);

      // Determine backend: use GCP for Indian regional languages, also check setting
      const voiceTtsBackend = settingsRef.current?.voiceTtsBackend ?? 'gcp';
      const isIndianRegional = /^(te|hi|ta|kn|ml|bn|mr|gu|pa)-IN/.test(targetLang);
      const useGcp = voiceTtsBackend === 'gcp' || isIndianRegional;

      if (useGcp) {
        setAvatarState('speaking');
        isSpeakingRef.current = true;

        try {
          api.logFromRenderer({ message: `[useVoiceTTS] GCP TTS: lang=${targetLang}, text="${text.slice(0, 40)}"` }).catch(() => {});
          const result = await api.synthesizeSpeech({ text, languageCode: targetLang });

          if (result?.audioContent) {
            if (!isSpeakingRef.current) {
              setAvatarState(nextState);
              return;
            }

            const audio = new Audio(`data:audio/mp3;base64,${result.audioContent}`);
            audio.volume = useVoiceStore.getState().volume;
            currentAudioRef.current = audio;

            audio.onended = () => {
              isSpeakingRef.current = false;
              currentAudioRef.current = null;
              setIsPaused(false);
              setAvatarState(nextState);
            };

            audio.onerror = (e) => {
              console.error('[useVoiceTTS] GCP Audio element error:', e);
              isSpeakingRef.current = false;
              currentAudioRef.current = null;
              setIsPaused(false);
              setAvatarState(nextState);
            };

            await audio.play();
          } else {
            api.logFromRenderer({ message: '[useVoiceTTS] GCP TTS empty response, falling back to browser' }).catch(() => {});
            isSpeakingRef.current = false;
            // Fallback to browser synthesis
            await speakBrowser(text, targetLang, nextState);
          }
        } catch (err) {
          console.warn('[useVoiceTTS] GCP TTS error, falling back to browser:', err);
          isSpeakingRef.current = false;
          await speakBrowser(text, targetLang, nextState);
        }
      } else {
        await speakBrowser(text, targetLang, nextState);
      }

      async function speakBrowser(spText: string, lang: string, next: string) {
        const chunks = splitIntoChunks(spText);
        if (chunks.length === 0) {
          setAvatarState(next as any);
          return;
        }

        const voice = pickVoice(lang, selectedVoiceURI);

        const utterances = chunks.map((chunk, idx) => {
          const u = new SpeechSynthesisUtterance(chunk);
          u.lang = lang;
          u.rate = 1.1;
          u.pitch = 1.02;
          u.volume = useVoiceStore.getState().volume;
          if (voice) u.voice = voice;

          if (idx === 0) {
            u.onstart = () => {
              isSpeakingRef.current = true;
              setAvatarState('speaking');
            };
          }

          if (idx === chunks.length - 1) {
            u.onend = () => {
              isSpeakingRef.current = false;
              utteranceQueueRef.current = [];
              if (typeof window !== 'undefined') { (window as any)._activeUtterances = []; }
              setIsPaused(false);
              setAvatarState(next as any);
            };
            u.onerror = (e) => {
              console.error('[useVoiceTTS] utterance error:', e);
              isSpeakingRef.current = false;
              utteranceQueueRef.current = [];
              if (typeof window !== 'undefined') { (window as any)._activeUtterances = []; }
              setIsPaused(false);
              setAvatarState(next as any);
            };
          }

          return u;
        });

        utteranceQueueRef.current = utterances;
        if (typeof window !== 'undefined') { (window as any)._activeUtterances = utterances; }
        utterances.forEach((u) => window.speechSynthesis.speak(u));
      }
    },
    [
      isMuted,
      selectedVoiceURI,
      pickVoice,
      splitIntoChunks,
      setAvatarState,
    ],
  );

  // ─── Stop / interrupt TTS ────────────────────────────────────────────────────
  const stop = useCallback(() => {
    window.speechSynthesis.cancel();
    utteranceQueueRef.current = [];
    if (typeof window !== 'undefined') { (window as any)._activeUtterances = []; }
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current = null;
    }
    isSpeakingRef.current = false;
    setIsPaused(false);
    const nextState = pendingConfirmTextRef.current ? 'confirming' : 'listening';
    setAvatarState(nextState);
  }, [setAvatarState, setIsPaused]);

  // ─── Pause TTS ───────────────────────────────────────────────────────────────
  const pause = useCallback(() => {
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
    }
    window.speechSynthesis.pause();
    setIsPaused(true);
    setAvatarState('idle');
  }, [setAvatarState, setIsPaused]);

  // ─── Resume TTS ──────────────────────────────────────────────────────────────
  const resume = useCallback(() => {
    if (currentAudioRef.current) {
      currentAudioRef.current.play().catch((err) => console.error('[useVoiceTTS] Play failed on resume:', err));
    }
    window.speechSynthesis.resume();
    setIsPaused(false);
    setAvatarState('speaking');
  }, [setAvatarState, setIsPaused]);

  // ─── Cleanup on unmount ──────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      window.speechSynthesis.cancel();
      if (typeof window !== 'undefined') { (window as any)._activeUtterances = []; }
      if (currentAudioRef.current) {
        currentAudioRef.current.pause();
        currentAudioRef.current = null;
      }
    };
  }, []);

  return {
    speak,
    stop,
    pause,
    resume,
    isSpeaking: () => isSpeakingRef.current,
  };
}
