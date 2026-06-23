import { logger } from '@main/logger';
import { TTSRequest, TTSResult } from './TTSProvider';
import { GoogleTTSProvider } from './GoogleTTSProvider';
import { AzureTTSProvider } from './AzureTTSProvider';
import { azureSpeechKey } from '@main/env';

export class TTSFactory {
  private static azureTts = new AzureTTSProvider();
  private static googleTts = new GoogleTTSProvider();

  static async synthesizeSpeech(request: TTSRequest): Promise<TTSResult> {
    try {
      // Prioritize Azure Speech TTS
      if (azureSpeechKey) {
        return await this.azureTts.synthesizeSpeech(request);
      }

      logger.warn('[TTSFactory] AZURE_SPEECH_KEY not found. Falling back to Google TTS.');
      return await this.googleTts.synthesizeSpeech(request);
    } catch (err) {
      logger.warn(
        '[TTSFactory] Azure TTS provider failed, falling back to Google TTS...',
        err,
      );
      // Fallback
      return await this.googleTts.synthesizeSpeech(request);
    }
  }
}
