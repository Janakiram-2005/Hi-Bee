/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 *
 * useCloudSTT — Alternative to useVoiceVAD that completely bypasses
 * Chromium's built-in Web Speech API (which throws `service-not-allowed`
 * in Electron transparent windows).
 *
 * Instead:
 *  1. Captures audio with getUserMedia + MediaRecorder (this DOES work in Electron)
 *  2. Accumulates chunks into a Blob per recording session
 *  3. Converts Blob → base64 and sends to the main process via IPC
 *  4. Main process calls Google Cloud Speech-to-Text v1 REST API
 *  5. Returns transcript to renderer → calls onCommit when silence detected
 *
 * Silence detection: if no speech above threshold for `silenceMs`, the
 * accumulated audio is committed and recording stops.
 *
 * Wake modes:
 *  - hotkey: user manually triggers startListening()
 *  - phrase: background loop; wake phrase triggers foreground commit
 *  - live_agent: background 4s-gap loop; Gemini decides if actionable; asks confirmation
 */
import { useRef, useCallback, useEffect } from 'react';
import { useVoiceStore } from '@renderer/store/voiceStore';
import { api } from '@renderer/api';

/** Robust punctuation-insensitive matching for wake phrases */
function matchWakePhrase(fullText: string, wakePhrase: string): { matched: boolean; command: string } {
  const cleanFull = fullText.toLowerCase().replace(/[^a-z0-9]/g, '');
  const cleanWake = wakePhrase.toLowerCase().replace(/[^a-z0-9]/g, '');

  if (!cleanFull.includes(cleanWake)) {
    // If the wake phrase is "hey hibee", also allow "hibee" or "hi bee" as a shortcut
    if (cleanWake === 'heyhibee') {
      const altCleanWake = 'hibee';
      if (cleanFull.includes(altCleanWake)) {
        return extractCommandAfterCleanWake(fullText, altCleanWake);
      }
    }
    return { matched: false, command: '' };
  }

  return extractCommandAfterCleanWake(fullText, cleanWake);
}

function extractCommandAfterCleanWake(fullText: string, cleanWake: string): { matched: boolean; command: string } {
  const cleanTextForMatch = (char: string) => /[a-z0-9]/i.test(char);

  const cleanFull = fullText.toLowerCase().split('').filter(cleanTextForMatch).join('');
  const startIdx = cleanFull.indexOf(cleanWake);
  if (startIdx === -1) return { matched: false, command: '' };
  const endIdx = startIdx + cleanWake.length;

  let cleanCount = 0;
  let cutIndex = 0;
  for (let i = 0; i < fullText.length; i++) {
    if (cleanTextForMatch(fullText[i])) {
      cleanCount++;
      if (cleanCount === endIdx) {
        cutIndex = i + 1;
        break;
      }
    }
  }

  const command = fullText.substring(cutIndex).trim();
  return { matched: true, command };
}

interface UseCloudSTTOptions {
  silenceMs?: number;
  chunkIntervalMs?: number;
  onCommit: (transcript: string) => void;
  onInterrupt?: () => void;
  onPermissionDenied?: () => void;
  speak?: (text: string) => Promise<void> | void;
}

/** Convert a Blob to a base64 string */
async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result as string;
      // Remove "data:<mime>;base64," prefix
      const base64 = dataUrl.split(',')[1] ?? '';
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/** Detect the best supported MIME type for MediaRecorder */
function getSupportedMimeType(): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  for (const mime of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  return 'audio/webm';
}

