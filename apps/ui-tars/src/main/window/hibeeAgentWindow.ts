/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 *
 * hibeeAgentWindow.ts — Manages the Hi-Bee AI Agent chat window.
 *
 * Opens a dedicated BrowserWindow loading hibee-agent.html which hosts
 * the Google Chat Messenger SDK connected to the Vertex AI Agent Builder
 * deployment:
 *   projects/229696319775/locations/us/apps/a7b38860-8742-4253-8e15-b5a358eaa2ac
 *   /deployments/eb2abb0a-bc8c-4107-84a7-a3333a106b90
 */
import path from 'node:path';
import { app, BrowserWindow, screen } from 'electron';
import { logger } from '@main/logger';

let agentWindow: BrowserWindow | null = null;

export function getHiBeeAgentWindow(): BrowserWindow | null {
  return agentWindow;
}

export function closeHiBeeAgentWindow(): void {
  if (agentWindow && !agentWindow.isDestroyed()) {
    agentWindow.close();
  }
  agentWindow = null;
}

export function createHiBeeAgentWindow(): BrowserWindow {
  // If already open, focus it
  if (agentWindow && !agentWindow.isDestroyed()) {
    agentWindow.focus();
    return agentWindow;
  }

  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: scrWidth, height: scrHeight } = primaryDisplay.workArea;
  const winWidth = 400;
  const winHeight = 620;
  const x = scrWidth - winWidth - 14;
  const y = Math.max(0, Math.floor((scrHeight - winHeight) / 2));

  agentWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x,
    y,
    frame: false,
    transparent: false,
    backgroundColor: '#0d1117',
    alwaysOnTop: true,
    resizable: true,
    minWidth: 320,
    minHeight: 480,
    skipTaskbar: false,
    hasShadow: true,
    title: 'Hi-Bee AI Agent',
    icon: path.join(__dirname, '../../resources/icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      // Allow loading the Chat Messenger CDN scripts
      webSecurity: false,
    },
  });

  // Load the local Hi-Bee agent HTML page
  const agentHtmlPath = app.isPackaged
    ? path.join(process.resourcesPath, 'hibee-agent.html')
    : path.join(__dirname, '../../resources/hibee-agent.html');

  agentWindow.loadFile(agentHtmlPath).catch((err) => {
    logger.error('[hibeeAgentWindow] Failed to load hibee-agent.html:', err);
  });

  agentWindow.once('ready-to-show', () => {
    agentWindow?.show();
    agentWindow?.focus();
    logger.info('[hibeeAgentWindow] Hi-Bee Agent chat window shown');
  });

  agentWindow.on('closed', () => {
    agentWindow = null;
    logger.info('[hibeeAgentWindow] Hi-Bee Agent chat window closed');
  });

  return agentWindow;
}

export function toggleHiBeeAgentWindow(): void {
  if (agentWindow && !agentWindow.isDestroyed()) {
    if (agentWindow.isVisible()) {
      agentWindow.hide();
    } else {
      agentWindow.show();
      agentWindow.focus();
    }
  } else {
    createHiBeeAgentWindow();
  }
}
