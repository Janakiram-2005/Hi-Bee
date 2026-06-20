/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Vertex AI service — Gemini 1.5 Flash with Search Grounding.
 * All errors are caught and return a conversational fallback message.
 */
import {
  VertexAI,
  HarmCategory,
  HarmBlockThreshold,
} from '@google-cloud/vertexai';
import { logger } from '@main/logger';
import {
  vertexProjectId,
  vertexLocation,
  vertexSearchEngineId,
} from '@main/env';
import { SettingStore } from '@main/store/setting';
import type { Citation } from './mongoService';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface VoiceChatHistory {
  role: 'user' | 'model';
  text: string;
}

export interface VoiceChatResult {
  text: string;
  citations: Citation[];
  error?: boolean;
  latencyMs?: number;
}

// ─── Fallback phrases (rotated so they don't feel robotic) ───────────────────
const FALLBACKS = [
  'I ran into a slight issue trying to do that. Could you rephrase it or give me a bit more detail?',
  "Hmm, I didn't quite get that. Could you try saying it differently?",
  'I had trouble processing that request. Could you try again with a little more context?',
  "Something went wrong on my end. Let me know if you'd like to try a different approach.",
];
let fallbackIndex = 0;
const nextFallback = () => FALLBACKS[fallbackIndex++ % FALLBACKS.length];

// ─── Vertex AI Client (lazy singleton) ───────────────────────────────────────

let lastProject: string | null = null;
let lastLocation: string | null = null;
let vertexClient: VertexAI | null = null;

function getVertex(): VertexAI {
  const storeSettings = SettingStore.getStore();
  const projectId = storeSettings.vertexProjectId || vertexProjectId;
  const location = storeSettings.vertexLocation || vertexLocation;
  const serviceAccountPath = storeSettings.vertexServiceAccountPath;

  if (serviceAccountPath && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = serviceAccountPath;
    logger.info(
      `[Hi-Bee] Using Service Account JSON from settings: ${serviceAccountPath}`,
    );
  }

  if (!vertexClient || lastProject !== projectId || lastLocation !== location) {
    logger.info(
      `[Hi-Bee] Initializing VertexAI client for project: ${projectId}, location: ${location}`,
    );
    vertexClient = new VertexAI({
      project: projectId,
      location: location,
    });
    lastProject = projectId;
    lastLocation = location;
  }
  return vertexClient;
}

// ─── Search Grounding Tool ────────────────────────────────────────────────────

function buildGroundingTool(projectId: string, searchEngineId: string) {
  return {
    retrieval: {
      vertexAiSearch: {
        datastore: `projects/${projectId}/locations/global/collections/default_collection/dataStores/${searchEngineId}`,
      },
      disableAttribution: false,
    },
  };
}

// ─── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_INSTRUCTION = `You are HI-Bee, a helpful, conversational AI voice assistant integrated into UI-TARS Desktop — a powerful GUI automation tool.
You respond naturally in speech-friendly language (no markdown, no bullet points, no code blocks unless explicitly asked).
Keep responses concise (2–4 sentences for simple queries, longer only if needed).
When you don't know something, admit it and suggest alternatives.
When the user is doing a multi-step task, acknowledge each step and confirm before proceeding.
Always respond in the same language the user speaks to you in.

Supported languages — detect automatically and respond in kind:
- English (en-US, en-IN, en-GB, en-AU)
- Telugu (te-IN) — తెలుగు
- Hindi (hi-IN) — हिंदी
- Tamil (ta-IN) — தமிழ்
- Kannada (kn-IN) — ಕನ್ನಡ
- Malayalam (ml-IN) — മലയാളം
- Bengali (bn-IN) — বাংলা
- Marathi (mr-IN) — मराठी
- Gujarati (gu-IN) — ગુજરાતી
- Punjabi (pa-IN) — ਪੰਜਾਬੀ
- Chinese (zh-CN, zh-TW), Japanese (ja-JP), Korean (ko-KR), Spanish, French, German, Portuguese, Arabic, Russian, Turkish, Italian

Code-switching: If the user mixes languages (e.g., Hinglish), respond naturally in the same style.

