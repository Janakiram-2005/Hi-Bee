/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'assert';
import { exec } from 'child_process';
import { shell } from 'electron';

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
import { UITarsModel, type UITarsModelConfig, type InvokeParams } from '@ui-tars/sdk/core';
import { registerCallUserTimer, cancelCallUserTimer } from './stopAgentRun';

interface FastAction {
  type: 'launch' | 'search' | 'url';
  commandOrUrl: string;
}

export function getFastActionCommand(instructions: string, isWindows: boolean): FastAction | null {
  const query = instructions.trim();
  
  // Redirect Chrome launching to open google.com directly
  if (/^(?:open|launch|start|run|show|execute)?\s*(google\s+)?chrome$/i.test(query)) {
    return {
      type: 'url',
      commandOrUrl: 'https://google.com'
    };
  }
  
  // 1. Check for search queries
  const searchForRegex = /^(?:search\s+for|google\s+search\s+for|search\s+on\s+google\s+for|google\s+search|google|search)\s+(.+)$/i;
  const searchForMatch = query.match(searchForRegex);
  if (searchForMatch) {
    const rawSearchQuery = searchForMatch[1].trim();
    const lowerQuery = rawSearchQuery.toLowerCase();
    const isApp = ['paint', 'notepad', 'chrome', 'edge', 'firefox', 'calculator', 'calc', 'settings', 'explorer', 'cmd', 'powershell', 'task manager', 'taskmgr', 'camera', 'photos', 'clock', 'store', 'vscode', 'code', 'safari', 'browser', 'terminal'].includes(lowerQuery);
    if (rawSearchQuery && !isApp) {
      return {
        type: 'search',
        commandOrUrl: `https://www.google.com/search?q=${encodeURIComponent(rawSearchQuery)}`
      };
    }
  }

  // 2. Direct website opens
  const urlRegex = /^(?:open|go\s+to|visit)\s+(https?:\/\/)?([a-z0-9]+([\-.]{1}[a-z0-9]+)*\.[a-z]{2,5}(:[0-9]{1,5})?(\/.*)?)$/i;
  const urlMatch = query.match(urlRegex);
  if (urlMatch) {
    let url = urlMatch[2];
    if (!urlMatch[1]) {
      url = 'https://' + url;
    }
    return {
      type: 'url',
      commandOrUrl: url
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
    linkedin: 'https://linkedin.com'
  };
  const friendlyWebRegex = /^(?:open|go\s+to|visit)\s+(youtube|github|chatgpt|google|gmail|outlook|wikipedia|facebook|twitter|linkedin)$/i;
  const friendlyWebMatch = query.match(friendlyWebRegex);
  if (friendlyWebMatch) {
    const name = friendlyWebMatch[1].toLowerCase();
    if (websiteNames[name]) {
      return {
        type: 'url',
        commandOrUrl: websiteNames[name]
      };
    }
  }

  // 3. Known App Launching
  const appMapping: Record<string, string> = isWindows ? {
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
    sticky_notes: 'explorer.exe shell:Appsfolder\\Microsoft.MicrosoftStickyNotes_8wekyb3d8bbwe!App',
    spotify: 'spotify:',
    discord: 'discord:'
  } : {
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
    photos: 'open -a "Photos"'
  };

  const appRegex = /^(?:open|launch|start|run|show|execute)\s+(.+)$/i;
  const appMatch = query.match(appRegex);
  if (appMatch) {
    const nameRaw = appMatch[1].trim().toLowerCase();
    const nameUnderscored = nameRaw.replace(/\s+/g, '_');
    if (appMapping[nameUnderscored]) {
      return {
        type: 'launch',
        commandOrUrl: appMapping[nameUnderscored]
      };
    }
    if (appMapping[nameRaw]) {
      return {
        type: 'launch',
        commandOrUrl: appMapping[nameRaw]
      };
    }
  }

  const normalizedQuery = query.toLowerCase().replace(/\s+/g, '_');
  const normalizedQueryRaw = query.toLowerCase().trim();
  if (appMapping[normalizedQuery]) {
    return {
      type: 'launch',
      commandOrUrl: appMapping[normalizedQuery]
    };
  }
  if (appMapping[normalizedQueryRaw]) {
    return {
      type: 'launch',
      commandOrUrl: appMapping[normalizedQueryRaw]
    };
  }

  // 4. Substring fallback matching for friendly names and app launch anywhere in query
  const lowerQuery = query.toLowerCase();
  for (const appName of Object.keys(appMapping)) {
    const regex = new RegExp(`\\b(open|launch|start|run|show|execute)\\s+${appName}\\b`, 'i');
    if (regex.test(lowerQuery)) {
      return {
        type: 'launch',
        commandOrUrl: appMapping[appName]
      };
    }
  }

  for (const [webName, url] of Object.entries(websiteNames)) {
    const regex = new RegExp(`\\b(open|go\\s+to|visit)\\s+${webName}\\b`, 'i');
    if (regex.test(lowerQuery)) {
      return {
        type: 'url',
        commandOrUrl: url
      };
    }
  }

  return null;
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
  const fastAction = getFastActionCommand(instructions, process.platform === 'win32');
  if (fastAction) {
    logger.info(`[runAgent] Fast Action Match: ${JSON.stringify(fastAction)}`);
    setState({
      ...getState(),
      status: StatusEnum.RUNNING,
      currentStep: 1,
      currentAction: `FastAction: ${fastAction.type} "${instructions}"`,
    });

    try {
      if (fastAction.type === 'search' || fastAction.type === 'url') {
        await shell.openExternal(fastAction.commandOrUrl);
      } else if (fastAction.type === 'launch') {
        const isProtocol = fastAction.commandOrUrl.endsWith(':') || fastAction.commandOrUrl.startsWith('ms-') || fastAction.commandOrUrl.includes('://');
        if (process.platform === 'win32' && isProtocol) {
          await shell.openExternal(fastAction.commandOrUrl);
        } else {
          let launchCmd = fastAction.commandOrUrl;
          if (process.platform === 'win32') {
            // For simple executables, use Windows start command to search registry App Paths
            if (!launchCmd.includes(' ') && !launchCmd.includes('\\') && !launchCmd.includes('/')) {
              launchCmd = `start "" "${launchCmd}"`;
            }
          }
          await new Promise<void>((resolve, reject) => {
            exec(launchCmd, (error) => {
              if (error) {
                logger.error(`[runAgent] Fast Action exec failed:`, error);
                reject(error);
              } else {
                resolve();
              }
            });
          });
        }
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
          }
        ]
      });
      return;
    } catch (err: any) {
      logger.error('[runAgent] Fast Action execution failed, falling back to desktop VLM agent:', err);
      // Fall through to standard VLM execution if direct launch fails
    }
  }

  const language = settings.language ?? 'en';
  const effectiveOperator = operatorOverride ?? settings.operator;
  const executionInstructions =
    effectiveOperator === Operator.LocalComputer
      ? `Perform the task by taking a concrete desktop action immediately. Do not stop after a screenshot, do not answer with wait, and do not remain passive.\n\n${instructions}`
      : instructions;

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
        currentAction = args ? `${latest.action_type}(${args})` : latest.action_type;
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
          value: 'No user response received. Please continue the task autonomously.',
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
      const lastScreenshotBase64 = lastScreenshotMsg?.screenshotBase64 || lastConv?.screenshotBase64 || null;

      mongoService.saveActiveAgentState({
        sessionId: 'active-session',
        status,
        instructions: instructions || '',
        lastStepIndex: conversationsWithSoM.length - 1,
        lastPredictionText,
        lastScreenshotBase64,
      }).catch((err) => {
        logger.warn('[runAgent] Failed to save active agent state to DB:', err);
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
      logger.error('[runAgent] Missing VLM credentials — aborting before agent loop');
      return;
    }
    modelInstance = modelConfig;
    logger.info('[runAgent] Using UITarsModel (OpenAI-compatible)');
  }

  const originalModel = (isGeminiProvider
    ? modelInstance
    : new UITarsModel(modelConfig)) as any;

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
        if (images[len - 1] === images[len - 2] && images[len - 2] === images[len - 3]) {
          logger.warn('[runAgent] Detected 3 identical screenshots in a row. Injecting recovery hint.');
          finalConversations = [
            ...conversations,
            {
              from: 'human' as const,
              value: 'SYSTEM HINT: The screen has not changed for the last 3 steps. The previous action may have failed, clicked an empty/non-interactive area, or was blocked. Please try a different strategy, click a slightly offset position, scroll, or use a different hotkey to recover.',
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
