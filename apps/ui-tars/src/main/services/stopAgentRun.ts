/**
 * Shared stop logic for agent runs — used by IPC and voice commands.
 *
 * Architecture note: runAgent creates a closure-local callUserTimer.
 * To allow stopActiveAgentRun() to cancel it from outside the closure,
 * we keep a module-level reference that runAgent registers/clears.
 */
import { StatusEnum } from '@ui-tars/shared/types';
import { GUIAgent } from '@ui-tars/sdk';
import { store } from '@main/store/create';
import { SettingStore } from '@main/store/setting';
import { GUIAgentManager } from '@main/ipcRoutes/agent';
import { showWindow } from '@main/window/index';
import { wasBackgroundRun } from '@main/utils/agent';
import { closeScreenMarker } from '@main/window/ScreenMarker';

const STOP_TRANSCRIPT_RE =
  /^\s*(stop|cancel|abort|halt)(\s+(that|it|the\s+run|work|task|process|now))?\s*[.!?]*\s*$/i;

export function isStopVoiceCommand(transcript: string): boolean {
  return STOP_TRANSCRIPT_RE.test(transcript.trim());
}

// ── Module-level call_user timer registry ─────────────────────────────────────
// runAgent registers its timer here so stopActiveAgentRun can cancel it even
// though the timer lives inside the runAgent closure.
let _pendingCallUserTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Called by runAgent to register the active call_user standby timer.
 * Pass null to clear the registration.
 */
export function registerCallUserTimer(
  timer: ReturnType<typeof setTimeout> | null,
): void {
  if (_pendingCallUserTimer && timer !== null) {
    // Clear previous timer before replacing (safety guard)
    clearTimeout(_pendingCallUserTimer);
  }
  _pendingCallUserTimer = timer;
}

/**
 * Cancel any pending call_user auto-resume timer.
 * Called both from runAgent cleanup and from stopActiveAgentRun.
 */
export function cancelCallUserTimer(): void {
  if (_pendingCallUserTimer) {
    clearTimeout(_pendingCallUserTimer);
    _pendingCallUserTimer = null;
    logger.info('[stopAgentRun] Cancelled pending call_user auto-resume timer');
  }
}

// Lazy import logger to avoid circular deps
import { logger } from '@main/logger';

export function stopActiveAgentRun(): void {
  // 1. Cancel call_user standby timer immediately — must happen before any
  //    other cleanup so the timer cannot fire and try to resume a dead agent.
  cancelCallUserTimer();

  const { abortController } = store.getState();

  // 2. Reset all UI state atomically, including live-action banner fields
  store.setState({
    status: StatusEnum.END,
    thinking: false,
    currentAction: null,
    currentStep: 0,
  });

  if (!wasBackgroundRun()) {
    // Don't show main window when voice assistant is active
    const voiceEnabled = SettingStore.getStore()?.voiceEnabled ?? false;
    if (!voiceEnabled) {
      showWindow();
    }
  }

  // 3. Signal the abort controller so any in-flight awaits break out
  abortController?.abort();

  // 4. Stop the GUIAgent loop itself
  const guiAgent = GUIAgentManager.getInstance().getAgent();
  if (guiAgent instanceof GUIAgent) {
    guiAgent.resume(); // unblock any paused/call_user wait first
    guiAgent.stop();
  }

  closeScreenMarker();
}
