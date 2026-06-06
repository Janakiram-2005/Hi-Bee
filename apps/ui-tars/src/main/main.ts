import { electronApp, optimizer } from '@electron-toolkit/utils';
import {
  app,
  BrowserView,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  session,
  WebContentsView,
  screen,
} from 'electron';
import squirrelStartup from 'electron-squirrel-startup';
import ElectronStore from 'electron-store';

import * as env from '@main/env';
import { logger } from '@main/logger';
import { createMainWindow, showMainWindow, hideMainWindow } from '@main/window/index';
import {
  createVoiceWindow,
  closeVoiceWindow,
  getVoiceWindow,
  moveVoiceWindow,
  setVoiceWindowIgnoreMouseEvents,
} from '@main/window/voiceWindow';
import {
  createHiBeeAgentWindow,
  toggleHiBeeAgentWindow,
  closeHiBeeAgentWindow,
  getHiBeeAgentWindow,
} from '@main/window/hibeeAgentWindow';
import { registerIpcMain } from '@ui-tars/electron-ipc/main';
import { ipcRoutes } from './ipcRoutes';

import { UTIOService } from './services/utio';
import { store } from './store/create';
import { SettingStore } from './store/setting';
import { createTray } from './tray';
import { registerSettingsHandlers } from './services/settings';
import { sanitizeState } from './utils/sanitizeState';
import { stopActiveAgentRun } from './services/stopAgentRun';
import { windowManager } from './services/windowManager';
import { checkBrowserAvailability } from './services/browserCheck';
import { mongoService } from './services/mongoService';

const { isProd } = env;

// ── Accessibility ─────────────────────────────────────────────────────────
app.commandLine.appendSwitch('force-renderer-accessibility');

// ── Override Chromium's speech / media blocking ────────────────────────────
// Prevents "service-not-allowed" from SpeechRecognition in transparent windows.
// `use-fake-ui-for-media-stream` makes Chromium auto-grant all media requests
// at the browser engine level — no permission dialog, no service check.
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
// Enable Web Speech API explicitly (some Electron builds disable it).
app.commandLine.appendSwitch('enable-features', 'WebSpeechAPI,SpeechSynthesis,AudioCaptureAllowed');
// Remove the requirement for a user gesture to start audio playback / capture.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Disable WebRTC mDNS that can interfere with audio capture routing.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
// Allow microphone capture without HTTPS — needed for file:// and localhost origins.
app.commandLine.appendSwitch('allow-insecure-localhost');
app.commandLine.appendSwitch('ignore-certificate-errors');


// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (squirrelStartup) {
  app.quit();
}

logger.debug('[env]', env);

ElectronStore.initRenderer();

if (isProd) {
  import('source-map-support').then(({ default: sourceMapSupport }) => {
    sourceMapSupport.install();
  });
}

const loadDevDebugTools = async () => {
  import('electron-debug').then(({ default: electronDebug }) => {
    electronDebug({ showDevTools: false });
  });

  import('electron-devtools-installer')
    .then((module) => {
      const installExtensionDefault = module.default;
      const REACT_DEVELOPER_TOOLS = module.REACT_DEVELOPER_TOOLS;
      // @ts-ignore
      const installExtension = typeof installExtensionDefault === 'function'
        ? installExtensionDefault
        : (installExtensionDefault as any)?.default;
      
      if (typeof installExtension !== 'function') {
        logger.warn('[main] DevTools installExtension is not a function, skipping.');
        return;
      }
      
      const extensions = [installExtension(REACT_DEVELOPER_TOOLS)];

      return Promise.all(extensions)
        .then((names) => logger.info('Added Extensions:', names.join(', ')))
        .catch((err) =>
          logger.error('An error occurred adding extension:', err),
        );
    })
    .catch(logger.error);
};

