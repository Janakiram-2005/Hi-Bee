/**
 * Explicit engagement gating and threshold validation for client-side gesture tracking.
 *
 * Enforces engagement states:
 * - DISENGAGED (Gated / Standby): Casual body/hand movements produce 0 triggers.
 * - ENGAGING: User is meeting engagement criteria (e.g. attentive gaze in bounds).
 * - ENGAGED: Gate is open; deliberate hold gestures are tracked and validated.
 * - COOLDOWN: Refractory window after trigger to prevent duplicate firing.
 */

export type EngagementState =
  | 'DISENGAGED'
  | 'ENGAGING'
  | 'ENGAGED'
  | 'COOLDOWN';

export interface GatekeeperConfig {
  targetMin?: number; // default 0.40
  targetMax?: number; // default 0.60
  engagementHoldMs?: number; // default 800
  gestureHoldMs?: number; // default 1000
  inactivityTimeoutMs?: number; // default 3000
  cooldownMs?: number; // default 1200
}

export interface GateResult<T = any> {
  state: EngagementState;
  gated: boolean;
  engagementProgress: number;
  holdProgress: number;
  activeGesture: T | null;
  triggeredGesture: T | null;
  shouldWake: boolean;
}

export class UIGestureGatekeeper<
  T extends { action?: string; name?: string; id?: string } = any,
