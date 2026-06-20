export interface TTSResult {
  audioContent: string; // Base64 encoded audio
  estimatedDurationSec?: number;
}

export interface TTSRequest {
  text: string;
  languageCode?: string; // Kept for compatibility, ElevenLabs auto-detects
  voiceId?: string;
  speed?: number; // Optional: Some providers might support native speed
}

export interface TTSProvider {
  /**
   * Generates speech from text.
   * @param request TTS Request configuration
   * @returns Base64 encoded MP3 audio or empty string on failure
   */
  synthesizeSpeech(request: TTSRequest): Promise<TTSResult>;
}
