/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Voice Settings tab — language, accent, silence threshold, and auto-start toggle.
 */
import { useEffect, useState } from 'react';
import { Mic, Globe, Volume2, Keyboard, Zap, Radio, Activity } from 'lucide-react';
import { Switch } from '@renderer/components/ui/switch';
import { Label } from '@renderer/components/ui/label';
import { Slider } from '@renderer/components/ui/slider';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select';
import { Input } from '@renderer/components/ui/input';
import { useVoiceStore } from '@renderer/store/voiceStore';

const LANGUAGES = [
  { code: 'en-US', label: '🇺🇸 English (US)' },
  { code: 'en-GB', label: '🇬🇧 English (UK)' },
  { code: 'en-AU', label: '🇦🇺 English (AU)' },
  { code: 'en-IN', label: '🇮🇳 English (India)' },
  { code: 'hi-IN', label: '🇮🇳 Hindi' },
  { code: 'te-IN', label: '🇮🇳 Telugu' },
  { code: 'ta-IN', label: '🇮🇳 Tamil' },
  { code: 'kn-IN', label: '🇮🇳 Kannada' },
  { code: 'ml-IN', label: '🇮🇳 Malayalam' },
  { code: 'zh-CN', label: '🇨🇳 Chinese (Simplified)' },
  { code: 'zh-TW', label: '🇹🇼 Chinese (Traditional)' },
  { code: 'ja-JP', label: '🇯🇵 Japanese' },
  { code: 'ko-KR', label: '🇰🇷 Korean' },
  { code: 'es-ES', label: '🇪🇸 Spanish (Spain)' },
  { code: 'es-MX', label: '🇲🇽 Spanish (Mexico)' },
  { code: 'fr-FR', label: '🇫🇷 French' },
  { code: 'de-DE', label: '🇩🇪 German' },
  { code: 'pt-BR', label: '🇧🇷 Portuguese (Brazil)' },
  { code: 'ar-SA', label: '🇸🇦 Arabic' },
  { code: 'ru-RU', label: '🇷🇺 Russian' },
  { code: 'tr-TR', label: '🇹🇷 Turkish' },
  { code: 'it-IT', label: '🇮🇹 Italian' },
];

