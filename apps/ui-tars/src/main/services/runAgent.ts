/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'assert';
import { exec } from 'child_process';
import { shell } from 'electron';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { logger } from '@main/logger';
import { StatusEnum } from '@ui-tars/shared/types';
import { type ConversationWithSoM } from '@main/shared/types';
import { GUIAgent, type GUIAgentConfig } from '@ui-tars/sdk';
import { GeminiVertexModel } from '@main/services/GeminiVertexModel';
import { mongoService } from './mongoService';
import { markClickPosition } from '@main/utils/image';
import { UTIOService } from '@main/services/utio';
import { NutJSElectronOperator } from '../agent/operator';
import {
  createRemoteBrowserOperator,
  RemoteComputerOperator,
} from '../remote/operators';
import {
  DefaultBrowserOperator,
  RemoteBrowserOperator,
} from '@ui-tars/operator-browser';
import { showPredictionMarker } from '@main/window/ScreenMarker';
import { SettingStore } from '@main/store/setting';
import { AppState, Operator } from '@main/store/types';
import { GUIAgentManager } from '../ipcRoutes/agent';
import { checkBrowserAvailability } from './browserCheck';
import {
  getModelVersion,
  getSpByModelVersion,
  beforeAgentRun,
  afterAgentRun,
  getLocalBrowserSearchEngine,
  type AgentRunOptions,
} from '../utils/agent';
import {
  shouldUseVertexGemini,
  getVertexProjectId,
  ensureVlmDefaults,
} from '../utils/vlmProvider';
import { FREE_MODEL_BASE_URL } from '../remote/shared';
import { getAuthHeader } from '../remote/auth';
import { ProxyClient } from '../remote/proxyClient';
import {
  UITarsModel,
  type UITarsModelConfig,
  type InvokeParams,
} from '@ui-tars/sdk/core';
import { registerCallUserTimer, cancelCallUserTimer } from './stopAgentRun';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface FastAction {
  type: 'launch' | 'search' | 'url' | 'summarize' | 'window_action';
  commandOrUrl: string;
  windowAction?: 'minimize' | 'maximize' | 'close';
  backgroundOverride?: boolean;
}

export function getFastActionCommand(
  instructions: string,
  isWindows: boolean,
): FastAction | null {
  const result = _getFastActionCommand(instructions, isWindows);
  if (result) {
    if (/in the background/i.test(instructions) || /background mode/i.test(instructions)) {
      result.backgroundOverride = true;
    }
  }
  return result;
}

