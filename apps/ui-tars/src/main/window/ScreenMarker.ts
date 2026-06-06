/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Portions Copyright 2024-present Bytedance, Inc. All rights reserved.
 * Use of this source code is governed by a MIT license that can be
 * found in https://github.com/web-infra-dev/midscene/blob/main/LICENSE
 *
 */
import { BrowserWindow, screen, app } from 'electron';

import { PredictionParsed, Conversation } from '@ui-tars/shared/types';

import * as env from '@main/env';
import { logger } from '@main/logger';

import { AppUpdater } from '@main/utils/updateApp';
import { setOfMarksOverlays } from '@main/shared/setOfMarks';
import path from 'path';
import MenuBuilder from '../menu';
import { windowManager } from '../services/windowManager';

let appUpdater;

class ScreenMarker {
  private static instance: ScreenMarker;
  private currentOverlay: BrowserWindow | null = null;
  private widgetWindow: BrowserWindow | null = null;
  private screenWaterFlow: BrowserWindow | null = null;
  private lastShowPredictionMarkerPos: { xPos: number; yPos: number } | null =
    null;

  static getInstance(): ScreenMarker {
    if (!ScreenMarker.instance) {
      ScreenMarker.instance = new ScreenMarker();
    }
    return ScreenMarker.instance;
  }

  showScreenWaterFlow() {
    if (this.screenWaterFlow) {
      return;
    }

    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: screenWidth, height: screenHeight } = primaryDisplay.size;

    this.screenWaterFlow = new BrowserWindow({
      width: screenWidth,
      height: screenHeight,
      x: 0,
      y: 0,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      thickFrame: false,
      paintWhenInitiallyHidden: true,
      type: 'panel',
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });

    this.screenWaterFlow.setFocusable(false);
    this.screenWaterFlow.setContentProtection(false);
    this.screenWaterFlow.setIgnoreMouseEvents(true);

