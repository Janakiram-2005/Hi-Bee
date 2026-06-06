/**
 * cloudTTS.ts — Google Cloud Text-to-Speech v1 REST API service.
 *
 * Synthesizes speech using Google Cloud TTS and returns base64-encoded MP3 audio.
 * Uses the same ADC / service-account credentials as cloudSTT.ts.
 *
 * Endpoint: POST https://texttospeech.googleapis.com/v1/text:synthesize
 *
 * Free tier: 4 million characters/month for Standard voices,
 *            1 million characters/month for WaveNet/Neural2 voices.
 *            No billing needed under these limits (billing must be linked but 
 *            free credits cover it).
 *
 * Voice quality hierarchy used here (best → good → standard):
 *   Neural2 > WaveNet > Standard
 */
import { logger } from '@main/logger';
import { getAccessToken } from './cloudSTT';
import * as env from '@main/env';
import { SettingStore } from '@main/store/setting';


// ── Types ──────────────────────────────────────────────────────────────────────

export interface TTSResult {
  /** Base64-encoded MP3 audio content */
  audioContent: string;
  /** Duration estimate in seconds (rough) */
  estimatedDurationSec?: number;
}

// ── Voice maps ─────────────────────────────────────────────────────────────────

interface VoiceConfig {
  name: string;
  languageCode: string;
}

/**
 * Maps BCP-47 language codes to the best available GCP TTS voice.
 * Falls back through Neural2 → WaveNet → Standard.
 */
const VOICE_MAP: Record<string, VoiceConfig> = {
  // Indian regional languages — FEMALE Chirp 3 HD voices (highest quality)
  'te-IN': { name: 'te-IN-Chirp3-HD-Achernar',  languageCode: 'te-IN' },  // FEMALE (Highest quality Telugu voice in GCP)
  'hi-IN': { name: 'hi-IN-Chirp3-HD-Achernar',  languageCode: 'hi-IN' },  // FEMALE
  'ta-IN': { name: 'ta-IN-Chirp3-HD-Achernar',  languageCode: 'ta-IN' },  // FEMALE
  'kn-IN': { name: 'kn-IN-Chirp3-HD-Achernar',  languageCode: 'kn-IN' },  // FEMALE
  'ml-IN': { name: 'ml-IN-Chirp3-HD-Achernar',  languageCode: 'ml-IN' },  // FEMALE
  'mr-IN': { name: 'mr-IN-Chirp3-HD-Achernar',  languageCode: 'mr-IN' },  // FEMALE
  'bn-IN': { name: 'bn-IN-Chirp3-HD-Achernar',  languageCode: 'bn-IN' },  // FEMALE
  'gu-IN': { name: 'gu-IN-Chirp3-HD-Achernar',  languageCode: 'gu-IN' },  // FEMALE
  'pa-IN': { name: 'pa-IN-Chirp3-HD-Achernar',  languageCode: 'pa-IN' },  // FEMALE
  // English variants — FEMALE Neural2 voices
  'en-IN': { name: 'en-IN-Neural2-A',  languageCode: 'en-IN' },  // FEMALE
  'en-US': { name: 'en-US-Neural2-F',  languageCode: 'en-US' },
  'en-GB': { name: 'en-GB-Neural2-A',  languageCode: 'en-GB' },
  'en-AU': { name: 'en-AU-Neural2-A',  languageCode: 'en-AU' },
  // East Asian
  'zh-CN': { name: 'cmn-CN-Wavenet-A', languageCode: 'cmn-CN' },
  'zh-TW': { name: 'cmn-TW-Wavenet-A', languageCode: 'cmn-TW' },
  'ja-JP': { name: 'ja-JP-Neural2-B',  languageCode: 'ja-JP' },
  'ko-KR': { name: 'ko-KR-Neural2-A',  languageCode: 'ko-KR' },
  // European
  'fr-FR': { name: 'fr-FR-Neural2-A',  languageCode: 'fr-FR' },
  'de-DE': { name: 'de-DE-Neural2-A',  languageCode: 'de-DE' },
  'es-ES': { name: 'es-ES-Neural2-A',  languageCode: 'es-ES' },
  'es-MX': { name: 'es-US-Neural2-A',  languageCode: 'es-US' },
  'pt-BR': { name: 'pt-BR-Neural2-A',  languageCode: 'pt-BR' },
  'it-IT': { name: 'it-IT-Neural2-A',  languageCode: 'it-IT' },
  'ru-RU': { name: 'ru-RU-Standard-A', languageCode: 'ru-RU' },
};

