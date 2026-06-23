const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const app = express();
const port = 3001;

// Use the folder space only! Pointing to the main UI-TARS app's dataset folder
const WORDS_DIR = path.resolve(__dirname, '../ui-tars/dataset/words');
const WORD_SCRIPT_PATH = path.resolve(__dirname, '../ui-tars/dataset/train_word_model.py');
const WORD_MODEL_JSON_PATH = path.resolve(__dirname, '../ui-tars/dataset/custom_word_model.json');

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Ensure dataset directory exists
if (!fs.existsSync(WORDS_DIR)) {
  fs.mkdirSync(WORDS_DIR, { recursive: true });
}

// Endpoint to save a sign language word
app.post('/api/save-word', (req, res) => {
  try {
    const { videoBase64, landmarksJson, label } = req.body;
    if (!videoBase64 || !label) return res.status(400).json({ error: 'Missing video or label' });

    const labelDir = path.join(WORDS_DIR, label);
    if (!fs.existsSync(labelDir)) fs.mkdirSync(labelDir, { recursive: true });

    const timestamp = new Date().getTime();
    const videoFilename = `video_${timestamp}.webm`;
    const jsonFilename = `data_${timestamp}.json`;
    const videoPath = path.join(labelDir, videoFilename);
    const jsonPath = path.join(labelDir, jsonFilename);

    const base64Data = videoBase64.replace(/^data:video\/webm;base64,/, '');
    fs.writeFileSync(videoPath, Buffer.from(base64Data, 'base64'));
    if (landmarksJson) fs.writeFileSync(jsonPath, landmarksJson, 'utf8');

    res.json({ success: true, filePath: videoPath });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// Endpoint to get the library of recorded words
app.get('/api/words-library', (req, res) => {
  const library = [];
  if (fs.existsSync(WORDS_DIR)) {
    for (const label of fs.readdirSync(WORDS_DIR)) {
      const labelDir = path.join(WORDS_DIR, label);
      if (fs.statSync(labelDir).isDirectory()) {
        const videos = fs.readdirSync(labelDir).filter(f => f.endsWith('.webm'));
        library.push({ label, videos: videos.map(v => path.join(labelDir, v)) });
      }
    }
  }
  res.json({ success: true, library });
});

// Endpoint to trigger training for the words model
app.post('/api/train-words', (req, res) => {
  exec(`python "${WORD_SCRIPT_PATH}"`, (error, stdout, stderr) => {
    if (error) return res.json({ success: false, error: stderr || error.message });
    res.json({ success: true, output: stdout });
  });
});

// Endpoint to serve the exported JSON AI model to the frontend
app.get('/api/word-model', (req, res) => {
  if (fs.existsSync(WORD_MODEL_JSON_PATH)) {
    try {
      res.json({ success: true, model: JSON.parse(fs.readFileSync(WORD_MODEL_JSON_PATH, 'utf8')) });
    } catch (e) {
      res.json({ success: false, error: 'Failed to parse model JSON' });
    }
  } else {
    res.json({ success: false, error: 'Word Model not found' });
  }
});

app.listen(port, () => {
  console.log(`Live Translator Server listening on http://localhost:${port}`);
  console.log(`Saving words to: ${WORDS_DIR}`);
});