    this.screenWaterFlow.loadURL(`data:text/html;charset=UTF-8,
      <html>
        <head>
          <style id="water-flow-animation">
            html::before {
              content: "";
              position: fixed;
              top: 0; right: 0; bottom: 0; left: 0;
              pointer-events: none;
              z-index: 9999;
              background:
                linear-gradient(to right, rgba(30, 144, 255, 0.4), transparent 50%) left,
                linear-gradient(to left, rgba(30, 144, 255, 0.4), transparent 50%) right,
                linear-gradient(to bottom, rgba(30, 144, 255, 0.4), transparent 50%) top,
                linear-gradient(to top, rgba(30, 144, 255, 0.4), transparent 50%) bottom;
              background-repeat: no-repeat;
              background-size: 10% 100%, 10% 100%, 100% 10%, 100% 10%;
              animation: waterflow 5s cubic-bezier(0.4, 0, 0.6, 1) infinite;
              filter: blur(8px);
            }

            @keyframes waterflow {
              0%, 100% {
                background-image:
                  linear-gradient(to right, rgba(30, 144, 255, 0.4), transparent 50%),
                  linear-gradient(to left, rgba(30, 144, 255, 0.4), transparent 50%),
                  linear-gradient(to bottom, rgba(30, 144, 255, 0.4), transparent 50%),
                  linear-gradient(to top, rgba(30, 144, 255, 0.4), transparent 50%);
                transform: scale(1);
              }
              25% {
                background-image:
                  linear-gradient(to right, rgba(30, 144, 255, 0.39), transparent 52%),
                  linear-gradient(to left, rgba(30, 144, 255, 0.39), transparent 52%),
                  linear-gradient(to bottom, rgba(30, 144, 255, 0.39), transparent 52%),
                  linear-gradient(to top, rgba(30, 144, 255, 0.39), transparent 52%);
                transform: scale(1.03);
              }
              50% {
                background-image:
                  linear-gradient(to right, rgba(30, 144, 255, 0.38), transparent 55%),
                  linear-gradient(to left, rgba(30, 144, 255, 0.38), transparent 55%),
                  linear-gradient(to bottom, rgba(30, 144, 255, 0.38), transparent 55%),
                  linear-gradient(to top, rgba(30, 144, 255, 0.38), transparent 55%);
                transform: scale(1.05);
              }
              75% {
                background-image:
                  linear-gradient(to right, rgba(30, 144, 255, 0.39), transparent 52%),
                  linear-gradient(to left, rgba(30, 144, 255, 0.39), transparent 52%),
                  linear-gradient(to bottom, rgba(30, 144, 255, 0.39), transparent 52%),
                  linear-gradient(to top, rgba(30, 144, 255, 0.39), transparent 52%);
                transform: scale(1.03);
              }
            }
          </style>
        </head>
        <body></body>
      </html>
    `);
  }

  hideScreenWaterFlow() {
    this.screenWaterFlow?.close();
    this.screenWaterFlow = null;
  }

  hideWidgetWindow() {
    this.widgetWindow?.close();
    this.widgetWindow = null;
  }

  showWidgetWindow() {
    if (this.widgetWindow) {
      this.widgetWindow.close();
      this.widgetWindow = null;
    }

    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: screenWidth, height: screenHeight } = primaryDisplay.size;

    this.widgetWindow = new BrowserWindow({
      width: 400,
      height: 400,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      resizable: false,
      type: 'toolbar',
      visualEffectState: 'active', // macOS only
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        sandbox: false,
        webSecurity: !!env.isDev,
      },
    });

    this.widgetWindow.setFocusable(false);
    this.widgetWindow.setContentProtection(true); // not show for vlm model
    this.widgetWindow.setPosition(
      Math.floor(screenWidth - 400 - 32),
      Math.floor(screenHeight - 400 - 32 - 64),
    );

    if (!app.isPackaged && env.rendererUrl) {
      this.widgetWindow.loadURL(env.rendererUrl + '#widget');
    } else {
      this.widgetWindow.loadFile(
        path.join(__dirname, '../renderer/index.html'),
        {
          hash: '#widget',
        },
      );
    }

    if (!appUpdater) {
      appUpdater = new AppUpdater(this.widgetWindow);
    }

    const menuBuilder = new MenuBuilder(this.widgetWindow, appUpdater);
    menuBuilder.buildMenu();

    windowManager.registerWindow(this.widgetWindow);
  }

  // show Screen Marker in screen for prediction
  showPredictionMarker(
    predictions: PredictionParsed[],
    screenshotContext: NonNullable<Conversation['screenshotContext']>,
  ) {
    const { overlays } = setOfMarksOverlays({
      predictions,
      screenshotContext,
      xPos: this.lastShowPredictionMarkerPos?.xPos,
      yPos: this.lastShowPredictionMarkerPos?.yPos,
    });

    const { scaleFactor = 1 } = screenshotContext;

    // loop predictions
    for (let i = 0; i < overlays.length; i++) {
      const overlay = overlays[i];
      // logger.info('[showPredictionMarker] prediction', overlay);

      try {
        this.closeOverlay();
        this.currentOverlay = new BrowserWindow({
          width: overlay.boxWidth || 300,
          height: overlay.boxHeight || 100,
          transparent: true,
          frame: false,
          alwaysOnTop: true,
          skipTaskbar: true,
          focusable: false,
          hasShadow: false,
          thickFrame: false,
          paintWhenInitiallyHidden: true,
          type: 'panel',
          webPreferences: { nodeIntegration: true, contextIsolation: false },
          ...(overlay.xPos &&
            overlay.yPos && {
              // logical pixels
              x: (overlay.xPos + overlay.offsetX) * scaleFactor,
              y: (overlay.yPos + overlay.offsetY) * scaleFactor,
            }),
        });

        this.currentOverlay.blur();
        this.currentOverlay.setFocusable(false);
        this.currentOverlay.setContentProtection(true); // not show for vlm model
        this.currentOverlay.setIgnoreMouseEvents(true, { forward: true });

        if (env.isWindows) {
          this.currentOverlay.setAlwaysOnTop(true, 'screen-saver');
        }

        // 在 Windows 上设置窗口为工具窗口
        // if (process.platform === 'win32') {
        //   this.currentOverlay.setWindowButtonVisibility(false);
        //   const { SetWindowAttributes } = await import('windows-native-registry');
        //   SetWindowAttributes(this.currentOverlay.getNativeWindowHandle(), {
        //     toolWindow: true,
        //   });
        // }

        if (overlay.xPos && overlay.yPos) {
          this.lastShowPredictionMarkerPos = {
            xPos: overlay.xPos,
            yPos: overlay.yPos,
          };
        }

        if (overlay.svg) {
          this.currentOverlay.loadURL(`data:text/html;charset=UTF-8,
    <html>
      <body style="background: transparent; margin: 0;">
        ${overlay.svg}
      </body>
    </html>
    `);

          // auto-close: 3 s for click actions, 5 s for others
          const isClickAction = predictions.some((p) =>
            ['click', 'left_click', 'left_single', 'left_double', 'double_click', 'right_click', 'right_single'].includes(
              (p as any).action_type ?? (p as any).type ?? '',
            ),
          );
          setTimeout(() => {
            this.closeOverlay();
          }, isClickAction ? 3000 : 5000);
        }
      } catch (error) {
        logger.error('[showPredictionMarker] 显示预测标记失败:', error);
      }
    }
  }

  close() {
    if (this.currentOverlay) {
      this.currentOverlay.close();
      this.currentOverlay = null;
    }
    if (this.widgetWindow) {
      this.widgetWindow.close();
      this.widgetWindow = null;
    }
    if (this.screenWaterFlow) {
      this.screenWaterFlow.close();
      this.screenWaterFlow = null;
    }
  }

  closeOverlay() {
    if (this.currentOverlay) {
      this.currentOverlay.close();
      this.currentOverlay = null;
    }
  }

  /**
   * Show a brief animated pulsing ring at the given screen coordinates
   * to visually indicate where the VLM is about to click.
   *
   * @param x           Logical screen X (pixels).
   * @param y           Logical screen Y (pixels).
   * @param lifetimeMs  How long the ring stays visible (default 800 ms).
   */
  showClickRing(x: number, y: number, lifetimeMs = 800): void {
    const SIZE = 48; // ring diameter in logical px
    const HALF = SIZE / 2;
    try {
      const ringWin = new BrowserWindow({
        width: SIZE,
        height: SIZE,
        x: Math.round(x - HALF),
        y: Math.round(y - HALF),
        transparent: true,
        frame: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        focusable: false,
        hasShadow: false,
        thickFrame: false,
        paintWhenInitiallyHidden: true,
        type: 'panel',
        webPreferences: { nodeIntegration: true, contextIsolation: false },
      });

      ringWin.blur();
      ringWin.setFocusable(false);
      ringWin.setContentProtection(true);
      ringWin.setIgnoreMouseEvents(true, { forward: true });

      if (env.isWindows) {
        ringWin.setAlwaysOnTop(true, 'screen-saver');
      }

      ringWin.loadURL(`data:text/html;charset=UTF-8,
<html>
<head>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${SIZE}px; height: ${SIZE}px; background: transparent; overflow: hidden; }
  .ring {
    width: ${SIZE}px;
    height: ${SIZE}px;
    border-radius: 50%;
    border: 3px solid rgba(72, 255, 140, 0.95);
    box-shadow: 0 0 12px rgba(72, 255, 140, 0.7), inset 0 0 6px rgba(72, 255, 140, 0.3);
    animation: pulse ${lifetimeMs}ms ease-out forwards;
  }
  @keyframes pulse {
    0%   { transform: scale(0.3); opacity: 1; }
    60%  { transform: scale(1.1); opacity: 0.9; }
    100% { transform: scale(1.4); opacity: 0; }
  }
</style>
</head>
<body><div class="ring"></div></body>
</html>`);

      // Auto-close after lifetime
      setTimeout(() => {
        try { ringWin.close(); } catch (_) { /* already closed */ }
      }, lifetimeMs + 50);

      logger.info(`[ScreenMarker] showClickRing at (${x}, ${y}) for ${lifetimeMs}ms`);
    } catch (err) {
      logger.warn('[ScreenMarker] showClickRing failed:', err);
    }
  }
}

export const closeScreenMarker = () => {
  ScreenMarker.getInstance().close();
};

export const showPredictionMarker = (
  predictions: PredictionParsed[],
  screenshotContext: NonNullable<Conversation['screenshotContext']>,
) => {
  ScreenMarker.getInstance().showPredictionMarker(
    predictions,
    screenshotContext,
  );
};

export const showWidgetWindow = () => {
  ScreenMarker.getInstance().showWidgetWindow();
};

export const hideWidgetWindow = () => {
  ScreenMarker.getInstance().hideWidgetWindow();
};

export const showScreenWaterFlow = () => {
  ScreenMarker.getInstance().showScreenWaterFlow();
};

export const hideScreenWaterFlow = () => {
  ScreenMarker.getInstance().hideScreenWaterFlow();
};

export const closeOverlay = () => {
  ScreenMarker.getInstance().closeOverlay();
};

/**
 * Show a pulsing green ring at (x, y) to indicate an imminent VLM click.
 */
export const showClickRing = (x: number, y: number, lifetimeMs = 800) => {
  ScreenMarker.getInstance().showClickRing(x, y, lifetimeMs);
};