CRITICAL: If the user asks you to perform an action on the computer, open an application, click on something, type something, or run a GUI automation task, you must start your response with:
[TRIGGER_RUN: <instruction in ENGLISH>]
followed by a brief, friendly verbal confirmation of what you are about to do. Make sure the <instruction> inside the bracket is ALWAYS in English (e.g. "open Paint", "search for weather in Tokyo on Chrome", etc.), regardless of the language the user speaks. The verbal confirmation must still be in the user's language.
If the user provides a continuous speech input with multiple steps (e.g., "open notepad and type hello, then save it"), consolidate the steps into a single unified instruction sequence (e.g. "[TRIGGER_RUN: open Notepad, type 'hello', and save the file]"). Do not prefix or include TRIGGER_RUN for general questions or conversational replies that do not require executing a computer action.

Special Fast Actions (use these exact phrasings in TRIGGER_RUN, ALWAYS IN ENGLISH):
- YouTube search: If the user says "search on YouTube for <query>" or "play <query> on YouTube", use: [TRIGGER_RUN: search on youtube <query>]
- Screen summarize: If the user says "summarize", "tell me about the screen", "describe what you see", "what's on screen", use: [TRIGGER_RUN: summarize]
  The system will take a screenshot and describe it back to you.
- Google search: If the user says "search for <query>" or "google <query>", use: [TRIGGER_RUN: search <query>]
- App launch: If the user says "open <app>", use: [TRIGGER_RUN: open <app>]`;

// ─── Main Chat Function ───────────────────────────────────────────────────────

export async function vertexChat(
  transcript: string,
  history: VoiceChatHistory[] = [],
  language = 'en-US',
): Promise<VoiceChatResult> {
  console.log(`[Hi-Bee] User input: "${transcript}"`);
  try {
    const { mongoService } = await import('./mongoService');
    let activeState: any = null;
    let systemInstruction = `${SYSTEM_INSTRUCTION}
