/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 *
 * LiveActionBanner — shows the action currently being executed by the agent.
 * Displayed during RUNNING state in the local operator page.
 */
import React, { useEffect, useState } from 'react';

interface LiveActionBannerProps {
  action: string | null;
  step: number;
  maxSteps?: number;
  startTime?: number;
}

/**
 * Format elapsed seconds as "Xm Ys" or "Xs".
 */
function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

/**
 * Map an action_type string to a friendly label + icon character.
 */
function actionLabel(raw: string): { icon: string; label: string } {
  const type = raw.split('(')[0].trim().toLowerCase();
  switch (type) {
    case 'click':         return { icon: '🖱', label: 'Click' };
    case 'left_double':   return { icon: '🖱', label: 'Double-click' };
    case 'right_single':  return { icon: '🖱', label: 'Right-click' };
    case 'type':          return { icon: '⌨', label: 'Type' };
    case 'hotkey':        return { icon: '⌨', label: 'Hotkey' };
    case 'scroll':        return { icon: '↕', label: 'Scroll' };
    case 'drag':          return { icon: '↔', label: 'Drag' };
    case 'wait':          return { icon: '⏳', label: 'Wait' };
    case 'finished':      return { icon: '✅', label: 'Finished' };
    case 'call_user':     return { icon: '❓', label: 'Needs input' };
    default:              return { icon: '⚙', label: raw.split('(')[0] };
  }
}

export const LiveActionBanner: React.FC<LiveActionBannerProps> = ({
  action,
  step,
  maxSteps = 100,
  startTime,
}) => {
  const [elapsed, setElapsed] = useState(0);

  // Update elapsed time every second
  useEffect(() => {
    if (!startTime) return;
    const id = setInterval(() => {
      setElapsed(Date.now() - startTime);
    }, 1000);
    return () => clearInterval(id);
  }, [startTime]);

  if (!action) return null;

  const { icon, label } = actionLabel(action);
  // Show args without the outer function wrapper for brevity
  const args = action.includes('(')
    ? action.slice(action.indexOf('(') + 1, action.lastIndexOf(')'))
    : '';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '8px 14px',
        borderRadius: '8px',
        background: 'linear-gradient(90deg, #1e293b 0%, #0f172a 100%)',
        border: '1px solid rgba(99,102,241,0.35)',
        boxShadow: '0 2px 12px rgba(99,102,241,0.12)',
        marginBottom: '8px',
        animation: 'live-fade-in 0.25s ease-out',
        overflow: 'hidden',
      }}
    >
      {/* Pulsing indicator */}
      <span
        style={{
          display: 'inline-block',
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: '#6366f1',
          flexShrink: 0,
          animation: 'live-pulse 1.4s ease-in-out infinite',
        }}
      />

      {/* Icon + Action label */}
      <span
        style={{
          fontSize: '13px',
          fontWeight: 600,
          color: '#a5b4fc',
          flexShrink: 0,
          letterSpacing: '0.01em',
        }}
      >
        {icon} {label}
      </span>

      {/* Args (truncated) */}
      {args && (
        <span
          title={args}
          style={{
            fontSize: '12px',
            color: '#94a3b8',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
            fontFamily: 'monospace',
          }}
        >
          {args.length > 60 ? args.slice(0, 57) + '…' : args}
        </span>
      )}

      {/* Step counter */}
      <span
        style={{
          fontSize: '11px',
          color: '#64748b',
          flexShrink: 0,
          whiteSpace: 'nowrap',
        }}
      >
        Step {step} / {maxSteps}
      </span>

      {/* Elapsed time */}
      {startTime !== undefined && (
        <span
          style={{
            fontSize: '11px',
            color: '#64748b',
            flexShrink: 0,
            whiteSpace: 'nowrap',
          }}
        >
          {formatElapsed(elapsed)}
        </span>
      )}

      {/* CSS keyframes via a <style> tag — avoids any CSS-in-JS dependency */}
      <style>{`
        @keyframes live-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%        { opacity: 0.4; transform: scale(0.75); }
        }
        @keyframes live-fade-in {
          from { opacity: 0; transform: translateY(-4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
};

export default LiveActionBanner;
