/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { Key, keyboard } from '@computer-use/nut-js';
import {
  type ScreenshotOutput,
  type ExecuteParams,
  type ExecuteOutput,
} from '@ui-tars/sdk/core';
import { NutJSOperator } from '@ui-tars/operator-nut-js';
import { clipboard, desktopCapturer } from 'electron';

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

  public async screenshot(): Promise<ScreenshotOutput> {
    const capture = async (): Promise<ScreenshotOutput> => {
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
      logger.warn('[screenshot] Stale frame detected — waiting 300 ms and retaking');
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
    const scaleFactor = params.scaleFactor || 1;
    const adjustedParams = {
      ...params,
      screenWidth: params.screenWidth / scaleFactor,
      screenHeight: params.screenHeight / scaleFactor,
    };

    const { action_type, action_inputs } = adjustedParams.parsedPrediction;

    // ── Pre-click highlight ring ────────────────────────────────────────────
    // For visual actions, show an animated ring at the target coordinate
    // BEFORE the actual click so the user can see where the VLM is clicking.
    const isClickLike = [
      'click', 'left_click', 'left_single',
      'left_double', 'double_click',
      'right_click', 'right_single',
    ].includes(action_type);

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
      if (isClickLike) {
        await this._verifyClickEffect();
      }
      return result;
    }
  }
}
