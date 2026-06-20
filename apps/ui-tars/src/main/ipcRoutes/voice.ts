/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Voice IPC routes — bridge between renderer voice hooks and main-process services.
 */
import { v4 as uuidv4 } from 'uuid';
import { globalShortcut } from 'electron';
import { initIpc } from '@ui-tars/electron-ipc/main';
import * as env from '@main/env';
import { logger } from '@main/logger';
import { mongoService } from '@main/services/mongoService';
import { vertexChat, VoiceChatHistory } from '@main/services/vertexAIService';
import { transcribeAudio } from '@main/services/cloudSTT';
import { TTSFactory } from '@main/services/tts/TTSFactory';
import { windowManager } from '@main/services/windowManager';
import { Operator } from '@main/store/types';
import { isStopVoiceCommand, stopActiveAgentRun } from '@main/services/stopAgentRun';
import { toggleHiBeeAgentWindow, getHiBeeAgentWindow } from '@main/window/hibeeAgentWindow';
import { SettingStore } from '@main/store/setting';

const t = initIpc.create();

// Session ID persists for the process lifetime
const SESSION_ID = uuidv4();

export const voiceRoute = t.router({
  // ── Cloud Speech-to-Text transcription (replaces Web Speech API) ───────
  transcribeAudio: t.procedure
    .input<{ audioBase64: string; mimeType: string; language: string }>()
    .handle(async ({ input }) => {
      const result = await transcribeAudio(input.audioBase64, input.language, input.mimeType);
      return result;
    }),

  // ── Cloud Text-to-Speech synthesis ──────────────────────────────────
  synthesizeSpeech: t.procedure
    .input<{ text: string; languageCode: string; ssml?: boolean; voiceId?: string; speed?: number }>()
    .handle(async ({ input }) => {
      // Pass the voice_id and speed parameters down to TTSFactory
      const result = await TTSFactory.synthesizeSpeech({
        text: input.text,
        languageCode: input.languageCode,
        voiceId: input.voiceId,
        speed: input.speed,
      });
      return result;
    }),

  // ── Generate task steps (goal-based JSON checklist) ─────────────────
  generateTaskSteps: t.procedure
    .input<{ instruction: string }>()
    .handle(async ({ input }) => {
      try {
        const prompt = [
          'You are a task planner. Break down this instruction into 3 to 5 concrete steps.',
          'Output ONLY a JSON array of objects with keys: stepNumber (1-indexed), description (short string).',
          'Example: [{"stepNumber":1,"description":"Open Chrome"}]',
          '',
          `Instruction: ${input.instruction}`,
        ].join('\n');

        const result = await vertexChat(prompt, [], 'en-US');
        const raw = result.text.trim();

        // Extract JSON array from response
        const jsonMatch = raw.match(/\[.*\]/s);
        if (!jsonMatch) return { steps: [] };

        const steps = JSON.parse(jsonMatch[0]) as Array<{
          stepNumber: number;
          description: string;
        }>;

        return {
          steps: steps.map((s) => ({
            stepNumber: s.stepNumber,
            description: s.description,
            status: 'pending' as const,
          })),
        };
      } catch (err) {
        logger.warn('[voiceRoute] generateTaskSteps failed:', err);
        return { steps: [] };
      }
    }),

  // ─── Log from renderer ─────────────────────────────────────────────────────
  logFromRenderer: t.procedure
    .input<{ message: string }>()
    .handle(async ({ input }) => {
      logger.info(`[Renderer Log] ${input.message}`);
      return { ok: true };
    }),

  // ─── Main chat endpoint ────────────────────────────────────────────────────
  voiceChat: t.procedure
    .input<{
      transcript: string;
      history: VoiceChatHistory[];
      language: string;
      taskId?: string | null;
      runInBackground?: boolean;
    }>()
    .handle(async ({ input }) => {
      const { transcript, history, language, taskId, runInBackground } = input;

      logger.info(`[voiceRoute] voiceChat — lang:${language}, transcript: "${transcript.slice(0, 80)}"`);

      if (isStopVoiceCommand(transcript)) {
        stopActiveAgentRun();
        // Localized stop acknowledgement
        let stopText = "I've stopped the current task.";
        if (language.startsWith('te-')) stopText = 'ప్రస్తుత పనిని ఆపాను.';
        else if (language.startsWith('hi-')) stopText = 'मैंने वर्तमान कार्य रोक दिया है।';
        else if (language.startsWith('ta-')) stopText = 'தற்போதைய பணியை நிறுத்திவிட்டேன்.';
        else if (language.startsWith('kn-')) stopText = 'ಚಾಲುತ್ತಿರುವ ಕೆಲಸವನ್ನು ನಿಲ್ಲಿಸಿದ್ದೇನೆ.';
        else if (language.startsWith('ml-')) stopText = 'നിലവിലെ ജോലി നിര്ത്തി.';
        else if (language.startsWith('bn-')) stopText = 'বর্তমান কাজ বন্ধ করেছি।';
        return {
          text: stopText,
          citations: [],
          error: false,
        };
      }

      // Call Vertex AI (never throws — returns fallback on error)
      const result = await vertexChat(transcript, history, language);

      let cleanText = result.text;
      const match = cleanText.match(/^\[TRIGGER_RUN:\s*([^\]]+)\]/i);
      if (match) {
        const instruction = match[1].trim();
        cleanText = cleanText.replace(/^\[TRIGGER_RUN:\s*[^\]]+\]/i, '').trim();
        logger.info(`[voiceRoute] Parsing TRIGGER_RUN instruction: "${instruction}"`);

        const { store } = await import('@main/store/create');
        const { runAgent } = await import('@main/services/runAgent');

        let canRun = true;
        if (env.isMacOS) {
          const { ensurePermissions } = await import('@main/utils/systemPermissions');
          const perms = ensurePermissions();
          store.setState({ ensurePermissions: perms });
          canRun = !!(perms.screenCapture && perms.accessibility);
          if (!canRun) {
            cleanText =
              (cleanText ? `${cleanText} ` : '') +
              'I need screen capture and accessibility permissions before I can control your desktop. Please grant them in System Settings, then try again.';
          }
        }

        if (canRun) {
          stopActiveAgentRun();

          store.setState({
            instructions: instruction,
            abortController: new AbortController(),
            thinking: true,
            errorMsg: null,
          });

          runAgent(store.setState, store.getState, Operator.LocalComputer, {
            background: runInBackground ?? false,
          })
            .then(() => {
              store.setState({ thinking: false });
            })
            .catch((err) => {
              logger.error('[voiceRoute] TRIGGER_RUN runAgent failed:', err);
              store.setState({ thinking: false });
            });
        }
      }

      // Persist to MongoDB (non-blocking, errors logged internally)
      if (mongoService.isConnected()) {
        mongoService.saveVoiceTurn({
          sessionId: SESSION_ID,
          timestamp: new Date(),
          language,
          userTranscript: transcript,
          aiResponse: cleanText,
          citations: result.citations,
          taskId: taskId ?? null,
        }).catch(() => {}); // already handles internally
      }

      return {
        text: cleanText,
        citations: result.citations,
        error: result.error ?? false,
      };
    }),

  // ─── Fetch recent voice history from MongoDB ───────────────────────────────
  getVoiceHistory: t.procedure
    .input<{ limit?: number }>()
    .handle(async ({ input }) => {
      if (!mongoService.isConnected()) return [];
      return mongoService.getRecentHistory(input.limit ?? 20);
    }),

  // ─── Task Knowledge Base — upsert full 10-step plan ───────────────────────
  saveTaskKnowledge: t.procedure
    .input<{
      taskId: string;
      taskTitle: string;
      steps: {
        stepNumber: number;
        description: string;
        status: 'pending' | 'in_progress' | 'done' | 'failed';
        result?: string | null;
      }[];
    }>()
    .handle(async ({ input }) => {
      if (!mongoService.isConnected()) return { ok: false };
      await mongoService.upsertTaskKnowledge({
        taskId: input.taskId,
        taskTitle: input.taskTitle,
        totalSteps: input.steps.length,
        steps: input.steps.map((s) => ({
          ...s,
          timestamp: null,
          result: s.result ?? null,
        })),
      });
      return { ok: true };
    }),

  // ─── Update a single task step ─────────────────────────────────────────────
  updateTaskStep: t.procedure
    .input<{
      taskId: string;
      stepNumber: number;
      status: 'pending' | 'in_progress' | 'done' | 'failed';
      result?: string;
    }>()
    .handle(async ({ input }) => {
      if (!mongoService.isConnected()) return { ok: false };
      await mongoService.updateTaskStep(input.taskId, input.stepNumber, {
        status: input.status,
        result: input.result,
        timestamp: new Date(),
      });
      return { ok: true };
    }),

  // ─── Get full task knowledge ───────────────────────────────────────────────
  getTaskKnowledge: t.procedure
    .input<{ taskId: string }>()
    .handle(async ({ input }) => {
      if (!mongoService.isConnected()) return null;
      return mongoService.getTaskKnowledge(input.taskId);
    }),

  // ─── List recent tasks ─────────────────────────────────────────────────────
  listRecentTasks: t.procedure
    .input<{ limit?: number }>()
    .handle(async ({ input }) => {
      if (!mongoService.isConnected()) return [];
      return mongoService.listRecentTasks(input.limit ?? 10);
    }),

  // ─── Get latest active agent state ─────────────────────────────────────────
  getLatestActiveAgentState: t.procedure
    .handle(async () => {
      if (!mongoService.isConnected()) return null;
      return mongoService.getLatestActiveAgentState();
    }),

  // ─── Live Agent Intent Check ──────────────────────────────────────────────
  checkLiveAgentIntent: t.procedure
    .input<{ transcript: string }>()
    .handle(async ({ input }) => {
      try {
        const prompt = [
          'You are a computer co-pilot gatekeeper.',
          'Analyze the following user speech transcript.',
          '1. If it is a direct request to perform an action on their computer (e.g. opening an app, clicking, searching), output ONLY a JSON object: {"actionable": true, "task": "short summary of the task in ENGLISH", "is_conversation": false}',
          '2. If it is a casual conversation, greeting, or question clearly directed at you (e.g. "Hello", "How are you", "What is your name"), output ONLY a JSON object: {"actionable": false, "is_conversation": true}',
          '3. If it is just random background noise, incomplete sentences, or people talking to each other, output ONLY a JSON object: {"actionable": false, "is_conversation": false}',
          'Do not include any markdown styling or extra text. Output strict JSON.',
          '',
          `Transcript: "${input.transcript}"`
        ].join('\n');

        const result = await vertexChat(prompt, [], 'en-US');
        const raw = result.text.trim();
        logger.info(`[checkLiveAgentIntent] Raw response: "${raw}"`);

        const jsonMatch = raw.match(/\{.*\}/s);
        if (!jsonMatch) return { actionable: false, is_conversation: false };

        const parsed = JSON.parse(jsonMatch[0]);
        return {
          actionable: !!parsed.actionable,
          task: parsed.task || null,
          is_conversation: !!parsed.is_conversation,
        };
      } catch (err) {
        logger.warn('[voiceRoute] checkLiveAgentIntent failed:', err);
        return { actionable: false };
      }
    }),

  // ─── Register / unregister global hotkeys ─────────────────────
  registerHotkey: t.procedure
    .input<{ enabled: boolean }>()
    .handle(async ({ input }) => {
      const VOICE_PAIRS = [
        { primary: 'CommandOrControl+Shift+V', fallback: 'CommandOrControl+Alt+V' },
        { primary: 'CommandOrControl+Shift+Space', fallback: 'CommandOrControl+Alt+Space' },
      ];

      const registerWithFallback = (primary: string, fallback: string, callback: () => void) => {
        try {
          if (!globalShortcut.isRegistered(primary)) {
            const success = globalShortcut.register(primary, callback);
            if (success) {
              logger.info(`[voiceRoute] Registered global shortcut: ${primary}`);
            } else {
              logger.warn(`Shortcut [${primary}] failed to register. It may be intercepted by the OS.`);
              if (!globalShortcut.isRegistered(fallback)) {
                const fallbackSuccess = globalShortcut.register(fallback, callback);
                if (fallbackSuccess) {
                  logger.info(`[voiceRoute] Registered fallback global shortcut: ${fallback}`);
                } else {
                  logger.warn(`Shortcut [${fallback}] failed to register. It may be intercepted by the OS.`);
                }
              }
            }
          }
        } catch (err) {
          logger.warn(`[voiceRoute] Could not register shortcut pair [${primary}] / [${fallback}]:`, err);
        }
      };

      try {
        if (input.enabled) {
          const onToggleVoice = () => {
            const currentSettings = SettingStore.getStore();
            if (currentSettings.googleApiSource === 'agent_builder') {
              toggleHiBeeAgentWindow();
            } else {
              windowManager.broadcast('voice:toggle-listen', null);
            }
            logger.info('[voiceRoute] Dynamic Voice toggle hotkey fired');
          };

          VOICE_PAIRS.forEach((pair) => {
            registerWithFallback(pair.primary, pair.fallback, onToggleVoice);
          });
        } else {
          VOICE_PAIRS.forEach((pair) => {
            try {
              if (globalShortcut.isRegistered(pair.primary)) {
                globalShortcut.unregister(pair.primary);
              }
              if (globalShortcut.isRegistered(pair.fallback)) {
                globalShortcut.unregister(pair.fallback);
              }
            } catch (err) {
              logger.warn(`[voiceRoute] Could not unregister hotkey:`, err);
            }
          });
        }
        return { ok: true };
      } catch (err) {
        logger.error('[voiceRoute] registerHotkey failed:', err);
        return { ok: false };
      }
    }),
  // ─── Push ambient voice pipeline status to Hi-Bee window ─────────────────
  sendPipelineStatus: t.procedure
    .input<{ event: string; data?: Record<string, unknown> }>()
    .handle(async ({ input }) => {
      try {
        const hibeeWin = getHiBeeAgentWindow();
        if (hibeeWin && !hibeeWin.isDestroyed()) {
          hibeeWin.webContents.send('hibee:pipeline-status', {
            event: input.event,
            data: input.data ?? {},
          });
        }
        // Also broadcast to all other registered windows (e.g. main renderer)
        windowManager.broadcast('hibee:pipeline-status', {
          event: input.event,
          data: input.data ?? {},
        });
        return { ok: true };
      } catch (err) {
        logger.warn('[voiceRoute] sendPipelineStatus failed:', err);
        return { ok: false };
      }
    }),
});
