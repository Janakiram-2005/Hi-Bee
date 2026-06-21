/**
 * cloudSTT.ts — Audio-to-text via Google Cloud Speech-to-Text v1 REST API.
 *
 * Replaces the old Vertex AI generateContent approach (which required billing
 * to be enabled on aiplatform.googleapis.com) with the dedicated
 * speech.googleapis.com endpoint, which has a 60-minute/month free tier and
 * works with the same ADC / service-account credentials already configured.
 *
 * Flow: MediaRecorder (WebM/Opus) → base64 → Cloud STT v1 → transcript text
 *
 * Endpoint: POST https://speech.googleapis.com/v1/speech:recognize
 */
import { logger } from '@main/logger';
import { SettingStore } from '@main/store/setting';
import * as env from '@main/env';

// ── Token cache ────────────────────────────────────────────────────────────────

let cachedToken: string | null = null;
let tokenExpiry = 0;

import { GoogleAuth } from 'google-auth-library';

export async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry - 60_000) return cachedToken;

  const settings = SettingStore.getStore();
  if (settings.vertexServiceAccountPath && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = settings.vertexServiceAccountPath;
  }

  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const client = await auth.getClient();
  const resp = await client.getAccessToken();
  if (!resp.token) throw new Error('[cloudSTT] Empty ADC token');
  cachedToken = resp.token;
  tokenExpiry = now + 3_600_000;
  return resp.token;
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface STTResult {
  transcript: string;
  confidence: number;
  isFinal: boolean;
}

// ── Encoding resolution ────────────────────────────────────────────────────────

/** Maps browser MediaRecorder MIME type to Cloud STT encoding enum. */
function resolveEncoding(mimeType: string): {
  encoding: string;
  sampleRateHertz: number;
} {
  const m = mimeType.toLowerCase();
  // webm/opus: the most common output from Chromium MediaRecorder
  if (m.includes('webm') || m.includes('opus')) {
    return { encoding: 'WEBM_OPUS', sampleRateHertz: 48000 };
  }
  // ogg/opus
  if (m.includes('ogg')) {
    return { encoding: 'OGG_OPUS', sampleRateHertz: 48000 };
  }
  // mp4 / aac
  if (m.includes('mp4') || m.includes('aac')) {
    return { encoding: 'MP3', sampleRateHertz: 16000 };
  }
  // wav / linear PCM
  if (m.includes('wav') || m.includes('pcm') || m.includes('linear')) {
    return { encoding: 'LINEAR16', sampleRateHertz: 16000 };
  }
  // fallback
  return { encoding: 'WEBM_OPUS', sampleRateHertz: 48000 };
}

/** Maps human language codes / names to BCP-47 tags for Cloud STT. */
function resolveBcp47(languageCode: string): string {
  const code = languageCode.toLowerCase().trim();
  const map: Record<string, string> = {
    // Indian regional languages
    'te': 'te-IN',
    'telugu': 'te-IN',
    'te-in': 'te-IN',
    'hi': 'hi-IN',
    'hindi': 'hi-IN',
    'hi-in': 'hi-IN',
    'ta': 'ta-IN',
    'tamil': 'ta-IN',
    'ta-in': 'ta-IN',
    'kn': 'kn-IN',
    'kannada': 'kn-IN',
    'ml': 'ml-IN',
    'malayalam': 'ml-IN',
    'mr': 'mr-IN',
    'marathi': 'mr-IN',
    // English variants
    'en': 'en-US',
    'en-us': 'en-US',
    'en-in': 'en-IN',
    'en-gb': 'en-GB',
    'english': 'en-US',
    'indian english': 'en-IN',
  };
  return map[code] ?? languageCode;
}

// ── Main export ────────────────────────────────────────────────────────────────

const CLOUD_STT_URL = 'https://speech.googleapis.com/v1/speech:recognize';

/**
 * Transcribe base64 audio using Google Cloud Speech-to-Text v1 REST API.
 *
 * @param audioBase64   Raw base64-encoded audio bytes (no data: prefix).
 * @param languageCode  BCP-47 tag or friendly name, e.g. "en-US", "te-IN", "telugu".
 * @param mimeType      Browser MediaRecorder mimeType, e.g. "audio/webm;codecs=opus".
 */
