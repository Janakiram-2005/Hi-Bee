import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';

async function test() {
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY
  });

  const modelsToTest = [
    'claude-3-5-sonnet-latest',
    'claude-3-5-sonnet-20241022',
    'claude-3-7-sonnet-20250219',
    'claude-sonnet-4-6'
  ];

  for (const model of modelsToTest) {
    try {
      console.log(`Testing model: ${model}`);
      const response = await client.messages.create({
        model: model,
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Hello' }]
      });
      console.log(`SUCCESS with ${model}! Response:`, response.content[0]);
      return; // Stop on first success
    } catch (e) {
      console.error(`FAILED with ${model}:`, e.message);
    }
  }
}

test();
