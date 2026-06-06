/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { OpenAI } from 'openai';
import { initIpc } from '@ui-tars/electron-ipc/main';
import { logger } from '../logger';
import { GeminiVertexModel } from '../services/GeminiVertexModel';
import { VLMProviderV2 } from '../store/types';

const t = initIpc.create();

export const settingRoute = t.router({
  checkVLMResponseApiSupport: t.procedure
    .input<{
      baseUrl: string;
      apiKey: string;
      modelName: string;
      provider?: string;
    }>()
    .handle(async ({ input }) => {
      if (input.provider === VLMProviderV2.gemini_vertex) {
        return false; // Vertex AI Gemini doesn't use OpenAI's custom Responses API
      }
      try {
        const openai = new OpenAI({
          apiKey: input.apiKey,
          baseURL: input.baseUrl,
        });
        const result = await openai.responses.create({
          model: input.modelName,
          input: 'return 1+1=?',
          stream: false,
        });
        console.log('result', result);
        return Boolean(result?.id || result?.previous_response_id);
      } catch (e) {
        logger.warn('[checkVLMResponseApiSupport] failed:', e);
        return false;
      }
    }),
  checkModelAvailability: t.procedure
    .input<{
      baseUrl: string;
      apiKey: string;
      modelName: string;
      provider?: string;
      // Vertex AI VLM parameters
      vertexProjectId?: string;
      vertexLocation?: string;
      vertexModelName?: string;
      vertexServiceAccountPath?: string;
    }>()
    .handle(async ({ input }) => {
      if (input.provider === VLMProviderV2.gemini_vertex) {
        try {
          const isHealthy = await GeminiVertexModel.healthCheck({
            projectId: input.vertexProjectId || '',
            location: input.vertexLocation || 'us-central1',
            modelName: input.vertexModelName || 'gemini-2.5-flash',
            serviceAccountPath: input.vertexServiceAccountPath || undefined,
          });
          if (!isHealthy) {
            throw new Error('Vertex AI Gemini check failed. Please verify your Project ID, Location, and Service Account key.');
          }
          return true;
        } catch (e) {
          logger.error('[checkModelAvailability] Vertex AI failed:', e);
          throw e;
        }
      }
      try {
        const openai = new OpenAI({
          apiKey: input.apiKey,
          baseURL: input.baseUrl,
        });
        const completion = await openai.chat.completions.create({
          model: input.modelName,
          messages: [{ role: 'user', content: 'return 1+1=?' }],
          stream: false,
        });
        console.log('result', completion);

        return Boolean(completion?.id || completion.choices[0].message.content);
      } catch (e) {
        throw e;
      }
    }),
});
