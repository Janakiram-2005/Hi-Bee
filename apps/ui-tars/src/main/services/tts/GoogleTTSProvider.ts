import { TTSProvider, TTSRequest, TTSResult } from './TTSProvider';
import { synthesizeGoogleFreeSpeech } from '../googleFreeTTS';
import { logger } from '@main/logger';

export class GoogleTTSProvider implements TTSProvider {
  async synthesizeSpeech(request: TTSRequest): Promise<TTSResult> {
    try {
      const lang = request.languageCode || 'en-US';
      const audioContent = await synthesizeGoogleFreeSpeech(request.text, lang);
      return { audioContent };
    } catch (error) {
      logger.error(`[GoogleTTSProvider] Failed to synthesize speech: ${error}`);
      return { audioContent: '' };
    }
  }
}
