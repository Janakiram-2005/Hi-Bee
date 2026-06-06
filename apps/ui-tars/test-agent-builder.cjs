const { GoogleAuth } = require('google-auth-library');
const path = require('path');
const fetch = require('node-fetch'); // we know node-fetch is in the project dependencies

process.env.GOOGLE_APPLICATION_CREDENTIALS = path.resolve(__dirname, '../../convertionalai-d8da9e4d43dd.json');

async function test() {
  try {
    const auth = new GoogleAuth({
      scopes: 'https://www.googleapis.com/auth/cloud-platform',
    });
    const client = await auth.getClient();
    const tokenResponse = await client.getAccessToken();
    const token = tokenResponse.token;
    console.log('Successfully acquired access token!');

    // Dialogflow CX / Gen App Builder session detectIntent URL
    const url = 'https://us-dialogflow.googleapis.com/v3/projects/229696319775/locations/us/agents/a7b38860-8742-4253-8e15-b5a358eaa2ac/sessions/voice-test-session:detectIntent';

    const body = {
      queryInput: {
        text: {
          text: 'Who are you?',
        },
        languageCode: 'en',
      },
    };

    console.log('Sending request to Dialogflow CX detectIntent...');
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    console.log('Response Status:', res.status);
    console.log('Response Body:', JSON.stringify(data, null, 2));

    if (data.queryResult?.responseMessages) {
      const texts = data.queryResult.responseMessages
        .map(m => m.text?.text?.join(' '))
        .filter(Boolean)
        .join(' ');
      console.log('AGENT BUILDER REPLY:', texts);
    }
  } catch (err) {
    console.error('ERROR during testing:', err);
  }
}

test();
