/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { app, BrowserWindow } from 'electron';

import { logger } from '@main/logger';
import * as env from '@main/env';

import { SettingStore } from '@main/store/setting';
import { createWindow } from './createWindow';
import { closeVoiceWindow } from './voiceWindow';

let mainWindow: BrowserWindow | null = null;

export function showInactive() {
  if (mainWindow) {
    // eslint-disable-next-line no-unused-expressions
    mainWindow.showInactive();
  }
}

export function show() {
  if (mainWindow) {
    mainWindow.show();
  }
}

export function createMainWindow(options?: { showInBackground?: boolean }) {
  mainWindow = createWindow({
    routerPath: '/',
    width: 1200,
    height: 700,
    alwaysOnTop: false,
    showInBackground: options?.showInBackground,
  });

  mainWindow.on('close', (event) => {
    logger.info('mainWindow closed');
    if (env.isMacOS) {
      event.preventDefault();

      // Black screen on window close in fullscreen mode
      // https://github.com/electron/electron/issues/20263#issuecomment-633179965
      if (mainWindow?.isFullScreen()) {
        mainWindow?.setFullScreen(false);

        mainWindow?.once('leave-full-screen', () => {
          mainWindow?.hide();
        });
      } else {
        mainWindow?.hide();
      }
    } else {
      const currentSettings = SettingStore.getStore();
      if (currentSettings.voiceEnabled) {
        event.preventDefault();
        mainWindow?.hide();
      } else {
        mainWindow = null;
        closeVoiceWindow();
        app.quit();
      }
    }
  });

  return mainWindow;
}

export function setContentProtection(enable: boolean) {
  mainWindow?.setContentProtection(enable);
}

export async function showWindow() {
  mainWindow?.setContentProtection(false);
  mainWindow?.setIgnoreMouseEvents(false);
  mainWindow?.show();
  mainWindow?.restore();
}

export async function hideMainWindow() {
  try {
    mainWindow?.setContentProtection(true);
    mainWindow?.setAlwaysOnTop(true);
    mainWindow?.setFocusable(false);
    mainWindow?.hide();
  } catch (error) {
    logger.error('[hideMainWindow]', error);
  }
}

export async function showMainWindow() {
  try {
    mainWindow?.setContentProtection(false);
    setTimeout(() => {
      mainWindow?.setAlwaysOnTop(false);
    }, 100);
    mainWindow?.setFocusable(true);
    mainWindow?.show();
  } catch (error) {
    logger.error('[showMainWindow]', error);
  }
}
