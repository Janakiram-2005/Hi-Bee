import { logger } from '@main/logger';

export async function synthesizeGoogleFreeSpeech(text: string, lang: string): Promise<string> {
  const tl = lang.split('-')[0];
  const textLimit = 200;
  
  // Sub-split the text into chunks <= 200 chars to avoid 400 Bad Request
  const words = text.split(' ');
  const microChunks: string[] = [];
  let currentChunk = '';
  for (const word of words) {
    if ((currentChunk + ' ' + word).length > textLimit) {
      if (currentChunk) microChunks.push(currentChunk.trim());
      currentChunk = word;
    } else {
      currentChunk += (currentChunk ? ' ' : '') + word;
    }
  }
  if (currentChunk) microChunks.push(currentChunk.trim());

  if (microChunks.length === 0) return '';

  logger.info(`[googleFreeTTS] Synthesizing ${text.length} chars in ${lang} using Free Google TTS`);

  const buffers: Buffer[] = [];

  for (const chunk of microChunks) {
    const url = `https://translate.googleapis.com/translate_tts?ie=UTF-8&tl=${tl}&client=gtx&q=${encodeURIComponent(chunk)}`;
    
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      
      if (!response.ok) {
        logger.error(`[googleFreeTTS] Error ${response.status}: ${await response.text()}`);
        throw new Error(`Google Free TTS failed with status ${response.status}`);
      }
      
      const arrayBuffer = await response.arrayBuffer();
      buffers.push(Buffer.from(arrayBuffer));
    } catch (err) {
      logger.error(`[googleFreeTTS] Fetch error: ${err}`);
      throw err;
    }
  }

  // MP3 files can be directly concatenated because they consist of independent frames
  const finalBuffer = Buffer.concat(buffers);
  return finalBuffer.toString('base64');
}
