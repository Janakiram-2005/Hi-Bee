import { describe, it, expect, beforeEach } from 'vitest';
import { UIGestureGatekeeper } from './gestureGatekeeper';

describe('UIGestureGatekeeper State Transitions & Gating', () => {
  let gatekeeper: UIGestureGatekeeper;

  beforeEach(() => {
    gatekeeper = new UIGestureGatekeeper({
      targetMin: 0.4,
      targetMax: 0.6,
      engagementHoldMs: 800,
      gestureHoldMs: 1000,
      inactivityTimeoutMs: 3000,
      cooldownMs: 1200,
    });
  });

  it('initializes in DISENGAGED state and is gated', () => {
    expect(gatekeeper.state).toBe('DISENGAGED');
    expect(gatekeeper.isGated()).toBe(true);
  });

  it('rejects candidate gestures when DISENGAGED (Zero spurious triggers)', () => {
    const gesture = { id: 'g1', name: 'Volume Up', action: 'volume_up' };
    const t0 = 1000;

    for (let i = 0; i < 10; i++) {
      const res = gatekeeper.processFrame(0.2, gesture, false, t0 + i * 100);
      expect(res.state).toBe('DISENGAGED');
      expect(res.gated).toBe(true);
      expect(res.triggeredGesture).toBeNull();
      expect(res.holdProgress).toBe(0);
    }
  });

  it('validates gaze bounds threshold correctly', () => {
    expect(gatekeeper.validateGazeBounds(0.35)).toBe(false);
    expect(gatekeeper.validateGazeBounds(0.65)).toBe(false);
    expect(gatekeeper.validateGazeBounds(null)).toBe(false);
    expect(gatekeeper.validateGazeBounds(0.5)).toBe(true);
  });

  it('transitions DISENGAGED -> ENGAGING upon valid gaze', () => {
    const res = gatekeeper.processFrame(0.5, null, false, 1000);
    expect(res.state).toBe('ENGAGING');
    expect(res.gated).toBe(true);
    expect(res.engagementProgress).toBe(0);
  });

  it('recovers to DISENGAGED if engagement is interrupted before threshold', () => {
    gatekeeper.processFrame(0.5, null, false, 1000);
    const mid = gatekeeper.processFrame(0.5, null, false, 1400); // 400ms / 800ms
    expect(mid.state).toBe('ENGAGING');
    expect(mid.engagementProgress).toBe(0.5);

    // Gaze lost
    const abort = gatekeeper.processFrame(0.2, null, false, 1500);
    expect(abort.state).toBe('DISENGAGED');
    expect(abort.gated).toBe(true);
    expect(abort.engagementProgress).toBe(0);
  });

  it('transitions ENGAGING -> ENGAGED when hold threshold is reached', () => {
    gatekeeper.processFrame(0.5, null, false, 1000);
    const res = gatekeeper.processFrame(0.5, null, false, 1800); // 800ms threshold reached
    expect(res.state).toBe('ENGAGED');
    expect(res.gated).toBe(false);
    expect(res.engagementProgress).toBe(1.0);
    expect(res.shouldWake).toBe(true);
  });

  it('provides immediate hold_progress feedback for deliberate gestures in ENGAGED state', () => {
    gatekeeper.setEngaged(true, 1000);
    const gesture = { id: 'g1', name: 'Open Palm', action: 'play_pause' };

    gatekeeper.processFrame(0.5, gesture, false, 1000);
    const res = gatekeeper.processFrame(0.5, gesture, false, 1500); // 500ms / 1000ms

    expect(res.state).toBe('ENGAGED');
    expect(res.holdProgress).toBe(0.5);
    expect(res.triggeredGesture).toBeNull();
  });

  it('handles gesture interruption gracefully and allows immediate retry (Fallback Scenario)', () => {
    gatekeeper.setEngaged(true, 1000);
    const gesture = { id: 'g1', name: 'L Shape', action: 'volume_up' };

    gatekeeper.processFrame(0.5, gesture, false, 1000);
    gatekeeper.processFrame(0.5, gesture, false, 1600); // 600ms hold

    // Interrupted
    const interrupted = gatekeeper.processFrame(0.5, null, false, 1700);
    expect(interrupted.state).toBe('ENGAGED');
    expect(interrupted.holdProgress).toBe(0);
    expect(interrupted.triggeredGesture).toBeNull();

    // Immediate retry
    const retry = gatekeeper.processFrame(0.5, gesture, false, 1800);
    expect(retry.state).toBe('ENGAGED');
    expect(retry.activeGesture?.name).toBe('L Shape');
  });

  it('triggers action when hold threshold is reached and enters COOLDOWN', () => {
    gatekeeper.setEngaged(true, 1000);
    const gesture = { id: 'g1', name: 'L Shape', action: 'volume_up' };

    gatekeeper.processFrame(0.5, gesture, false, 1000);
    const triggered = gatekeeper.processFrame(0.5, gesture, false, 2000); // 1000ms reached

    expect(triggered.triggeredGesture?.action).toBe('volume_up');
    expect(triggered.state).toBe('COOLDOWN');
  });

  it('rejects duplicate triggers during cooldown', () => {
    gatekeeper.setEngaged(true, 1000);
    const gesture = { id: 'g1', name: 'L Shape', action: 'volume_up' };

    gatekeeper.processFrame(0.5, gesture, false, 1000);
    gatekeeper.processFrame(0.5, gesture, false, 2000);

    const duringCooldown = gatekeeper.processFrame(0.5, gesture, false, 2500);
    expect(duringCooldown.state).toBe('COOLDOWN');
    expect(duringCooldown.triggeredGesture).toBeNull();
  });

  it('expires cooldown and allows subsequent triggers', () => {
    gatekeeper.setEngaged(true, 1000);
    const gesture = { id: 'g1', name: 'L Shape', action: 'volume_up' };

    gatekeeper.processFrame(0.5, gesture, false, 1000);
    gatekeeper.processFrame(0.5, gesture, false, 2000); // Cooldown until 3200ms

    // After cooldown (at 3300ms)
    const afterCooldown = gatekeeper.processFrame(0.5, null, false, 3300);
    expect(afterCooldown.state).toBe('ENGAGED');

    // New gesture trigger succeeds
    gatekeeper.processFrame(0.5, gesture, false, 3400);
    const secondTrigger = gatekeeper.processFrame(0.5, gesture, false, 4400);
    expect(secondTrigger.triggeredGesture?.action).toBe('volume_up');
  });

  it('reverts to DISENGAGED after inactivity timeout', () => {
    gatekeeper.setEngaged(true, 1000);
    expect(gatekeeper.state).toBe('ENGAGED');

    // Inactivity timeout = 3000ms -> at 4100ms
    const timedOut = gatekeeper.processFrame(0.2, null, false, 4100);
    expect(timedOut.state).toBe('DISENGAGED');
    expect(timedOut.gated).toBe(true);
  });
});
