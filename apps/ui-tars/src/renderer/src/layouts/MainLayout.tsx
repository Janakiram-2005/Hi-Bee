import { Outlet, useNavigate } from 'react-router';
import { AppSidebar } from '@/renderer/src/components/SideBar/app-sidebar';
import { SidebarInset, SidebarProvider } from '@renderer/components/ui/sidebar';
import { useEffect } from 'react';
import { useGlobalSettings } from '../components/Settings/global';

export function MainLayout() {
  const navigate = useNavigate();
  const openSettings = useGlobalSettings((state) => state.openSettings);

  useEffect(() => {
    const handler = () => {
      navigate('/test-navigation');
      sessionStorage.setItem('auto-start-test', 'true');
    };
    const unsubscribe = window.electron?.ipcRenderer?.on('test-navigation:start', handler);
    return () => {
      unsubscribe?.();
    };
  }, [navigate]);

  useEffect(() => {
    /**
     * Request microphone permission once from the MAIN (visible) window.
     * The main window has user-activation context, so getUserMedia succeeds here.
     * We persist `micPermissionGranted: true` in settings so the transparent
     * voice window can skip the check entirely on all subsequent launches.
     */
    const requestMicOnce = async () => {
      try {
        const settings = await window.electron?.setting?.getSetting();

        // Already granted previously — nothing to do
        if (settings?.micPermissionGranted === true) return;

        // Request mic access from the visible main window
        try {
          const stream = await navigator.mediaDevices?.getUserMedia({ audio: true, video: false });
          if (stream) {
            stream.getTracks().forEach((t) => t.stop());
          }
        } catch (mediaErr) {
          console.warn('[MainLayout] getUserMedia failed (will retry from voice window):', mediaErr);
          // Do not return — still save the flag so the voice window attempts its own retry
        }

        // Persist so the voice window skips its own permission gate
        await window.electron?.setting?.updateSetting({ micPermissionGranted: true }).catch(
          (e) => console.warn('[MainLayout] Failed to save micPermissionGranted:', e)
        );

        console.info('[MainLayout] micPermissionGranted saved');
      } catch (err) {
        console.warn('[MainLayout] requestMicOnce failed:', err);
      }
    };

    // Small delay so Electron session permission handlers are fully registered
    const t = setTimeout(requestMicOnce, 500);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const handler = () => openSettings();
    const unsubscribe = window.electron?.ipcRenderer?.on('voice:open-settings-ui', handler);
    return () => { unsubscribe?.(); };
  }, [openSettings]);

  useEffect(() => {
    const handler = () => navigate('/gestures');
    const unsubscribe = window.electron?.ipcRenderer?.on('voice:open-gestures-ui' as any, handler);
    return () => { unsubscribe?.(); };
  }, [navigate]);

  return (
    <SidebarProvider
      style={{ '--sidebar-width-icon': '72px' }}
      className="flex h-screen w-full bg-white"
    >
      <AppSidebar />
      <SidebarInset className="flex-1">
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  );
}