export function useCloudSTT({
  silenceMs = 1500,
  onCommit,
  onInterrupt,
  onPermissionDenied,
  speak,
}: UseCloudSTTOptions) {
  const {
    selectedLanguage,
    setAvatarState,
    avatarState,
    voiceWakeupMode,
    voiceWakePhrase,
    inputMode,
    pendingConfirmText,
    setPendingConfirmText,
  } = useVoiceStore();

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const isListeningRef = useRef(false);
  const chunksRef = useRef<Blob[]>([]);
  const mimeTypeRef = useRef(getSupportedMimeType());
  const languageRef = useRef(selectedLanguage);
  const avatarStateRef = useRef(avatarState);
  const isStartingRef = useRef(false);

  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const vadIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isBackgroundRef = useRef(false);
  const voiceWakeupModeRef = useRef(voiceWakeupMode);
  const voiceWakePhraseRef = useRef(voiceWakePhrase);
  const pendingConfirmTextRef = useRef(pendingConfirmText);
  const startListeningRef = useRef<((isBackground?: boolean) => Promise<void>) | null>(null);

  // Keep refs in sync with store
  useEffect(() => { languageRef.current = selectedLanguage; }, [selectedLanguage]);
  useEffect(() => { avatarStateRef.current = avatarState; }, [avatarState]);
  useEffect(() => { voiceWakeupModeRef.current = voiceWakeupMode; }, [voiceWakeupMode]);
  useEffect(() => { voiceWakePhraseRef.current = voiceWakePhrase; }, [voiceWakePhrase]);
  useEffect(() => { pendingConfirmTextRef.current = pendingConfirmText; }, [pendingConfirmText]);

  // ─── Helper: get localised confirmation prompts ──────────────────────────
  const getConfirmMessages = (lang: string) => {
    if (lang.startsWith('te-')) return {
      ok: 'అలాగే, ప్రారంభిస్తున్నాను.',
      cancel: 'అలాగే, రద్దు చేయబడింది.',
      fail: 'నాకు అర్థం కాలేదు. రద్దు చేయబడింది.',
    };
    if (lang.startsWith('hi-')) return {
      ok: 'ठीक है, शुरू कर रहा हूँ।',
      cancel: 'ठीक है, रद्द कर दिया गया है।',
      fail: 'मुझे समझ नहीं आया। रद्द कर दिया गया है।',
    };
    if (lang.startsWith('ta-')) return {
      ok: 'சரி, தொடங்குகிறேன்.',
      cancel: 'சரி, ரத்து செய்யப்பட்டது.',
      fail: 'எனக்கு புரியவில்லை. ரத்து செய்யப்பட்டது.',
    };
    if (lang.startsWith('kn-')) return {
      ok: 'ಸರಿ, ಪ್ರಾರಂಭಿಸುತ್ತೇನೆ.',
      cancel: 'ಸರಿ, ರದ್ದುಗೊಳಿಸಲಾಗಿದೆ.',
      fail: 'ನನಗೆ ಅರ್ಥವಾಗಲಿಲ್ಲ. ರದ್ದುಗೊಳಿಸಲಾಗಿದೆ.',
    };
    if (lang.startsWith('ml-')) return {
      ok: 'ശരി, ആരംഭിക്കാം.',
      cancel: 'ശരി, റദ്ദാക്കിയിരിക്കുന്നു.',
      fail: 'എനിക്ക് മനസ്സിലായില്ല. റദ്ദാക്കിയിരിക്കുന്നു.',
    };
    if (lang.startsWith('bn-')) return {
      ok: 'ঠিক আছে, শুরু করছি।',
      cancel: 'ঠিক আছে, বাতিল করা হয়েছে।',
      fail: 'আমি বুঝতে পারিনি। বাতিল করা হয়েছে।',
    };
    return {
      ok: 'Understood, executing.',
      cancel: 'Understood, cancelled.',
      fail: "I didn't catch that. Task cancelled.",
    };
  };

  const getListenPrompt = (lang: string) => {
    const map: Record<string, string> = {
      'te-IN': 'అవును, నేను వింటున్నాను.',
      'hi-IN': 'हाँ, मैं सुन रहा हूँ।',
      'ta-IN': 'ஆம், நான் கேட்கிறேன்.',
      'kn-IN': 'ಹೌದು, ನಾನು ಕೇಳುತ್ತಿದ್ದೇನೆ.',
      'ml-IN': 'അതെ, ഞാൻ കേൾക്കുന്നുണ്ട്.',
      'bn-IN': 'হ্যাঁ, আমি শুনছি।',
    };
    return map[lang] ?? "Yes, I'm listening.";
  };

  // ─── Handle the fully committed audio transcription ──────────────────────
  const handleTranscript = useCallback(async (finalText: string, wasBackground: boolean) => {
    api.logFromRenderer({ message: `[useCloudSTT] Transcription result (bg=${wasBackground}): "${finalText}"` }).catch(() => {});

    // 1. In 'confirming' state — user is answering yes/no to a task confirmation
    if (avatarStateRef.current === 'confirming') {
      const lower = finalText.toLowerCase();
      const isYes = /\b(yes|yeah|sure|go\s+ahead|do\s+it|ok|okay|yup|yep|confirm|please|అవును|హా|ఆమ్|ಹೌದು|അതെ|हाँ|हा|ji|ji\s+haan|acha)\b/i.test(lower);
      const isNo = /\b(no|nay|dont|don't|stop|cancel|nevermind|nope|వద్దు|నొ|నహి|రద్దు|నా|ಬೇಡ|വേണ്ട|नहीं|नही|mat|ruk)\b/i.test(lower);

      const task = pendingConfirmTextRef.current;
      setPendingConfirmText(null);

      const msgs = getConfirmMessages(languageRef.current);

      if (isYes && task) {
        setAvatarState('executing');
        speak?.(msgs.ok);
        onCommit(task);
      } else {
        setAvatarState('idle');
        speak?.(isNo ? msgs.cancel : msgs.fail);
        // After cancel, restart background listening if in phrase/live_agent mode
        if (voiceWakeupModeRef.current !== 'hotkey') {
          setTimeout(() => startListeningRef.current?.(true), 1500);
        }
      }
      return;
    }

    // 2. Background recording (wake phrase or live agent mode)
    if (wasBackground) {
      if (voiceWakeupModeRef.current === 'phrase') {
        // Check if the wake phrase is present
        const match = matchWakePhrase(finalText, voiceWakeupModeRef.current === 'phrase' ? (voiceWakePhraseRef.current || 'hey hibee') : 'hey hibee');

        if (match.matched) {
          let cmd = match.command;
          // Strip leading/trailing punctuation
          cmd = cmd.replace(/^[.,\/#!$%\^&\*;:{}=\-_`~()\?]+|[.,\/#!$%\^&\*;:{}=\-_`~()\?]+$/g, '').trim();

          if (cmd.length > 2) {
            // Command given right after wake phrase — commit immediately
            setAvatarState('thinking');
            onCommit(cmd);
          } else {
            // Only wake phrase spoken, no command — switch to foreground listening
            setAvatarState('listening');
            await speak?.(getListenPrompt(languageRef.current));
            // Give 600ms for TTS to start then restart foreground
            setTimeout(() => startListeningRef.current?.(false), 600);
          }
        } else {
          // No wake phrase, restart background loop
          setTimeout(() => startListeningRef.current?.(true), 200);
        }
        return;
      }

      if (voiceWakeupModeRef.current === 'live_agent') {
        try {
          const analysis = await api.checkLiveAgentIntent({ transcript: finalText });

          if (analysis?.actionable && analysis.task) {
            // Actionable task detected — ask for confirmation
            setPendingConfirmText(analysis.task);
            setAvatarState('confirming');

            // Build localised confirmation prompt
            const lang = languageRef.current;
            let promptText = `Can I proceed with this task: ${analysis.task}?`;
            if (lang.startsWith('te-')) {
              promptText = `నేను ఈ పనిని ప్రారంభించవచ్చా: ${analysis.task}?`;
            } else if (lang.startsWith('hi-')) {
              promptText = `क्या मैं इस कार्य को आगे बढ़ाऊं: ${analysis.task}?`;
            } else if (lang.startsWith('ta-')) {
              promptText = `நான் இந்த பணியை தொடரலாமா: ${analysis.task}?`;
            } else if (lang.startsWith('kn-')) {
              promptText = `ನಾನು ಈ ಕೆಲಸವನ್ನು ಮುಂದುವರಿಸಬೇಕೇ: ${analysis.task}?`;
            } else if (lang.startsWith('ml-')) {
              promptText = `ഞാൻ ഈ ജോലി തുടരട്ടെയോ: ${analysis.task}?`;
            } else if (lang.startsWith('bn-')) {
              promptText = `আমি কি এই কাজটি করতে পারি: ${analysis.task}?`;
            } else {
              const taskLower = analysis.task.toLowerCase();
              if (taskLower.includes('open') || taskLower.includes('launch') || taskLower.includes('start')) {
                promptText = `May I help you open ${analysis.task.replace(/^(open|launch|start|the)\s+/i, '')}?`;
              } else if (Math.random() < 0.5) {
                promptText = `Should I start this work: ${analysis.task}?`;
              }
            }

            await speak?.(promptText);

            // After TTS ends (2s buffer), restart FOREGROUND listening for yes/no
            setTimeout(() => startListeningRef.current?.(false), 2000);
          } else {
            // Not actionable — restart background loop
            setTimeout(() => startListeningRef.current?.(true), 300);
          }
        } catch (err) {
          console.warn('[useCloudSTT] live_agent intent check failed:', err);
          setTimeout(() => startListeningRef.current?.(true), 500);
        }
        return;
      }
    }

    // 3. Foreground listening — commit to main chat handler
    onCommit(finalText);
  }, [onCommit, setAvatarState, setPendingConfirmText, speak]);

  // ─── Stop listening and optionally commit ────────────────────────────────
  const stopListening = useCallback((shouldCommit = false) => {
    const wasBackground = isBackgroundRef.current;
    isListeningRef.current = false;
    api.logFromRenderer({ message: `[useCloudSTT] stopListening: shouldCommit=${shouldCommit}, bg=${wasBackground}` }).catch(() => {});

    // Clear VAD interval
    if (vadIntervalRef.current) {
      clearInterval(vadIntervalRef.current);
      vadIntervalRef.current = null;
    }
    // Close AudioContext
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    analyserRef.current = null;

    const currentRecorder = mediaRecorderRef.current;
    const currentStream = streamRef.current;

    // Clean up references
    mediaRecorderRef.current = null;
    streamRef.current = null;

    if (!shouldCommit) {
      if (!wasBackground) {
        setAvatarState('idle');
      }
      // On background stop without commit, restart background loop if applicable
      if (wasBackground && voiceWakeupModeRef.current !== 'hotkey') {
        setTimeout(() => startListeningRef.current?.(true), 300);
      }
      // Cleanup stream
      try { currentStream?.getTracks().forEach((t) => t.stop()); } catch (_) {}
      chunksRef.current = [];
      return;
    }

    if (currentRecorder && currentRecorder.state !== 'inactive') {
      currentRecorder.ondataavailable = async (e) => {
        if (e.data && e.data.size > 0) {
          chunksRef.current.push(e.data);
        }

        if (shouldCommit && chunksRef.current.length > 0) {
          const blob = new Blob(chunksRef.current, { type: mimeTypeRef.current });
          chunksRef.current = [];

          if (blob.size >= 512) {
            if (!wasBackground) {
              setAvatarState('thinking');
            }

            try {
              const audioBase64 = await blobToBase64(blob);
              api.logFromRenderer({ message: `[useCloudSTT] Transcribing audio (${blob.size} bytes, bg=${wasBackground})...` }).catch(() => {});
              const result = await api.transcribeAudio({
                audioBase64,
                mimeType: mimeTypeRef.current,
                language: languageRef.current,
              });

              if (result?.transcript && result.transcript.trim().length > 1) {
                await handleTranscript(result.transcript.trim(), wasBackground);
              } else {
                api.logFromRenderer({ message: '[useCloudSTT] Empty transcription result' }).catch(() => {});
                if (!wasBackground) {
                  setAvatarState('idle');
                } else if (voiceWakeupModeRef.current !== 'hotkey') {
                  setTimeout(() => startListeningRef.current?.(true), 300);
                }
              }
            } catch (err) {
              console.warn('[useCloudSTT] Transcription error:', err);
              if (!wasBackground) {
                setAvatarState('idle');
              } else if (voiceWakeupModeRef.current !== 'hotkey') {
                setTimeout(() => startListeningRef.current?.(true), 500);
              }
            }
          } else {
            // Audio too short to transcribe
            if (!wasBackground) {
              setAvatarState('idle');
            } else if (voiceWakeupModeRef.current !== 'hotkey') {
              setTimeout(() => startListeningRef.current?.(true), 300);
            }
          }
        } else {
          chunksRef.current = [];
          if (wasBackground && voiceWakeupModeRef.current !== 'hotkey') {
            setTimeout(() => startListeningRef.current?.(true), 300);
          }
        }
      };

      try { currentRecorder.stop(); } catch (_) {}
    } else {
      chunksRef.current = [];
      if (wasBackground && voiceWakeupModeRef.current !== 'hotkey') {
        setTimeout(() => startListeningRef.current?.(true), 300);
      }
    }

    try { currentStream?.getTracks().forEach((t) => t.stop()); } catch (_) {}
  }, [setAvatarState, handleTranscript]);

  // ─── Start listening session ─────────────────────────────────────────────
  const startListening = useCallback(async (isBackground = false) => {
    if (isListeningRef.current || isStartingRef.current) return;
    isStartingRef.current = true;
    isBackgroundRef.current = isBackground;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 48000,
          channelCount: 1,
        },
        video: false,
      });

      streamRef.current = stream;
      mimeTypeRef.current = getSupportedMimeType();

      // Initialize VAD AudioContext
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);

      audioContextRef.current = audioContext;
      analyserRef.current = analyser;

      const recorder = new MediaRecorder(stream, {
        mimeType: mimeTypeRef.current,
        audioBitsPerSecond: 16000,
      });

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      recorder.onerror = (e) => {
        console.error('[useCloudSTT] MediaRecorder error:', e);
        stopListening();
        onPermissionDenied?.();
      };

      mediaRecorderRef.current = recorder;
      chunksRef.current = [];
      isListeningRef.current = true;

      setAvatarState(isBackground ? 'idle' : 'listening');

      api.logFromRenderer({ message: `[useCloudSTT] startListening: started (isBackground=${isBackground}, mode=${voiceWakeupModeRef.current})` }).catch(() => {});

      recorder.start();

      // VAD interval
      const bufferLength = analyser.fftSize;
      const dataArray = new Float32Array(bufferLength);
      let silenceSamplesCount = 0;
      // Live agent uses 4s gap, others use configured silenceMs
      const currentSilenceMs = (isBackground && voiceWakeupModeRef.current === 'live_agent') ? 4000 : silenceMs;
      const samplesNeededForSilence = currentSilenceMs / 100;
      const samplesNeededForTimeout = 12000 / 100; // 12s max if no speech at all
      let hasSpoken = false;
      let totalSamplesCount = 0;

      const vadInterval = setInterval(() => {
        if (!isListeningRef.current) return;

        analyser.getFloatTimeDomainData(dataArray);

        let sumSquares = 0.0;
        for (let i = 0; i < bufferLength; i++) {
          const val = dataArray[i];
          sumSquares += val * val;
        }
        const rms = Math.sqrt(sumSquares / bufferLength);
        
        // VAD threshold optimized for standard background noise:
        // - Older threshold (0.015) was causing misses for quieter or slightly distant speech.
        // - Newer threshold (0.010) is more forgiving.
        // - To convert RMS to Decibels: dB = 20 * Math.log10(rms). 
        //   An RMS of 0.010 corresponds to approximately -40dB amplitude.
        const speechThreshold = 0.010;

        // Interrupt TTS if user speaks during speaking state
        if (avatarStateRef.current === 'speaking') {
          if (rms > speechThreshold) {
            api.logFromRenderer({ message: `[VAD] User speech during TTS (RMS: ${rms.toFixed(4)}) → Interrupting` }).catch(() => {});
            onInterrupt?.();
          }
          return;
        }

        // VAD logic: detect silence after speech
        if (
          avatarStateRef.current === 'listening' ||
          avatarStateRef.current === 'idle' ||
          avatarStateRef.current === 'confirming'
        ) {
          totalSamplesCount++;
          if (rms > speechThreshold) {
            if (!hasSpoken) {
              hasSpoken = true;
              if (isBackground) {
                // Switch to active listening indicator when speech detected in background
                setAvatarState('listening');
              }
              api.logFromRenderer({ message: `[VAD] User started speaking (RMS: ${rms.toFixed(4)})` }).catch(() => {});
            }
            silenceSamplesCount = 0;
          } else {
            if (hasSpoken) {
              silenceSamplesCount++;
              if (silenceSamplesCount >= samplesNeededForSilence) {
                api.logFromRenderer({ message: `[VAD] Silence detected for ${currentSilenceMs}ms. Committing.` }).catch(() => {});
                stopListening(true);
              }
            } else if (!isBackground && totalSamplesCount >= samplesNeededForTimeout) {
              // Foreground timeout if nobody speaks
              api.logFromRenderer({ message: '[VAD] No speech for 12s. Timing out.' }).catch(() => {});
              stopListening(false);
            } else if (isBackground && totalSamplesCount >= samplesNeededForTimeout * 2) {
              // Background restart after 24s if completely silent (avoids dead loop)
              stopListening(false);
            }
          }
        }
      }, 100);

      vadIntervalRef.current = vadInterval;
      console.info(`[useCloudSTT] Listening started (isBackground=${isBackground}, mode=${voiceWakeupModeRef.current})`);
    } catch (err: any) {
      const name = err?.name ?? String(err);
      console.error('[useCloudSTT] getUserMedia / VAD setup failed:', name, err);
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'NotFoundError') {
        onPermissionDenied?.();
      }
    } finally {
      isStartingRef.current = false;
    }
  }, [silenceMs, onInterrupt, onPermissionDenied, stopListening, setAvatarState]);

  // Sync startListening ref
  useEffect(() => {
    startListeningRef.current = startListening;
  }, [startListening]);

  // ─── Synchronize background listening based on mode, inputMode, avatarState ─
  useEffect(() => {
    // Don't do anything in text mode
    if (inputMode !== 'audio') {
      if (isListeningRef.current) {
        stopListening(false);
      }
      return;
    }

    // In hotkey mode: never auto-start background
    if (voiceWakeupMode === 'hotkey') {
      if (isListeningRef.current && isBackgroundRef.current) {
        stopListening(false);
      }
      return;
    }

    // In phrase/live_agent mode: auto-start background when idle
    let t: ReturnType<typeof setTimeout> | null = null;
    if (avatarState === 'idle') {
      t = setTimeout(() => {
        if (!isListeningRef.current && !isStartingRef.current) {
          startListeningRef.current?.(true);
        }
      }, 400);
    } else if (avatarState === 'executing' || avatarState === 'thinking') {
      // Stop listening while agent is working
      if (isListeningRef.current) {
        stopListening(false);
      }
    }

    return () => {
      if (t) clearTimeout(t);
    };
  }, [avatarState, voiceWakeupMode, inputMode, stopListening]);

  // ─── Restart on language change ─────────────────────────────────────────
  useEffect(() => {
    if (isListeningRef.current) {
      const isBg = isBackgroundRef.current;
      stopListening(false);
      setTimeout(() => startListeningRef.current?.(isBg), 400);
    }
  }, [selectedLanguage]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Cleanup on unmount ─────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      isListeningRef.current = false;
      if (vadIntervalRef.current) clearInterval(vadIntervalRef.current);
      if (audioContextRef.current) audioContextRef.current.close().catch(() => {});
      try { mediaRecorderRef.current?.stop(); } catch (_) {}
      try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch (_) {}
    };
  }, []);

  return {
    startListening,
    stopListening,
    isListening: () => isListeningRef.current,
  };
}