CRITICAL: The user's preferred language is ${language}. You MUST formulate your response in this language/dialect (e.g. if te-IN, write in Telugu script; if hi-IN, write in Devanagari Hindi script; if ta-IN, write in Tamil script; if kn-IN, write in Kannada script; if ml-IN, write in Malayalam script; etc.). Even if the user speaks or types to you in English, you must respond in their preferred language: ${language}.`;

    if (mongoService.isConnected()) {
      try {
        activeState = await mongoService.getLatestActiveAgentState();
        if (activeState) {
          const stepInfo =
            activeState.lastStepIndex >= 0
              ? `Step ${activeState.lastStepIndex + 1}`
              : 'initial step';
          systemInstruction += `\n\n[Active GUI Automation Task Context]:
- Task Instruction: "${activeState.instructions}"
- Automation Status: ${activeState.status}
- Current Progress: ${stepInfo}
- Last Predicted Action: "${activeState.lastPredictionText || 'None'}"
You have access to this live execution status and current screenshot. If the user asks about the progress, what the automation is doing, or what is currently on the screen, reference this context naturally.`;
        }
      } catch (err) {
        logger.warn(
          '[vertexChat] Failed to query active agent state context:',
          err,
        );
      }
    }

    const storeSettings = SettingStore.getStore();
    const modelName =
      storeSettings.vertexChatModelName ||
      storeSettings.vertexModelName ||
      'gemini-2.5-flash';
    const activeProjectId = storeSettings.vertexProjectId || vertexProjectId;
    const canUseGrounding = Boolean(activeProjectId && vertexSearchEngineId);
    const useStreaming = storeSettings.enableStreamingResponse !== false;
    const vertex = getVertex();
    const model = vertex.getGenerativeModel({
      model: modelName,
      systemInstruction,
      generationConfig: {
        maxOutputTokens: 512,
        temperature: 0.7,
        topP: 0.9,
      },
      safetySettings: [
        {
          category: HarmCategory.HARM_CATEGORY_HARASSMENT,
          threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        },
        {
          category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
          threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
        },
      ],
      ...(canUseGrounding
        ? {
            tools: [
              buildGroundingTool(activeProjectId, vertexSearchEngineId) as any,
            ],
          }
        : {}),
    });

    const userParts: any[] = [{ text: transcript }];
    if (activeState?.lastScreenshotBase64) {
      try {
        const rawBase64 = activeState.lastScreenshotBase64.replace(
          /^data:[^;]+;base64,/,
          '',
        );
        userParts.push({
          inlineData: {
            mimeType: 'image/png',
            data: rawBase64,
          },
        });
        logger.info('[vertexChat] Attached active screenshot to Gemini query');
      } catch (err) {
        logger.warn(
          '[vertexChat] Failed to attach screenshot to Gemini query:',
          err,
        );
      }
    }

    // Build contents from history + new message
    const contents = [
      ...history.map((h) => ({
        role: h.role,
        parts: [{ text: h.text }],
      })),
      {
        role: 'user' as const,
        parts: userParts,
      },
    ];

    const t0 = Date.now();
    let result;
    const maxRetries = 5;
    let lastError: any = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (useStreaming) {
          // Streaming path: lower first-token latency
          const streamResult = await model.generateContentStream({ contents });
          const response = await streamResult.response;
          result = { response };
        } else {
          result = await model.generateContent({ contents });
        }
        break;
      } catch (err: any) {
        lastError = err;
        const errMsg = err?.message || '';
        if (
          errMsg.includes('datastore') ||
          errMsg.includes('tools') ||
          errMsg.includes('grounding') ||
          errMsg.includes('INVALID_ARGUMENT')
        ) {
          logger.info(
            '[Hi-Bee] Vertex AI Grounding failed. Retrying without grounding tool...',
          );
          const fallbackModel = vertex.getGenerativeModel({
            model: modelName,
            systemInstruction,
            generationConfig: {
              maxOutputTokens: 512,
              temperature: 0.7,
              topP: 0.9,
            },
            safetySettings: [
              {
                category: HarmCategory.HARM_CATEGORY_HARASSMENT,
                threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
              },
              {
                category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
                threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
              },
            ],
          });
          try {
            result = await fallbackModel.generateContent({ contents });
            break;
          } catch (fallbackErr: any) {
            lastError = fallbackErr;
          }
        }

        if (attempt < maxRetries) {
          const isRateLimit =
            errMsg.includes('429') ||
            errMsg.toLowerCase().includes('exhausted') ||
            errMsg.toLowerCase().includes('too many requests');

          let backoff = Math.min(500 * 2 ** attempt, 4000);
          if (isRateLimit) {
            backoff = Math.min(2000 * 2.5 ** attempt, 15000);
          }
          logger.warn(
            `[Hi-Bee] [vertexChat] attempt ${attempt + 1} failed: ${errMsg}. Retry in ${backoff}ms`,
          );
          await new Promise((resolve) => setTimeout(resolve, backoff));
        } else {
          throw lastError;
        }
      }
    }
    const response = result.response;

    // Extract text
    const rawText =
      response.candidates?.[0]?.content?.parts?.[0]?.text || nextFallback();

    // Extract grounding citations
    const citations: Citation[] = [];
    const groundingMeta = response.candidates?.[0]?.groundingMetadata as any;

    if (groundingMeta?.groundingChunks) {
      for (const chunk of groundingMeta.groundingChunks) {
        if (chunk.web?.uri && chunk.web?.title) {
          citations.push({ title: chunk.web.title, url: chunk.web.uri });
        }
      }
    }

    // Strip any markdown formatting for clean TTS output
    const ttsText = rawText
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/\*(.*?)\*/g, '$1')
      .replace(/`(.*?)`/g, '$1')
      .replace(/#{1,6}\s+/g, '')
      .replace(/\n+/g, ' ')
      .trim();

    const latencyMs = Date.now() - t0;
    console.log(`[Hi-Bee] Agent response: "${ttsText}" (${latencyMs}ms)`);
    logger.info(
      `[VertexAI] Response (${ttsText.length} chars), citations: ${citations.length}, latency: ${latencyMs}ms`,
    );

    return { text: ttsText, citations, latencyMs };
  } catch (err: any) {
    const fallbackMsg = nextFallback();
    console.log(`[Hi-Bee] Agent error response: "${fallbackMsg}"`);
    logger.error('[VertexAI] Chat error:', err?.message || err);
    return {
      text: fallbackMsg,
      citations: [],
      error: true,
    };
  }
}