function _getFastActionCommand(
  instructions: string,
  isWindows: boolean,
): FastAction | null {
  // Strip trailing punctuation (like periods, question marks, commas, etc.)
  const query = instructions
    .trim()
    .replace(/[.,\/#!$%\^\&\*;:{}=\-_`~()?]+$/g, '')
    .trim();

  // Redirect Chrome launching to open google.com directly
  if (
    /^(?:open|launch|start|run|show|execute)?\s*(google\s+)?chrome$/i.test(
      query,
    )
  ) {
    return {
      type: 'url',
      commandOrUrl: 'https://google.com',
    };
  }

  // 0. Check for screen summarize / describe requests
  const summarizeRegex =
    /^(?:summarize|summarise|describe|tell\s+me\s+about|what['']?s\s+on|what\s+is\s+on|explain|read)\s*(?:the\s+)?(?:screen|this|my\s+screen|what\s+you\s+see|the\s+display|what['']?s\s+happening)?$/i;
  if (summarizeRegex.test(query)) {
    return {
      type: 'summarize',
      commandOrUrl: query,
    };
  }

  // 0b. YouTube search (e.g. "search on youtube believer song", "youtube search for cats")
  const youtubeSearchRegex =
    /^(?:search\s+on\s+youtube|youtube\s+search|search\s+(?:in|on|for)\s+youtube|search\s+youtube|play\s+on\s+youtube|find\s+on\s+youtube|youtube)\s+(?:for\s+)?(.+)$/i;
  const youtubeSearchMatch = query.match(youtubeSearchRegex);
  if (youtubeSearchMatch) {
    const ytQuery = youtubeSearchMatch[1].trim();
    if (ytQuery) {
      return {
        type: 'url',
        commandOrUrl: `https://www.youtube.com/results?search_query=${encodeURIComponent(ytQuery)}`,
      };
    }
  }

  // 1. Check for search queries (Google)
  const searchForRegex =
    /^(?:search\s+for|google\s+search\s+for|search\s+on\s+google\s+for|google\s+search|google|search)\s+(.+)$/i;
  const searchForMatch = query.match(searchForRegex);
  if (searchForMatch) {
    const rawSearchQuery = searchForMatch[1].trim();
    const lowerQuery = rawSearchQuery.toLowerCase();
    const isApp = [
      'paint',
      'notepad',
      'chrome',
      'edge',
      'firefox',
      'calculator',
      'calc',
      'settings',
      'explorer',
      'cmd',
      'powershell',
      'task manager',
      'taskmgr',
      'camera',
      'photos',
      'clock',
      'store',
      'vscode',
      'code',
      'safari',
      'browser',
      'terminal',
    ].includes(lowerQuery);
    if (rawSearchQuery && !isApp) {
      return {
        type: 'search',
        commandOrUrl: `https://www.google.com/search?q=${encodeURIComponent(rawSearchQuery)}`,
      };
    }
  }

  // 2. Direct website opens
  const urlRegex =
    /^(?:open|go\s+to|visit)\s+(https?:\/\/)?([a-z0-9]+([\-.]{1}[a-z0-9]+)*\.[a-z]{2,5}(:[0-9]{1,5})?(\/.*)?)$/i;
  const urlMatch = query.match(urlRegex);
  if (urlMatch) {
    let url = urlMatch[2];
    if (!urlMatch[1]) {
      url = 'https://' + url;
    }
    return {
      type: 'url',
      commandOrUrl: url,
    };
  }

  // Common website names mapping
  const websiteNames: Record<string, string> = {
    youtube: 'https://youtube.com',
    github: 'https://github.com',
    chatgpt: 'https://chatgpt.com',
    google: 'https://google.com',
    gmail: 'https://gmail.com',
    outlook: 'https://outlook.live.com',
    wikipedia: 'https://wikipedia.org',
    facebook: 'https://facebook.com',
    twitter: 'https://twitter.com',
    linkedin: 'https://linkedin.com',
  };
  const friendlyWebRegex =
    /^(?:open|go\s+to|visit)\s+(youtube|github|chatgpt|google|gmail|outlook|wikipedia|facebook|twitter|linkedin)$/i;
  const friendlyWebMatch = query.match(friendlyWebRegex);
  if (friendlyWebMatch) {
    const name = friendlyWebMatch[1].toLowerCase();
    if (websiteNames[name]) {
      return {
        type: 'url',
        commandOrUrl: websiteNames[name],
      };
    }
  }

  // 3. Known App Launching
  const appMapping: Record<string, string> = isWindows
    ? {
        paint: 'mspaint.exe',
        mspaint: 'mspaint.exe',
        notepad: 'notepad.exe',
        chrome: 'chrome.exe',
        google_chrome: 'chrome.exe',
        edge: 'msedge.exe',
        msedge: 'msedge.exe',
        microsoft_edge: 'msedge.exe',
        firefox: 'firefox.exe',
        calculator: 'ms-calculator:',
        calc: 'ms-calculator:',
        settings: 'ms-settings:',
        control_panel: 'control.exe',
        control: 'control.exe',
        explorer: 'explorer.exe',
        file_explorer: 'explorer.exe',
        cmd: 'cmd.exe',
        command_prompt: 'cmd.exe',
        powershell: 'powershell.exe',
        task_manager: 'taskmgr.exe',
        taskmgr: 'taskmgr.exe',
        camera: 'microsoft.windows.camera:',
        photos: 'ms-photos:',
        clock: 'ms-clock:',
        store: 'ms-store:',
        microsoft_store: 'ms-store:',
        vscode: 'Code.exe',
        code: 'Code.exe',
        word: 'winword.exe',
        msword: 'winword.exe',
        microsoft_word: 'winword.exe',
        excel: 'excel.exe',
        microsoft_excel: 'excel.exe',
        powerpoint: 'powerpnt.exe',
        mspowerpoint: 'powerpnt.exe',
        microsoft_powerpoint: 'powerpnt.exe',
        outlook: 'outlook.exe',
        teams: 'teams.exe',
        weather: 'ms-weather:',
        calendar: 'outlookcal:',
        mail: 'outlookmail:',
        sticky_notes:
          'explorer.exe shell:Appsfolder\\Microsoft.MicrosoftStickyNotes_8wekyb3d8bbwe!App',
        spotify: 'spotify:',
        discord: 'discord:',
      }
    : {
        chrome: 'open -a "Google Chrome"',
        google_chrome: 'open -a "Google Chrome"',
        safari: 'open -a "Safari"',
        calculator: 'open -a "Calculator"',
        calc: 'open -a "Calculator"',
        settings: 'open -a "System Settings"',
        system_settings: 'open -a "System Settings"',
        notepad: 'open -a "TextEdit"',
        textedit: 'open -a "TextEdit"',
        terminal: 'open -a "Terminal"',
        vscode: 'open -a "Visual Studio Code"',
        code: 'open -a "Visual Studio Code"',
        finder: 'open -a "Finder"',
        word: 'open -a "Microsoft Word"',
        microsoft_word: 'open -a "Microsoft Word"',
        excel: 'open -a "Microsoft Excel"',
        microsoft_excel: 'open -a "Microsoft Excel"',
        powerpoint: 'open -a "Microsoft PowerPoint"',
        microsoft_powerpoint: 'open -a "Microsoft PowerPoint"',
        mail: 'open -a "Mail"',
        calendar: 'open -a "Calendar"',
        maps: 'open -a "Maps"',
        spotify: 'open -a "Spotify"',
        music: 'open -a "Music"',
        photos: 'open -a "Photos"',
      };

  const appRegex = /^(?:open|launch|start|run|show|execute)\s+(.+)$/i;
  const appMatch = query.match(appRegex);
  if (appMatch) {
    const nameRaw = appMatch[1].trim().toLowerCase();
    const nameUnderscored = nameRaw.replace(/\s+/g, '_');
    if (appMapping[nameUnderscored]) {
      return {
        type: 'launch',
        commandOrUrl: appMapping[nameUnderscored],
      };
    }
    if (appMapping[nameRaw]) {
      return {
        type: 'launch',
        commandOrUrl: appMapping[nameRaw],
      };
    }
  }

  const normalizedQuery = query.toLowerCase().replace(/\s+/g, '_');
  const normalizedQueryRaw = query.toLowerCase().trim();
  if (appMapping[normalizedQuery]) {
    return {
      type: 'launch',
      commandOrUrl: appMapping[normalizedQuery],
    };
  }
  if (appMapping[normalizedQueryRaw]) {
    return {
      type: 'launch',
      commandOrUrl: appMapping[normalizedQueryRaw],
    };
  }

  // 4. Substring fallback matching for friendly names and app launch anywhere in query
  const lowerQuery = query.toLowerCase();
  for (const appName of Object.keys(appMapping)) {
    const regex = new RegExp(
      `\\b(open|launch|start|run|show|execute)\\s+${appName}\\b`,
      'i',
    );
    if (regex.test(lowerQuery)) {
      // Guard: If query contains coordinating conjunctions or is long, let VLM agent handle the multi-step flow
      if (
        lowerQuery.includes(' and ') ||
        lowerQuery.includes(' then ') ||
        lowerQuery.split(/\s+/).length > 5
      ) {
        continue;
      }
      return {
        type: 'launch',
        commandOrUrl: appMapping[appName],
      };
    }
  }

  for (const [webName, url] of Object.entries(websiteNames)) {
    const regex = new RegExp(`\\b(open|go\\s+to|visit)\\s+${webName}\\b`, 'i');
    if (regex.test(lowerQuery)) {
      // Guard: If query contains coordinating conjunctions or is long, let VLM agent handle the multi-step flow
      if (
        lowerQuery.includes(' and ') ||
        lowerQuery.includes(' then ') ||
        lowerQuery.split(/\s+/).length > 5
      ) {
        continue;
      }
      return {
        type: 'url',
        commandOrUrl: url,
      };
    }
  }

  // 5. Window Actions
  const windowActionRegex = /^(minimize|maximize|close)\s+(?:the\s+)?(.+)$/i;
  const windowActionMatch = query.match(windowActionRegex);
  if (windowActionMatch) {
    return {
      type: 'window_action',
      commandOrUrl: windowActionMatch[2].trim(),
      windowAction: windowActionMatch[1].toLowerCase() as 'minimize' | 'maximize' | 'close',
    };
  }

  // 6. Telugu/Regional language format: "[App] ని క్లోజ్ చేయి"
  const teluguRegex = /^(.+?)(?:\s+ని|\s+ను)?\s+(క్లోజ్|ఓపెన్|మినిమైజ్|మాక్సిమైజ్|మూసివేయు|తెరవండి|తెరచు)(?:\s+చేయి|\s+చేయండి)?$/i;
  const teluguMatch = query.match(teluguRegex);
  if (teluguMatch) {
    let rawTarget = teluguMatch[1].trim();
    const rawAction = teluguMatch[2];
    let actionType: 'launch' | 'minimize' | 'maximize' | 'close' = 'launch';
    
    if (rawAction.includes('క్లోజ్') || rawAction.includes('మూసివేయు')) actionType = 'close';
    else if (rawAction.includes('మినిమైజ్')) actionType = 'minimize';
    else if (rawAction.includes('మాక్సిమైజ్')) actionType = 'maximize';
    else actionType = 'launch';

    // Remove any trailing words from target like 'అప్లికేషన్'
    rawTarget = rawTarget.replace(/\s+(అప్లికేషన్|యాప్)$/i, '').trim();

    if (actionType === 'launch') {
      const normalizedTarget = rawTarget.toLowerCase().replace(/\s+/g, '_');
      if (appMapping[normalizedTarget] || appMapping[rawTarget.toLowerCase()]) {
        return {
          type: 'launch',
          commandOrUrl: appMapping[normalizedTarget] || appMapping[rawTarget.toLowerCase()],
        };
      }
    } else {
      return {
        type: 'window_action',
        commandOrUrl: rawTarget,
        windowAction: actionType,
      };
    }
  }

  return null;
}

const aliasMap: Record<string, string> = {
  notpad: 'notepad',
  notepade: 'notepad',
  'note pad': 'notepad',
  notepads: 'notepad',
  paint: 'paint',
  mspaint: 'paint',
  paints: 'paint',
  calc: 'calc',
  calculator: 'calculator',
  caculator: 'calculator',
  cmd: 'cmd',
  command: 'cmd',
  powershell: 'powershell',
  ps: 'powershell',
  chrome: 'chrome',
  google: 'chrome',
  edge: 'edge',
  msedge: 'edge',
};

async function launchInBackgroundWindows(cmdOrUrl: string): Promise<void> {
  const psScript = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
$prevHwnd = [Win32]::GetForegroundWindow()
Start-Process "${cmdOrUrl}"
Start-Sleep -Milliseconds 800
$newHwnd = [Win32]::GetForegroundWindow()
if ($newHwnd -ne $prevHwnd -and $newHwnd -ne [IntPtr]::Zero) {
    [void][Win32]::ShowWindow($newHwnd, 6) # SW_MINIMIZE
}
[void][Win32]::SetForegroundWindow($prevHwnd)
`.trim();
  const tempFile = path.join(os.tmpdir(), `bg_launch_${Date.now()}.ps1`);
  try {
    fs.writeFileSync(tempFile, psScript, 'utf8');
    await new Promise<void>((resolve) => {
      exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tempFile}"`, () => {
        try { fs.unlinkSync(tempFile); } catch (e) {}
        resolve();
      });
    });
  } catch (err) {
    console.error('[launchInBackgroundWindows] Error:', err);
  }
}

