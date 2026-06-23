/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import dotenv from 'dotenv';

const envPath = path.resolve(process.cwd(), '../../.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  // Fallback for flat structures or production
  dotenv.config();
}

export const mode = process.env.NODE_ENV;
export const isProd = mode === 'production';
export const isDev = mode === 'development';
export const forceDownload = !!process.env.UPGRADE_EXTENSIONS;
export const port = process.env.PORT || 1212;
export const startMinimized = process.env.START_MINIMIZED;
export const rendererUrl = process.env.ELECTRON_RENDERER_URL;
export const isE2eTest = process.env.CI === 'e2e';

// ── Standard VLM provider env vars ────────────────────────────────────────────
export const vlmProvider = process.env.VLM_PROVIDER;
export const vlmBaseUrl = process.env.VLM_BASE_URL;
export const vlmApiKey = process.env.VLM_API_KEY;
export const vlmModelName = process.env.VLM_MODEL_NAME;

// ── Vertex AI Voice Assistant ─────────────────────────────────────────────────
const DEFAULT_GCP_SA_FILENAME = 'convertionalai-d8da9e4d43dd.json';

export const mongoUri =
  process.env.MONGODB_URI ||
  'mongodb+srv://testuser:testpassword123@cluster0.vulsn3z.mongodb.net/Gemini_DB';
export const vertexProjectId = process.env.VERTEX_PROJECT_ID || 'convertionalai';
export const vertexLocation = process.env.VERTEX_LOCATION || 'us-central1';
export const vertexSearchEngineId =
  process.env.VERTEX_SEARCH_ENGINE_ID || 'geminiweb-official_1777470868243';

// ── Vertex AI VLM Provider (GUI automation) ───────────────────────────────────
/** GCP project ID used by the Gemini VLM provider */
export const vertexVlmProjectId = process.env.VERTEX_VLM_PROJECT_ID || process.env.VERTEX_PROJECT_ID || '';
/** Vertex AI region for the Gemini VLM provider */
export const vertexVlmLocation = process.env.VERTEX_VLM_LOCATION || process.env.VERTEX_LOCATION || 'us-central1';
/** Gemini model name for GUI automation */
export const vertexVlmModelName = process.env.VERTEX_VLM_MODEL_NAME || 'gemini-2.5-flash';

// ── Azure TTS ──────────────────────────────────────────────────────────────────
export const azureSpeechKey = process.env.AZURE_SPEECH_KEY;
export const azureSpeechRegion = process.env.AZURE_SPEECH_REGION;


// ── GCP Credentials auto-detection ────────────────────────────────────────────
// Searches for a service-account JSON file in well-known locations.
// The filename is read from env var GCP_SA_FILENAME (no hardcoded filenames).
// Priority:
//   1. GOOGLE_APPLICATION_CREDENTIALS already set → do nothing
//   2. GCP_SA_FILENAME env var → search for that filename at standard paths
//   3. Fall through → Application Default Credentials (gcloud auth)
(function autoSetGcpCredentials() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.log('[env] GOOGLE_APPLICATION_CREDENTIALS already set:', process.env.GOOGLE_APPLICATION_CREDENTIALS);
    return;
  }

  const saFilename = process.env.GCP_SA_FILENAME || DEFAULT_GCP_SA_FILENAME;

  const candidates = [
    // current working directory (dev, monorepo root)
    path.resolve(process.cwd(), saFilename),
    // monorepo root when running dev server
    path.resolve(process.cwd(), '..', saFilename),
    // app root relative guesses (works across dev/build layouts)
    path.resolve(__dirname, '..', '..', '..', '..', saFilename),
    // dev: repo root (5 levels up from apps/ui-tars/src/main)
    path.resolve(__dirname, '..', '..', '..', '..', '..', saFilename),
    path.resolve(__dirname, '..', '..', '..', '..', '..', '..', saFilename),
    // prod (asar): next to app.asar or exe
    path.resolve(process.resourcesPath || '', saFilename),
    path.resolve(process.execPath ? path.dirname(process.execPath) : '', saFilename),
    // home directory (common convention)
    path.resolve(os.homedir(), '.config', 'gcloud', saFilename),
  ];

  console.log('[env] Searching for service account JSON:', saFilename);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = candidate;
      process.env.VERTEX_SERVICE_ACCOUNT_PATH = candidate;
      console.log('[env] Found service account JSON:', candidate);
      break;
    }
  }
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.log('[env] Service account JSON not found in candidates list');
  }
})();

const { platform } = process;
export const isMacOS = platform === 'darwin';
export const isWindows = platform === 'win32';
export const isLinux = platform === 'linux';

/**
 * @see https://learn.microsoft.com/en-us/windows/release-health/windows11-release-information
 * Windows 11 buildNumber starts from 22000.
 */
const detectingWindows11 = () => {
  if (!isWindows) return false;
  const release = os.release();
  const majorVersion = Number.parseInt(release.split('.')[0]);
  const buildNumber = Number.parseInt(release.split('.')[2]);
  return majorVersion === 10 && buildNumber >= 22000;
};

export const isWindows11 = detectingWindows11();
