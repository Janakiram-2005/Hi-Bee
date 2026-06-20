import { logger } from '@main/logger';
import { TTSRequest, TTSResult } from './TTSProvider';
import { ElevenLabsProvider } from './ElevenLabsProvider';
import { GoogleTTSProvider } from './GoogleTTSProvider';
import { elevenLabsApiKey } from '@main/env';

export class TTSFactory {
  private static elevenLabs = new ElevenLabsProvider();
  private static googleTts = new GoogleTTSProvider();

  static async synthesizeSpeech(request: TTSRequest): Promise<TTSResult> {
    try {
      // Use ElevenLabs as the default provider if API key is present
      if (elevenLabsApiKey) {
        // ElevenLabs multilingual_v2 supports Hindi, Tamil, English, etc.
        // It DOES NOT support Telugu, Kannada, Malayalam, Bengali, Gujarati, Punjabi.
        const lang = request.languageCode || 'en-US';
        const unsupportedElevenLabs = ['te', 'kn', 'ml', 'bn', 'gu', 'pa'];
        const isUnsupported = unsupportedElevenLabs.some(code => lang.toLowerCase().startsWith(code));

        if (isUnsupported) {
          logger.info(`[TTSFactory] ElevenLabs does not support ${lang}. Falling back to Google TTS.`);
          return await this.googleTts.synthesizeSpeech(request);
        }

        return await this.elevenLabs.synthesizeSpeech(request);
      } else {
        logger.warn('[TTSFactory] ELEVENLABS_API_KEY not found. Falling back to Google TTS.');
        return await this.googleTts.synthesizeSpeech(request);
      }
    } catch (err) {
      logger.warn('[TTSFactory] Primary TTS provider failed, falling back to Google TTS...', err);
      // Fallback
      return await this.googleTts.synthesizeSpeech(request);
    }
  }
}
