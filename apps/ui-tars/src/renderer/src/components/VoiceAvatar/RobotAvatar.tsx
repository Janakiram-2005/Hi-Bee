/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 *
 * RobotAvatar — pure SVG animated 2D robot face.
 * All animation driven by CSS classes based on avatarState.
 */

interface RobotAvatarProps {
  state: string;
  size?: number;
}

export function RobotAvatar({ state, size = 52 }: RobotAvatarProps) {
  const isListening = state === 'listening';
  const isThinking = state === 'thinking';
  const isSpeaking = state === 'speaking';
  const isExecuting = state === 'executing';
  const isSearching = state === 'searching';
  const isScanning = state === 'scanning';
  const isClicking = state === 'clicking';
  const isTyping = state === 'typing';
  const isNavigating = state === 'navigating';
  const isSuccess = state === 'success';
  const isError = state === 'error';

  // Dynamic colors per state
  let eyeColor = '#7c3aed'; // default purple/indigo
  if (isThinking || isTyping) eyeColor = '#a855f7';
  else if (isSpeaking || isSuccess) eyeColor = '#34d399';
  else if (isSearching || isScanning || isNavigating || isExecuting) eyeColor = '#22d3ee';
  else if (isClicking) eyeColor = '#f472b6';
  else if (isError) eyeColor = '#ef4444';
  else if (isListening) eyeColor = '#818cf8';

  let antennaColor = '#6b7280';
  if (isListening) antennaColor = '#818cf8';
  else if (isThinking || isTyping) antennaColor = '#a855f7';
  else if (isSpeaking || isSuccess) antennaColor = '#34d399';
  else if (isSearching || isScanning || isNavigating || isExecuting) antennaColor = '#22d3ee';
  else if (isClicking) antennaColor = '#f472b6';
  else if (isError) antennaColor = '#ef4444';

  let bodyStroke = '#374151';
  if (isListening) bodyStroke = '#6366f1';
  else if (isThinking || isTyping) bodyStroke = '#c084fc';
  else if (isSpeaking || isSuccess) bodyStroke = '#10b981';
  else if (isSearching || isScanning || isNavigating || isExecuting) bodyStroke = '#06b6d4';
  else if (isClicking) bodyStroke = '#ec4899';
  else if (isError) bodyStroke = '#f87171';

  return (
    <svg
      className="robot-svg"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Antenna */}
      <line x1="32" y1="4" x2="32" y2="12" stroke={antennaColor} strokeWidth="2" strokeLinecap="round" />
      <circle cx="32" cy="3" r="2.5" fill={antennaColor} />

      {/* Head */}
      <rect x="10" y="12" width="44" height="32" rx="8" ry="8"
        fill="#1e1b4b" stroke={bodyStroke} strokeWidth="1.5" />

      {/* Left Eye */}
      <rect className="robot-eye" x="16" y="20" width="12" height="10" rx="3" fill={eyeColor}
        style={{ transformOrigin: '22px 25px' }} />

      {/* Right Eye */}
      <rect className="robot-eye" x="36" y="20" width="12" height="10" rx="3" fill={eyeColor}
        style={{ transformOrigin: '42px 25px' }} />

      {/* Nose indicator */}
      <circle cx="32" cy="30" r="2" fill={bodyStroke} opacity="0.6" />

      {/* Mouth — static unless speaking */}
      {state !== 'speaking' && (
        <rect x="18" y="36" width="28" height="3" rx="1.5"
          fill={state === 'listening' ? '#818cf8' : state === 'thinking' ? '#a855f7' : '#4b5563'} />
      )}

      {/* Mouth waveform bars — speaking state only */}
      {state === 'speaking' && (
        <g>
          <rect className="voice-bar" x="17" y="35" width="4" height="5" rx="2" />
          <rect className="voice-bar" x="23" y="33" width="4" height="9" rx="2" />
          <rect className="voice-bar" x="29" y="31" width="4" height="13" rx="2" />
          <rect className="voice-bar" x="35" y="33" width="4" height="9" rx="2" />
          <rect className="voice-bar" x="41" y="35" width="4" height="5" rx="2" />
        </g>
      )}

      {/* Ears */}
      <rect x="6" y="22" width="5" height="10" rx="2.5"
        fill="#1e1b4b" stroke={bodyStroke} strokeWidth="1.5" />
      <rect x="53" y="22" width="5" height="10" rx="2.5"
        fill="#1e1b4b" stroke={bodyStroke} strokeWidth="1.5" />

      {/* Neck */}
      <rect x="26" y="44" width="12" height="6" rx="2"
        fill="#111827" stroke={bodyStroke} strokeWidth="1" />

      {/* Body */}
      <rect x="14" y="50" width="36" height="10" rx="4"
        fill="#111827" stroke={bodyStroke} strokeWidth="1.5" />

      {/* Body indicator dots */}
      <circle cx="24" cy="55" r="2" fill={antennaColor} opacity="0.7" />
      <circle cx="32" cy="55" r="2" fill={antennaColor} opacity="0.5" />
      <circle cx="40" cy="55" r="2" fill={antennaColor} opacity="0.3" />

      {/* Executing / Scanning / Navigating: animated scan stripe on head */}
      {(state === 'scanning' || state === 'navigating' || state === 'searching' || state === 'executing') && (
        <rect
          className="robot-scan-line"
          x="10" y="22"
          width="44" height="3"
          rx="1.5"
          fill={eyeColor}
          opacity="0.6"
          style={{ transformOrigin: '32px 32px' }}
        />
      )}
    </svg>
  );
}

