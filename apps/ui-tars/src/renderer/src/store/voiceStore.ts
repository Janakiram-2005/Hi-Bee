/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Zustand voice store — all renderer-side voice state lives here.
 * Extended in vNext with agentStatus fields for live Hi-Bee status banner.
 */
import { create } from 'zustand';

export type AvatarState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'executing' | 'confirming';

export interface Citation {
  title: string;
  url: string;
}

export interface VoiceTurn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
  citations?: Citation[];
  latencyMs?: number;
}

// ─── Agent Status Mapping ─────────────────────────────────────────────────────

export interface AgentStatusInfo {
  label: string;
  icon: string;
  color: string;
  bgColor: string;
  animation: 'scan' | 'click' | 'type' | 'pulse' | 'spin' | 'none';
}

export function mapActionToStatus(action: string | null, errorMsg?: string | null): AgentStatusInfo {
  if (errorMsg) {
    return { label: 'Error occurred', icon: '⚠️', color: '#ef4444', bgColor: 'rgba(239,68,68,0.12)', animation: 'none' };
  }
  if (!action) {
    return { label: 'Thinking…', icon: '🧠', color: '#f97316', bgColor: 'rgba(249,115,22,0.12)', animation: 'spin' };
  }
  const type = action.split('(')[0].trim().toLowerCase();
  const args = action.toLowerCase();
  switch (type) {
    case 'click':
    case 'left_double':
    case 'right_single':
      return { label: 'Clicking…', icon: '🖱️', color: '#a78bfa', bgColor: 'rgba(167,139,250,0.12)', animation: 'click' };
    case 'type':
      return { label: 'Typing…', icon: '⌨️', color: '#f59e0b', bgColor: 'rgba(245,158,11,0.12)', animation: 'type' };
    case 'hotkey':
      return { label: 'Shortcut…', icon: '⌨️', color: '#f59e0b', bgColor: 'rgba(245,158,11,0.12)', animation: 'type' };
    case 'scroll':
      return { label: 'Navigating…', icon: '🧭', color: '#14b8a6', bgColor: 'rgba(20,184,166,0.12)', animation: 'pulse' };
    case 'drag':
      return { label: 'Dragging…', icon: '↔️', color: '#60a5fa', bgColor: 'rgba(96,165,250,0.12)', animation: 'pulse' };
    case 'screenshot':
      return { label: 'Scanning…', icon: '🔍', color: '#38bdf8', bgColor: 'rgba(56,189,248,0.12)', animation: 'scan' };
    case 'wait':
      return { label: 'Just a moment…', icon: '⏳', color: '#94a3b8', bgColor: 'rgba(148,163,184,0.12)', animation: 'none' };
    case 'finished':
      return { label: 'Done ✓', icon: '✅', color: '#22c55e', bgColor: 'rgba(34,197,94,0.12)', animation: 'none' };
    case 'call_user':
      return { label: 'Please wait…', icon: '🙏', color: '#eab308', bgColor: 'rgba(234,179,8,0.12)', animation: 'pulse' };
    default:
      if (args.includes('search') || args.includes('google') || args.includes('bing')) {
        return { label: 'Searching…', icon: '🔎', color: '#818cf8', bgColor: 'rgba(129,140,248,0.12)', animation: 'scan' };
      }
      if (args.includes('navig') || args.includes('open') || args.includes('launch')) {
        return { label: 'Navigating…', icon: '🧭', color: '#14b8a6', bgColor: 'rgba(20,184,166,0.12)', animation: 'pulse' };
      }
      return { label: 'Executing…', icon: '⚙️', color: '#6366f1', bgColor: 'rgba(99,102,241,0.12)', animation: 'pulse' };
  }
}

// ─── Store Interface ──────────────────────────────────────────────────────────

interface VoiceStore {
  // ── State
  avatarState: AvatarState;
  isExpanded: boolean;
  isMuted: boolean;
  liveTranscript: string;          // interim (real-time) transcript
  history: VoiceTurn[];            // rendered conversation history
  selectedLanguage: string;        // BCP-47
  selectedVoiceURI: string;        // SpeechSynthesis voice URI
  availableVoices: SpeechSynthesisVoice[];
  currentTaskId: string | null;    // linked task KB
  inputMode: 'audio' | 'text';     // input mode (voice or typed text)
  // Wake-up mode
  voiceWakeupMode: 'hotkey' | 'phrase' | 'live_agent';
  voiceWakePhrase: string;
  // Live preview
  liveScreenshot: string | null;   // base64 screenshot from agent execution
  pendingConfirmText: string | null; // text read out for 'confirming' state
  volume: number;
  isPaused: boolean;
  textInput: string;
  runInBackground: boolean;

  // ── ElevenLabs TTS Settings
  hibeeSelectedVoice: string;
  hibeeVoiceSpeed: number;
  hibeeAutoSpeak: boolean;

  // ── Agent Status (shared with Hi-Bee Live View)
  agentAction: string | null;      // raw action string e.g. "click(x=450, y=320)"
  agentStatusLabel: string | null; // human label e.g. "Clicking…"
  agentStep: number;               // current step number
  agentRunning: boolean;           // is agent currently running?

