/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 *
 * GeminiVertexModel — Google Vertex AI Gemini VLM provider for UI-TARS Desktop.
 *
 * Lives in the Electron main process (has access to @google-cloud/vertexai).
 * Implements the same interface as UITarsModel so GUIAgent accepts it directly.
 */

import {
  VertexAI,
  HarmCategory,
  HarmBlockThreshold,
  type Content,
  type Part,
  type GenerativeModel,
} from '@google-cloud/vertexai';

import { actionParser } from '@ui-tars/action-parser';
import { IMAGE_PLACEHOLDER } from '@ui-tars/shared/constants';
import {
  UITarsModelVersion,
  MAX_PIXELS_V1_5,
} from '@ui-tars/shared/types';

import { logger } from '@main/logger';

// ─── Types (mirrored from SDK to avoid needing a built SDK dist) ──────────────

interface ScreenContext {
  width: number;
  height: number;
}

interface Message {
  from: 'human' | 'gpt';
  value: string;
  screenshotBase64?: string;
}

export interface InvokeParams {
  conversations: Message[];
  images: string[];
  screenContext: ScreenContext;
  scaleFactor?: number;
  uiTarsVersion?: UITarsModelVersion;
  headers?: Record<string, string>;
  previousResponseId?: string;
}

export interface InvokeOutput {
  prediction: string;
  parsedPredictions: unknown[];
  costTime?: number;
  costTokens?: number;
  responseId?: string;
}

// ─── Default coordinate factors (same as UITarsModel) ────────────────────────

/** [widthFactor, heightFactor] — matches UITarsModel.DEFAULT_FACTORS */
const DEFAULT_FACTORS: [number, number] = [1000, 1000];

// ─── Public Interfaces ────────────────────────────────────────────────────────

/**
 * Configuration required to authenticate and call Vertex AI Gemini as a VLM.
 *
 * Authentication priority:
 *   1. `serviceAccountPath` → sets GOOGLE_APPLICATION_CREDENTIALS
 *   2. GOOGLE_APPLICATION_CREDENTIALS env var (set by env.ts auto-detect)
 *   3. Application Default Credentials (gcloud auth / metadata server)
 */
export interface VertexAIConfig {
  /** Google Cloud project ID, e.g. "my-project-123" */
  projectId: string;
  /** Vertex AI region, e.g. "us-central1" */
  location: string;
  /**
   * Gemini model name.
   * Supported: "gemini-2.5-flash" | "gemini-2.5-pro" | "gemini-1.5-flash"
   */
  modelName: string;
  /**
   * Optional: absolute path to a service-account JSON key file.
   * Leave blank to use GOOGLE_APPLICATION_CREDENTIALS or ADC.
   */
  serviceAccountPath?: string;
  /** Max output tokens (default: 65535) */
  maxOutputTokens?: number;
  /** Temperature (default: 0 — deterministic for automation) */
  temperature?: number;
}

/**
 * Adapter interface for converting Gemini text → InvokeOutput.
 * Exposed for testing.
 */
export interface GeminiResponseAdapter {
  adapt(
    rawText: string,
    params: {
      screenContext: ScreenContext;
      scaleFactor?: number;
      uiTarsVersion?: UITarsModelVersion;
    },
  ): InvokeOutput;
}

// ─── Image resize helper (same logic as SDK preprocessResizeImage) ────────────

const resizedImageCache = new Map<string, string>();

