import { synthesizeGoogleFreeSpeech } from './apps/ui-tars/src/main/services/googleFreeTTS';
import * as fs from 'fs';

async function test() {
  try {
    const b64 = await synthesizeGoogleFreeSpeech("హలో, ఎలా ఉన్నారు? నేను టాస్క్ స్టార్ట్ చేయవచ్చా?", "te-IN");
    if (b64) {
      fs.writeFileSync('test_output.mp3', Buffer.from(b64, 'base64'));
      console.log('SUCCESS! Wrote test_output.mp3');
    } else {
      console.log('FAILED! Empty result');
    }
  } catch (err) {
    console.error('ERROR:', err);
  }
}

test();
