/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { z } from 'zod';

import { SearchEngineForSettings, VLMProviderV2, Operator } from './types';

const PresetSourceSchema = z.object({
  type: z.enum(['local', 'remote']),
  url: z.string().url().optional(),
  autoUpdate: z.boolean().optional(),
  lastUpdated: z.number().optional(),
});

export const PresetSchema = z.object({
  // ── Local VLM Settings (OpenAI-compatible providers) ─────────────────────
  vlmProvider: z.nativeEnum(VLMProviderV2).optional(),
  /** Required for non-Vertex providers; optional when using Vertex AI */
  vlmBaseUrl: z.union([z.string().url(), z.literal('')]).optional(),
  /** Required for non-Vertex providers; optional when using Vertex AI */
  vlmApiKey: z.string().optional(),
  vlmModelName: z.string().optional(),
  useResponsesApi: z.boolean().optional(),

  // ── Google Vertex AI Gemini Settings ─────────────────────────────────────
  /** GCP project ID, e.g. "my-project-123" */
  vertexProjectId: z.string().optional(),
  /** Vertex AI region, e.g. "us-central1" */
  vertexLocation: z.string().optional(),
  /**
   * Gemini VLM model name (for GUI automation).
   * e.g. "gemini-2.5-flash-preview-05-20" | "gemini-2.5-pro"
   */
  vertexModelName: z.string().optional(),
  /**
   * Gemini chat model name (for voice/conversational agent).
   * e.g. "gemini-2.5-flash-preview-05-20"
   */
  vertexChatModelName: z.string().optional(),
  /**
   * Absolute path to a service-account JSON key file.
   * Leave blank to use GOOGLE_APPLICATION_CREDENTIALS env var or ADC.
   */
  vertexServiceAccountPath: z.string().optional(),
  /** Enable streaming response for lower first-token latency */
  enableStreamingResponse: z.boolean().optional(),
  /** Google API Source: "direct" or "agent_builder" */
  googleApiSource: z.enum(['direct', 'agent_builder']).optional(),

  // ── Chat / Execution Settings ─────────────────────────────────────────────
  operator: z.nativeEnum(Operator),
  language: z.enum(['zh', 'en']).optional(),
  screenshotScale: z.number().min(0.1).max(1).optional(),
  maxLoopCount: z.number().min(25).max(200).optional(),
  loopIntervalInMs: z.number().min(0).max(3000).optional(),
  searchEngineForBrowser: z.nativeEnum(SearchEngineForSettings).optional(),

  // ── Report Settings ───────────────────────────────────────────────────────
  reportStorageBaseUrl: z.string().url().optional(),
  utioBaseUrl: z.string().url().optional(),
  presetSource: PresetSourceSchema.optional(),

  // ── Voice Agent Settings ──────────────────────────────────────────────────
  voiceEnabled: z.boolean().optional(),          // show/enable voice avatar
  voiceAutoStart: z.boolean().optional(),        // auto-start listening on launch
  voiceLanguage: z.string().optional(),          // BCP-47 e.g. 'en-US', 'hi-IN'
  voiceAccent: z.string().optional(),            // SpeechSynthesis voice URI (new key)
  voiceAccentUri: z.string().optional(),         // SpeechSynthesis voice URI
  voiceSilenceMs: z.number().min(300).max(5000).optional(), // silence threshold
  voiceHotkey: z.string().optional(),            // display string e.g. 'Ctrl+Shift+V'
  micPermissionGranted: z.boolean().optional(),
  // Wake-up mode
  voiceWakeupMode: z.enum(['hotkey', 'phrase', 'live_agent']).optional(),
  voiceWakePhrase: z.string().optional(),        // phrase to activate e.g. 'hey hibee'
  voiceTtsBackend: z.enum(['browser', 'gcp']).optional(), // TTS engine
});

export type PresetSource = z.infer<typeof PresetSourceSchema>;
export type LocalStore = z.infer<typeof PresetSchema>;

export const validatePreset = (data: unknown): LocalStore => {
  return PresetSchema.parse(data);
};
