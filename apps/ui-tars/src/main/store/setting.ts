/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import ElectronStore from 'electron-store';
import yaml from 'js-yaml';

import * as env from '@main/env';
import { logger } from '@main/logger';

import {
  LocalStore,
  SearchEngineForSettings,
  VLMProviderV2,
  Operator,
} from './types';
import { validatePreset } from './validate';
import { BrowserWindow } from 'electron';
import { getVertexProjectId } from '@main/utils/vlmProvider';

const defaultVertexProjectId = getVertexProjectId({
  vertexProjectId: '',
} as LocalStore);

export const DEFAULT_SETTING: LocalStore = {
  language: 'en',
  vlmProvider:
    (env.vlmProvider as VLMProviderV2) ||
    (defaultVertexProjectId ? VLMProviderV2.gemini_vertex : ('' as VLMProviderV2)),
  vlmBaseUrl: env.vlmBaseUrl || '',
  vlmApiKey: env.vlmApiKey || '',
  vlmModelName: env.vlmModelName || '',
  useResponsesApi: false,
  maxLoopCount: 100,
  loopIntervalInMs: 1000,
  searchEngineForBrowser: SearchEngineForSettings.GOOGLE,
  operator: Operator.LocalComputer,
  reportStorageBaseUrl: '',
  utioBaseUrl: '',
  // ── Google Vertex AI Gemini defaults ──────────────────────────────────────
  vertexProjectId: env.vertexVlmProjectId || env.vertexProjectId || '',
  vertexLocation: env.vertexVlmLocation || env.vertexLocation || 'us-central1',
  vertexModelName: env.vertexVlmModelName || 'gemini-2.5-flash',
  vertexChatModelName: 'gemini-2.5-flash',
  vertexServiceAccountPath: '',
  enableStreamingResponse: true,
  googleApiSource: 'direct',
  // ── Voice Agent defaults ───────────────────────────────────────────────────
  voiceEnabled: true,
  voiceAutoStart: true,
  voiceLanguage: 'en-US',
  voiceAccent: '',
  voiceAccentUri: '',
  voiceSilenceMs: 1000,
  voiceHotkey: 'Ctrl+Shift+V',
  micPermissionGranted: false,
  voiceWakeupMode: 'hotkey',
  voiceWakePhrase: 'hey hibee',
  voiceTtsBackend: 'gcp',
  useTeluguVoice: false,
};

export class SettingStore {
  private static instance: ElectronStore<LocalStore>;

  public static getInstance(): ElectronStore<LocalStore> {
    if (!SettingStore.instance) {
      SettingStore.instance = new ElectronStore<LocalStore>({
        name: 'ui_tars.setting',
        defaults: DEFAULT_SETTING,
      });

      // Sanitization: override deprecated/non-existent model names persisted on disk
      try {
        const store = SettingStore.instance.store;
        if (
          store.vertexModelName === 'gemini-2.5-flash-preview-05-20' ||
          store.vertexModelName === 'gemini-1.5-flash'
        ) {
          logger.info(`[SettingStore] Migrated vertexModelName: ${store.vertexModelName} -> gemini-2.5-flash`);
          SettingStore.instance.set('vertexModelName', 'gemini-2.5-flash');
        } else if (store.vertexModelName === 'gemini-1.5-pro') {
          logger.info(`[SettingStore] Migrated vertexModelName: gemini-1.5-pro -> gemini-2.5-pro`);
          SettingStore.instance.set('vertexModelName', 'gemini-2.5-pro');
        }

        if (
          store.vertexChatModelName === 'gemini-2.5-flash-preview-05-20' ||
          store.vertexChatModelName === 'gemini-1.5-flash'
        ) {
          logger.info(`[SettingStore] Migrated vertexChatModelName: ${store.vertexChatModelName} -> gemini-2.5-flash`);
          SettingStore.instance.set('vertexChatModelName', 'gemini-2.5-flash');
        } else if (store.vertexChatModelName === 'gemini-1.5-pro') {
          logger.info(`[SettingStore] Migrated vertexChatModelName: gemini-1.5-pro -> gemini-2.5-pro`);
          SettingStore.instance.set('vertexChatModelName', 'gemini-2.5-pro');
        }
        // Migrate TTS backend: 'browser' → 'gcp' so Indian language voices work
        if (store.voiceTtsBackend === 'browser' || !store.voiceTtsBackend) {
          logger.info('[SettingStore] Migrating voiceTtsBackend: browser -> gcp for Indian language support');
          SettingStore.instance.set('voiceTtsBackend', 'gcp');
        }
      } catch (err) {
        logger.error('[SettingStore] Failed to sanitize settings model names:', err);
      }

      SettingStore.instance.onDidAnyChange((newValue, oldValue) => {
        logger.log(
          `SettingStore: ${JSON.stringify(oldValue)} changed to ${JSON.stringify(newValue)}`,
        );
        // Notify that value updated
        BrowserWindow.getAllWindows().forEach((win) => {
          win.webContents.send('setting-updated', newValue);
        });
      });
    }
    return SettingStore.instance;
  }

  public static set<K extends keyof LocalStore>(
    key: K,
    value: LocalStore[K],
  ): void {
    SettingStore.getInstance().set(key, value);
  }

  public static setStore(state: LocalStore): void {
    SettingStore.getInstance().set(state);
  }

  public static get<K extends keyof LocalStore>(key: K): LocalStore[K] {
    return SettingStore.getInstance().get(key);
  }

  public static remove<K extends keyof LocalStore>(key: K): void {
    SettingStore.getInstance().delete(key);
  }

  public static getStore(): LocalStore {
    return SettingStore.getInstance().store;
  }

  public static clear(): void {
    SettingStore.getInstance().set(DEFAULT_SETTING);
  }

  public static openInEditor(): void {
    SettingStore.getInstance().openInEditor();
  }

  public static async importPresetFromUrl(
    url: string,
    autoUpdate = false,
  ): Promise<void> {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch preset: ${response.status}`);
      }

      const yamlText = await response.text();
      const preset = yaml.load(yamlText);
      const validatedPreset = validatePreset(preset);

      SettingStore.setStore({
        ...validatedPreset,
        presetSource: {
          type: 'remote',
          url,
          autoUpdate,
          lastUpdated: Date.now(),
        },
      });
    } catch (error) {
      logger.error(error);
      throw new Error(
        `Failed to import preset: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  public static async importPresetFromText(
    yamlContent: string,
  ): Promise<LocalStore> {
    try {
      const settings = await parsePresetYaml(yamlContent);
      return settings;
    } catch (error) {
      logger.error('Failed to import preset from text:', error);
      throw error;
    }
  }

  public static async fetchPresetFromUrl(url: string): Promise<LocalStore> {
    try {
      const response = await fetch(url);
      const yamlContent = await response.text();
      return await this.importPresetFromText(yamlContent);
    } catch (error) {
      logger.error('Failed to fetch preset from URL:', error);
      throw error;
    }
  }
}

async function parsePresetYaml(yamlContent: string): Promise<LocalStore> {
  const preset = yaml.load(yamlContent);
  const validatedPreset = validatePreset(preset);
  return validatedPreset;
}
