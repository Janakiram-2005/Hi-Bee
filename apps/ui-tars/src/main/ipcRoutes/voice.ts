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
import { synthesizeSpeech } from '@main/services/cloudTTS';
import { windowManager } from '@main/services/windowManager';
import { Operator } from '@main/store/types';
import { isStopVoiceCommand, stopActiveAgentRun } from '@main/services/stopAgentRun';
import { toggleHiBeeAgentWindow } from '@main/window/hibeeAgentWindow';
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
    .input<{ text: string; languageCode: string; ssml?: boolean }>()
    .handle(async ({ input }) => {
      const result = await synthesizeSpeech(input.text, input.languageCode, input.ssml ?? false);
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
    }>()
    .handle(async ({ input }) => {
      const { transcript, history, language, taskId } = input;

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
            background: true,
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
          'Analyze if the following user speech transcript is a direct request, command, or task to perform an action on their computer (e.g. opening an app, typing, searching, navigating, clicking, etc.).',
          'If it is a clear computer action request, output ONLY a JSON object: {"actionable": true, "task": "short summary of the task in a few words"}',
          'If it is casual conversation, background talking, or not an action request, output ONLY a JSON object: {"actionable": false}',
          'Do not include any markdown styling or extra text. Output strict JSON.',
          '',
          `Transcript: "${input.transcript}"`
        ].join('\n');

        const result = await vertexChat(prompt, [], 'en-US');
        const raw = result.text.trim();
        logger.info(`[checkLiveAgentIntent] Raw response: "${raw}"`);

        const jsonMatch = raw.match(/\{.*\}/s);
        if (!jsonMatch) return { actionable: false };

        const parsed = JSON.parse(jsonMatch[0]);
        return {
          actionable: !!parsed.actionable,
          task: parsed.task || null,
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
      const SHORTCUTS = [
        'CommandOrControl+Shift+V',
        'CommandOrControl+Alt+V',
        'CommandOrControl+Shift+Space',
      ];
      try {
        if (input.enabled) {
          SHORTCUTS.forEach((shortcut) => {
            if (!globalShortcut.isRegistered(shortcut)) {
              globalShortcut.register(shortcut, () => {
                const currentSettings = SettingStore.getStore();
                if (currentSettings.googleApiSource === 'agent_builder') {
                  toggleHiBeeAgentWindow();
                } else {
                  windowManager.broadcast('voice:toggle-listen', null);
                }
                logger.info(`[voiceRoute] Hotkey ${shortcut} fired`);
              });
            }
          });
        } else {
          SHORTCUTS.forEach((shortcut) => {
            if (globalShortcut.isRegistered(shortcut)) {
              globalShortcut.unregister(shortcut);
            }
          });
        }
        return { ok: true };
      } catch (err) {
        logger.error('[voiceRoute] registerHotkey failed:', err);
        return { ok: false };
      }
    }),
});
