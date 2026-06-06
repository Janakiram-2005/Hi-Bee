/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 *
 * VoicePanel — Glassmorphism expanded panel with conversation history,
 * live transcript, language/voice selector, and Task KB viewer.
 */
import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, VolumeX, Volume2, ExternalLink, ChevronDown, ChevronUp, X, Power, Send, Bot, Square, Settings, Play, Pause, RotateCcw } from 'lucide-react';
import { useVoiceStore } from '@renderer/store/voiceStore';
import { RobotAvatar } from './RobotAvatar';
import { api } from '@renderer/api';
import { useSetting } from '@renderer/hooks/useSetting';
import { useStore } from '@renderer/hooks/useStore';
import { StatusEnum } from '@ui-tars/shared/types';

// Language options with display names
const LANGUAGES = [
  { code: 'en-US', label: '🇺🇸 English (US)' },
  { code: 'en-GB', label: '🇬🇧 English (UK)' },
  { code: 'en-AU', label: '🇦🇺 English (AU)' },
  { code: 'en-IN', label: '🇮🇳 English (IN)' },
  // ── Indian Regional Languages ──
  { code: 'hi-IN', label: '🇮🇳 Hindi (हिंदी)' },
  { code: 'te-IN', label: '🇮🇳 Telugu (తెలుగు)' },
  { code: 'ta-IN', label: '🇮🇳 Tamil (தமிழ்)' },
  { code: 'kn-IN', label: '🇮🇳 Kannada (ಕನ್ನಡ)' },
  { code: 'ml-IN', label: '🇮🇳 Malayalam (മലയാളം)' },
  { code: 'bn-IN', label: '🇮🇳 Bengali (বাংলা)' },
  { code: 'mr-IN', label: '🇮🇳 Marathi (मराठी)' },
  { code: 'gu-IN', label: '🇮🇳 Gujarati (ગુજરાતી)' },
  { code: 'pa-IN', label: '🇮🇳 Punjabi (ਪੰਜਾਬੀ)' },
  // ── Global Languages ──
  { code: 'zh-CN', label: '🇨🇳 Chinese (Simplified)' },
  { code: 'zh-TW', label: '🇹🇼 Chinese (Traditional)' },
  { code: 'ja-JP', label: '🇯🇵 Japanese' },
  { code: 'ko-KR', label: '🇰🇷 Korean' },
  { code: 'es-ES', label: '🇪🇸 Spanish (ES)' },
  { code: 'es-MX', label: '🇲🇽 Spanish (MX)' },
  { code: 'fr-FR', label: '🇫🇷 French' },
  { code: 'de-DE', label: '🇩🇪 German' },
  { code: 'pt-BR', label: '🇧🇷 Portuguese (BR)' },
  { code: 'ar-SA', label: '🇸🇦 Arabic' },
  { code: 'ru-RU', label: '🇷🇺 Russian' },
  { code: 'tr-TR', label: '🇹🇷 Turkish' },
  { code: 'it-IT', label: '🇮🇹 Italian' },
];

interface VoicePanelProps {
  onClose: () => void;
  onStopTTS: () => void;
  onPauseTTS: () => void;
  onResumeTTS: () => void;
  onPlayLast: () => void;
  onToggleMic: () => void;
  isListening: boolean;
  onSendText?: (text: string) => void;
  onReset: () => void;
}

