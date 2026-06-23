import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import 'dotenv/config';

async function test() {
  try {
    const client = new AnthropicVertex({
      projectId: process.env.VERTEX_VLM_PROJECT_ID || 'convertionalai',
      region: 'us-east5',
    });

    const response = await client.messages.create({
      model: 'claude-3-5-sonnet-v2@20241022',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hello' }]
    });

    console.log("Response from standard vertex model:", response);
  } catch (e) {
    console.error("Error with standard vertex model:", e);
  }

  try {
    const client2 = new AnthropicVertex({
      projectId: process.env.VERTEX_VLM_PROJECT_ID || 'convertionalai',
      region: 'us-east5',
    });

    const response2 = await client2.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hello' }]
    });

    console.log("Response from claude-sonnet-4-6:", response2);
  } catch (e) {
    console.error("Error with claude-sonnet-4-6:", e);
  }
}

test();