const initializeApp = async () => {
  const isAccessibilityEnabled = app.isAccessibilitySupportEnabled();
  logger.info('isAccessibilityEnabled', isAccessibilityEnabled);
  if (env.isMacOS) {
    app.setAccessibilitySupportEnabled(true);
    const { ensurePermissions } = await import('@main/utils/systemPermissions');

    const ensureScreenCapturePermission = ensurePermissions();
    store.setState({ ensurePermissions: ensureScreenCapturePermission });
    logger.info('ensureScreenCapturePermission', ensureScreenCapturePermission);
  } else {
    store.setState({
      ensurePermissions: { screenCapture: true, accessibility: true },
    });
  }

  await checkBrowserAvailability();

  // if (env.isDev) {
  await loadDevDebugTools();
  // }

  logger.info('createTray');
  // Tray
  await createTray();

  // Connect MongoDB (non-blocking — app works even if this fails)
  mongoService.connect().catch((err) => logger.warn('[main] MongoDB connect failed:', err));

  // Helper to register global shortcuts with fallback and error logging
  const registerWithFallback = (primary: string, fallback: string, callback: () => void) => {
    try {
      const success = globalShortcut.register(primary, callback);
      if (success) {
        logger.info(`[main] Registered global shortcut: ${primary}`);
        return true;
      } else {
        logger.warn(`Shortcut [${primary}] failed to register. It may be intercepted by the OS.`);
        
        // Attempt fallback registration
        const fallbackSuccess = globalShortcut.register(fallback, callback);
        if (fallbackSuccess) {
          logger.info(`[main] Registered fallback global shortcut: ${fallback}`);
          return true;
        } else {
          logger.warn(`Shortcut [${fallback}] failed to register. It may be intercepted by the OS.`);
          return false;
        }
      }
    } catch (err) {
      logger.warn(`[main] Could not register global shortcut [${primary}] or [${fallback}]:`, err);
      return false;
    }
  };

  // Toggle Voice callback
  const onToggleVoice = () => {
    logger.info('[main] Voice toggle hotkey fired!');
    const currentSettings = SettingStore.getStore();
    if (currentSettings.googleApiSource === 'agent_builder') {
      toggleHiBeeAgentWindow();
    } else {
      if (!currentSettings.voiceEnabled) {
        SettingStore.set('voiceEnabled', true);
      }
      
      let win = getVoiceWindow();
      if (!win || win.isDestroyed()) {
        win = createVoiceWindow();
      }
      
      if (win && !win.isDestroyed()) {
        win.showInactive();
      }
      
      windowManager.broadcast('voice:toggle-listen', null);
    }
  };

  // Register Voice toggles with fallbacks
  registerWithFallback('CommandOrControl+Shift+V', 'CommandOrControl+Alt+V', onToggleVoice);
  registerWithFallback('CommandOrControl+Shift+Space', 'CommandOrControl+Alt+Space', onToggleVoice);

  // Register Toggle Agent chat window with fallback (Ctrl+Shift+H / Ctrl+Alt+H)
  registerWithFallback('CommandOrControl+Shift+H', 'CommandOrControl+Alt+H', () => {
    logger.info('[main] Toggling Hi-Bee Agent window');
    toggleHiBeeAgentWindow();
  });

  // Register Stop Action command with fallback (Ctrl+Shift+S / Ctrl+Alt+S)
  registerWithFallback('CommandOrControl+Shift+S', 'CommandOrControl+Alt+S', () => {
    logger.info('[main] Global shortcut: stopping active agent run');
    stopActiveAgentRun();
  });

  // Send app launched event
  await UTIOService.getInstance().appLaunched();

  // Force/sync startup settings to ensure voice agent always activates on project run
  SettingStore.set('voiceEnabled', true);

  const { ensureVlmDefaults } = await import('@main/utils/vlmProvider');
  const syncedSettings = ensureVlmDefaults(SettingStore.getStore());
  if (syncedSettings.vlmProvider !== SettingStore.get('vlmProvider')) {
    SettingStore.set('vlmProvider', syncedSettings.vlmProvider);
  }
  if (
    syncedSettings.vertexProjectId &&
    syncedSettings.vertexProjectId !== SettingStore.get('vertexProjectId')
  ) {
    SettingStore.set('vertexProjectId', syncedSettings.vertexProjectId);
  }

  const settings = SettingStore.getStore();

  logger.info('createMainWindow');
  let mainWindow = createMainWindow({
    showInBackground: settings.voiceEnabled,
  });

  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
        const primaryDisplay = screen.getPrimaryDisplay();
        const primarySource = sources.find(
          (source) => source.display_id === primaryDisplay.id.toString(),
        );

        callback({ video: primarySource!, audio: 'loopback' });
      });
    },
    { useSystemPicker: false },
  );

  const grantedMediaPermissions = new Set<string>();

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const mediaPerms = ['media', 'audio', 'microphone', 'audioCapture', 'mediaKeySystem'];
    if (mediaPerms.includes(permission as string)) {
      if (!grantedMediaPermissions.has(permission)) {
        grantedMediaPermissions.add(permission);
        logger.info(`[main] Permission granted: ${permission}`);
      }
      callback(true);
    } else {
      // Grant most other permissions (notifications, geolocation etc) too
      logger.info(`[main] Permission auto-granted: ${permission}`);
      callback(true);
    }
  });

  session.defaultSession.setPermissionCheckHandler((_webContents, _permission) => {
    // Always return true — the voice window needs unconditional media access
    return true;
  });

  // Electron 20+: auto-grant device access for microphone/camera so getUserMedia
  // never throws NotAllowedError from a transparent/background window.
  if (typeof session.defaultSession.setDevicePermissionHandler === 'function') {
    session.defaultSession.setDevicePermissionHandler((details) => {
      logger.info(`[main] Device permission requested: ${details.deviceType}`);
      // Grant audio (microphone) always; grant video only if explicitly needed
      if (details.deviceType === ('media' as any)) {
        return true;
      }
      return true;
    });
  }

  logger.info('mainZustandBridge');

  const { unsubscribe } = registerIPCHandlers([mainWindow]);

  app.on('window-all-closed', () => {
    logger.info('window-all-closed');
    if (!env.isMacOS) {
      app.quit();
    }
  });

  app.on('before-quit', () => {
    logger.info('before-quit');
    globalShortcut.unregisterAll();
    mongoService.disconnect().catch(() => {});
    const windows = BrowserWindow.getAllWindows();
    windows.forEach((window) => window.destroy());
  });

  app.on('quit', () => {
    logger.info('app quit');
    unsubscribe();
  });

  app.on('activate', () => {
    logger.info('app activate');
    if (!mainWindow || mainWindow.isDestroyed()) {
      const settings = SettingStore.getStore();
      mainWindow = createMainWindow({
        showInBackground: settings.voiceEnabled,
      });
    } else {
      if (!mainWindow.isVisible()) {
        mainWindow.show();
      }
      mainWindow.focus();
    }
  });

  logger.info('initializeApp end');

  // Check and update remote presets
  if (
    settings.presetSource?.type === 'remote' &&
    settings.presetSource.autoUpdate
  ) {
    try {
      await SettingStore.importPresetFromUrl(settings.presetSource.url!, true);
    } catch (error) {
      logger.error('Failed to update preset:', error);
    }
  }

  // Create voice window on startup if enabled
  if (settings.voiceEnabled) {
    if (settings.googleApiSource === 'agent_builder') {
      createHiBeeAgentWindow();
    } else {
      createVoiceWindow();
    }
  }

  // Listen for settings change to dynamically show/hide the voice window
  SettingStore.getInstance().onDidAnyChange((newVal) => {
    if (newVal?.voiceEnabled) {
      if (newVal.googleApiSource === 'agent_builder') {
        closeVoiceWindow();
        const win = getHiBeeAgentWindow();
        if (!win || win.isDestroyed()) {
          createHiBeeAgentWindow();
        }
      } else {
        closeHiBeeAgentWindow();
        const win = getVoiceWindow();
        if (!win || win.isDestroyed()) {
          createVoiceWindow();
        }
      }
    } else {
      closeVoiceWindow();
      closeHiBeeAgentWindow();
    }
  });
};

