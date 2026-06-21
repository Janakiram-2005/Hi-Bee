/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 *
 * VoiceAvatarWidget — root orchestrator.
 * - Draggable fixed-position robot avatar
 * - Wires VAD → IPC → TTS state machine
 * - Listens for Ctrl+Shift+V hotkey via IPC from main process
 * - Persists drag position in localStorage
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useVoiceStore } from '@renderer/store/voiceStore';
import { useCloudSTT } from '@renderer/hooks/useCloudSTT';
import { useVoiceTTS } from '@renderer/hooks/useVoiceTTS';
import { useSetting } from '@renderer/hooks/useSetting';
import { useStore } from '@renderer/hooks/useStore';
import { StatusEnum } from '@ui-tars/shared/types';
import { api } from '@renderer/api';
import { RobotAvatar } from './RobotAvatar';
import { VoicePanel } from './VoicePanel';
import { VoicePermissionGate } from './VoicePermissionGate';
import { VisionWakePanel } from './VisionWakePanel';
import { Resizable } from 're-resizable';

import './VoiceAvatar.css';

export function VoiceAvatarWidget() {
  const { settings } = useSetting();

  // If voice is disabled in settings, render nothing
  if (!settings?.voiceEnabled) return null;

  return <VoiceAvatarInner settings={settings} />;
}

