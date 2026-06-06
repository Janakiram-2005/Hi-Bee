/**
 * Resolve which VLM provider to use for desktop automation runs.
 */
import * as env from '@main/env';
import { LocalStore, Operator, VLMProviderV2 } from '@main/store/types';

export function getVertexProjectId(settings: LocalStore): string {
  return (
    settings.vertexProjectId?.trim() ||
    env.vertexVlmProjectId?.trim() ||
    env.vertexProjectId?.trim() ||
    ''
  );
}

export function shouldUseVertexGemini(
  settings: LocalStore,
  effectiveOperator: Operator,
): boolean {
  if (
    effectiveOperator === Operator.RemoteComputer ||
    effectiveOperator === Operator.RemoteBrowser
  ) {
    return false;
  }

  if (settings.vlmProvider === VLMProviderV2.gemini_vertex) {
    return Boolean(getVertexProjectId(settings));
  }

  const projectId = getVertexProjectId(settings);
  if (!projectId) {
    return false;
  }

  const hasOpenAiVlm =
    Boolean(settings.vlmApiKey?.trim()) &&
    Boolean(settings.vlmBaseUrl?.trim()) &&
    Boolean(settings.vlmModelName?.trim()) &&
    Boolean(settings.vlmProvider);

  return !hasOpenAiVlm;
}

export function ensureVlmDefaults(settings: LocalStore): LocalStore {
  const projectId = getVertexProjectId(settings);
  const next = { ...settings };

  if (projectId && !next.vertexProjectId?.trim()) {
    next.vertexProjectId = projectId;
  }

  if (
    projectId &&
    (!next.vlmProvider || next.vlmProvider === ('' as VLMProviderV2))
  ) {
    next.vlmProvider = VLMProviderV2.gemini_vertex;
  }

  if (!next.vertexLocation?.trim()) {
    next.vertexLocation =
      env.vertexVlmLocation || env.vertexLocation || 'us-central1';
  }

  if (!next.vertexModelName?.trim()) {
    next.vertexModelName = env.vertexVlmModelName || 'gemini-2.5-pro';
  }

  if (!next.vertexServiceAccountPath?.trim() && process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    next.vertexServiceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  }

  return next;
}
