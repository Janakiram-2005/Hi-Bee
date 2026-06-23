import { logger } from '@main/logger';
import { azureSpeechKey, azureSpeechRegion } from '@main/env';
import { TTSProvider, TTSRequest, TTSResult } from './TTSProvider';

// Simple LRU Cache for translated text & audio
const ttsCache = new Map<string, string>();
const MAX_CACHE_SIZE = 100;

async function translateText(
  text: string,
  targetLang: string,
): Promise<string> {
  const tl = targetLang.split('-')[0].toLowerCase();
  // Don't translate if target is English or text is empty
  if (tl === 'en' || !text.trim()) return text;

  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`;
  try {
    const response = await fetch(url);
    if (!response.ok) return text;
    const json = (await response.json()) as any;
    if (json && json[0]) {
      let translated = '';
      for (const item of json[0]) {
        if (item && item[0]) {
          translated += item[0];
        }
      }
      return translated.trim() || text;
    }
  } catch (error) {
    logger.error('[AzureTTSProvider] Translation error:', error);
  }
  return text;
}

function getAzureVoice(
  languageCode: string,
  requestedVoiceId?: string,
): { voice: string; locale: string } {
  if (requestedVoiceId && requestedVoiceId.includes('Neural')) {
    const parts = requestedVoiceId.split('-');
    const locale = parts.slice(0, 2).join('-');
    return { voice: requestedVoiceId, locale };
  }

  const lang = (languageCode || 'en-US').toLowerCase();
  if (lang.startsWith('hi'))
    return { voice: 'hi-IN-SwaraNeural', locale: 'hi-IN' };
  if (lang.startsWith('te'))
    return { voice: 'te-IN-ShrutiNeural', locale: 'te-IN' };
  if (lang.startsWith('ta'))
    return { voice: 'ta-IN-PallaviNeural', locale: 'ta-IN' };
  if (lang.startsWith('kn'))
    return { voice: 'kn-IN-SapnaNeural', locale: 'kn-IN' };
  if (lang.startsWith('ml'))
    return { voice: 'ml-IN-SobhanaNeural', locale: 'ml-IN' };
  if (lang.startsWith('bn'))
    return { voice: 'bn-IN-TanishaaNeural', locale: 'bn-IN' };
  if (lang.startsWith('mr'))
    return { voice: 'mr-IN-AarohiNeural', locale: 'mr-IN' };
  if (lang.startsWith('gu'))
    return { voice: 'gu-IN-DhwaniNeural', locale: 'gu-IN' };
  if (lang.includes('in'))
    return { voice: 'en-IN-NeerjaNeural', locale: 'en-IN' };

  return { voice: 'en-US-JennyNeural', locale: 'en-US' };
}

function buildSSML(
  text: string,
  voice: string,
  locale: string,
  speed?: number,
): string {
  const rateShift = speed ? Math.round((speed - 1.0) * 100) : 0;
  const rateValue =
    rateShift !== 0 ? `${rateShift > 0 ? '+' : ''}${rateShift}%` : '0%';

  const safeText = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return `<speak version='1.0' xml:lang='${locale}' xmlns='http://www.w3.org/2001/10/synthesis'>
  <voice name='${voice}'>
    <prosody rate='${rateValue}'>${safeText}</prosody>
  </voice>
</speak>`;
}

export class AzureTTSProvider implements TTSProvider {
  async synthesizeSpeech(request: TTSRequest): Promise<TTSResult> {
    if (!request.text?.trim()) {
      return { audioContent: '' };
    }

    const lang = request.languageCode || 'en-US';
    const { voice, locale } = getAzureVoice(lang, request.voiceId);

    // 1. Translate the text to the target language locale first
    let textToSynthesize = request.text;
    try {
      textToSynthesize = await translateText(request.text, lang);
      logger.info(
        `[AzureTTS] Text: "${request.text.slice(0, 40)}" -> Translated: "${textToSynthesize.slice(0, 40)}"`,
      );
    } catch (e) {
      logger.warn('[AzureTTS] Translation fallback used.', e);
    }

    // 2. Check Cache
    const cacheKey = `${voice}|${lang}|${textToSynthesize}|${request.speed || 1.0}`;
    const cached = ttsCache.get(cacheKey);
    if (cached) {
      logger.info(
        `[AzureTTS] Cache hit for "${textToSynthesize.slice(0, 40)}"`,
      );
      return { audioContent: cached };
    }

    // 3. Verify credentials
    if (!azureSpeechKey || !azureSpeechRegion) {
      logger.warn(
        '[AzureTTS] AZURE_SPEECH_KEY or AZURE_SPEECH_REGION not configured.',
      );
      throw new Error('Azure Speech credentials are not set');
    }

    const url = `https://${azureSpeechRegion}.tts.speech.microsoft.com/cognitiveservices/v1`;
    const ssml = buildSSML(textToSynthesize, voice, locale, request.speed);

    try {
      logger.info(
        `[AzureTTS] → Fetching TTS for voice: ${voice}, locale: ${locale}`,
      );

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': azureSpeechKey,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3',
          'User-Agent': 'hi-bee',
        },
        body: ssml,
      });

      if (!response.ok) {
        const errText = await response.text();
        logger.error(`[AzureTTS] API Error ${response.status}:`, errText);
        throw new Error(`Azure TTS API failed with status ${response.status}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = Buffer.from(arrayBuffer);
      const audioContent = audioBuffer.toString('base64');

      if (!audioContent) {
        logger.warn('[AzureTTS] Empty audio returned');
        return { audioContent: '' };
      }

      // Store in cache
      if (ttsCache.size >= MAX_CACHE_SIZE) {
        const firstKey = ttsCache.keys().next().value;
        if (firstKey !== undefined) ttsCache.delete(firstKey);
      }
      ttsCache.set(cacheKey, audioContent);

      const estimatedDurationSec = (audioContent.length * 3) / 4 / 16000;
      logger.info(
        `[AzureTTS] ✅ Synthesized audio successfully (~${estimatedDurationSec.toFixed(1)}s)`,
      );

      return { audioContent, estimatedDurationSec };
    } catch (err) {
      logger.error('[AzureTTS] synthesizeSpeech error:', err);
      throw err;
    }
  }
}