function VoiceAvatarInner({ settings }: { settings: any }) {
  const [permissionsReady, setPermissionsReady] = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [pythonState, setPythonState] = useState<{
    vadState: string;
    wsState: string;
    queueDepth: number;
    currentAction: any;
  }>({
    vadState: 'SLEEPING',
    wsState: 'CLOSED',
    queueDepth: 0,
    currentAction: null,
  });

  useEffect(() => {
    const handler = (_event: any, payload: any) => {
      const { event, data } = payload;
      setPythonState((prev) => {
        const next = { ...prev };
        if (event === 'vad:wake') {
          next.vadState = 'LISTENING';
        } else if (event === 'vad:sleep') {
          next.vadState = 'SLEEPING';
          next.wsState = 'CLOSED';
          next.queueDepth = 0;
          next.currentAction = null;
        } else if (event === 'ws:connected') {
          next.wsState = 'CONNECTED';
        } else if (event === 'ws:closed') {
          next.wsState = 'CLOSED';
        } else if (event === 'ws:error') {
          next.wsState = 'ERROR';
        } else if (event === 'queue:enqueue') {
          next.queueDepth++;
        } else if (event === 'queue:dispatch') {
          next.currentAction = data;
          if (next.queueDepth > 0) next.queueDepth--;
        } else if (event === 'queue:done') {
          next.currentAction = null;
          if (next.queueDepth > 0) next.queueDepth--;
        }
        return next;
      });
    };
    const unsubscribe = window.electron?.ipcRenderer?.on('hibee:pipeline-status', handler);
    return () => {
      unsubscribe?.();
    };
  }, []);

  const {
    avatarState,
    isExpanded,
    selectedLanguage,
    toggleExpanded,
    setExpanded,
    addTurn,
    setAvatarState,
    setLanguage,
    setVoice,
    currentTaskId,
    history,
    inputMode,
    liveTranscript,
    liveScreenshot,
    setLiveScreenshot,
    pendingConfirmText,
    setTextInput,
    voiceWakeupMode,
    clearHistory,
    setCurrentTask,
    runInBackground,
  } = useVoiceStore();

  // ── Global VLM automation store state ────────────────────────────────────
  const {
    status: agentStatus,
    currentAction: agentAction,
    thinking: agentThinking,
    errorMsg: agentError,
    messages: agentMessages,
  } = useStore();

  // ── Synchronize live screenshot from agent execution messages ───────────
  useEffect(() => {
    if (agentMessages && agentMessages.length > 0) {
      const lastScreenshotMsg = [...agentMessages]
        .reverse()
        .find((m) => m.screenshotBase64 || m.screenshotBase64WithElementMarker);
      const b64 = lastScreenshotMsg?.screenshotBase64WithElementMarker || lastScreenshotMsg?.screenshotBase64 || null;
      if (b64) {
        setLiveScreenshot(b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`);
      } else {
        setLiveScreenshot(null);
      }
    } else {
      setLiveScreenshot(null);
    }
  }, [agentMessages, setLiveScreenshot]);

  // ── Overrides from updateAgentState ──────────────────────────────────────
  const [overrideState, setOverrideState] = useState<string | null>(null);
  const [overrideText, setOverrideText] = useState<string | null>(null);

  // ── Controlled panel size ────────────────────────────────────────────────
  const [panelSize, setPanelSize] = useState<{ width: number | string; height: number | string }>({
    width: 340,
    height: 'auto',
  });

  // Expose updateAgentState to window
  useEffect(() => {
    (window as any).updateAgentState = (state: string, text: string) => {
      setOverrideState(state);
      setOverrideText(text);
    };
    return () => {
      delete (window as any).updateAgentState;
    };
  }, []);

  const [completedMsgOverride, setCompletedMsgOverride] = useState<string | null>(null);
  const [errorMsgOverride, setErrorMsgOverride] = useState<string | null>(null);
  const idleMsgs = ['Ready to work', "Let's begin", 'Hello..!!', 'See you soon'];

  // Whenever a new run starts or when we become idle, clear the override
  useEffect(() => {
    if (agentStatus === StatusEnum.INIT || agentStatus === StatusEnum.RUNNING) {
      setOverrideState(null);
      setOverrideText(null);
    }
  }, [agentStatus]);

  // Handle task completion message rotation and timeout
  useEffect(() => {
    let t1: ReturnType<typeof setTimeout>;
    let t2: ReturnType<typeof setTimeout>;

    if (agentStatus === StatusEnum.END) {
      setCompletedMsgOverride('Task completed successfully.');
      t1 = setTimeout(() => {
        const randomMsg = idleMsgs[Math.floor(Math.random() * idleMsgs.length)];
        setCompletedMsgOverride(randomMsg);
        t2 = setTimeout(() => {
          setCompletedMsgOverride(null);
        }, 6000);
      }, 6000);
    } else {
      setCompletedMsgOverride(null);
    }

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [agentStatus]);

  // Handle agent error message timeout
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    if (agentError) {
      setErrorMsgOverride(agentError);
      t = setTimeout(() => {
        setErrorMsgOverride(null);
      }, 6000);
    } else {
      setErrorMsgOverride(null);
    }
    return () => clearTimeout(t);
  }, [agentError]);

  // ── Compute effective state & text ───────────────────────────────────────
  let effectiveState = 'idle';
  let effectiveText: string | null = null;

  if (settings?.googleApiSource === 'agent_builder') {
    if (pythonState.wsState === 'ERROR') {
      effectiveState = 'error';
      effectiveText = 'WebSocket error occurred';
    } else if (pythonState.queueDepth > 0 || pythonState.currentAction) {
      const actionName = pythonState.currentAction?.name || '';
      const actionLower = actionName.toLowerCase();
      if (actionLower.includes('type') || actionLower.includes('write')) {
        effectiveState = 'typing';
        effectiveText = 'Writing text...';
      } else if (actionLower.includes('launch') || actionLower.includes('open')) {
        effectiveState = 'navigating';
        effectiveText = `Launching ${pythonState.currentAction?.args?.app_name || 'app'}...`;
      } else {
        effectiveState = 'executing';
        effectiveText = 'Executing background task...';
      }
    } else if (pythonState.wsState === 'CONNECTED') {
      effectiveState = 'listening';
      effectiveText = 'Listening... (Vertex Live WSS)';
    } else if (pythonState.vadState === 'LISTENING') {
      effectiveState = 'listening';
      effectiveText = 'Ambient listening active';
    } else {
      effectiveState = 'idle';
      effectiveText = 'Hi-Bee is sleeping (monitoring locally)';
    }
  } else if (overrideState) {
    effectiveState = overrideState;
    effectiveText = overrideText;
  } else if (errorMsgOverride) {
    effectiveState = 'error';
    effectiveText = errorMsgOverride;
  } else if (agentStatus === StatusEnum.RUNNING || agentStatus === StatusEnum.CALL_USER || agentThinking) {
    if (agentThinking && !agentAction) {
      effectiveState = 'thinking';
      effectiveText = 'Analyzing your request...';
    } else if (agentStatus === StatusEnum.CALL_USER) {
      effectiveState = 'thinking';
      effectiveText = 'Waiting for user input...';
    } else if (agentAction) {
      const actionLower = agentAction.toLowerCase();
      
      if (actionLower.startsWith('click') || actionLower.startsWith('double') || actionLower.includes('press')) {
        effectiveState = 'clicking';
        effectiveText = 'Clicking target elements...';
      } else if (actionLower.startsWith('type') || actionLower.startsWith('hotkey') || actionLower.includes('write')) {
        effectiveState = 'typing';
        effectiveText = 'Writing text...';
      } else if (actionLower.startsWith('screenshot') || actionLower.includes('scan')) {
        effectiveState = 'scanning';
        effectiveText = 'Scanning desktop elements...';
      } else if (actionLower.includes('search') || actionLower.includes('google') || actionLower.includes('bing') || actionLower.includes('chrome')) {
        effectiveState = 'searching';
        effectiveText = 'Searching Chrome tabs...';
      } else if (actionLower.includes('scroll') || actionLower.includes('drag') || actionLower.includes('navigate') || actionLower.includes('open') || actionLower.includes('launch')) {
        effectiveState = 'navigating';
        effectiveText = 'Navigating screen area...';
      } else if (actionLower.startsWith('finished') || actionLower.startsWith('finish')) {
        effectiveState = 'success';
        effectiveText = 'Task completed successfully.';
      } else {
        effectiveState = 'thinking';
        effectiveText = 'Analyzing your request...';
      }
    } else {
      effectiveState = 'thinking';
      effectiveText = 'Analyzing your request...';
    }
  } else if (completedMsgOverride) {
    effectiveState = idleMsgs.includes(completedMsgOverride) ? 'idle' : 'success';
    effectiveText = completedMsgOverride;
  } else {
    // Fall back to voice-specific active states (listening, speaking, thinking, idle)
    if (avatarState === 'listening') {
      effectiveState = 'listening';
      effectiveText = liveTranscript || 'Listening...';
    } else if (avatarState === 'confirming') {
      effectiveState = 'confirming';
      effectiveText = `Can I execute: "${pendingConfirmText}" for you, sir?`;
    } else if (avatarState === 'speaking') {
      effectiveState = 'speaking';
      const lastAssistantTurn = [...history].reverse().find((t) => t.role === 'assistant');
      effectiveText = lastAssistantTurn ? lastAssistantTurn.text : 'Speaking...';
    } else if (avatarState === 'thinking') {
      effectiveState = 'thinking';
      effectiveText = 'Thinking...';
    } else {
      effectiveState = 'idle';
      effectiveText = null;
    }
  }

  // ── Speech bubble text transitions ───────────────────────────────────────
  const [displayedText, setDisplayedText] = useState<string | null>(null);
  const [isFading, setIsFading] = useState(false);

  useEffect(() => {
    if (effectiveText !== displayedText) {
      setIsFading(true);
      const timer = setTimeout(() => {
        setDisplayedText(effectiveText);
        setIsFading(false);
      }, 150);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [effectiveText, displayedText]);

  const showBubble = !isExpanded && !!displayedText && displayedText.trim() !== '';

  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0, startX: 0, startY: 0 });
  const isListeningRef = useRef(false);

  // ─── TTS hook ────────────────────────────────────────────────────────────
  const { speak, stop: stopTTS, pause: pauseTTS, resume: resumeTTS } = useVoiceTTS();

  const handlePlayLast = useCallback(() => {
    const lastAssistantTurn = [...history].reverse().find((t) => t.role === 'assistant');
    if (lastAssistantTurn?.text) {
      speak(lastAssistantTurn.text);
    }
  }, [history, speak]);

  // ─── Process committed transcript → call Vertex AI ───────────────────────
  const handleCommit = useCallback(
    async (transcript: string) => {
      setAvatarState('thinking');
      isListeningRef.current = false;

      // Add user turn to history
      addTurn({ id: uuidv4(), role: 'user', text: transcript, timestamp: Date.now() });

      // Build chat history for context (last 10 turns)
      const ctxHistory = history.slice(-10).map((t) => ({
        role: t.role === 'user' ? ('user' as const) : ('model' as const),
        text: t.text,
      }));

      try {
        const result = await api.voiceChat({
          transcript,
          history: ctxHistory,
          language: selectedLanguage,
          taskId: currentTaskId ?? undefined,
          runInBackground,
        });

        addTurn({
          id: uuidv4(),
          role: 'assistant',
          text: result.text,
          timestamp: Date.now(),
          citations: result.citations,
        });

        speak(result.text);
      } catch (err) {
        // Localized fallback based on selected language
        const lang = selectedLanguage;
        let fallback = "I ran into a slight issue. Could you try again?";
        if (lang.startsWith('te-')) fallback = 'క్షమించండి, నాకు ఒక సమస్య వచ్చింది. మళ్ళీ ప్రయత్నించండి.';
        else if (lang.startsWith('hi-')) fallback = 'माफ़ करें, एक समस्या आई। कृपया फिर से प्रयास करें।';
        else if (lang.startsWith('ta-')) fallback = 'மன்னிக்கவும், ஒரு பிழை ஏற்பட்டது. மீண்டும் முயற்சிக்கவும்.';
        else if (lang.startsWith('kn-')) fallback = 'ಕ್ಷಮಿಸಿ, ಒಂದು ಸಮಸ್ಯೆ ಆಯಿತು. ದಯವಿಟ್ಟು ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.';
        else if (lang.startsWith('ml-')) fallback = 'ക്ഷമിക്കണം, ഒരു പ്രശ്‌നം ഉണ്ടായി. വീണ്ടും ശ്രമിക്കൂ.';
        else if (lang.startsWith('bn-')) fallback = 'দুঃখিত, একটি সমস্যা হয়েছে। আবার চেষ্টা করুন।';
        addTurn({ id: uuidv4(), role: 'assistant', text: fallback, timestamp: Date.now() });
        speak(fallback);
      }
    },
    [history, selectedLanguage, currentTaskId, addTurn, setAvatarState, speak],
  );

  // ─── Interruption: user speaks while TTS is playing ──────────────────────
  const handleInterrupt = useCallback(() => {
    stopTTS();
  }, [stopTTS]);

  const handlePermissionDenied = useCallback(() => {
    setPermissionError('Microphone access was denied or the Speech Recognition service is unavailable. Please check system permissions or switch to Text Chat mode.');
    setPermissionsReady(false);
    setExpanded(true);
  }, [setExpanded]);

  // ─── Cloud STT hook (replaces Chromium Web Speech API) ───────────────────
  const { startListening, stopListening, isListening } = useCloudSTT({
    silenceMs: settings?.voiceSilenceMs ?? 1500,
    chunkIntervalMs: 3000,
    autoCommit: (settings?.voiceWakeupMode ?? voiceWakeupMode) !== 'hotkey',
    onCommit: (transcript) => {
      const mode = settings?.voiceWakeupMode ?? voiceWakeupMode;
      if (mode === 'hotkey') {
        // Set the textInput state instead of submitting
        setTextInput(transcript);
        setAvatarState('idle');
      } else {
        handleCommit(transcript);
      }
    },
    onInterrupt: handleInterrupt,
    onPermissionDenied: handlePermissionDenied,
    speak,
  });

  // ─── If inputMode is text, stop VAD listening immediately ─────────────────
  useEffect(() => {
    if (inputMode === 'text') {
      stopListening();
    }
  }, [inputMode, stopListening]);

  const toggleListening = useCallback(async () => {
    const active = isListening ? isListening() : false;
    if (active) {
      stopListening(true);
    } else {
      stopTTS();
      if (agentStatus === StatusEnum.RUNNING || agentStatus === StatusEnum.CALL_USER) {
        await api.stopRun().catch(() => {});
      }
      setExpanded(true);
      startListening();
    }
  }, [isListening, startListening, stopListening, stopTTS, agentStatus, setExpanded]);

  const handleReset = useCallback(async () => {
    await api.stopRun().catch(() => {});
    await api.clearHistory().catch(() => {});
    stopTTS();
    clearHistory();
    setCurrentTask(null);
    setTextInput('');
    setAvatarState('idle');

    const lang = selectedLanguage;
    let msg = "Memory cleared. Starting fresh!";
    if (lang.startsWith('te-')) msg = "టాస్క్ మెమరీ క్లియర్ చేయబడింది. కొత్తగా ప్రారంభిస్తున్నాను!";
    else if (lang.startsWith('hi-')) msg = "कार्य स्मृति साफ़ कर दी गई है। नए सिरे से शुरुआत कर रहे हैं!";
    else if (lang.startsWith('ta-')) msg = "பணி நினைவகம் அழிக்கப்பட்டது. புதியதாக தொடங்குகிறது!";
    else if (lang.startsWith('kn-')) msg = "ಕೆಲಸದ ಮೆಮೊರಿ ತೆರವುಗೊಳಿಸಲಾಗಿದೆ. ಹೊಸದಾಗಿ ಪ್ರಾರಂಭಿಸಲಾಗುತ್ತಿದೆ!";
    else if (lang.startsWith('ml-')) msg = "ടാസ്ക് മെമ്മറി മായ്‌ച്ചു. പുതിയതായി ആരംഭിക്കുന്നു!";
    else if (lang.startsWith('bn-')) msg = "টাস্ক মেমরি মুছে ফেলা হয়েছে। নতুন করে শুরু করছি!";
    speak(msg);
  }, [speak, stopTTS, clearHistory, setCurrentTask, setTextInput, setAvatarState, selectedLanguage]);

  // ─── Hotkey listener from main process ───────────────────────────────────
  useEffect(() => {
    const handler = () => toggleListening();
    const unsubscribe = window.electron?.ipcRenderer?.on('voice:toggle-listen', handler);
    return () => {
      unsubscribe?.();
    };
  }, [toggleListening]);

  // ─── External Speak request listener (e.g. from Hi-Bee Agent window) ─────
  useEffect(() => {
    const handler = (...args: unknown[]) => {
      const text = args[0];
      if (typeof text === 'string') {
        speak(text);
      }
    };
    const unsubscribe = window.electron?.ipcRenderer?.on('voice:speak-text', handler);
    return () => {
      unsubscribe?.();
    };
  }, [speak]);

  const startListeningRef = useRef(startListening);
  useEffect(() => {
    startListeningRef.current = startListening;
  }, [startListening]);

  // ─── Auto-start if setting is on (after permissions gate passes) ─────────
  useEffect(() => {
    if (!settings?.voiceAutoStart || !permissionsReady) return;
    const t = setTimeout(() => {
      startListeningRef.current();
    }, 500);
    return () => clearTimeout(t);
  }, [permissionsReady, settings?.voiceAutoStart]);

  // ─── Auto-restart listening after speaking completes (hotkey mode only) ──
  // For phrase/live_agent modes, useCloudSTT manages the restart loop internally.
  const restartDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  const [pendingGesture, setPendingGesture] = useState<any>(null);
  const [showVisionPanel, setShowVisionPanel] = useState(false);

  // ─── Listen for gesture triggers from local python engine ───────────────
  useEffect(() => {
    const handler = (_event: any, payload: any) => {
      console.log('[Gesture]', payload.action, payload.actionArg);
      if (payload.action === 'start_listening') {
        if (!isListening?.()) {
          api.logFromRenderer({ message: `[VoiceWidget] Gesture triggered start_listening` }).catch(() => {});
          startListening();
        }
      } else if (payload.action === 'start_task') {
        if (settings?.googleApiSource === 'agent_builder') {
          window.electron.ipcRenderer.invoke('hibee-agent:toggle').catch(() => {});
        } else {
          toggleExpanded();
        }
      } else if (payload.action) {
        // volume_up, volume_down, play_pause, open_app
        window.electron.ipcRenderer.invoke('system:action', { 
          action: payload.action, 
          arg: payload.actionArg 
        }).catch(() => {});
      }
    };
    
    const unsubscribe = window.electron?.ipcRenderer?.on('vision-gesture' as any, handler);

    const localWakeHandler = () => {
      if (!isListening?.()) {
        api.logFromRenderer({ message: `[VoiceWidget] Frontend Vision wake triggered` }).catch(() => {});
        startListening();
      }
    };
    window.addEventListener('vision:wake-triggered', localWakeHandler);

    const localGestureHandler = (e: CustomEvent) => {
      const g = e.detail;
      if (g.action === 'start_task') {
        setPendingGesture(g);
      } else if (g.action === 'start_listening') {
        if (!isListening?.()) startListening();
      } else if (g.action) {
        window.electron.ipcRenderer.invoke('system:action', { action: g.action, arg: g.actionArg }).catch(() => {});
      }
    };
    window.addEventListener('vision:gesture-triggered', localGestureHandler as EventListener);

    return () => {
      unsubscribe?.();
      window.removeEventListener('vision:wake-triggered', localWakeHandler);
      window.removeEventListener('vision:gesture-triggered', localGestureHandler as EventListener);
    };
  }, [startListening, isListening, settings?.googleApiSource, toggleExpanded]);

  useEffect(() => {
    if (inputMode === 'text') return;
    const mode = settings?.voiceWakeupMode ?? 'hotkey';
    // In hotkey mode, restart foreground listening when state returns to 'listening'
    // and no recording is active. Debounced to avoid React strict-mode double-firing.
    if (mode === 'hotkey' && avatarState === 'listening' && isListening && !isListening()) {
      // Clear any pending restart
      if (restartDebounceRef.current) clearTimeout(restartDebounceRef.current);
      restartDebounceRef.current = setTimeout(() => {
        restartDebounceRef.current = null;
        if (!isListening?.()) {
          api.logFromRenderer({ message: `[VoiceWidget] Hotkey mode auto-restart listening` }).catch(() => {});
          startListening();
        }
      }, 300);
      return () => {
        if (restartDebounceRef.current) clearTimeout(restartDebounceRef.current);
      };
    }
    return undefined;
  }, [avatarState, startListening, isListening, inputMode, settings?.voiceWakeupMode]);

  const handlePermissionsReady = useCallback(() => {
    setPermissionsReady(true);
    setPermissionError(null);
  }, []);

  // ─── Apply persisted language/accent settings to runtime store ───────────
  useEffect(() => {
    if (typeof settings?.voiceLanguage === 'string' && settings.voiceLanguage) {
      setLanguage(settings.voiceLanguage);
    }
    const accent = settings?.voiceAccentUri || settings?.voiceAccent;
    if (typeof accent === 'string') {
      setVoice(accent);
    }
  }, [settings?.voiceLanguage, settings?.voiceAccentUri, settings?.voiceAccent, setLanguage, setVoice]);

  // ─── Dragging logic ───────────────────────────────────────────────────────
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    dragStart.current = { x: e.screenX, y: e.screenY, startX: e.screenX, startY: e.screenY };

    const onMove = (ev: MouseEvent) => {
      if (!isDragging.current) return;
      const dx = ev.screenX - dragStart.current.x;
      const dy = ev.screenY - dragStart.current.y;
      dragStart.current.x = ev.screenX;
      dragStart.current.y = ev.screenY;
      
      // Drag the transparent Electron window itself
      window.electron.ipcRenderer.invoke('voice-window:move', { dx, dy }).catch(() => {});
    };

    const onUp = (ev: MouseEvent) => {
      isDragging.current = false;
      const totalDx = Math.abs(ev.screenX - dragStart.current.startX);
      const totalDy = Math.abs(ev.screenY - dragStart.current.startY);
      // Only toggle if it was a click (not a drag)
      if (totalDx < 5 && totalDy < 5) {
        if (settings?.googleApiSource === 'agent_builder') {
          window.electron.ipcRenderer.invoke('hibee-agent:toggle').catch(() => {});
        } else {
          toggleExpanded();
        }
      }
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [toggleExpanded]);

  // Keep default position in the transparent window (fixed at bottom-right corner)
  const defaultPos = { right: 24, bottom: 24 };

  return (
    <VoicePermissionGate onReady={handlePermissionsReady}>
      <div
        className="voice-avatar-root"
        style={{ right: defaultPos.right, bottom: permissionError ? 100 : defaultPos.bottom }}
        onMouseEnter={() => {
          window.electron.ipcRenderer.invoke('voice-window:set-ignore-mouse-events', false).catch(() => {});
        }}
        onMouseLeave={() => {
          window.electron.ipcRenderer.invoke('voice-window:set-ignore-mouse-events', true).catch(() => {});
        }}
      >
        {permissionError && (
          <div className="voice-permission-error">{permissionError}</div>
        )}

        {/* Floating Screenshot Preview */}
        {!isExpanded && liveScreenshot && (
          <div className="voice-screenshot-preview">
            <div className="preview-label">Live View</div>
            <img src={liveScreenshot} alt="Live Agent Screen" />
          </div>
        )}

        {/* Gesture Confirmation Modal */}
        {pendingGesture && (
          <div className="gesture-confirmation-modal" style={{ position: 'absolute', top: '-100px', right: 0, width: '280px', background: 'rgba(15, 23, 42, 0.95)', backdropFilter: 'blur(12px)', border: '1px solid #3b82f6', borderRadius: '12px', padding: '16px', color: 'white', zIndex: 999, boxShadow: '0 10px 25px rgba(0,0,0,0.5)' }}>
            <h3 style={{ margin: '0 0 8px 0', fontSize: '14px', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ color: '#4ade80' }}>✋ Gesture Detected</span>
            </h3>
            <p style={{ margin: '0 0 16px 0', fontSize: '13px', color: '#cbd5e1' }}>
              Execute task linked to <strong>{pendingGesture.name}</strong>:
              <br />
              <span style={{ color: '#60a5fa' }}>"{pendingGesture.actionArg}"</span> ?
            </p>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button 
                style={{ padding: '6px 12px', borderRadius: '6px', background: 'transparent', border: '1px solid #475569', color: '#cbd5e1', cursor: 'pointer', fontSize: '12px' }}
                onClick={() => setPendingGesture(null)}
              >
                Cancel
              </button>
              <button 
                style={{ padding: '6px 12px', borderRadius: '6px', background: '#3b82f6', border: 'none', color: 'white', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold' }}
                onClick={() => {
                  handleCommit(pendingGesture.actionArg);
                  setPendingGesture(null);
                }}
              >
                Execute
              </button>
            </div>
          </div>
        )}

        {/* Vision Wake Panel */}
        <div style={{ 
          position: 'absolute', 
          bottom: '84px', 
          right: isExpanded ? '360px' : '0', 
          zIndex: 99, 
          transition: 'right 0.3s, opacity 0.3s',
          opacity: (isExpanded && showVisionPanel) ? 1 : 0,
          pointerEvents: (isExpanded && showVisionPanel) ? 'auto' : 'none'
        }}>
          <VisionWakePanel />
        </div>

        {/* Expanded panel (renders above orb) */}
        <Resizable
          style={{
            display: isExpanded ? 'flex' : 'none',
            position: 'absolute',
            bottom: '84px',
            right: 0,
            zIndex: 100
          }}
          className="voice-resizable-wrapper"
          size={panelSize}
          onResizeStop={(e, direction, ref, d) => {
            setPanelSize({
              width: ref.style.width,
              height: ref.style.height,
            });
          }}
          minWidth={300}
          maxWidth={600}
          enable={{ top: true, right: true, bottom: true, left: true, topRight: true, bottomRight: true, bottomLeft: true, topLeft: true }}
          handleClasses={{
            top: 'resize-handle-top',
            right: 'resize-handle-right',
            bottom: 'resize-handle-bottom',
            left: 'resize-handle-left',
            topRight: 'resize-handle-tr',
            bottomRight: 'resize-handle-br',
            bottomLeft: 'resize-handle-bl',
            topLeft: 'resize-handle-tl',
          }}
        >
          <VoicePanel
            style={{ width: '100%', height: '100%' }}
            onClose={() => setExpanded(false)}
            onHeightReset={() => {
              setPanelSize(prev => ({ ...prev, height: 'auto' }));
            }}
            onStopTTS={stopTTS}
            onPauseTTS={pauseTTS}
            onResumeTTS={resumeTTS}
            onPlayLast={handlePlayLast}
            onToggleMic={toggleListening}
            isListening={isListening ? isListening() : false}
            onSendText={handleCommit}
            onReset={handleReset}
            isHeightAuto={panelSize.height === 'auto'}
            showVisionPanel={showVisionPanel}
            onToggleVisionPanel={() => setShowVisionPanel(prev => !prev)}
          />
        </Resizable>

        {/* Floating Speech Bubble */}
        {showBubble && (
          <div className={`speech-bubble state-${effectiveState} ${isFading || !effectiveText ? 'fading-out' : 'fading-in'}`}>
            <div className="bubble-content">
              {displayedText}
              {effectiveState === 'typing' && (
                <span className="typing-dots">
                  <span className="dot"></span>
                  <span className="dot"></span>
                  <span className="dot"></span>
                </span>
              )}
              {effectiveState === 'success' && (
                <span className="success-checkmark">✓</span>
              )}
            </div>
            <div className="bubble-tail" />
          </div>
        )}

        {/* The draggable robot orb */}
        <div
          className={`voice-orb state-${effectiveState}`}
          onMouseDown={handleMouseDown}
          title={
            effectiveState === 'idle' ? 'Click to toggle / drag to move' :
            effectiveState === 'listening' ? 'Listening… (click to stop)' :
            effectiveState === 'thinking' ? 'Processing…' :
            'Speaking… (click to stop)'
          }
        >
          {/* Circling Loading and Searching Animation */}
          {(effectiveState === 'thinking' ||
            effectiveState === 'searching' ||
            effectiveState === 'scanning' ||
            effectiveState === 'navigating') && (
            <div className="circling-loader" />
          )}

          <div className={`state-${effectiveState}`}>
            <RobotAvatar state={effectiveState} size={48} />
          </div>
        </div>
      </div>
    </VoicePermissionGate>
  );
}

// Named export for lazy loading
export default VoiceAvatarWidget;
