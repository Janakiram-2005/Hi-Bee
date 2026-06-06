const { VertexAI } = require('@google-cloud/vertexai');
const path = require('path');

process.env.GOOGLE_APPLICATION_CREDENTIALS = path.resolve(__dirname, '../../convertionalai-d8da9e4d43dd.json');

const projectId = 'convertionalai';
const location = 'us-central1';

const vertex = new VertexAI({
  project: projectId,
  location: location,
});

async function run() {
  const modelsToTry = [
    'gemini-1.5-flash',
    'gemini-1.5-pro',
    'gemini-1.5-flash-001',
    'gemini-1.5-flash-002',
    'gemini-1.5-pro-001',
    'gemini-1.5-pro-002',
    'gemini-1.0-pro',
    'gemini-2.0-flash-exp',
    'gemini-2.5-flash',
    'gemini-2.5-pro'
  ];

  for (const modelName of modelsToTry) {
    try {
      console.log(`Trying model: ${modelName} in region ${location}...`);
      const model = vertex.getGenerativeModel({ model: modelName });
      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      });
      console.log(`SUCCESS with ${modelName}:`, JSON.stringify(result.response.candidates[0].content));
    } catch (err) {
      console.error(`FAILED with ${modelName}:`, err.message);
    }
  }
}

run();
