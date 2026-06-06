import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Button } from '@renderer/components/ui/button';
import { LocalStore } from '@main/store/validate';
import { VLMProviderV2 } from '@main/store/types';

import { VLMSettings, VLMSettingsRef } from './category/vlm';
import { useRef } from 'react';

interface LocalSettingsDialogProps {
  isOpen: boolean;
  onSubmit: () => void;
  onClose: () => void;
}

export const checkVLMSettings = async () => {
  const settingRpc = window.electron.setting;

  const currentSetting = ((await settingRpc.getSetting()) ||
    {}) as Partial<LocalStore>;
  const {
    vlmApiKey,
    vlmBaseUrl,
    vlmModelName,
    vlmProvider,
    vertexProjectId,
    vertexLocation,
    vertexModelName,
  } = currentSetting;

  if (!vlmProvider) {
    return false;
  }

  if (vlmProvider === VLMProviderV2.gemini_vertex) {
    if (vertexProjectId && vertexLocation && vertexModelName) {
      return true;
    }
    return false;
  }

  if (vlmApiKey && vlmBaseUrl && vlmModelName) {
    return true;
  }

  return false;
};

export const LocalSettingsDialog = ({
  isOpen,
  onSubmit,
  onClose,
}: LocalSettingsDialogProps) => {
  const vlmSettingsRef = useRef<VLMSettingsRef>(null);

  const handleGetStart = async () => {
    try {
      await vlmSettingsRef.current?.submit();
      onSubmit();
    } catch (error) {
      console.error('Failed to submit settings:', error);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[480px]">
        <DialogHeader>
          <DialogTitle>VLM Settings</DialogTitle>
          <DialogDescription>
            Enter VLM settings to enable the model to control the local computer
            or browser.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto pr-2">
          <VLMSettings ref={vlmSettingsRef} />
        </div>
        <Button className="mt-4 mx-8" onClick={handleGetStart}>
          Get Start
        </Button>
      </DialogContent>
    </Dialog>
  );
};