async function resizeImageForGemini(base64: string, maxPixels: number): Promise<string> {
  const cached = resizedImageCache.get(base64);
  if (cached) return cached;

  // Dynamically import jimp only at runtime so the renderer process is not affected
  const { Jimp } = await import('jimp');
  const raw = base64.replace(/^data:[^;]+;base64,/, '');
  const buf = Buffer.from(raw, 'base64');
  const img = await Jimp.read(buf);
  const { width, height } = img.bitmap;
  if (width * height > maxPixels) {
    const f = Math.sqrt(maxPixels / (width * height));
    img.resize({ w: Math.floor(width * f), h: Math.floor(height * f) });
  }
  const out = await img.getBuffer('image/jpeg', { quality: 75 });
  const result = out.toString('base64');

  // Keep cache size bounded
  if (resizedImageCache.size > 100) {
    const firstKey = resizedImageCache.keys().next().value;
    if (firstKey !== undefined) {
      resizedImageCache.delete(firstKey);
    }
  }
  resizedImageCache.set(base64, result);
  return result;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Convert a raw base64 string into a Gemini inline image Part.
 */
function base64ToGeminiPart(base64: string, mimeType = 'image/jpeg'): Part {
  return {
    inlineData: {
      mimeType,
      data: base64.replace(/^data:[^;]+;base64,/, ''),
    },
  };
}

/**
 * Convert UI-TARS Message[] + compressed images[] → Gemini Content[].
 *
 * UI-TARS layout:
 *   human:  "<system+task text>"
 *   human:  IMAGE_PLACEHOLDER  ← becomes an inline image content block
 *   gpt:    "<action text>"
 *   ...
 */
export function convertMessagesToGemini(
  conversations: Message[],
  images: string[],
): Content[] {
  const contents: Content[] = [];
  let imageIdx = 0;

  for (const conv of conversations) {
    const role = conv.from === 'human' ? 'user' : 'model';

    if (conv.value === IMAGE_PLACEHOLDER) {
      if (imageIdx < images.length) {
        contents.push({
          role: 'user',
          parts: [base64ToGeminiPart(images[imageIdx])],
        });
        imageIdx++;
      }
    } else {
      // Merge consecutive same-role text parts to minimise round-trips
      const last = contents[contents.length - 1];
      if (last && last.role === role && !last.parts.some((p) => 'inlineData' in p)) {
        (last.parts as Part[]).push({ text: conv.value });
      } else {
        contents.push({ role, parts: [{ text: conv.value }] });
      }
    }
  }

  return contents;
}

// ─── Default adapter ──────────────────────────────────────────────────────────

class DefaultGeminiResponseAdapter implements GeminiResponseAdapter {
  adapt(
    rawText: string,
    {
      screenContext,
      scaleFactor,
      uiTarsVersion = UITarsModelVersion.V1_5,
    }: Parameters<GeminiResponseAdapter['adapt']>[1],
  ): InvokeOutput {
    if (!rawText) {
      const err = new Error('GeminiVertexModel: empty prediction from Gemini');
      err.name = 'vlm response error';
      throw err;
    }

    let cleanedText = rawText.trim();
    if (!/Action[:：]/.test(cleanedText)) {
      const actionMatch = cleanedText.match(/\b(click|drag|type|wait|finished|call_user|scroll|left_double|right_single|hotkey)\b/);
      if (actionMatch && actionMatch.index !== undefined) {
        const index = actionMatch.index;
        cleanedText = cleanedText.substring(0, index) + '\nAction: ' + cleanedText.substring(index);
      }
    }

    try {
      const { parsed: parsedPredictions } = actionParser({
        prediction: cleanedText,
        factor: DEFAULT_FACTORS,
        screenContext,
        scaleFactor,
        modelVer: uiTarsVersion,
      });
      return { prediction: cleanedText, parsedPredictions };
    } catch {
      return { prediction: cleanedText, parsedPredictions: [] };
    }
  }
}

// ─── GeminiVertexModel ────────────────────────────────────────────────────────

/**
 * UI-TARS VLM provider backed by Google Vertex AI Gemini.
 *
 * Implements the same `invoke(params)` interface as UITarsModel so
 * GUIAgent treats it identically.
 *
 * @example
 * ```ts
 * import { GeminiVertexModel } from '@main/services/GeminiVertexModel';
 * const model = new GeminiVertexModel({
 *   projectId: 'my-project',
 *   location: 'us-central1',
 *   modelName: 'gemini-2.5-pro',
 * });
 * const agent = new GUIAgent({ model, operator, ... });
 * ```
 */
export class GeminiVertexModel {
  private readonly cfg: Required<
    Omit<VertexAIConfig, 'serviceAccountPath'>
  > & { serviceAccountPath?: string };

  private vertexClient: VertexAI | null = null;
  private readonly adapter: GeminiResponseAdapter;

  get factors(): [number, number] {
    return DEFAULT_FACTORS;
  }

  get modelName(): string {
    return this.cfg.modelName;
  }

  reset() {
    // No-op — GeminiVertexModel is stateless between runs.
  }

  constructor(
    config: VertexAIConfig,
    adapter: GeminiResponseAdapter = new DefaultGeminiResponseAdapter(),
  ) {
    this.cfg = {
      projectId: config.projectId,
      location: config.location,
      modelName: config.modelName,
      maxOutputTokens: config.maxOutputTokens ?? 65535,
      temperature: config.temperature ?? 0,
      serviceAccountPath: config.serviceAccountPath,
    };
    this.adapter = adapter;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private getClient(): VertexAI {
    if (this.cfg.serviceAccountPath && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = this.cfg.serviceAccountPath;
    }
    if (!this.vertexClient) {
      this.vertexClient = new VertexAI({
        project: this.cfg.projectId,
        location: this.cfg.location,
      });
    }
    return this.vertexClient;
  }

  private buildModel(): GenerativeModel {
    return this.getClient().getGenerativeModel({
      model: this.cfg.modelName,
      generationConfig: {
        maxOutputTokens: this.cfg.maxOutputTokens,
        temperature: this.cfg.temperature,
        topP: 0.95,
      },
      safetySettings: [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT,        threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,        threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,  threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,  threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
      ],
    });
  }

  private async callWithRetry(
    contents: Content[],
    maxRetries = 3,
  ): Promise<{ text: string; costTime: number; costTokens: number }> {
    const genModel = this.buildModel();
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const t0 = Date.now();
        const result = await genModel.generateContent({ contents });
        const costTime = Date.now() - t0;
        const response = result.response;

        const text =
          response.candidates?.[0]?.content?.parts
            ?.map((p) => ('text' in p ? (p as { text: string }).text : ''))
            .join('') ?? '';

        const costTokens =
          (response.usageMetadata?.promptTokenCount ?? 0) +
          (response.usageMetadata?.candidatesTokenCount ?? 0);

        return { text, costTime, costTokens };
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxRetries) {
          const backoff = Math.min(500 * 2 ** attempt, 4000);
          logger.warn(`[GeminiVertexModel] attempt ${attempt + 1} failed: ${lastError.message}. Retry in ${backoff}ms`);
          await sleep(backoff);
        }
      }
    }
    throw lastError ?? new Error('GeminiVertexModel: all retries exhausted');
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Health-check: verify project/location/model are reachable.
   */
  static async healthCheck(config: VertexAIConfig): Promise<boolean> {
    try {
      if (config.serviceAccountPath) {
        process.env.GOOGLE_APPLICATION_CREDENTIALS = config.serviceAccountPath;
      }
      const vertex = new VertexAI({ project: config.projectId, location: config.location });
      const model = vertex.getGenerativeModel({ model: config.modelName });
      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
      });
      return !!result.response.candidates?.[0];
    } catch {
      return false;
    }
  }

  /**
   * Called by GUIAgent on every screenshot → action iteration.
   * Mirrors UITarsModel.invoke() in signature.
   */
  async invoke(params: InvokeParams): Promise<InvokeOutput> {
    const { conversations, images, screenContext, scaleFactor, uiTarsVersion } = params;

    logger.info(
      `[GeminiVertexModel] invoke model=${this.cfg.modelName} ` +
        `screen=${JSON.stringify(screenContext)} images=${images.length}`,
    );

    // Resize images to Gemini-safe pixel budget
    const compressed = await Promise.all(
      images.map((img) => resizeImageForGemini(img, MAX_PIXELS_V1_5)),
    );

    const contents = convertMessagesToGemini(conversations, compressed);

    if (contents.length === 0) {
      throw new Error('[GeminiVertexModel] No content — conversations array is empty');
    }

    const { text, costTime, costTokens } = await this.callWithRetry(contents);

    logger.info(
      `[GeminiVertexModel] response costTime=${costTime}ms tokens=${costTokens} len=${text.length}`,
    );

    const output = this.adapter.adapt(text, { screenContext, scaleFactor, uiTarsVersion });
    return { ...output, costTime, costTokens };
  }
}