/**
 * Register IPC handlers
 */
const registerIPCHandlers = (
  wrappers: (BrowserWindow | WebContentsView | BrowserView)[],
) => {
  ipcMain.handle('getState', () => {
    const state = store.getState();
    return sanitizeState(state);
  });

  // 初始化时注册已有窗口
  wrappers.forEach((wrapper) => {
    if (wrapper instanceof BrowserWindow) {
      windowManager.registerWindow(wrapper);
    }
  });

  // only send state to the wrappers that are not destroyed
  ipcMain.on('subscribe', (state: unknown) => {
    const sanitizedState = sanitizeState(state as Record<string, unknown>);
    windowManager.broadcast('subscribe', sanitizedState);
  });

  const unsubscribe = store.subscribe((state: unknown) =>
    ipcMain.emit('subscribe', state),
  );

  // TODO: move to ipc routes
  ipcMain.handle('utio:shareReport', async (_, params) => {
    await UTIOService.getInstance().shareReport(params);
  });

  ipcMain.handle('voice-window:move', (_, { dx, dy }) => {
    moveVoiceWindow(dx, dy);
  });

  ipcMain.handle('voice-window:set-ignore-mouse-events', (_, ignore) => {
    setVoiceWindowIgnoreMouseEvents(ignore);
  });

  // ── Hi-Bee Agent window IPC ─────────────────────────────────────────────────
  ipcMain.handle('hibee-agent:open', () => {
    createHiBeeAgentWindow();
  });

  ipcMain.handle('hibee-agent:close', () => {
    closeHiBeeAgentWindow();
  });

  ipcMain.handle('hibee-agent:toggle', () => {
    toggleHiBeeAgentWindow();
  });

  ipcMain.handle('voice:open-settings', () => {
    showMainWindow();
    windowManager.broadcast('voice:open-settings-ui', null);
  });

  ipcMain.handle('voice:show-main-window', () => {
    logger.info('[main] Showing main window for microphone permission request');
    showMainWindow();
  });

  ipcMain.handle('voice:hide-main-window-if-background', () => {
    logger.info('[main] Hiding main window after microphone permission request');
    const settings = SettingStore.getStore();
    if (settings.voiceEnabled) {
      hideMainWindow();
    }
  });

  ipcMain.handle('voice:speak', (_event, text) => {
    windowManager.broadcast('voice:speak-text', text);
  });

  registerSettingsHandlers();
  // register ipc services routes
  registerIpcMain(ipcRoutes);

  return { unsubscribe };
};

/**
 * Add event listeners...
 */

app
  .whenReady()
  .then(async () => {
    electronApp.setAppUserModelId('com.electron');

    // Default open or close DevTools by F12 in development
    // and ignore CommandOrControl + R in production.
    // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window);
    });

    await initializeApp();

    logger.info('app.whenReady end');
  })

  .catch(console.log);