export function VoiceSettings() {
  const {
    selectedLanguage, setLanguage,
    selectedVoiceURI, setVoice,
    availableVoices,
    voiceWakeupMode, setWakeupMode,
    setWakePhrase,
    hibeeSelectedVoice, setHibeeSelectedVoice,
    hibeeVoiceSpeed, setHibeeVoiceSpeed,
    hibeeAutoSpeak, setHibeeAutoSpeak,
  } = useVoiceStore();

  const ELEVENLABS_VOICES = [
    { name: "Keshavi", description: "Friendly Female", voice_id: "Ek86tj0PS0XTYchY9Ody" },
    { name: "Anika", description: "Professional Female", voice_id: "jUjRbhZWoMK4aDciW36V" },
    { name: "Viraj", description: "Energetic Male", voice_id: "iWNf11sz1GrUE4ppxTOL" },
    { name: "Amit Gupta", description: "Professional Male", voice_id: "WuePGPKIAIKI8COZpzce" },
    { name: "Muskaan", description: "Calm Female", voice_id: "xoV6iGVuOGYHLWjXhVC7" }
  ];

  const [silenceMs, setSilenceMs] = useState(1500);
  const [autoStart, setAutoStart] = useState(false);
  const [hotkeyLabel, setHotkeyLabel] = useState('Ctrl+Shift+V');
  const [wakePhrase, setLocalWakePhrase] = useState('hey hibee');
  const [useTeluguVoice, setUseTeluguVoice] = useState(false);

  // Load settings from electron-store
  useEffect(() => {
    const settingRpc = window.electron?.setting;
    if (!settingRpc) return;
    settingRpc.getSetting().then((s: any) => {
      if (s?.voiceLanguage) setLanguage(s.voiceLanguage);
      if (s?.voiceAccentUri || s?.voiceAccent) setVoice(s.voiceAccentUri || s.voiceAccent);
      if (s?.voiceSilenceMs) setSilenceMs(s.voiceSilenceMs);
      if (typeof s?.voiceAutoStart === 'boolean') setAutoStart(s.voiceAutoStart);
      if (typeof s?.voiceHotkey === 'string' && s.voiceHotkey.trim()) setHotkeyLabel(s.voiceHotkey);
      if (s?.voiceWakeupMode) setWakeupMode(s.voiceWakeupMode);
      if (s?.voiceWakePhrase) { setWakePhrase(s.voiceWakePhrase); setLocalWakePhrase(s.voiceWakePhrase); }
      if (typeof s?.useTeluguVoice === 'boolean') setUseTeluguVoice(s.useTeluguVoice);
    }).catch(() => {});
  }, [setLanguage, setVoice, setWakeupMode, setWakePhrase]);

  const save = (updates: Record<string, any>) => {
    const settingRpc = window.electron?.setting;
    if (!settingRpc) return;
    settingRpc.updateSetting(updates).catch(() => {});
  };

  // Voices for current language
  const prefix = selectedLanguage.split('-')[0];
  const langVoices = availableVoices.filter((v) => v.lang.startsWith(prefix));

  const handleLanguageChange = (val: string) => {
    setLanguage(val);
    save({ voiceLanguage: val });
  };

  const handleVoiceChange = (uri: string) => {
    setVoice(uri);
    save({ voiceAccent: uri, voiceAccentUri: uri });
  };

  const handleSilenceChange = (val: number[]) => {
    setSilenceMs(val[0]);
    save({ voiceSilenceMs: val[0] });
  };

  const handleAutoStart = (val: boolean) => {
    setAutoStart(val);
    save({ voiceAutoStart: val });
  };

  const handleWakeupModeChange = (mode: 'hotkey' | 'phrase' | 'live_agent') => {
    setWakeupMode(mode);
    save({ voiceWakeupMode: mode });
  };

  const handleWakePhraseBlur = () => {
    setWakePhrase(wakePhrase);
    save({ voiceWakePhrase: wakePhrase });
  };

  return (
    <div className="space-y-6 pb-4">
      {/* Auto-start */}
      <div className="flex items-start justify-between gap-4 p-4 rounded-lg border border-border bg-muted/20">
        <div className="flex gap-3">
          <Zap className="h-5 w-5 text-violet-500 mt-0.5" />
          <div>
            <Label className="text-sm font-medium">Auto-start Listening</Label>
            <p className="text-xs text-muted-foreground mt-1">
              Automatically begin listening when the app launches.
              When off, use <kbd className="px-1.5 py-0.5 rounded text-xs bg-muted border border-border font-mono">{hotkeyLabel}</kbd> to toggle.
            </p>
          </div>
        </div>
        <Switch checked={autoStart} onCheckedChange={handleAutoStart} />
      </div>

      {/* Global hotkey info */}
      <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/30 border border-border">
        <Keyboard className="h-4 w-4 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          <strong>Global Hotkey:</strong> Press{' '}
          <kbd className="px-1.5 py-0.5 rounded text-xs bg-background border border-border font-mono">{hotkeyLabel}</kbd>{' '}
          anywhere on your computer to toggle HI-Bee.
        </p>
      </div>


      {/* Language */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-muted-foreground" />
          <Label className="text-sm font-medium">Recognition & Response Language</Label>
        </div>
        <Select value={selectedLanguage} onValueChange={handleLanguageChange}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select language" />
          </SelectTrigger>
          <SelectContent>
            {LANGUAGES.map((l) => (
              <SelectItem key={l.code} value={l.code}>{l.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Both speech recognition and TTS will use this language.
        </p>
      </div>

      {/* ── Primary Voice Settings ── */}
      <div className="space-y-4 pt-4 border-t border-border">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Volume2 className="h-4 w-4 text-violet-500" />
          Primary Voice Settings
        </h3>

        {/* Voice Selection */}
        <div className="space-y-2">
          <Label className="text-sm font-medium">Primary Voice</Label>
          <Select value={hibeeSelectedVoice} onValueChange={setHibeeSelectedVoice}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select a voice" />
            </SelectTrigger>
            <SelectContent>
              {ELEVENLABS_VOICES.map((v) => (
                <SelectItem key={v.voice_id} value={v.voice_id}>
                  {v.name} ({v.description})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            High-fidelity multilingual AI voices powered by ElevenLabs.
          </p>
        </div>

        {/* Voice Speed */}
        <div className="space-y-2">
          <Label className="text-sm font-medium">Voice Speed</Label>
          <Select value={hibeeVoiceSpeed.toString()} onValueChange={(val) => setHibeeVoiceSpeed(parseFloat(val))}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select speed" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0.75">0.75x (Slow)</SelectItem>
              <SelectItem value="1">1.0x (Normal)</SelectItem>
              <SelectItem value="1.25">1.25x (Fast)</SelectItem>
              <SelectItem value="1.5">1.5x (Very Fast)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Auto Speak Toggle */}
        <div className="flex items-start justify-between gap-4 p-4 rounded-lg border border-border bg-muted/20">
          <div className="flex gap-3">
            <Volume2 className="h-5 w-5 text-violet-500 mt-0.5" />
            <div>
              <Label className="text-sm font-medium">Auto Speak Responses</Label>
              <p className="text-xs text-muted-foreground mt-1">
                Automatically play the audio response when Hi-Bee replies.
              </p>
            </div>
          </div>
          <Switch checked={hibeeAutoSpeak} onCheckedChange={setHibeeAutoSpeak} />
        </div>
      </div>

      {/* Silence threshold */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Mic className="h-4 w-4 text-muted-foreground" />
          <Label className="text-sm font-medium">
            Silence Detection Threshold:{' '}
            <span className="text-violet-600 font-semibold">{silenceMs}ms</span>
          </Label>
        </div>
        <Slider
          value={[silenceMs]}
          min={500}
          max={4000}
          step={100}
          onValueChange={handleSilenceChange}
          className="w-full"
        />
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>500ms (Very fast)</span>
          <span>4000ms (Very slow)</span>
        </div>
        <p className="text-xs text-muted-foreground">
          How long the agent waits after you stop speaking before processing your request.
          Lower = faster but may cut off mid-sentence.
        </p>
      </div>

      {/* Wake-up Mode */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Radio className="h-4 w-4 text-muted-foreground" />
          <Label className="text-sm font-medium">Wake-up Mode</Label>
        </div>
        <Select value={voiceWakeupMode} onValueChange={(v) => handleWakeupModeChange(v as any)}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select wake-up mode" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="hotkey">🎹 Hotkey ({hotkeyLabel})</SelectItem>
            <SelectItem value="phrase">🗣️ Wake Word (e.g. "Hey Hi-Bee")</SelectItem>
            <SelectItem value="live_agent">🔴 Live Agent (always listening)</SelectItem>
          </SelectContent>
        </Select>
        {voiceWakeupMode === 'phrase' && (
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Wake Phrase</Label>
            <Input
              value={wakePhrase}
              onChange={(e) => setLocalWakePhrase(e.target.value)}
              onBlur={handleWakePhraseBlur}
              placeholder="hey hibee"
              className="text-sm"
            />
            <p className="text-xs text-muted-foreground">Say this phrase to activate Hi-Bee.</p>
          </div>
        )}
        {voiceWakeupMode === 'live_agent' && (
          <div className="flex items-center gap-2 p-2 rounded bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
            <Activity className="h-4 w-4 text-amber-600 shrink-0" />
            <p className="text-xs text-amber-700 dark:text-amber-300">
              Hi-Bee listens continuously. After a 4-second speech gap, it will ask for your confirmation before executing.
            </p>
          </div>
        )}
      </div>

      {/* Info box */}
      <div className="p-3 rounded-lg bg-violet-50 dark:bg-violet-900/20 border border-violet-200 dark:border-violet-800">
        <p className="text-xs text-violet-700 dark:text-violet-300">
          <strong>STT:</strong> Google Cloud Speech-to-Text v1 (60 min/month free) ·{' '}
          <strong>TTS:</strong> ElevenLabs Multilingual v2 (Default) ·{' '}
          <strong>AI:</strong> Gemini Vertex (<code>convertionalai</code>).<br/>
          Voice history is saved to MongoDB Atlas for context.
        </p>
      </div>
    </div>
  );
}
