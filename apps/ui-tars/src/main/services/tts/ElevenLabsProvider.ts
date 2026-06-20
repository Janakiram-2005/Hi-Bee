import { logger } from '@main/logger';
import { elevenLabsApiKey } from '@main/env';
import { TTSProvider, TTSRequest, TTSResult } from './TTSProvider';

const DEFAULT_VOICE_ID = 'Ek86tj0PS0XTYchY9Ody'; // Keshavi
const MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2';

// Simple LRU Cache
const ttsCache = new Map<string, string>();
const MAX_CACHE_SIZE = 50;

export class ElevenLabsProvider implements TTSProvider {
  async synthesizeSpeech(request: TTSRequest): Promise<TTSResult> {
    if (!request.text?.trim()) {
      return { audioContent: '' };
    }

    const voiceId = request.voiceId || DEFAULT_VOICE_ID;
    const cacheKey = `${voiceId}|${request.text}`;

    const cached = ttsCache.get(cacheKey);
    if (cached) {
      logger.info(`[ElevenLabs] Cache hit for "${request.text.slice(0, 40)}"`);
      return { audioContent: cached };
    }

    if (!elevenLabsApiKey) {
      logger.warn('[ElevenLabs] API key not configured. Falling back.');
      throw new Error('ELEVENLABS_API_KEY is not set');
    }

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`;

    const body = {
      text: request.text,
      model_id: MODEL_ID,
    };

    try {
      logger.info(`[ElevenLabs] → Fetching TTS for voice: ${voiceId}`);
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'xi-api-key': elevenLabsApiKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg'
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errText = await response.text();
        logger.error(`[ElevenLabs] API Error ${response.status}:`, errText);
        throw new Error(`ElevenLabs API failed with status ${response.status}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = Buffer.from(arrayBuffer);
      const audioContent = audioBuffer.toString('base64');

      if (!audioContent) {
        logger.warn('[ElevenLabs] Empty audio returned');
        return { audioContent: '' };
      }

      // Store in cache
      if (ttsCache.size >= MAX_CACHE_SIZE) {
        const firstKey = ttsCache.keys().next().value;
        if (firstKey !== undefined) ttsCache.delete(firstKey);
      }
      ttsCache.set(cacheKey, audioContent);

      const estimatedDurationSec = (audioContent.length * 3) / 4 / 16000;

      logger.info(`[ElevenLabs] ✅ Synthesized audio successfully (~${estimatedDurationSec.toFixed(1)}s)`);

      return { audioContent, estimatedDurationSec };
    } catch (err) {
      logger.error('[ElevenLabs] synthesizeSpeech error:', err);
      throw err; // Let the factory fallback to Google TTS or empty
    }
  }
}
