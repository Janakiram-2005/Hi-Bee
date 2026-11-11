/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  ElectronApplication,
  Page,
  _electron as electron,
  expect,
  test,
} from '@playwright/test';
import { findLatestBuild, parseElectronApp } from 'electron-playwright-helpers';
import * as path from 'path';

let electronApp: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  let executablePath: string;
  let main: string;
  try {
    const latestBuild = findLatestBuild();
    const parsed = parseElectronApp(latestBuild);
    executablePath = parsed.executable;
    main = parsed.main;
  } catch (error) {
    if (process.platform === 'linux') {
      executablePath = path.resolve(
        __dirname,
        '../out/UI TARS-linux-x64/UI-TARS',
      );
      main = path.resolve(
        __dirname,
        '../out/UI TARS-linux-x64/resources/app.asar/dist/main/main.js',
      );
    } else if (process.platform === 'win32') {
      executablePath = path.resolve(
        __dirname,
        '../out/UI TARS-win32-x64/UI-TARS.exe',
      );
      main = path.resolve(
        __dirname,
        '../out/UI TARS-win32-x64/resources/app.asar/dist/main/main.js',
      );
    } else {
      executablePath = path.resolve(
        __dirname,
        '../out/UI TARS-darwin-arm64/UI TARS.app/Contents/MacOS/UI-TARS',
      );
      main = path.resolve(
        __dirname,
        '../out/UI TARS-darwin-arm64/UI TARS.app/Contents/Resources/app.asar/dist/main/main.js',
      );
    }
  }

  console.log('executablePath:', executablePath, '\nmain:', main);
  process.env.CI = 'e2e';
  electronApp = await electron.launch({
    args: [main],
    executablePath,
    env: {
      ...process.env,
      CI: 'e2e',
    },
    timeout: 120_000,
  });

  page = await electronApp.firstWindow({ timeout: 120_000 });
  electronApp.on('window', async (page) => {
    const filename = page.url()?.split('/').pop();
    console.log(`Window opened: ${filename}`);

    // capture errors
    page.on('pageerror', (error) => {
      console.error(error);
    });
    // capture console messages
    page.on('console', (msg) => {
      console.log(msg.text());
    });
  });
}, 120_000);

test.afterAll(async () => {
  await electronApp?.close();
});

test('app can launch', async () => {
  test.setTimeout(120_000);
  await page.waitForLoadState('domcontentloaded', { timeout: 120_000 });

  await page.waitForSelector('button', { state: 'visible' });

  const buttonElement = await page.$('button');
  expect(await buttonElement?.isVisible()).toBe(true);
});
