import { initIpc } from '@ui-tars/electron-ipc/main';
import { logger } from '../logger';
import { vertexChat } from '@main/services/vertexAIService';
import { TTSFactory } from '@main/services/tts/TTSFactory';
import { windowManager } from '@main/services/windowManager';

const t = initIpc.create();

export const visionRoute = {
  startVisionBrain: t.procedure.handle(async () => {
    logger.info('[Vision] Vision engine handled by frontend now.');
    return { success: true };
  }),

  stopVisionBrain: t.procedure.handle(async () => {
    logger.info('[Vision] Vision engine handled by frontend now.');
    return { success: true };
  }),

  saveGestureVideo: t.procedure
    .input<{ videoBase64: string; landmarksJson: string; label: string }>()
    .handle(async ({ input }) => {
      const fs = require('fs');
      const path = require('path');
      
      try {
        const baseDir = process.cwd(); // or app.getPath('userData')
        const datasetDir = path.join(baseDir, 'dataset', 'gestures', input.label);
        
        if (!fs.existsSync(datasetDir)) {
          fs.mkdirSync(datasetDir, { recursive: true });
        }

        const timestamp = new Date().getTime();
        const videoFilename = `video_${timestamp}.webm`;
        const jsonFilename = `data_${timestamp}.json`;
        
        const videoPath = path.join(datasetDir, videoFilename);
        const jsonPath = path.join(datasetDir, jsonFilename);

        // Save Video
        const base64Data = input.videoBase64.replace(/^data:video\/webm;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        fs.writeFileSync(videoPath, buffer);
        
        // Save JSON Landmarks
        if (input.landmarksJson) {
          fs.writeFileSync(jsonPath, input.landmarksJson, 'utf8');
        }

        logger.info(`[Vision] Saved gesture dataset: ${videoPath} and ${jsonPath}`);

        return { success: true, filePath: videoPath };
      } catch (err) {
        logger.error(`[Vision] Failed to save gesture video:`, err);
        return { success: false, error: String(err) };
      }
    }),

  getGestureLibrary: t.procedure.handle(async () => {
    const fs = require('fs');
    const path = require('path');
    const baseDir = process.cwd();
    const datasetDir = path.join(baseDir, 'dataset', 'gestures');
    const dbPath = path.join(baseDir, 'apps', 'ui-tars', 'src', 'renderer', 'src', 'const', 'gesture_db.json');

    let db: Record<string, string> = {};
    if (fs.existsSync(dbPath)) {
      try { db = JSON.parse(fs.readFileSync(dbPath, 'utf8')); } catch(e){}
    }

    const library: any[] = [];
    if (fs.existsSync(datasetDir)) {
      const labels = fs.readdirSync(datasetDir);
      for (const label of labels) {
        const labelDir = path.join(datasetDir, label);
        if (fs.statSync(labelDir).isDirectory()) {
          const files = fs.readdirSync(labelDir);
          const videos = files.filter((f: string) => f.endsWith('.webm'));
          library.push({
            label,
            text: db[label] || '',
            videos: videos.map((v: string) => `file://${path.join(labelDir, v).replace(/\\/g, '/')}`)
          });
        }
      }
    }
    return { success: true, library };
  }),

  updateGestureTranslation: t.procedure
    .input<{ label: string; text: string }>()
    .handle(async ({ input }) => {
      const fs = require('fs');
      const path = require('path');
      const dbPath = path.join(process.cwd(), 'apps', 'ui-tars', 'src', 'renderer', 'src', 'const', 'gesture_db.json');
      
      let db: Record<string, string> = {};
      if (fs.existsSync(dbPath)) {
        try { db = JSON.parse(fs.readFileSync(dbPath, 'utf8')); } catch(e){}
      }
      
      db[input.label] = input.text;
      fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf8');
      return { success: true };
    }),

  deleteGestureVideo: t.procedure
    .input<{ videoPath: string }>()
    .handle(async ({ input }) => {
      const fs = require('fs');
      try {
        const localPath = input.videoPath.replace('file://', '');
        if (fs.existsSync(localPath)) {
          fs.unlinkSync(localPath);
          
          // Try to delete corresponding .json
          const jsonPath = localPath.replace('.webm', '.json').replace('video_', 'data_');
          if (fs.existsSync(jsonPath)) {
            fs.unlinkSync(jsonPath);
          }
        }
        return { success: true };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    }),

  deleteGestureLabel: t.procedure
    .input<{ label: string }>()
    .handle(async ({ input }) => {
      const fs = require('fs');
      const path = require('path');
      try {
        const baseDir = process.cwd();
        const labelDir = path.join(baseDir, 'dataset', 'gestures', input.label);
        
        if (fs.existsSync(labelDir)) {
          fs.rmSync(labelDir, { recursive: true, force: true });
        }
        
        // Remove from DB
        const dbPath = path.join(baseDir, 'apps', 'ui-tars', 'src', 'renderer', 'src', 'const', 'gesture_db.json');
        if (fs.existsSync(dbPath)) {
          const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
          if (db[input.label]) {
            delete db[input.label];
            fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf8');
          }
        }
        return { success: true };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    }),

  renameGestureLabel: t.procedure
    .input<{ oldLabel: string; newLabel: string }>()
    .handle(async ({ input }) => {
      const fs = require('fs');
      const path = require('path');
      try {
        const baseDir = process.cwd();
        const oldDir = path.join(baseDir, 'dataset', 'gestures', input.oldLabel);
        const newDir = path.join(baseDir, 'dataset', 'gestures', input.newLabel);
        
        if (fs.existsSync(oldDir)) {
          fs.renameSync(oldDir, newDir);
        }

        // Update DB
        const dbPath = path.join(baseDir, 'apps', 'ui-tars', 'src', 'renderer', 'src', 'const', 'gesture_db.json');
        if (fs.existsSync(dbPath)) {
          const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
          if (db[input.oldLabel]) {
            db[input.newLabel] = db[input.oldLabel];
            delete db[input.oldLabel];
            fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf8');
          }
        }
        return { success: true };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    }),

  trainCustomModel: t.procedure.handle(async () => {
    const { exec } = require('child_process');
    const path = require('path');
    return new Promise((resolve) => {
      const scriptPath = path.join(process.cwd(), 'apps', 'ui-tars', 'dataset', 'train_model.py');
      // Execute the python script
      exec(`python "${scriptPath}"`, (error: any, stdout: string, stderr: string) => {
        if (error) {
          logger.error('[Vision] Training error:', error);
          resolve({ success: false, error: stderr || error.message });
          return;
        }
        // Assuming the script prints the accuracy or success message
        resolve({ success: true, output: stdout });
      });
    });
  }),

  processGestureSentence: t.procedure
    .input<{ keywords: string[] }>()
    .handle(async ({ input }) => {
      try {
        const { keywords } = input;
        logger.info(`[visionRoute] processGestureSentence keywords: ${keywords.join(', ')}`);

        if (keywords.length === 0) return { success: false, error: 'Empty sequence' };

        // 1. AI Text Parsing
        const prompt = `Turn this sequence of signed keywords into a natural, grammatically correct spoken sentence.
Keywords: [${keywords.join(', ')}]
Only return the final sentence, no other text.`;
        
        const result = await vertexChat(prompt, [], 'en-US');
        const refinedSentence = result.text.trim();
        logger.info(`[visionRoute] AI refined sentence: ${refinedSentence}`);

        // 2. Voice Generation
        const storeModule = await import('@main/store/create');
        const settings = storeModule.store.getState().settings;
        const languageCode = settings?.voiceLanguage || 'en-US';
        const voiceId = settings?.voiceAccentUri || settings?.voiceAccent || undefined;

        const ttsResult = await TTSFactory.synthesizeSpeech({
          text: refinedSentence,
          languageCode,
          voiceId
        });

        // 3. Play audio immediately
        if (ttsResult.audioContent) {
          windowManager.broadcast('voice:play-audio', { 
            audioContent: ttsResult.audioContent,
            text: refinedSentence
          });
        }

        // 4. Send to chat display
        windowManager.broadcast('voice:speak-text', refinedSentence);

        return { success: true, sentence: refinedSentence };
      } catch (err) {
        logger.error(`[visionRoute] processGestureSentence error:`, err);
        return { success: false, error: String(err) };
      }
    })
};
