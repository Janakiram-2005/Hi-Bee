/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { Key, keyboard, Point, Button, mouse } from '@computer-use/nut-js';
import {
  type ScreenshotOutput,
  type ExecuteParams,
  type ExecuteOutput,
} from '@ui-tars/sdk/core';
import { NutJSOperator } from '@ui-tars/operator-nut-js';
import { clipboard, desktopCapturer, BrowserWindow } from 'electron';
import { exec, execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { StatusEnum } from '@ui-tars/shared/types';

import * as env from '@main/env';
import { logger } from '@main/logger';
import { sleep } from '@ui-tars/shared/utils';
import { getScreenSize } from '@main/utils/screen';
import { showClickRing } from '@main/window/ScreenMarker';
import { parseBoxToScreenCoords } from '@ui-tars/sdk/core';

export class NutJSElectronOperator extends NutJSOperator {
  static MANUAL = {
    ACTION_SPACES: [
      `click(start_box='[x1, y1, x2, y2]')`,
      `left_double(start_box='[x1, y1, x2, y2]')`,
      `right_single(start_box='[x1, y1, x2, y2]')`,
      `drag(start_box='[x1, y1, x2, y2]', end_box='[x3, y3, x4, y4]')`,
      `hotkey(key='')`,
      `type(content='') #If you want to submit your input, use "\\n" at the end of \`content\`.`,
      `scroll(start_box='[x1, y1, x2, y2]', direction='down or up or right or left')`,
      `wait() #Sleep for 5s and take a screenshot to check for any changes.`,
      `finished()`,
      `call_user() # Submit the task and call the user when the task is unsolvable, or when you need the user's help.`,
    ],
  };

  /** Hash of the last screenshot (simple length+sample check — no crypto dep). */
  private _lastScreenshotHash: string = '';

  /**
   * Compute a fast, lightweight fingerprint of a base64 screenshot.
   * Samples the first, middle and last 64 chars plus the total length.
   */
  private _hashB64(b64: string): string {
    const len = b64.length;
    const mid = Math.floor(len / 2);
    return `${len}|${b64.slice(0, 64)}|${b64.slice(mid, mid + 64)}|${b64.slice(-64)}`;
  }

  private async _getActiveWindowTitle(): Promise<string> {
    return new Promise((resolve) => {
      if (process.platform !== 'win32') return resolve('');
      const cmd = `powershell -NoProfile -Command "(Add-Type '[DllImport(\\"user32.dll\\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\\"user32.dll\\")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);' -Name Win32 -PassThru)::GetWindowText(([Win32]::GetForegroundWindow()), ($title = New-Object System.Text.StringBuilder 256), 256) | Out-Null; $title.ToString()"`;
      exec(cmd, (error, stdout) => {
        if (error) return resolve('');
        resolve(stdout.trim());
      });
    });
  }

  private async _getOSDOMTree(): Promise<any[]> {
    return new Promise((resolve) => {
      const candidates = [
        path.join(
          process.cwd(),
          'hybrid_gui_agent',
          'native_bridge',
          'bin',
          'UIAParser.exe',
        ),
        path.join(
          process.cwd(),
          '..',
          'hybrid_gui_agent',
          'native_bridge',
          'bin',
          'UIAParser.exe',
        ),
        path.join(
          process.cwd(),
          '..',
          '..',
          'hybrid_gui_agent',
          'native_bridge',
          'bin',
          'UIAParser.exe',
        ),
        path.join(
          __dirname,
          '..',
          '..',
          '..',
          '..',
          'hybrid_gui_agent',
          'native_bridge',
          'bin',
          'UIAParser.exe',
        ),
        path.join(
          __dirname,
          '..',
          '..',
          '..',
          '..',
          '..',
          'hybrid_gui_agent',
          'native_bridge',
          'bin',
          'UIAParser.exe',
        ),
        path.join(process.resourcesPath || '', 'UIAParser.exe'),
        path.join(process.resourcesPath || '', 'bin', 'UIAParser.exe'),
      ];
      let parserExePath = '';
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          parserExePath = candidate;
          break;
        }
      }
      if (!parserExePath) {
        parserExePath = path.join(
          process.cwd(),
          'hybrid_gui_agent',
          'native_bridge',
          'bin',
          'UIAParser.exe',
        );
        logger.error(
          `[DOM-First] UIAParser.exe not found at path: ${parserExePath}`,
        );
        return resolve([]);
      }

      execFile(parserExePath, [], { timeout: 2000 }, (error, stdout) => {
        if (error) {
          logger.error(`[DOM-First] UIAParser error: ${error.message}`);
          return resolve([]);
        }
        try {
          const raw = stdout.trim();
          // Escape raw control characters (ASCII 0x00 to 0x1F, like raw newlines/tabs)
          const sanitized = raw.replace(/[\x00-\x1F\x7F-\x9F]/g, (char) => {
            if (char === '\n') return '\\n';
            if (char === '\r') return '\\r';
            if (char === '\t') return '\\t';
            return '';
          });
          const elements = JSON.parse(sanitized);
          if (Array.isArray(elements)) {
            return resolve(elements);
          }
        } catch (e: any) {
          logger.error(
            `[DOM-First] Failed to parse UIAParser output: ${e.message}`,
          );
        }
        resolve([]);
      });
    });
  }

  public async screenshot(): Promise<ScreenshotOutput> {
    const capture = async (): Promise<ScreenshotOutput> => {
      // Hide all UI-TARS windows before taking screenshot so they don't block the screen
      const visibleWindows: BrowserWindow[] = [];
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed() && win.isVisible()) {
          visibleWindows.push(win);
          win.hide();
        }
      }

      if (visibleWindows.length > 0) {
        await sleep(250); // Wait for the OS to repaint the screen fully
      }

      const {
        physicalSize,
        logicalSize,
        scaleFactor,
        id: primaryDisplayId,
      } = getScreenSize(); // Logical = Physical / scaleX

      logger.info(
        '[screenshot] [primaryDisplay]',
        'logicalSize:',
        logicalSize,
        'scaleFactor:',
        scaleFactor,
      );

      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: Math.round(physicalSize.width),
          height: Math.round(physicalSize.height),
        },
      });
      const primarySource =
        sources.find(
          (source) => source.display_id === primaryDisplayId.toString(),
        ) || sources[0];

      if (!primarySource) {
        logger.error('[screenshot] Primary display source not found', {
          primaryDisplayId,
          availableSources: sources.map((s) => s.display_id),
        });
        // fallback to default screenshot
        return await super.screenshot();
      }

      const screenshot = primarySource.thumbnail;

      const resized = screenshot.resize({
        width: physicalSize.width,
        height: physicalSize.height,
      });

      // Restore windows
      for (const win of visibleWindows) {
        if (!win.isDestroyed()) {
          win.showInactive();
        }
      }

      return {
        base64: resized.toJPEG(85).toString('base64'),
        scaleFactor,
      };
    };

    // ── Deduplication guard ───────────────────────────────────────────────────
    // If the screen hasn't changed since the last capture (hash match) the VLM
    // would see a stale frame and might repeat the previous action.  Wait 300 ms
    // and retake once before handing the frame to the agent.
    let result = await capture();
    const newHash = this._hashB64(result.base64);
    if (newHash === this._lastScreenshotHash) {
      logger.warn(
        '[screenshot] Stale frame detected — waiting 300 ms and retaking',
      );
      await sleep(300);
      result = await capture();
    }
    this._lastScreenshotHash = this._hashB64(result.base64);
    return result;
  }

  /**
   * Show a brief click-ring overlay then wait 50 ms before the actual click,
   * giving the user visual confirmation of exactly where the VLM will click.
   */
  private async _preClickHighlight(x: number, y: number): Promise<void> {
    try {
      showClickRing(x, y, 800);
    } catch (err) {
      // Non-critical — don't block the click
      logger.warn('[NutJSElectronOperator] _preClickHighlight failed:', err);
    }
    await sleep(50); // short pause so the ring is visible before the click lands
  }

  /**
   * Quick post-click verification: compare screenshot hashes 150 ms after
   * click.  If the screen hasn't changed at all and the click was a primary
   * action, log a warning (could indicate a missed target).
   */
  private async _verifyClickEffect(): Promise<void> {
    await sleep(150);
    const before = this._lastScreenshotHash;
    const after = await this.screenshot();
    const afterHash = this._hashB64(after.base64);
    if (afterHash === before) {
      logger.warn(
        '[NutJSElectronOperator] Post-click: screen unchanged — click may have missed the target.',
      );
    } else {
      logger.info('[NutJSElectronOperator] Post-click: screen changed ✓');
    }
  }

  async execute(params: ExecuteParams): Promise<ExecuteOutput> {
    // 1. Correct DPI scaling factor mapping on Windows and macOS
    const scaleFactor = params.scaleFactor || 1;
    const adjustedParams = {
      ...params,
      screenWidth: params.screenWidth / scaleFactor,
      screenHeight: params.screenHeight / scaleFactor,
    };

    const { action_type, action_inputs } = adjustedParams.parsedPrediction;

    const isClickLike = [
      'click',
      'left_click',
      'left_single',
      'left_double',
      'double_click',
      'right_click',
      'right_single',
      'hover',
      'mouse_move',
    ].includes(action_type);

    // 2. DOM-First Execution Hierarchy Logic
    if (
      process.platform === 'win32' &&
      isClickLike &&
      action_inputs?.start_box
    ) {
      try {
        const { logicalSize } = getScreenSize();
        const startBoxStr = action_inputs.start_box;

        // Calculate physical target coordinates
        const { x: startX_phys, y: startY_phys } = parseBoxToScreenCoords({
          boxStr: startBoxStr,
          screenWidth: logicalSize.width * scaleFactor,
          screenHeight: logicalSize.height * scaleFactor,
        });

        if (startX_phys !== null && startY_phys !== null) {
          // A. Get active window title and UIA DOM Tree
          const activeTitle = await this._getActiveWindowTitle();
          const domElements = await this._getOSDOMTree();

          // Filter matching elements containing target coordinates
          const matches = domElements
            .filter((el: any) => {
              if (!el.rect || el.rect.length !== 4) return false;
              const [x, y, w, h] = el.rect;
              return (
                startX_phys >= x &&
                startX_phys <= x + w &&
                startY_phys >= y &&
                startY_phys <= y + h
              );
            })
            // Sort by container area ascending to select the most specific/deepest node
            .sort(
              (a: any, b: any) => a.rect[2] * a.rect[3] - b.rect[2] * b.rect[3],
            );

          if (matches.length > 0) {
            const bestMatch = matches[0];
            const [x, y, w, h] = bestMatch.rect;
            const cx_phys = x + w / 2;
            const cy_phys = y + h / 2;

            logger.info(
              `[Hierarchy] Found matched DOM element: "${bestMatch.name}" (${bestMatch.type})`,
            );

            // Step 1: Active Tab / Window Check
            // If the element's name is already in the active window title, the tab is already active/open
            if (
              bestMatch.name &&
              activeTitle &&
              activeTitle.toLowerCase().includes(bestMatch.name.toLowerCase())
            ) {
              logger.info(
                `[Hierarchy] Active Tab Check: "${bestMatch.name}" is already the active tab/window (Current window title: "${activeTitle}"). Skipping action.`,
              );
              return { status: StatusEnum.RUNNING };
            }

            // Step 2: Quick Openable Shortcuts Check
            // If the targeted element represents a basic launch helper and matches common utilities
            const nameLower = bestMatch.name
              ? bestMatch.name.toLowerCase()
              : '';
            const quickApps = [
              'notepad',
              'paint',
              'calculator',
              'cmd',
              'powershell',
              'chrome',
              'edge',
            ];
            const matchedApp = quickApps.find((app) => nameLower.includes(app));
            if (matchedApp) {
              logger.info(
                `[Hierarchy] Quick Openable Shortcut found for: "${matchedApp}". Launching directly.`,
              );
              try {
                const appCmd =
                  matchedApp === 'calculator'
                    ? 'calc.exe'
                    : `${matchedApp}.exe`;
                exec(appCmd);
                return { status: StatusEnum.RUNNING };
              } catch (err) {
                logger.warn(
                  `[Hierarchy] Quick launch shortcut execution failed:`,
                  err,
                );
              }
            }

            // Step 3: OS DOM Elements Navigation
            // Calculate precise logical coordinates of the DOM element center
            const cx_logical = cx_phys / scaleFactor;
            const cy_logical = cy_phys / scaleFactor;
            logger.info(
              `[Hierarchy] OS DOM click target snapped from (${startX_phys / scaleFactor}, ${startY_phys / scaleFactor}) to exact center (${cx_logical}, ${cy_logical})`,
            );

            // Pre-click highlight
            await this._preClickHighlight(cx_logical, cy_logical);

            // Execute mouse click using logical coordinates
            await mouse.setPosition(
              new Point(Math.round(cx_logical), Math.round(cy_logical)),
            );
            await sleep(100);
            if (
              action_type === 'left_double' ||
              action_type === 'double_click'
            ) {
              await mouse.doubleClick(Button.LEFT);
            } else if (
              action_type === 'right_click' ||
              action_type === 'right_single'
            ) {
              await mouse.click(Button.RIGHT);
            } else if (
              action_type === 'hover' ||
              action_type === 'mouse_move'
            ) {
              // Hover only, no click needed
            } else {
              await mouse.click(Button.LEFT);
            }

            if (action_type !== 'hover' && action_type !== 'mouse_move') {
              await this._verifyClickEffect();
            }
            return { status: StatusEnum.RUNNING };
          } else {
            logger.info(
              `[Hierarchy] DOM scan returned no matching elements at (${startX_phys}, ${startY_phys}). Falling back to Vision.`,
            );
          }
        }
      } catch (err) {
        logger.error(
          `[Hierarchy] OS DOM routing failed, falling back to Vision:`,
          err,
        );
      }
    }

    // Step 4: Vision-Based Navigation Fallback (original flow)
    if (isClickLike && action_inputs?.start_box) {
      const { logicalSize } = getScreenSize();
      const { x: rawX, y: rawY } = parseBoxToScreenCoords({
        boxStr: action_inputs.start_box,
        screenWidth: logicalSize.width,
        screenHeight: logicalSize.height,
      });
      if (rawX !== null && rawY !== null) {
        await this._preClickHighlight(rawX, rawY);
      }
    }

    if (action_type === 'type' && env.isWindows && action_inputs?.content) {
      const content = action_inputs.content;

      logger.info('[device] type', content);
      const stripContent = content.replace(/\\n$/, '').replace(/\n$/, '');
      const originalClipboard = clipboard.readText();
      clipboard.writeText(stripContent);
      await keyboard.pressKey(Key.LeftControl, Key.V);
      await sleep(50);
      await keyboard.releaseKey(Key.LeftControl, Key.V);
      await sleep(50);
      clipboard.writeText(originalClipboard);

      if (content.endsWith('\n') || content.endsWith('\\n')) {
        await keyboard.pressKey(Key.Enter);
        await sleep(50);
        await keyboard.releaseKey(Key.Enter);
      }
    } else {
      const result = await super.execute(adjustedParams);
      // Post-click verification for click-type actions
      if (
        isClickLike &&
        action_type !== 'hover' &&
        action_type !== 'mouse_move'
      ) {
        await this._verifyClickEffect();
      }
      return result;
    }
  }
}