export async function transcribeAudio(
  audioBase64: string,
  languageCode = 'en-US',
  mimeType = 'audio/webm;codecs=opus',
): Promise<STTResult> {
  if (!audioBase64 || audioBase64.length < 200) {
    return { transcript: '', confidence: 0, isFinal: true };
  }

  // Google Cloud Speech-to-Text sync API fails on > 1 min audio.
  // 1 min of 48kHz Opus is ~1MB base64. Reject gracefully if > 1.5MB to avoid 400 spam.
  if (audioBase64.length > 1500000) {
    logger.warn(`[cloudSTT] Audio exceeds sync length limit (${audioBase64.length} bytes). Dropping.`);
    return { transcript: '', confidence: 0, isFinal: true };
  }

  const { encoding, sampleRateHertz } = resolveEncoding(mimeType);
  const bcp47 = resolveBcp47(languageCode);

  // Always include English alternatives for Indian languages so English
  // wake phrases ("Hey Buddy", app names, etc.) are recognized even when
  // primary STT language is Telugu/Hindi/Tamil/Kannada/Malayalam etc.
  // Also cross-pollinate with other common Indian languages.
  const alternativeLanguageCodes: string[] = [];
  const isIndianRegional = /^(te|hi|ta|kn|ml|bn|mr|gu|pa)-IN/.test(bcp47);
  if (isIndianRegional) {
    alternativeLanguageCodes.push('en-IN', 'hi-IN', 'en-US');
  } else if (bcp47 === 'en-IN') {
    alternativeLanguageCodes.push('te-IN', 'hi-IN', 'ta-IN');
  } else if (bcp47 === 'en-US' || bcp47 === 'en-GB') {
    alternativeLanguageCodes.push('en-IN', 'te-IN', 'hi-IN');
  }

  const body = {
    config: {
      encoding,
      sampleRateHertz,
      languageCode: bcp47,
      ...(alternativeLanguageCodes.length > 0 && { alternativeLanguageCodes }),
      model: 'latest_long',          // best accuracy for conversational audio
      enableAutomaticPunctuation: true,
      useEnhanced: true,             // enhanced model (same quota tier)
      metadata: {
        interactionType: 'VOICE_SEARCH',
        microphoneDistance: 'NEARFIELD',
        recordingDeviceType: 'PC',
      },
    },
    audio: {
      content: audioBase64,
    },
  };

  try {
    const token = await getAccessToken();

    logger.info(
      `[cloudSTT] → speech.googleapis.com | encoding=${encoding} | lang=${bcp47} | bytes=${audioBase64.length}`,
    );

    const settings = SettingStore.getStore();
    const projectId = settings.vertexProjectId || env.vertexProjectId;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    if (projectId) {
      headers['x-goog-user-project'] = projectId;
    }

    const response = await fetch(CLOUD_STT_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      logger.error(`[cloudSTT] Cloud STT error ${response.status}:`, errText);
      return { transcript: '', confidence: 0, isFinal: true };
    }

    const data = (await response.json()) as {
      results?: Array<{
        alternatives?: Array<{ transcript: string; confidence: number }>;
      }>;
    };

    const alternatives = data?.results?.[0]?.alternatives;
    if (!alternatives || alternatives.length === 0) {
      logger.info('[cloudSTT] No speech detected in audio');
      return { transcript: '', confidence: 0.9, isFinal: true };
    }

    const best = alternatives[0];
    const transcript = best.transcript?.trim() ?? '';
    const confidence = best.confidence ?? 0.9;

    if (!transcript) {
      return { transcript: '', confidence: 0.9, isFinal: true };
    }

    logger.info(`[cloudSTT] ✅ Transcribed (${bcp47}): "${transcript.slice(0, 120)}"`);
    return { transcript, confidence, isFinal: true };
  } catch (err) {
    logger.error('[cloudSTT] transcribeAudio error:', err);
    return { transcript: '', confidence: 0, isFinal: true };
  }
}
