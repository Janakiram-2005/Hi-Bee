import { useEffect } from 'react';
import { VoiceAvatarWidget } from '@renderer/components/VoiceAvatar';

export default function VoiceAvatarPage() {
  useEffect(() => {
    // Force body and document to have a transparent background so the frameless window works
    document.body.style.background = 'transparent';
    document.documentElement.style.background = 'transparent';
    // Remove scrollbars
    document.body.style.overflow = 'hidden';
  }, []);

  const handleMouseEnter = () => {
    window.electron.ipcRenderer.invoke('voice-window:set-ignore-mouse-events', false).catch(() => {});
  };

  const handleMouseLeave = () => {
    window.electron.ipcRenderer.invoke('voice-window:set-ignore-mouse-events', true).catch(() => {});
  };

  return (
    <div
      className="w-screen h-screen overflow-hidden bg-transparent select-none relative"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <VoiceAvatarWidget />
    </div>
  );
}
