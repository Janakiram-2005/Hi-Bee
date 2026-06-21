/**
 * Voice avatar window lifecycle — shared so main window close can tear it down.
 */
import path from 'node:path';
import { app, BrowserWindow, screen } from 'electron';

import * as env from '@main/env';
import { windowManager } from '@main/services/windowManager';

let voiceWindow: BrowserWindow | null = null;

export function getVoiceWindow() {
  return voiceWindow;
}

export function closeVoiceWindow() {
  if (voiceWindow && !voiceWindow.isDestroyed()) {
    voiceWindow.close();
  }
  voiceWindow = null;
}

export function createVoiceWindow() {
  if (voiceWindow && !voiceWindow.isDestroyed()) {
    return voiceWindow;
  }

  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: scrWidth, height: scrHeight } = primaryDisplay.workArea;
  const winWidth = 800;
  const winHeight = 650;
  const x = scrWidth - winWidth - 10;
  const y = scrHeight - winHeight - 10;

  voiceWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      // webSecurity must be false so that getUserMedia / SpeechRecognition
      // work from the transparent file:// origin without Chromium blocking them.
      webSecurity: false,
    },
  });

  voiceWindow.setAlwaysOnTop(true, 'screen-saver');

  const routerPath = '#/voice-avatar';
  if (!app.isPackaged && env.rendererUrl) {
    voiceWindow.loadURL(env.rendererUrl + routerPath);
  } else {
    voiceWindow.loadFile(path.join(__dirname, '../renderer/index.html'), {
      hash: 'voice-avatar',
    });
  }

  windowManager.registerWindow(voiceWindow);

  voiceWindow.once('ready-to-show', () => {
    voiceWindow?.showInactive();
  });

  voiceWindow.webContents.on('did-finish-load', () => {
    voiceWindow?.setIgnoreMouseEvents(true, { forward: true });
  });

  voiceWindow.on('closed', () => {
    voiceWindow = null;
  });

  return voiceWindow;
}

export function moveVoiceWindow(dx: number, dy: number) {
  if (voiceWindow && !voiceWindow.isDestroyed()) {
    const [x, y] = voiceWindow.getPosition();
    voiceWindow.setPosition(x + dx, y + dy);
  }
}

export function setVoiceWindowIgnoreMouseEvents(ignore: boolean) {
  if (voiceWindow && !voiceWindow.isDestroyed()) {
    if (ignore) {
      voiceWindow.setIgnoreMouseEvents(true, { forward: true });
    } else {
      voiceWindow.setIgnoreMouseEvents(false);
    }
  }
}