export function VoicePanel({
  onClose,
  onStopTTS,
  onPauseTTS,
  onResumeTTS,
  onPlayLast,
  onToggleMic,
  isListening,
  onSendText,
  onReset,
}: VoicePanelProps) {
  const { settings, updateSetting } = useSetting();
  const { status: agentStatus } = useStore();
  const {
    avatarState,
    isMuted,
    toggleMuted,
    history,
    liveTranscript,
    selectedLanguage,
    selectedVoiceURI,
    availableVoices,
    setLanguage,
    setVoice,
    currentTaskId,
    inputMode,
    voiceWakeupMode,
    voiceWakePhrase,
    setWakeupMode,
    setWakePhrase,
    volume,
    setVolume,
    isPaused,
    textInput,
    setTextInput,
  } = useVoiceStore();

  const scrollRef = useRef<HTMLDivElement>(null);
  const [taskKB, setTaskKB] = useState<any>(null);
  const [taskExpanded, setTaskExpanded] = useState(false);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [history.length, liveTranscript]);

  // Load task KB when currentTaskId changes and poll every 2 seconds
  useEffect(() => {
    if (!currentTaskId) {
      setTaskKB(null);
      return;
    }
    const fetchKB = () => {
      api.getTaskKnowledge({ taskId: currentTaskId })
        .then((kb) => setTaskKB(kb))
        .catch(() => {});
    };
    fetchKB();
    const timer = setInterval(fetchKB, 2000);
    return () => clearInterval(timer);
  }, [currentTaskId]);

  // Get available voices for selected language
  const langVoices = availableVoices.filter(
    (v) => v.lang.startsWith(selectedLanguage.split('-')[0]),
  );

  const handleTextSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!textInput.trim() || avatarState === 'thinking') return;
    onSendText?.(textInput.trim());
    setTextInput('');
  };

  const stateBadgeClass = `voice-state-badge ${avatarState}`;

  // Determine badge label based on state
  const stateBadgeLabel = () => {
    if (avatarState === 'executing') return '⚡ EXECUTING';
    if (inputMode === 'text') return 'TEXT CHAT';
    if (avatarState === 'listening') return '🎙️ LISTENING';
    if (avatarState === 'thinking') return '🧠 THINKING';
    if (avatarState === 'speaking') return '🔊 SPEAKING';
    return 'NOT LISTENING';
  };

  return (
    <div className="voice-panel">
      {/* Header */}
      <div className="voice-panel-header">
        <RobotAvatar state={avatarState} size={28} />
        <span className="voice-panel-title">HI-Bee</span>
        <span className={stateBadgeClass}>
          {stateBadgeLabel()}
        </span>
        <button
          className="voice-ctrl-btn hover:text-indigo-400 hover:border-indigo-400/40"
          onClick={() => window.electron.ipcRenderer.invoke('hibee-agent:toggle').catch(() => {})}
          title="Open Hi-Bee AI Agent Chat (Ctrl+Shift+H)"
          style={{ marginRight: 4 }}
        >
          <Bot size={12} strokeWidth={1.5} />
        </button>
        <button
          className="voice-ctrl-btn hover:text-indigo-400 hover:border-indigo-400/40"
          onClick={() => window.electron.ipcRenderer.invoke('voice:open-settings').catch(() => {})}
          title="Open Settings Configuration"
          style={{ marginRight: 4 }}
        >
          <Settings size={12} strokeWidth={1.5} />
        </button>
        <button
          className="voice-ctrl-btn hover:text-red-500 hover:border-red-500/40"
          onClick={() => updateSetting({ ...settings, voiceEnabled: false })}
          title="Turn off Voice Agent completely"
          style={{ marginRight: 6 }}
        >
          <Power size={12} strokeWidth={1.5} />
        </button>
        <button className="voice-ctrl-btn" onClick={onClose} title="Minimize to orb">
          <X size={12} strokeWidth={1.5} />
        </button>
      </div>

      {/* Conversation history */}
      <div className="voice-transcript" ref={scrollRef}>
        {history.length === 0 && (
          <div className="voice-empty-placeholder">
            {inputMode === 'text' ? 'Type a message to start chatting…' : 'Say something to start a conversation…'}
          </div>
        )}
        {history.map((turn) => (
          <div key={turn.id} className={`voice-turn ${turn.role === 'user' ? 'user' : 'assistant'}`}>
            <div>{turn.text}</div>
            {turn.latencyMs && turn.role === 'assistant' && (
              <div style={{ fontSize: '9px', color: '#475569', marginTop: 2 }}>
                ⚡ {turn.latencyMs}ms
              </div>
            )}
            {turn.citations && turn.citations.length > 0 && (
              <div style={{ marginTop: 6 }}>
                {turn.citations.map((c, i) => (
                  <a
                    key={i}
                    href={c.url}
                    target="_blank"
                    rel="noreferrer"
                    className="voice-citation-chip"
                    onClick={(e) => { e.preventDefault(); window.open(c.url, '_blank'); }}
                  >
                    <ExternalLink size={8} strokeWidth={1.5} />
                    {c.title.slice(0, 32)}{c.title.length > 32 ? '…' : ''}
                  </a>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Live transcript bar */}
      {liveTranscript && (
        <div className="voice-live-bar" style={{ margin: '0 12px 4px 12px', fontSize: '11px', color: '#a78bfa', background: 'rgba(167,139,250,0.05)', padding: '4px 8px', borderRadius: '4px' }}>
          🎙 {liveTranscript}
        </div>
      )}

      {/* Unified Text & Mic Input Container */}
      <form onSubmit={handleTextSubmit} className="voice-text-form-container" style={{ margin: '8px 12px', display: 'flex', gap: '8px', background: 'rgba(15, 23, 42, 0.04)', padding: '6px', borderRadius: '8px', border: '1px solid rgba(15, 23, 42, 0.08)' }}>
        <input
          type="text"
          className="voice-text-input-field"
          value={textInput}
          onChange={(e) => setTextInput(e.target.value)}
          placeholder={isListening ? "🎙️ Recording... Speak now..." : "Type or speak to Hi-Bee..."}
          disabled={avatarState === 'thinking'}
          style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: '#0f172a', fontSize: '13px', padding: '0 8px' }}
        />
        
        {/* Traditional Mic Button */}
        <button
          type="button"
          className={`voice-text-send-btn ${isListening ? 'listening-pulse active' : ''}`}
          onClick={onToggleMic}
          title={isListening ? 'Stop recording & transcribe' : 'Start recording'}
          style={{
            background: isListening ? '#ef4444' : 'rgba(255,255,255,0.08)',
            color: '#fff',
            border: '1px solid',
            borderColor: isListening ? '#dc2626' : 'rgba(255,255,255,0.1)',
            padding: '8px',
            borderRadius: '6px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            transition: 'all 0.2s'
          }}
        >
          {isListening ? <Square size={12} strokeWidth={1.5} fill="currentColor" /> : <Mic size={12} strokeWidth={1.5} />}
        </button>

        {/* Send Button */}
        <button
          type="submit"
          className="voice-text-send-btn"
          disabled={!textInput.trim() || avatarState === 'thinking' || isListening}
          title="Send message (Enter)"
          style={{
            background: 'rgba(99,102,241,0.2)',
            color: '#c7d2fe',
            border: '1px solid rgba(99,102,241,0.3)',
            padding: '8px',
            borderRadius: '6px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            opacity: (!textInput.trim() || avatarState === 'thinking' || isListening) ? 0.4 : 1,
            transition: 'all 0.2s'
          }}
        >
          <Send size={12} strokeWidth={1.5} />
        </button>
      </form>

      {/* Footer / Controls Section */}
      <div className="voice-footer">
        {/* Dropdowns Row (Language and Voice Accent selectors) */}
        <div className="voice-settings-row">
          <select
            className="voice-lang-select"
            value={selectedLanguage}
            onChange={(e) => {
              const lang = e.target.value;
              setLanguage(lang);
              // Persist to settings so it survives app restart
              updateSetting({ ...settings, voiceLanguage: lang });
            }}
            title="Select Language"
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>{l.label}</option>
            ))}
          </select>

          {langVoices.length > 1 && (
            <select
              className="voice-lang-select voice-accent-select"
              value={selectedVoiceURI}
              onChange={(e) => setVoice(e.target.value)}
              title="Select Voice/Accent"
            >
              <option value="">Default Accent</option>
              {langVoices.map((v) => (
                <option key={v.voiceURI} value={v.voiceURI}>
                  {v.name.replace(/(Google |Microsoft )/g, '').slice(0, 20)}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Wakeup Mode and Wake Phrase Settings Row */}
        <div className="voice-settings-row">
          <select
            className="voice-lang-select"
            value={voiceWakeupMode}
            onChange={(e) => {
              const val = e.target.value as 'hotkey' | 'phrase' | 'live_agent';
              setWakeupMode(val);
              updateSetting({ ...settings, voiceWakeupMode: val });
            }}
            title="Select Wake Mode"
          >
            <option value="hotkey">🔑 Hotkey Mode</option>
            <option value="phrase">🗣️ Wake Word</option>
            <option value="live_agent">🤖 Live Agent</option>
          </select>

          {voiceWakeupMode === 'phrase' && (
            <input
              type="text"
              className="voice-lang-select voice-accent-select"
              style={{ padding: '0 8px', fontSize: '11px', height: '32px' }}
              value={voiceWakePhrase}
              onChange={(e) => {
                const val = e.target.value;
                setWakePhrase(val);
                updateSetting({ ...settings, voiceWakePhrase: val });
              }}
              placeholder="Wake Phrase"
              title="Wake Phrase"
            />
          )}
        </div>

        {/* Actions/Controls Row */}
        <div className="voice-controls-row">
          {/* Start/Stop Mic Button */}
          <button
            type="button"
            className={`voice-ctrl-btn ${isListening ? 'active' : ''}`}
            onClick={onToggleMic}
            title={isListening ? 'Stop Listening' : 'Start Listening'}
            style={{
              color: isListening ? '#ef4444' : undefined,
              borderColor: isListening ? '#dc2626' : undefined,
              background: isListening ? 'rgba(239, 68, 68, 0.15)' : undefined,
            }}
          >
            {isListening ? <Mic size={16} strokeWidth={1.5} className="listening-pulse" /> : <MicOff size={16} strokeWidth={1.5} />}
          </button>

          {/* Mute toggle */}
          <button
            className={`voice-ctrl-btn ${isMuted ? 'active' : ''}`}
            onClick={toggleMuted}
            title={isMuted ? 'Unmute Voice output' : 'Mute Voice output'}
          >
            {isMuted ? <VolumeX size={16} strokeWidth={1.5} /> : <Volume2 size={16} strokeWidth={1.5} />}
          </button>

          {/* Reset Memory / Clear Memory Button */}
          <button
            type="button"
            className="voice-ctrl-btn"
            style={{ color: '#d97706', borderColor: '#fde047' }}
            onClick={onReset}
            title="Reset/Clear memory and start fresh"
          >
            <RotateCcw size={16} strokeWidth={1.5} />
          </button>

          {/* TTS Play/Pause controls */}
          {(avatarState === 'speaking' || isPaused || history.some((t) => t.role === 'assistant')) && (
            <div className="flex items-center gap-1 border-l border-white/10 pl-2 ml-1">
              {avatarState === 'speaking' ? (
                <button
                  className="voice-ctrl-btn"
                  onClick={onPauseTTS}
                  title="Pause response"
                >
                  <Pause size={16} strokeWidth={1.5} />
                </button>
              ) : (
                <button
                  className="voice-ctrl-btn"
                  onClick={isPaused ? onResumeTTS : onPlayLast}
                  title={isPaused ? "Resume response" : "Replay last response"}
                >
                  <Play size={16} strokeWidth={1.5} />
                </button>
              )}

              {(avatarState === 'speaking' || isPaused) && (
                <button
                  className="voice-ctrl-btn"
                  onClick={onStopTTS}
                  title="Stop speaking"
                >
                  <Square size={12} strokeWidth={1.5} fill="currentColor" style={{ transform: 'scale(0.8)' }} />
                </button>
              )}
            </div>
          )}

          {/* Volume slider control */}
          <div className="flex items-center gap-2 border-l border-white/10 pl-2 ml-1 bg-white/5 rounded-full px-2 py-0.5" style={{ height: '32px' }}>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={isMuted ? 0 : volume}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                setVolume(val);
                if (isMuted && val > 0) toggleMuted();
              }}
              className="voice-volume-slider"
              title={`Volume: ${Math.round((isMuted ? 0 : volume) * 100)}%`}
            />
          </div>

          {/* Stop Agent Task button (Stop/Abort execution) */}
          {(agentStatus === StatusEnum.RUNNING || avatarState === 'executing' || avatarState === 'thinking' || avatarState === 'speaking') && (
            <button
              className="voice-ctrl-btn active stop-task-btn"
              style={{ background: '#fee2e2', borderColor: '#fca5a5', color: '#ef4444' }}
              onClick={async () => {
                await api.stopRun();
                onStopTTS();
              }}
              title="Stop Agent Task"
            >
              <Square size={16} strokeWidth={1.5} fill="currentColor" />
            </button>
          )}
        </div>
      </div>

      {/* Task Knowledge Base */}
      {taskKB && (
        <div className="voice-task-kb">
          <div
            className="voice-task-kb-title"
            style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
            onClick={() => setTaskExpanded((v) => !v)}
          >
            Task: {taskKB.taskTitle}
            {taskExpanded ? <ChevronUp size={10} strokeWidth={1.5} /> : <ChevronDown size={10} strokeWidth={1.5} />}
          </div>
          {taskExpanded && taskKB.steps.map((step: any) => (
            <div key={step.stepNumber} className="voice-task-step">
              <span className={`voice-task-step-num ${step.status}`}>{step.stepNumber}</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {step.description}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