async function focusOrRestoreApp(
  appNameRaw: string,
  launchCmd: string,
  background: boolean = false,
): Promise<boolean> {
  const resolvedName = aliasMap[appNameRaw] || appNameRaw;
  let focused = false;
  if (process.platform === 'win32') {
    const cleanName = resolvedName.replace(/[^a-zA-Z0-9]/g, '');
    const psScript = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);
}
"@
$proc = Get-Process | Where-Object { $_.ProcessName -like "*${cleanName}*" -or $_.MainWindowTitle -like "*${cleanName}*" } | Select-Object -First 1
if ($proc) {
    $hwnd = $proc.MainWindowHandle
    if ($hwnd -ne [IntPtr]::Zero) {
        if ("${background}" -ne "true") {
            if ([Win32]::IsIconic($hwnd)) {
                [void][Win32]::ShowWindow($hwnd, 9) # SW_RESTORE
            }
            [void][Win32]::ShowWindow($hwnd, 5) # SW_SHOW
            [void][Win32]::SetForegroundWindow($hwnd)
        }
    } else {
        if ("${background}" -ne "true") {
            $wshell = New-Object -ComObject wscript.shell
            [void]$wshell.AppActivate($proc.Id)
        }
    }
    Write-Output "focused"
} else {
    Write-Output "notfound"
}
`.trim();

    const tempFile = path.join(os.tmpdir(), `restore_win_${Date.now()}.ps1`);
    try {
      fs.writeFileSync(tempFile, psScript, 'utf8');
      focused = await new Promise<boolean>((resolve) => {
        exec(
          `powershell -NoProfile -ExecutionPolicy Bypass -File "${tempFile}"`,
          (error, stdout, stderr) => {
            try {
              fs.unlinkSync(tempFile);
            } catch (unlinkErr) {
              console.error(
                '[Hi-Bee Live] [Pre-Launch] Failed to delete temp PS script:',
                unlinkErr,
              );
            }
            if (error) {
              console.error(
                '[Hi-Bee Live] [Pre-Launch] PowerShell error:',
                error,
              );
              console.error(
                '[Hi-Bee Live] [Pre-Launch] PowerShell stderr:',
                stderr,
              );
              resolve(false);
            } else {
              console.log(
                '[Hi-Bee Live] [Pre-Launch] PowerShell stdout:',
                stdout.trim(),
              );
              resolve(stdout.trim() === 'focused');
            }
          },
        );
      });
    } catch (writeErr) {
      console.error(
        '[Hi-Bee Live] [Pre-Launch] Failed to write temp PS script:',
        writeErr,
      );
      focused = false;
    }
  }

  if (focused) {
    console.log(
      `[Hi-Bee Live] [Pre-Launch] "${appNameRaw}" is already running. Focused active window instead of launching new instance.`,
    );
    return true;
  }

  console.log(
    `[Hi-Bee Live] [Pre-Launch] "${appNameRaw}" not running. Launching natively.`,
  );
  const isProtocol =
    launchCmd.endsWith(':') ||
    launchCmd.startsWith('ms-') ||
    launchCmd.includes('://');
  if (process.platform === 'win32' && isProtocol) {
    await shell.openExternal(launchCmd);
  } else {
    let execCmd = launchCmd;
    if (
      process.platform === 'win32' &&
      !execCmd.includes(' ') &&
      !execCmd.includes('\\') &&
      !execCmd.includes('/')
    ) {
      if (background) {
        execCmd = `start /MIN "" "${execCmd}"`;
      } else {
        execCmd = `start "" "${execCmd}"`;
      }
    }
    await new Promise<void>((resolve, reject) => {
      exec(execCmd, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
  return false;
}

export const runAgent = async (
  setState: (state: AppState) => void,
  getState: () => AppState,
  operatorOverride?: Operator,
  runOptions: AgentRunOptions = {},
) => {
  logger.info('runAgent');
  const rawSettings = SettingStore.getStore();
  const settings = ensureVlmDefaults(rawSettings);
  const { instructions, abortController } = getState();
  assert(instructions, 'instructions is required');

  // ── Fast Actions Layer Interception ───────────────────────────────────────
  const fastAction = getFastActionCommand(
    instructions,
    process.platform === 'win32',
  );
  if (fastAction) {
    logger.info(`[runAgent] Fast Action Match: ${JSON.stringify(fastAction)}`);
    setState({
      ...getState(),
      status: StatusEnum.RUNNING,
      currentStep: 1,
      currentAction: `FastAction: ${fastAction.type} "${instructions}"`,
    });

    try {
      if (fastAction.type === 'summarize') {
        // Take a screenshot and send to Vertex AI for description
        setState({
          ...getState(),
          currentAction: 'Scanning screen for summarization...',
        });

        try {
          const { desktopCapturer: dc } = await import('electron');
          const sources = await dc.getSources({
            types: ['screen'],
            thumbnailSize: { width: 1920, height: 1080 },
          });
          const primarySource = sources[0];
          if (!primarySource) throw new Error('No screen source available');

          const screenshotBase64 = primarySource.thumbnail
            .toJPEG(80)
            .toString('base64');

          const summarizePrompt =
            'Describe what you see on this screen in 3-5 sentences. Focus on what application is open, what content is visible, and any notable UI elements. Be concise and speak naturally as if explaining to someone who cannot see the screen.';

          // Use Vertex AI client directly with the screenshot for vision-based description
          const { VertexAI } = await import('@google-cloud/vertexai');
          const { SettingStore: SS } = await import('@main/store/setting');
          const { vertexProjectId: vPid, vertexLocation: vLoc } = await import(
            '@main/env'
          );
          const storeSet = SS.getStore();
          const pid = storeSet.vertexProjectId || vPid;
          const loc = storeSet.vertexLocation || vLoc;
          const modelName =
            storeSet.vertexChatModelName ||
            storeSet.vertexModelName ||
            'gemini-2.5-flash';

          const vertex = new VertexAI({ project: pid, location: loc });
          const model = vertex.getGenerativeModel({ model: modelName });
          const ssResult = await model.generateContent({
            contents: [
              {
                role: 'user',
                parts: [
                  { text: summarizePrompt },
                  {
                    inlineData: {
                      mimeType: 'image/jpeg',
                      data: screenshotBase64,
                    },
                  },
                ],
              },
            ],
          });

          const summaryText =
            ssResult.response.candidates?.[0]?.content?.parts?.[0]?.text ||
            'I could not describe the screen right now. Please try again.';
          const cleanSummary = summaryText
            .replace(/\*\*(.*?)\*\*/g, '$1')
            .replace(/\*(.*?)\*/g, '$1')
            .replace(/`(.*?)`/g, '$1')
            .replace(/#{1,6}\s+/g, '')
            .replace(/\n+/g, ' ')
            .trim();

          logger.info(
            `[runAgent] Screen summarize result: "${cleanSummary.slice(0, 100)}..."`,
          );

          // Broadcast to voice window for TTS playback
          const { windowManager: wm } = await import(
            '@main/services/windowManager'
          );
          wm.broadcast('voice:speak-text', cleanSummary);

          setState({
            ...getState(),
            status: StatusEnum.END,
            currentStep: 1,
            currentAction: 'FastAction completed successfully',
            messages: [
              ...(getState().messages || []),
              {
                from: 'gpt' as const,
                value: `Thought: The user asked me to summarize the screen. I took a screenshot and described it: "${cleanSummary.slice(0, 200)}..." Action: finished()`,
                timing: { start: Date.now(), end: Date.now(), cost: 0 },
              },
            ],
          });
          return;
        } catch (ssErr: any) {
          logger.error('[runAgent] Screen summarize failed:', ssErr);
          // Fall through to standard VLM agent
        }
      } else if (fastAction.type === 'search' || fastAction.type === 'url') {
        const bg = fastAction.backgroundOverride || runOptions.background;
        if (bg && process.platform === 'win32') {
          await launchInBackgroundWindows(fastAction.commandOrUrl);
        } else {
          await shell.openExternal(fastAction.commandOrUrl);
        }
      } else if (fastAction.type === 'launch') {
        const appRegex = /^(?:open|launch|start|run|show|execute)\s+(.+)$/i;
        const appMatch = instructions.trim().match(appRegex);
        let appNameRaw = appMatch ? appMatch[1].trim().toLowerCase() : 'app';
        appNameRaw = appNameRaw.replace(/in the background/i, '').trim();
        const bg = fastAction.backgroundOverride || runOptions.background;
        if (bg && process.platform === 'win32') {
          await launchInBackgroundWindows(fastAction.commandOrUrl);
        } else {
          await focusOrRestoreApp(appNameRaw, fastAction.commandOrUrl, false);
        }
      } else if (fastAction.type === 'window_action' && process.platform === 'win32') {
        const appNameRaw = fastAction.commandOrUrl;
        const resolvedName = aliasMap[appNameRaw] || appNameRaw;
        const cleanName = resolvedName.replace(/[^a-zA-Z0-9 ]/g, '');
        let actionCode = '';
        if (fastAction.windowAction === 'minimize') actionCode = '[void][Win32]::ShowWindow($hwnd, 6)';
        else if (fastAction.windowAction === 'maximize') actionCode = '[void][Win32]::ShowWindow($hwnd, 3)';
        else if (fastAction.windowAction === 'close') actionCode = '[void][Win32]::SendMessage($hwnd, 0x0010, 0, 0)';

        const psScript = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, int wParam, int lParam);
}
"@
$proc = Get-Process | Where-Object { $_.ProcessName -like "*${cleanName}*" -or $_.MainWindowTitle -like "*${cleanName}*" } | Select-Object -First 1
if ($proc) {
    $hwnd = $proc.MainWindowHandle
    if ($hwnd -ne [IntPtr]::Zero) {
        ${actionCode}
    }
}
`.trim();
        const tempFile = path.join(os.tmpdir(), `window_action_${Date.now()}.ps1`);
        fs.writeFileSync(tempFile, psScript, 'utf8');
        await new Promise<void>((resolve) => {
          exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tempFile}"`, () => {
            try { fs.unlinkSync(tempFile); } catch (e) {}
            resolve();
          });
        });
      }

      // Mark as finished successfully
      setState({
        ...getState(),
        status: StatusEnum.END,
        currentStep: 1,
        currentAction: `FastAction completed successfully`,
        messages: [
          ...(getState().messages || []),
          {
            from: 'gpt' as const,
            value: `Thought: I recognized this command ("${instructions}") as a native action and executed it directly without using the slower desktop VLM agent. Action: finished()`,
            timing: { start: Date.now(), end: Date.now(), cost: 0 },
          },
        ],
      });
      return;
    } catch (err: any) {
      logger.error(
        '[runAgent] Fast Action execution failed, falling back to desktop VLM agent:',
        err,
      );
      // Fall through to standard VLM execution if direct launch fails
    }
  }

  let currentInstructions = instructions;

  // ── Smart Pre-Launch Interception ───────────────────────────────────────
  const launchSplitRegex =
    /^(?:open|launch|start|run|show|execute)\s+([a-zA-Z0-9_\s]+?)(?:\s+(?:and\s+then|then|and)\s+|,\s*)(.+)$/i;
  const launchSplitMatch = instructions.trim().match(launchSplitRegex);
  if (launchSplitMatch) {
    const appNameRaw = launchSplitMatch[1].trim().toLowerCase();
    const rest = launchSplitMatch[2].trim();
    const appMapping: Record<string, string> =
      process.platform === 'win32'
        ? {
            paint: 'mspaint.exe',
            mspaint: 'mspaint.exe',
            notepad: 'notepad.exe',
            chrome: 'chrome.exe',
            google_chrome: 'chrome.exe',
            edge: 'msedge.exe',
            msedge: 'msedge.exe',
            microsoft_edge: 'msedge.exe',
            firefox: 'firefox.exe',
            calculator: 'ms-calculator:',
            calc: 'ms-calculator:',
            settings: 'ms-settings:',
            control_panel: 'control.exe',
            control: 'control.exe',
            explorer: 'explorer.exe',
            file_explorer: 'explorer.exe',
            cmd: 'cmd.exe',
            command_prompt: 'cmd.exe',
            powershell: 'powershell.exe',
            task_manager: 'taskmgr.exe',
            taskmgr: 'taskmgr.exe',
          }
        : {
            chrome: 'open -a "Google Chrome"',
            google_chrome: 'open -a "Google Chrome"',
            safari: 'open -a "Safari"',
            calculator: 'open -a "Calculator"',
            calc: 'open -a "Calculator"',
            notepad: 'open -a "TextEdit"',
            textedit: 'open -a "TextEdit"',
            terminal: 'open -a "Terminal"',
          };
    const resolvedName = aliasMap[appNameRaw] || appNameRaw;
    const nameUnderscored = resolvedName.replace(/\s+/g, '_');
    const launchCmd =
      appMapping[nameUnderscored] ||
      appMapping[resolvedName] ||
      appMapping[appNameRaw];
    if (launchCmd) {
      try {
        await focusOrRestoreApp(appNameRaw, launchCmd);
        currentInstructions = rest;
        console.log(
          `[Hi-Bee Live] [Pre-Launch] App pre-launch phase complete. Remaining task for agent: "${currentInstructions}"`,
        );
        await sleep(1000); // wait for window to spawn and gain focus
      } catch (err) {
        console.error(
          `[Hi-Bee Live] [Pre-Launch] Pre-launch action failed:`,
          err,
        );
      }
    }
  }

  const language = settings.language ?? 'en';
  const effectiveOperator = operatorOverride ?? settings.operator;
  const executionInstructions =
    effectiveOperator === Operator.LocalComputer
      ? `Perform the task by taking a concrete desktop action immediately. Do not stop after a screenshot, do not answer with wait, and do not remain passive.\n\n${currentInstructions}`
      : currentInstructions;

  logger.info('settings.operator', settings.operator);
  logger.info('runAgent.operatorOverride', operatorOverride ?? 'none');

  // ── Step counter shared across the closure ───────────────────────────────
  let stepCounter = 0;

  const handleData: GUIAgentConfig<NutJSElectronOperator>['onData'] = async ({
    data,
  }) => {
    const lastConv = getState().messages[getState().messages.length - 1];
    const { status, conversations, ...restUserData } = data;
    logger.info('[onGUIAgentData] status', status, conversations.length);

    // add SoM to conversations
    const conversationsWithSoM: ConversationWithSoM[] = await Promise.all(
      conversations.map(async (conv) => {
        const { screenshotContext, predictionParsed } = conv;
        if (
          lastConv?.screenshotBase64 &&
          screenshotContext?.size &&
          predictionParsed
        ) {
          const screenshotBase64WithElementMarker = await markClickPosition({
            screenshotContext,
            base64: lastConv?.screenshotBase64,
            parsed: predictionParsed,
          }).catch((e) => {
            logger.error('[markClickPosition error]:', e);
            return '';
          });
          return {
            ...conv,
            screenshotBase64WithElementMarker,
          };
        }
        return conv;
      }),
    ).catch((e) => {
      logger.error('[conversationsWithSoM error]:', e);
      return conversations;
    });

    const {
      screenshotBase64,
      predictionParsed,
      screenshotContext,
      screenshotBase64WithElementMarker,
      ...rest
    } = conversationsWithSoM?.[conversationsWithSoM.length - 1] || {};
    logger.info(
      '[onGUIAgentData] ======data======\n',
      predictionParsed,
      screenshotContext,
      rest,
      status,
      '\n========',
    );

    if (
      effectiveOperator === Operator.LocalComputer &&
      predictionParsed?.length &&
      screenshotContext?.size &&
      !abortController?.signal?.aborted
    ) {
      showPredictionMarker(predictionParsed, screenshotContext);
    }

    // ── Live-action state ──────────────────────────────────────────────────
    // Build a human-readable summary of the latest action for the UI banner.
    let currentAction: string | null = null;
    if (predictionParsed?.length) {
      const latest = predictionParsed[predictionParsed.length - 1];
      if (latest) {
        const args = Object.entries(latest.action_inputs ?? {})
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(', ');
        currentAction = args
          ? `${latest.action_type}(${args})`
          : latest.action_type;
      }
    }
    stepCounter = conversationsWithSoM.length;

    setState({
      ...getState(),
      status,
      restUserData,
      messages: [...(getState().messages || []), ...conversationsWithSoM],
      currentAction,
      currentStep: stepCounter,
    });

    // ── call_user standby-timeout ─────────────────────────────────────────
    // Cancel any previous timer first (covers rapid successive data events)
    cancelCallUserTimer();
    if (status === 'call_user' && !abortController?.signal?.aborted) {
      const CALL_USER_TIMEOUT_MS = 120_000; // 2 minutes
      const timer = setTimeout(() => {
        logger.warn('[runAgent] call_user timeout reached — auto-resuming');
        // Clear registration so stop doesn't try to cancel an already-fired timer
        registerCallUserTimer(null);
        // Inject a synthetic user response so the agent can continue
        const syntheticMsg = {
          from: 'human' as const,
          value:
            'No user response received. Please continue the task autonomously.',
          timing: { start: Date.now(), end: Date.now(), cost: 0 },
        };
        setState({
          ...getState(),
          messages: [...getState().messages, syntheticMsg],
        });
        const agent = GUIAgentManager.getInstance().getAgent();
        if (agent && typeof (agent as any).resume === 'function') {
          (agent as any).resume();
        }
      }, CALL_USER_TIMEOUT_MS);
      // Register with the module-level registry so stopActiveAgentRun can cancel it
      registerCallUserTimer(timer);
    }

    // Save active state to MongoDB for the voice agent to access
    if (mongoService.isConnected()) {
      const lastGptMessage = [...conversationsWithSoM]
        .reverse()
        .find((m) => m?.from === 'gpt');
      const lastPredictionText = lastGptMessage?.value || null;

      const lastScreenshotMsg = [...conversationsWithSoM]
        .reverse()
        .find((m) => m?.screenshotBase64);
      const lastScreenshotBase64 =
        lastScreenshotMsg?.screenshotBase64 ||
        lastConv?.screenshotBase64 ||
        null;

      mongoService
        .saveActiveAgentState({
          sessionId: 'active-session',
          status,
          instructions: instructions || '',
          lastStepIndex: conversationsWithSoM.length - 1,
          lastPredictionText,
          lastScreenshotBase64,
        })
        .catch((err) => {
          logger.warn(
            '[runAgent] Failed to save active agent state to DB:',
            err,
          );
        });
    }
  };

  let operatorType: 'computer' | 'browser' = 'computer';
  let agentOperator:
    | NutJSElectronOperator
    | DefaultBrowserOperator
    | RemoteComputerOperator
    | RemoteBrowserOperator;

  switch (effectiveOperator) {
    case Operator.LocalComputer:
      agentOperator = new NutJSElectronOperator();
      operatorType = 'computer';
      break;
    case Operator.LocalBrowser:
      await checkBrowserAvailability();
      const { browserAvailable } = getState();
      if (!browserAvailable) {
        setState({
          ...getState(),
          status: StatusEnum.ERROR,
          errorMsg:
            'Browser is not available. Please install Chrome and try again.',
        });
        return;
      }

      agentOperator = await DefaultBrowserOperator.getInstance(
        false,
        false,
        false,
        getState().status === StatusEnum.CALL_USER,
        getLocalBrowserSearchEngine(settings.searchEngineForBrowser),
      );
      operatorType = 'browser';
      break;
    case Operator.RemoteComputer:
      agentOperator = await RemoteComputerOperator.create();
      operatorType = 'computer';
      break;
    case Operator.RemoteBrowser:
      agentOperator = await createRemoteBrowserOperator();
      operatorType = 'browser';
      break;
    default:
      break;
  }

  let modelVersion = getModelVersion(settings.vlmProvider);
  let modelConfig: UITarsModelConfig = {
    baseURL: settings.vlmBaseUrl ?? '',
    // secretlint-disable-next-line
    apiKey: settings.vlmApiKey ?? '',
    model: settings.vlmModelName ?? '',
    useResponsesApi: settings.useResponsesApi,
  };
  let modelAuthHdrs: Record<string, string> = {};

  if (
    effectiveOperator === Operator.RemoteComputer ||
    effectiveOperator === Operator.RemoteBrowser
  ) {
    const useResponsesApi = await ProxyClient.getRemoteVLMResponseApiSupport();
    modelConfig = {
      baseURL: FREE_MODEL_BASE_URL,
      // secretlint-disable-next-line
      apiKey: '',
      model: '',
      useResponsesApi,
    };
    modelAuthHdrs = await getAuthHeader();
    modelVersion = await ProxyClient.getRemoteVLMProvider();
  }

  const systemPrompt = getSpByModelVersion(
    modelVersion,
    language,
    operatorType,
  );

  // ── Model instantiation ───────────────────────────────────────────────────
  // If the user selected the Gemini Vertex AI provider, build a GeminiVertexModel
  // instead of the default OpenAI-compatible UITarsModel. All other code paths
  // (GUIAgent, operators, action parsing) remain identical.
  const isGeminiProvider = shouldUseVertexGemini(settings, effectiveOperator);

  let modelInstance: GeminiVertexModel | UITarsModelConfig;

  if (isGeminiProvider) {
    const projectId = getVertexProjectId(settings);
    const location = settings.vertexLocation || 'us-central1';
    const modelName = settings.vertexModelName || 'gemini-2.5-pro';

    if (!projectId) {
      setState({
        ...getState(),
        status: StatusEnum.ERROR,
        errorMsg:
          'Vertex AI Gemini provider is selected but no Project ID is configured. ' +
          'Please set it in Settings → VLM Settings → Vertex Project ID.',
      });
      return;
    }

    logger.info(
      `[runAgent] Using GeminiVertexModel project=${projectId} location=${location} model=${modelName}`,
    );

    modelInstance = new GeminiVertexModel({
      projectId,
      location,
      modelName,
      serviceAccountPath: settings.vertexServiceAccountPath || undefined,
    });
  } else {
    if (!modelConfig.apiKey?.trim() || !modelConfig.baseURL?.trim()) {
      setState({
        ...getState(),
        status: StatusEnum.ERROR,
        errorMsg:
          'No VLM provider configured. Set Vertex AI (Settings → VLM) or provide VLM API key and base URL.',
      });
      logger.error(
        '[runAgent] Missing VLM credentials — aborting before agent loop',
      );
      return;
    }
    modelInstance = modelConfig;
    logger.info('[runAgent] Using UITarsModel (OpenAI-compatible)');
  }

  const originalModel = (
    isGeminiProvider ? modelInstance : new UITarsModel(modelConfig)
  ) as any;

  const wrappedModel = {
    get factors() {
      return originalModel.factors;
    },
    get modelName() {
      return originalModel.modelName;
    },
    reset() {
      if (typeof (originalModel as any).reset === 'function') {
        (originalModel as any).reset();
      }
    },
    async invoke(params: InvokeParams) {
      const { conversations, images } = params;
      let finalConversations = conversations;
      if (images && images.length >= 3) {
        const len = images.length;
        if (
          images[len - 1] === images[len - 2] &&
          images[len - 2] === images[len - 3]
        ) {
          logger.warn(
            '[runAgent] Detected 3 identical screenshots in a row. Injecting recovery hint.',
          );
          finalConversations = [
            ...conversations,
            {
              from: 'human' as const,
              value:
                'SYSTEM HINT: The screen has not changed for the last 3 steps. The previous action may have failed, clicked an empty/non-interactive area, or was blocked. Please try a different strategy, click a slightly offset position, scroll, or use a different hotkey to recover.',
            },
          ];
        }
      }
      return originalModel.invoke({
        ...params,
        conversations: finalConversations,
      });
    },
  };

  const guiAgent = new GUIAgent({
    // wrappedModel satisfies UITarsModel's runtime interface (invoke method).
    model: wrappedModel as any,
    systemPrompt: systemPrompt,
    logger,
    signal: abortController?.signal,
    operator: agentOperator!,
    onData: handleData,
    onError: (params) => {
      const { error } = params;
      logger.error('[onGUIAgentError]', settings, error);
      setState({
        ...getState(),
        status: StatusEnum.ERROR,
        errorMsg: JSON.stringify({
          status: error?.status,
          message: error?.message,
          stack: error?.stack,
        }),
      });
    },
    retry: {
      model: {
        maxRetries: 5,
      },
      screenshot: {
        maxRetries: 5,
      },
      execute: {
        // Increased from 1 → 3: transient operator failures (click miss, focus
        // loss) should be retried before aborting the step entirely.
        maxRetries: 3,
      },
    },
    maxLoopCount: settings.maxLoopCount,
    // Floor at 300 ms — values below this cause thrashing on slow machines.
    loopIntervalInMs: Math.max(settings.loopIntervalInMs ?? 1000, 300),
    uiTarsVersion: modelVersion,
  });

  GUIAgentManager.getInstance().setAgent(guiAgent);
  UTIOService.getInstance().sendInstruction(executionInstructions);

  const { sessionHistoryMessages } = getState();

  beforeAgentRun(effectiveOperator, runOptions);

  const startTime = Date.now();

  await guiAgent
    .run(executionInstructions, sessionHistoryMessages, modelAuthHdrs)
    .catch((e) => {
      logger.error('[runAgentLoop error]', e);
      setState({
        ...getState(),
        status: StatusEnum.ERROR,
        errorMsg: e.message,
      });
    });

  logger.info('[runAgent Total cost]: ', (Date.now() - startTime) / 1000, 's');

  // Cancel any pending call_user timer and clear the live-action banner
  cancelCallUserTimer();
  setState({
    ...getState(),
    currentAction: null,
    currentStep: 0,
  });

  afterAgentRun(effectiveOperator);
};