function resolveVoice(languageCode: string): VoiceConfig {
  // Exact match
  if (VOICE_MAP[languageCode]) return VOICE_MAP[languageCode];
  // Prefix match (e.g. 'en' → 'en-US')
  const prefix = languageCode.split('-')[0];
  const fallback = Object.entries(VOICE_MAP).find(([k]) => k.startsWith(prefix));
  if (fallback) return fallback[1];
  // Default to US English
  return VOICE_MAP['en-US'];
}

// ── API endpoint ───────────────────────────────────────────────────────────────

const TTS_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';

// Simple response cache: avoid re-synthesising identical (text+lang) pairs
const ttsCache = new Map<string, string>();
const MAX_CACHE_SIZE = 50;

/**
 * Synthesize speech via Google Cloud TTS v1 REST API.
 *
 * @param text          Text to synthesise (SSML or plain text).
 * @param languageCode  BCP-47 language tag, e.g. "en-US", "hi-IN", "te-IN".
 * @param ssml          If true, `text` is treated as SSML markup.
 * @returns             Base64-encoded MP3 audio content (ready for <audio>).
 */
export async function synthesizeSpeech(
  text: string,
  languageCode = 'en-US',
  ssml = false,
): Promise<TTSResult> {
  if (!text?.trim()) {
    return { audioContent: '' };
  }

  const cacheKey = `${languageCode}|${text}`;
  const cached = ttsCache.get(cacheKey);
  if (cached) {
    logger.info(`[cloudTTS] Cache hit for "${text.slice(0, 40)}"`);
    return { audioContent: cached };
  }

  const voice = resolveVoice(languageCode);

  const body = {
    input: ssml ? { ssml: text } : { text },
    voice: {
      languageCode: voice.languageCode,
      name: voice.name,
    },
    audioConfig: {
      audioEncoding: 'MP3',
      speakingRate: 1.05,      // slightly faster for natural assistant feel
      pitch: 0.0,
      volumeGainDb: 0.0,
      effectsProfileId: ['headphone-class-device'],
    },
  };

  try {
    const token = await getAccessToken();

    logger.info(
      `[cloudTTS] → texttospeech.googleapis.com | lang=${voice.languageCode} | voice=${voice.name} | chars=${text.length}`,
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

    const response = await fetch(TTS_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      logger.error(`[cloudTTS] TTS error ${response.status}:`, errText);
      return { audioContent: '' };
    }

    const data = (await response.json()) as { audioContent?: string };
    const audioContent = data.audioContent ?? '';

    if (!audioContent) {
      logger.warn('[cloudTTS] Empty audioContent in response');
      return { audioContent: '' };
    }

    // Store in cache (bounded)
    if (ttsCache.size >= MAX_CACHE_SIZE) {
      const firstKey = ttsCache.keys().next().value;
      if (firstKey !== undefined) ttsCache.delete(firstKey);
    }
    ttsCache.set(cacheKey, audioContent);

    // Rough duration estimate: MP3 at ~32 kbps for speech
    const bytes = (audioContent.length * 3) / 4;
    const estimatedDurationSec = bytes / 4000; // ≈ 32 kbps

    logger.info(
      `[cloudTTS] ✅ Synthesized ${bytes} bytes (~${estimatedDurationSec.toFixed(1)}s)`,
    );

    return { audioContent, estimatedDurationSec };
  } catch (err) {
    logger.error('[cloudTTS] synthesizeSpeech error:', err);
    return { audioContent: '' };
  }
}
