import { UITarsModelVersion } from '@ui-tars/shared/constants';
import {
  Operator,
  SearchEngineForSettings,
  VLMProviderV2,
} from '../store/types';
import {
  getSystemPrompt,
  getSystemPromptDoubao_15_15B,
  getSystemPromptDoubao_15_20B,
  getSystemPromptV1_5,
} from '../agent/prompts';
import {
  closeScreenMarker,
  hideScreenWaterFlow,
  hideWidgetWindow,
  showScreenWaterFlow,
  // showWidgetWindow,
} from '../window/ScreenMarker';
import { hideMainWindow /*, showMainWindow */ } from '../window';
import { SearchEngine } from '@ui-tars/operator-browser';

export const getModelVersion = (
  provider: VLMProviderV2 | undefined,
): UITarsModelVersion => {
  switch (provider) {
    case VLMProviderV2.ui_tars_1_5:
      return UITarsModelVersion.V1_5;
    case VLMProviderV2.ui_tars_1_0:
      return UITarsModelVersion.V1_0;
    case VLMProviderV2.doubao_1_5:
      return UITarsModelVersion.DOUBAO_1_5_15B;
    case VLMProviderV2.doubao_1_5_vl:
      return UITarsModelVersion.DOUBAO_1_5_20B;
    case VLMProviderV2.gemini_vertex:
      // Gemini supports long context; use V1_5 for the largest system prompt
      // and 65535-token output budget.
      return UITarsModelVersion.V1_5;
    default:
      return UITarsModelVersion.V1_0;
  }
};

export const getSpByModelVersion = (
  modelVersion: UITarsModelVersion,
  language: 'zh' | 'en',
  operatorType: 'browser' | 'computer',
) => {
  switch (modelVersion) {
    case UITarsModelVersion.DOUBAO_1_5_20B:
      return getSystemPromptDoubao_15_20B(language, operatorType);
    case UITarsModelVersion.DOUBAO_1_5_15B:
      return getSystemPromptDoubao_15_15B(language);
    case UITarsModelVersion.V1_5:
      return getSystemPromptV1_5(language, 'normal');
    default:
      return getSystemPrompt(language);
  }
};

export const getLocalBrowserSearchEngine = (
  engine?: SearchEngineForSettings,
) => {
  return (engine || SearchEngineForSettings.GOOGLE) as unknown as SearchEngine;
};

export type AgentRunOptions = {
  /** Voice/background runs: keep main UI hidden and do not restore it after the run. */
  background?: boolean;
};

let lastRunWasBackground = false;

export const setRunBackground = (background: boolean) => {
  lastRunWasBackground = background;
};

export const wasBackgroundRun = () => lastRunWasBackground;

export const beforeAgentRun = async (
  operator: Operator,
  options: AgentRunOptions = {},
) => {
  const { background = false } = options;
  setRunBackground(background);

  switch (operator) {
    case Operator.RemoteComputer:
      break;
    case Operator.RemoteBrowser:
      break;
    case Operator.LocalComputer:
      // showWidgetWindow();
      showScreenWaterFlow();
      hideMainWindow();
      break;
    case Operator.LocalBrowser:
      hideMainWindow();
      // showWidgetWindow();
      break;
    default:
      break;
  }
};

export const afterAgentRun = (operator: Operator) => {
  // const restoreMainWindow = !wasBackgroundRun();

  switch (operator) {
    case Operator.RemoteComputer:
      break;
    case Operator.RemoteBrowser:
      break;
    case Operator.LocalComputer:
      hideWidgetWindow();
      closeScreenMarker();
      hideScreenWaterFlow();
      // if (restoreMainWindow) {
      //   showMainWindow();
      // }
      break;
    case Operator.LocalBrowser:
      hideWidgetWindow();
      // if (restoreMainWindow) {
      //   showMainWindow();
      // }
      break;
    default:
      break;
  }

  setRunBackground(false);
};
