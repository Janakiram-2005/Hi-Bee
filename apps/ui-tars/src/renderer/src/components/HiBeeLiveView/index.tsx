/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 *
 * HiBeeLiveView — Smart Live Status View.
 * Replaces the old UI-TARS right-panel screenshot viewer.
 *
 * Shows contextual agent execution states:
 *   Scanning → Clicking → Navigating → Searching → Typing →
 *   Just a moment → Please wait → Done ✓ → Error occurred
 *
 * Design: Premium glassmorphism with animated state transitions,
 * Hi-Bee robot inline, pulsing activity rings, and a mini step tracker.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Square } from 'lucide-react';
import { mapActionToStatus } from '@renderer/store/voiceStore';
import { api } from '@renderer/api';
import { StatusEnum } from '@ui-tars/shared/types';
import './HiBeeLiveView.css';

interface HiBeeLiveViewProps {
  action: string | null;
  step: number;
  maxSteps?: number;
  startTime?: number;
  status?: string;
  errorMsg?: string | null;
  lastScreenshot?: string | null;
  /** Called after abort is confirmed */
  onAbort?: () => void;
}

/** Format elapsed time as "Xm Ys" or "Xs" */
function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

/** Animated waveform bars (5 bars) — shows agent is actively processing */
function WaveformBars({ color }: { color: string }) {
  return (
    <span className="hblv-waveform" aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className="hblv-bar"
          style={{
            background: color,
            animationDelay: `${i * 0.12}s`,
          }}
        />
      ))}
    </span>
  );
}

/** Mini robot head SVG — the Hi-Bee face shown inline */
function MiniBeeIcon({ color }: { color: string }) {
  return (
    <svg width="22" height="22" viewBox="0 0 64 64" className="hblv-robot-icon" aria-hidden>
      {/* Antenna */}
      <line x1="32" y1="2" x2="32" y2="10" stroke={color} strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="32" cy="2" r="3" fill={color} />
      {/* Head */}
      <rect x="10" y="10" width="44" height="34" rx="8" fill="#0d1117" stroke={color} strokeWidth="2" />
      {/* Eyes */}
      <rect x="16" y="19" width="11" height="9" rx="3" fill={color} />
      <rect x="37" y="19" width="11" height="9" rx="3" fill={color} />
      {/* Mouth */}
      <rect x="18" y="33" width="28" height="3" rx="1.5" fill={color} opacity="0.7" />
    </svg>
  );
}

/** Mini step progress dots */
function StepDots({ step, maxSteps }: { step: number; maxSteps: number }) {
  const dots = Math.min(maxSteps, 20); // show at most 20 dots
  return (
    <div className="hblv-dots">
      {Array.from({ length: dots }, (_, i) => (
        <span
          key={i}
          className={`hblv-dot ${i < step ? 'done' : i === step ? 'active' : 'pending'}`}
        />
      ))}
      {maxSteps > 20 && <span className="hblv-dot-more">+{maxSteps - 20}</span>}
    </div>
  );
}

export const HiBeeLiveView: React.FC<HiBeeLiveViewProps> = ({
  action,
  step,
  maxSteps = 100,
  startTime,
  status,
  errorMsg,
  lastScreenshot,
  onAbort,
}) => {
  const [elapsed, setElapsed] = useState(0);
  const [aborting, setAborting] = useState(false);
  const prevActionRef = useRef<string | null>(null);
  const [slideKey, setSlideKey] = useState(0);

  // Update elapsed every second
  useEffect(() => {
    if (!startTime) return;
    const id = setInterval(() => setElapsed(Date.now() - startTime), 1000);
    return () => clearInterval(id);
  }, [startTime]);

  // Trigger slide-in animation on action change
  useEffect(() => {
    if (action !== prevActionRef.current) {
      prevActionRef.current = action;
      setSlideKey((k) => k + 1);
    }
  }, [action]);

  const isFinished = status === StatusEnum.END || action?.startsWith('finished');
  const isError = !!errorMsg;
  const isCallUser = status === StatusEnum.CALL_USER;

  const statusInfo = mapActionToStatus(
    isCallUser ? 'call_user' : action,
    errorMsg,
  );

  const handleAbort = async () => {
    if (aborting) return;
    setAborting(true);
    try {
      await api.stopRun();
      onAbort?.();
    } finally {
      setAborting(false);
    }
  };

  return (
    <div
      className={`hblv-root hblv-anim-${statusInfo.animation}`}
      style={{ '--hblv-color': statusInfo.color, '--hblv-bg': statusInfo.bgColor } as React.CSSProperties}
      aria-live="polite"
    >
      {/* Top row: robot icon + status + controls */}
      <div className="hblv-top-row">
        {/* Pulse ring around icon */}
        <div className="hblv-icon-ring">
          <MiniBeeIcon color={statusInfo.color} />
          {!isFinished && !isError && (
            <span className="hblv-ring-pulse" style={{ borderColor: statusInfo.color }} />
          )}
        </div>

        {/* Status label area */}
        <div className="hblv-status-area" key={slideKey}>
          <span className="hblv-status-icon">{statusInfo.icon}</span>
          <span className="hblv-status-label" style={{ color: statusInfo.color }}>
            {statusInfo.label}
          </span>
          {!isFinished && !isError && (
            <WaveformBars color={statusInfo.color} />
          )}
        </div>

        {/* Step counter + elapsed */}
        <div className="hblv-meta">
          <span className="hblv-step-badge">
            Step {step}
            {maxSteps > 0 && ` / ${maxSteps}`}
          </span>
          {startTime !== undefined && (
            <span className="hblv-elapsed">{formatElapsed(elapsed)}</span>
          )}
        </div>

        {/* Abort button */}
        {!isFinished && (
          <button
            className={`hblv-abort-btn ${aborting ? 'aborting' : ''}`}
            onClick={handleAbort}
            disabled={aborting}
            title="Stop agent"
            aria-label="Stop agent"
          >
            <Square size={11} />
            {aborting ? 'Stopping…' : 'Stop'}
          </button>
        )}
      </div>

      {/* Action args line */}
      {action && !isFinished && !isError && (
        <div className="hblv-args-row">
          <span className="hblv-args-label">Action:</span>
          <span className="hblv-args-value" title={action}>
            {action.length > 80 ? action.slice(0, 77) + '…' : action}
          </span>
        </div>
      )}

      {/* Error message */}
      {isError && (
        <div className="hblv-error-row">
          <span>⚠️ {errorMsg}</span>
          <button
            className="hblv-retry-btn"
            onClick={() => api.runAgent()}
          >
            Retry
          </button>
        </div>
      )}

      {/* call_user message */}
      {isCallUser && !isError && (
        <div className="hblv-calluser-row">
          🙏 Hi-Bee needs your input — please respond in the chat below.
        </div>
      )}

      {/* Step progress dots */}
      {!isError && step > 0 && (
        <StepDots step={step} maxSteps={Math.min(maxSteps, 20)} />
      )}

      {/* Mini screenshot thumbnail (if available) */}
      {lastScreenshot && (
        <div className="hblv-screenshot-thumb">
          <img
            src={`data:image/jpeg;base64,${lastScreenshot}`}
            alt="Last captured screen"
            className="hblv-thumb-img"
          />
          <span className="hblv-thumb-label">Latest snapshot</span>
        </div>
      )}
    </div>
  );
};

export default HiBeeLiveView;