> {
  private targetMin: number;
  private targetMax: number;
  private engagementHoldMs: number;
  private gestureHoldMs: number;
  private inactivityTimeoutMs: number;
  private cooldownMs: number;

  public state: EngagementState = 'DISENGAGED';
  private engagementStartTime: number | null = null;
  private lastActivityTime: number = 0;
  private cooldownUntil: number = 0;

  private activeCandidate: T | null = null;
  private candidateHoldStart: number | null = null;

  constructor(config: GatekeeperConfig = {}) {
    this.targetMin = config.targetMin ?? 0.4;
    this.targetMax = config.targetMax ?? 0.6;
    this.engagementHoldMs = config.engagementHoldMs ?? 800;
    this.gestureHoldMs = config.gestureHoldMs ?? 1000;
    this.inactivityTimeoutMs = config.inactivityTimeoutMs ?? 3000;
    this.cooldownMs = config.cooldownMs ?? 1200;
  }

  public isGated(): boolean {
    return this.state !== 'ENGAGED' && this.state !== 'COOLDOWN';
  }

  public validateGazeBounds(
    relativePosition: number | null | undefined,
  ): boolean {
    if (relativePosition == null || isNaN(relativePosition)) return false;
    return (
      relativePosition >= this.targetMin && relativePosition <= this.targetMax
    );
  }

  public setEngaged(
    engaged: boolean,
    now: number = Date.now(),
    reason: string = 'manual',
  ): void {
    if (engaged) {
      this.state = 'ENGAGED';
      this.lastActivityTime = now;
      this.engagementStartTime = null;
      console.log(
        `[GestureGatekeeper] State transition -> ENGAGED (${reason})`,
      );
    } else {
      this.state = 'DISENGAGED';
      this.engagementStartTime = null;
      this.activeCandidate = null;
      this.candidateHoldStart = null;
      console.log(
        `[GestureGatekeeper] State transition -> DISENGAGED (${reason})`,
      );
    }
  }

  public processFrame(
    gazePosition: number | null | undefined,
    matchedGesture: T | null = null,
    wakeCondition: boolean = false,
    now: number = Date.now(),
  ): GateResult<T> {
    const isGazeValid = this.validateGazeBounds(gazePosition);
    let engagementProgress = 0;
    let holdProgress = 0;
    let triggeredGesture: T | null = null;
    let shouldWake = false;

    // Check cooldown expiry
    if (this.state === 'COOLDOWN' && now >= this.cooldownUntil) {
      this.state = 'ENGAGED';
      console.log(
        '[GestureGatekeeper] State transition: COOLDOWN -> ENGAGED (cooldown_expired)',
      );
    }

    // -------------------------------------------------------------
    // STATE: DISENGAGED
    // -------------------------------------------------------------
    if (this.state === 'DISENGAGED') {
      // In disengaged state, casual gestures are blocked.
      // Engagement criteria: valid gaze or deliberate wake condition
      if (isGazeValid || wakeCondition) {
        this.engagementStartTime = now;
        this.state = 'ENGAGING';
        engagementProgress = 0;
        console.log(
          '[GestureGatekeeper] State transition: DISENGAGED -> ENGAGING (engagement_initiated)',
        );
      } else {
        this.engagementStartTime = null;
      }
    }

    // -------------------------------------------------------------
    // STATE: ENGAGING
    // -------------------------------------------------------------
    else if (this.state === 'ENGAGING') {
      if ((isGazeValid || wakeCondition) && this.engagementStartTime !== null) {
        const elapsed = now - this.engagementStartTime;
        engagementProgress = Math.min(1.0, elapsed / this.engagementHoldMs);

        if (elapsed >= this.engagementHoldMs) {
          this.state = 'ENGAGED';
          this.lastActivityTime = now;
          this.engagementStartTime = null;
          engagementProgress = 1.0;
          shouldWake = true; // Signal engagement wake
          console.log(
            '[GestureGatekeeper] State transition: ENGAGING -> ENGAGED (engagement_achieved)',
          );
        }
      } else {
        // Fallback recovery: interrupted engagement reset
        this.engagementStartTime = null;
        this.state = 'DISENGAGED';
        engagementProgress = 0;
        console.log(
          '[GestureGatekeeper] State transition: ENGAGING -> DISENGAGED (engagement_interrupted)',
        );
      }
    }

    // -------------------------------------------------------------
    // STATE: ENGAGED or COOLDOWN
    // -------------------------------------------------------------
    if (this.state === 'ENGAGED' || this.state === 'COOLDOWN') {
      engagementProgress = 1.0;

      // Activity reset
      const hasActivity =
        isGazeValid || matchedGesture !== null || wakeCondition;
      if (hasActivity) {
        this.lastActivityTime = now;
      }

      // Inactivity timeout
      if (now - this.lastActivityTime >= this.inactivityTimeoutMs) {
        this.state = 'DISENGAGED';
        this.activeCandidate = null;
        this.candidateHoldStart = null;
        console.log(
          `[GestureGatekeeper] State transition: -> DISENGAGED (inactivity_timeout_${this.inactivityTimeoutMs}ms)`,
        );
        return {
          state: this.state,
          gated: true,
          engagementProgress: 0,
          holdProgress: 0,
          activeGesture: null,
          triggeredGesture: null,
          shouldWake: false,
        };
      }

      if (this.state === 'COOLDOWN') {
        this.activeCandidate = null;
        this.candidateHoldStart = null;
        holdProgress = 0;
      } else {
        // Evaluate candidate gesture hold
        if (matchedGesture) {
          const candKey =
            matchedGesture.id || matchedGesture.action || matchedGesture.name;
          const activeKey = this.activeCandidate
            ? this.activeCandidate.id ||
              this.activeCandidate.action ||
              this.activeCandidate.name
            : null;

          if (activeKey && activeKey === candKey) {
            const elapsedHold = now - (this.candidateHoldStart ?? now);
            holdProgress = Math.min(1.0, elapsedHold / this.gestureHoldMs);

            if (elapsedHold >= this.gestureHoldMs) {
              // Gesture hold threshold achieved! Trigger action
              triggeredGesture = matchedGesture;
              this.cooldownUntil = now + this.cooldownMs;
              this.state = 'COOLDOWN';
              this.activeCandidate = null;
              this.candidateHoldStart = null;
              holdProgress = 0;
              console.log(
                `[GestureGatekeeper] Deliberate gesture triggered: ${matchedGesture.name || candKey} -> COOLDOWN`,
              );
            }
          } else {
            // New candidate gesture started
            this.activeCandidate = matchedGesture;
            this.candidateHoldStart = now;
            holdProgress = 0;
          }
        } else {
          // Gesture interrupted / dropped -> reset candidate hold without state drop
          this.activeCandidate = null;
          this.candidateHoldStart = null;
          holdProgress = 0;
        }
      }
    }

    return {
      state: this.state,
      gated: this.isGated(),
      engagementProgress: Math.round(engagementProgress * 1000) / 1000,
      holdProgress: Math.round(holdProgress * 1000) / 1000,
      activeGesture: this.activeCandidate,
      triggeredGesture,
      shouldWake,
    };
  }
}