  // ── Actions
  setAvatarState: (s: AvatarState) => void;
  setExpanded: (v: boolean) => void;
  toggleExpanded: () => void;
  setMuted: (v: boolean) => void;
  toggleMuted: () => void;
  addTurn: (turn: VoiceTurn) => void;
  clearHistory: () => void;
  setLiveTranscript: (t: string) => void;
  setLanguage: (lang: string) => void;
  setVoice: (uri: string) => void;
  setAvailableVoices: (v: SpeechSynthesisVoice[]) => void;
  setCurrentTask: (id: string | null) => void;
  setInputMode: (m: 'audio' | 'text') => void;
  setAgentStatus: (action: string | null, step: number, running: boolean) => void;
  clearAgentStatus: () => void;
  setWakeupMode: (mode: 'hotkey' | 'phrase' | 'live_agent') => void;
  setWakePhrase: (phrase: string) => void;
  setLiveScreenshot: (b64: string | null) => void;
  setPendingConfirmText: (text: string | null) => void;
  setVolume: (v: number) => void;
  setIsPaused: (p: boolean) => void;
  setTextInput: (text: string) => void;
  setRunInBackground: (v: boolean) => void;

  setHibeeSelectedVoice: (id: string) => void;
  setHibeeVoiceSpeed: (speed: number) => void;
  setHibeeAutoSpeak: (auto: boolean) => void;
}

export const useVoiceStore = create<VoiceStore>((set) => ({
  avatarState: 'idle',
  isExpanded: false,
  isMuted: false,
  liveTranscript: '',
  history: [],
  selectedLanguage: 'en-US',
  selectedVoiceURI: '',
  availableVoices: [],
  currentTaskId: null,
  inputMode: 'audio',
  voiceWakeupMode: 'hotkey',
  voiceWakePhrase: 'hey hibee',
  liveScreenshot: null,
  pendingConfirmText: null,
  volume: 1.0,
  isPaused: false,
  textInput: '',
  runInBackground: false,

  // Read defaults from localStorage if available
  hibeeSelectedVoice: typeof localStorage !== 'undefined' ? localStorage.getItem('hibee_selected_voice') || 'Ek86tj0PS0XTYchY9Ody' : 'Ek86tj0PS0XTYchY9Ody',
  hibeeVoiceSpeed: typeof localStorage !== 'undefined' ? parseFloat(localStorage.getItem('hibee_voice_speed') || '1.0') : 1.0,
  hibeeAutoSpeak: typeof localStorage !== 'undefined' ? localStorage.getItem('hibee_auto_speak') !== 'false' : true,

  // Agent status defaults
  agentAction: null,
  agentStatusLabel: null,
  agentStep: 0,
  agentRunning: false,

  setAvatarState: (s) => set({ avatarState: s }),
  setExpanded: (v) => set({ isExpanded: v }),
  toggleExpanded: () => set((st) => ({ isExpanded: !st.isExpanded })),
  setMuted: (v) => set({ isMuted: v }),
  toggleMuted: () => set((st) => ({ isMuted: !st.isMuted })),
  addTurn: (turn) =>
    set((st) => ({
      history: [...st.history.slice(-99), turn], // keep last 100 turns
    })),
  clearHistory: () => set({ history: [] }),
  setLiveTranscript: (t) => set({ liveTranscript: t }),
  setLanguage: (lang) => set({ selectedLanguage: lang }),
  setVoice: (uri) => set({ selectedVoiceURI: uri }),
  setAvailableVoices: (v) => set({ availableVoices: v }),
  setCurrentTask: (id) => set({ currentTaskId: id }),
  setInputMode: (m) => set({ inputMode: m }),
  setAgentStatus: (action, step, running) =>
    set({ agentAction: action, agentStatusLabel: action, agentStep: step, agentRunning: running }),
  clearAgentStatus: () =>
    set({ agentAction: null, agentStatusLabel: null, agentStep: 0, agentRunning: false }),
  setWakeupMode: (mode) => set({ voiceWakeupMode: mode }),
  setWakePhrase: (phrase) => set({ voiceWakePhrase: phrase }),
  setLiveScreenshot: (b64) => set({ liveScreenshot: b64 }),
  setPendingConfirmText: (text) => set({ pendingConfirmText: text }),
  setVolume: (v) => set({ volume: v }),
  setIsPaused: (p) => set({ isPaused: p }),
  setTextInput: (text) => set({ textInput: text }),
  setRunInBackground: (v) => set({ runInBackground: v }),

  setHibeeSelectedVoice: (id) => {
    if (typeof localStorage !== 'undefined') localStorage.setItem('hibee_selected_voice', id);
    set({ hibeeSelectedVoice: id });
  },
  setHibeeVoiceSpeed: (speed) => {
    if (typeof localStorage !== 'undefined') localStorage.setItem('hibee_voice_speed', speed.toString());
    set({ hibeeVoiceSpeed: speed });
  },
  setHibeeAutoSpeak: (auto) => {
    if (typeof localStorage !== 'undefined') localStorage.setItem('hibee_auto_speak', auto.toString());
    set({ hibeeAutoSpeak: auto });
  },
}));
