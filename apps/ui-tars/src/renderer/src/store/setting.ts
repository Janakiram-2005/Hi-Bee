import { create } from 'zustand';
import { LocalStore } from '@main/store/validate';

interface SettingStoreState {
  settings: Partial<LocalStore>;
  setSettings: (settings: Partial<LocalStore>) => void;
  updateSetting: (updates: Partial<LocalStore>) => Promise<void>;
}

export const useSettingStore = create<SettingStoreState>((set) => ({
  settings: {},
  setSettings: (settings) => set({ settings }),
  updateSetting: async (updates) => {
    if (window.electron?.setting) {
      await window.electron.setting.updateSetting(updates);
      set((state) => ({ settings: { ...state.settings, ...updates } }));
    }
  },
}));
