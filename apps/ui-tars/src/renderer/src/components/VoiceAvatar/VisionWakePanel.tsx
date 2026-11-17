import { useEffect, useRef, useState } from 'react';
import {
  Eye,
  EyeOff,
  Video,
  VideoOff,
  AlertTriangle,
  RefreshCw,
  Cpu,
  CheckCircle,
} from 'lucide-react';
import {
  HandLandmarker,
  FaceLandmarker,
  DrawingUtils,
} from '@mediapipe/tasks-vision';
import {
  resolveVisionWasmFileset,
  createHandLandmarkerWithFallback,
  createFaceLandmarkerWithFallback,
} from '../../utils/visionLoader';
import {
  GestureStateMachine,
  computeFingerStates,
  isOpenPalm,
  findMatchingGesture,
  GestureConfig,
} from '../../utils/gestureEngine';
import './VoiceAvatar.css';

export function VisionWakePanel({
  autoStart = false,
  testGestures = null,
}: {
  autoStart?: boolean;
  testGestures?: any[] | null;
}) {
  const [isVisionEnabled, setIsVisionEnabled] = useState(autoStart);
  const [isPreviewEnabled, setIsPreviewEnabled] = useState(autoStart);
  const [lowLightWarning, setLowLightWarning] = useState(false);
  const [engineReady, setEngineReady] = useState(false);
  const [errorState, setErrorState] = useState<string | null>(null);
  const [engineSource, setEngineSource] = useState<'local' | 'cdn' | null>(
    null,
  );
  const [engineDelegate, setEngineDelegate] = useState<'GPU' | 'CPU' | null>(
    null,
  );
  const [initRetryKey, setInitRetryKey] = useState<number>(0);

  const [isTranslating, setIsTranslating] = useState(false);
  const [activeHoldProgress, setActiveHoldProgress] = useState<number>(0);
  const [activeCandidate, setActiveCandidate] = useState<GestureConfig | null>(
    null,
  );

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const handLandmarkerRef = useRef<HandLandmarker | null>(null);
  const faceLandmarkerRef = useRef<FaceLandmarker | null>(null);
  const animationRef = useRef<number | null>(null);
  const lastVideoTimeRef = useRef<number>(-1);
  const lastWakeTimeRef = useRef<number>(0);
  const configuredGesturesRef = useRef<any[]>([]);
  const testGesturesRef = useRef<any[] | null>(null);

  const gestureStateMachineRef = useRef<GestureStateMachine>(
    new GestureStateMachine({
      minHoldDurationMs: 250,
      cooldownDurationMs: 1500,
    }),
  );

  const isTranslatingRef = useRef(false);
  const translationBufferRef = useRef<string[]>([]);
  const lastAddedGestureRef = useRef<{ name: string; time: number }>({
    name: '',
    time: 0,
  });
  const openPalmHoldStartRef = useRef<number>(0);

  useEffect(() => {
    testGesturesRef.current = testGestures;
  }, [testGestures]);

  // Initialize MediaPipe Models with Offline Fallback and Delegate Resilience
  useEffect(() => {
    let active = true;
    setErrorState(null);
    setEngineReady(false);

    const initModels = async () => {
      try {
        console.info(
          '[VisionWakePanel] Initializing MediaPipe vision engine...',
        );
        const { fileset, source } = await resolveVisionWasmFileset((msg) =>
          console.info('[VisionWakePanel]', msg),
        );

        if (!active) return;
        setEngineSource(source);

        // HandLandmarker with GPU -> CPU delegate fallback
        const { landmarker: handLandmarker, delegate: handDelegate } =
          await createHandLandmarkerWithFallback(fileset, {}, (msg) =>
            console.info('[VisionWakePanel]', msg),
          );

        if (!active) {
          handLandmarker.close();
          return;
        }

        // FaceLandmarker with GPU -> CPU delegate fallback
        const { landmarker: faceLandmarker } =
          await createFaceLandmarkerWithFallback(fileset, {}, (msg) =>
            console.info('[VisionWakePanel]', msg),
          );

        if (!active) {
          handLandmarker.close();
          faceLandmarker.close();
          return;
        }

        handLandmarkerRef.current = handLandmarker;
        faceLandmarkerRef.current = faceLandmarker;
        setEngineDelegate(handDelegate);
        setEngineReady(true);
        setErrorState(null);
        console.info(
          `[VisionWakePanel] Vision engine ready (${source === 'local' ? 'Local Bundle' : 'CDN'}, ${handDelegate} delegate).`,
        );
      } catch (error: any) {
        if (!active) return;
        console.error(
          '[VisionWakePanel] Failed to load MediaPipe models:',
          error,
        );
        setErrorState(`AI Model Error: ${error?.message || error}`);
        setEngineReady(false);
      }
    };

    initModels();

    return () => {
      active = false;
      handLandmarkerRef.current?.close();
      faceLandmarkerRef.current?.close();
      handLandmarkerRef.current = null;
      faceLandmarkerRef.current = null;
    };
  }, [initRetryKey]);

  // Load configured gestures
  useEffect(() => {
    const loadGestures = () => {
      window.electron?.ipcRenderer
        ?.invoke('gesture:load')
        .then((loaded: any[]) => {
          if (loaded && loaded.length > 0)
            configuredGesturesRef.current = loaded;
        })
        .catch(console.error);
    };

    loadGestures();

    const unsubscribe = window.electron?.ipcRenderer?.on(
      'gesture:updated' as any,
      loadGestures,
    );
    return () => {
      unsubscribe?.();
    };
  }, []);

  // Handle Camera & Render Loop
  useEffect(() => {
    if (!isVisionEnabled || !engineReady) return;

    let stream: MediaStream | null = null;
    let active = true;

    const startCamera = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: true,
        });
        if (!active || !videoRef.current) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        videoRef.current.srcObject = stream;
        videoRef.current.onloadedmetadata = () => {
          videoRef.current
            ?.play()
            .catch((err) => console.error('Video play failed:', err));
        };

        // Start Render Loop
        const renderLoop = () => {
          if (
            !active ||
            !videoRef.current ||
            !canvasRef.current ||
            !handLandmarkerRef.current ||
            !faceLandmarkerRef.current
          )
            return;

          const video = videoRef.current;
          const canvas = canvasRef.current;
          const ctx = canvas.getContext('2d');

          if (
            video.currentTime !== lastVideoTimeRef.current &&
            video.readyState >= 2 &&
            ctx
          ) {
            lastVideoTimeRef.current = video.currentTime;

            // Detect
            const handResults = handLandmarkerRef.current.detectForVideo(
              video,
              performance.now(),
            );
            const faceResults = faceLandmarkerRef.current.detectForVideo(
              video,
              performance.now(),
            );

            // Check brightness roughly
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const imgData = ctx.getImageData(
              0,
              0,
              canvas.width,
              canvas.height,
            ).data;
            let sum = 0;
            for (let i = 0; i < imgData.length; i += 4 * 100) {
              sum += (imgData[i] + imgData[i + 1] + imgData[i + 2]) / 3;
            }
            const avgBrightness = sum / (imgData.length / 400);
            setLowLightWarning(avgBrightness < 30);

            // Draw
            ctx.save();
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            if (isPreviewEnabled) {
              ctx.translate(canvas.width, 0);
              ctx.scale(-1, 1);
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            }

            let shouldWake = false;
            let detectedGesture: any = null;
            let frameCandidate: GestureConfig | null = null;

            // Process Hands
            if (handResults.landmarks && handResults.landmarks.length > 0) {
              for (const landmarks of handResults.landmarks) {
                const drawingUtils = new DrawingUtils(ctx);
                drawingUtils.drawConnectors(
                  landmarks,
                  HandLandmarker.HAND_CONNECTIONS,
                  {
                    color: '#00FF00',
                    lineWidth: 2,
                  },
                );

                // Draw fingertips
                for (let i = 0; i < landmarks.length; i++) {
                  const x = landmarks[i].x * canvas.width;
                  const y = landmarks[i].y * canvas.height;
                  ctx.beginPath();
                  ctx.arc(x, y, 4, 0, 2 * Math.PI);
                  if ([4, 8, 12, 16, 20].includes(i)) {
                    ctx.fillStyle = '#FF0000';
                  } else {
                    ctx.fillStyle = '#0000FF';
                  }
                  ctx.fill();
                  ctx.stroke();
                }

                // Compute Finger States using robust Euclidean distance helper
                const currentState = computeFingerStates(landmarks);
                if (!currentState) continue;

                // Emit raw state so Gestures page can capture it
                window.dispatchEvent(
                  new CustomEvent('vision:raw-hand-state', {
                    detail: currentState,
                  }),
                );

                // Check for "Open Palm" (all 5 fingers open) to toggle translation mode
                const isPalm = isOpenPalm(currentState);

                if (isPalm) {
                  if (openPalmHoldStartRef.current === 0) {
                    openPalmHoldStartRef.current = Date.now();
                  } else if (Date.now() - openPalmHoldStartRef.current > 1000) {
                    // Toggled!
                    const newTranslatingState = !isTranslatingRef.current;
                    isTranslatingRef.current = newTranslatingState;
                    setIsTranslating(newTranslatingState);
                    openPalmHoldStartRef.current = 0; // reset

                    if (
                      !newTranslatingState &&
                      translationBufferRef.current.length > 0
                    ) {
                      // Stopped translating -> Send buffer to backend
                      window.electron?.ipcRenderer
                        ?.invoke('visionRoute.processGestureSentence', {
                          keywords: translationBufferRef.current,
                        })
                        .catch(console.error);
                      translationBufferRef.current = []; // clear buffer
                    }

                    // Flash screen to indicate mode change
                    if (canvasRef.current) {
                      canvasRef.current.style.boxShadow = newTranslatingState
                        ? '0 0 20px #a855f7'
                        : '0 0 20px #ef4444';
                      setTimeout(() => {
                        if (canvasRef.current)
                          canvasRef.current.style.boxShadow = 'none';
                      }, 1000);
                    }

                    // Add cooldown so it doesn't instantly toggle back
                    openPalmHoldStartRef.current = Date.now() + 2000;
                  }
                } else {
                  if (Date.now() > openPalmHoldStartRef.current) {
                    openPalmHoldStartRef.current = 0;
                  }
                }

                // Match against configured gestures
                const gesturesToUse =
                  testGesturesRef.current || configuredGesturesRef.current;
                if (gesturesToUse && gesturesToUse.length > 0) {
                  frameCandidate = findMatchingGesture(
                    currentState,
                    gesturesToUse,
                  );
                }

                // Fallback L-shape wake (if no config matched but matches L-shape roughly)
                const thumbTip = landmarks[4];
                const indexTip = landmarks[8];
                const middleTip = landmarks[12];
                if (
                  !frameCandidate &&
                  indexTip.y < middleTip.y - 0.1 &&
                  Math.abs(thumbTip.y - indexTip.y) > 0.1
                ) {
                  shouldWake = true;
                }
              }
            }

            // Update Gesture State Machine for threshold validation, hold progress, and spurious suppression
            const smUpdate = gestureStateMachineRef.current.update(
              frameCandidate,
              Date.now(),
            );
            setActiveHoldProgress(smUpdate.holdProgress);
            setActiveCandidate(smUpdate.candidateGesture);

            if (smUpdate.state === 'TRIGGERED' && smUpdate.triggeredGesture) {
              detectedGesture = smUpdate.triggeredGesture;
            }

            // If in translation mode, buffer the gesture
            if (
              isTranslatingRef.current &&
              detectedGesture &&
              !openPalmHoldStartRef.current
            ) {
              const label =
                detectedGesture.actionArg ||
                detectedGesture.name ||
                detectedGesture.label;
              if (
                label &&
                (label !== lastAddedGestureRef.current.name ||
                  Date.now() - lastAddedGestureRef.current.time > 1500)
              ) {
                translationBufferRef.current.push(label);
                lastAddedGestureRef.current = { name: label, time: Date.now() };

                // Brief flash to indicate word recorded
                if (canvasRef.current) {
                  canvasRef.current.style.boxShadow = '0 0 10px #60a5fa';
                  setTimeout(() => {
                    if (canvasRef.current)
                      canvasRef.current.style.boxShadow = 'none';
                  }, 300);
                }
              }
            }

            // Process Face
            if (
              faceResults.faceBlendshapes &&
              faceResults.faceBlendshapes.length > 0
            ) {
              const blendshapes = faceResults.faceBlendshapes[0].categories;

              const blinkLeft =
                blendshapes.find((b) => b.categoryName === 'eyeBlinkLeft')
                  ?.score || 0;
              const blinkRight =
                blendshapes.find((b) => b.categoryName === 'eyeBlinkRight')
                  ?.score || 0;

              const eyeLookInLeft =
                blendshapes.find((b) => b.categoryName === 'eyeLookInLeft')
                  ?.score || 0;
              const eyeLookOutLeft =
                blendshapes.find((b) => b.categoryName === 'eyeLookOutLeft')
                  ?.score || 0;

              const isBlink = blinkLeft > 0.6 && blinkRight > 0.6;
              const isLookLeft = eyeLookOutLeft > 0.5;
              const isLookRight = eyeLookInLeft > 0.5;

              let isNodUp = false;
              let isNodDown = false;
              let isTurnLeft = false;
              let isTurnRight = false;

              if (
                faceResults.faceLandmarks &&
                faceResults.faceLandmarks.length > 0
              ) {
                const landmarks = faceResults.faceLandmarks[0];
                const nose = landmarks[1];
                const leftCheek = landmarks[234];
                const rightCheek = landmarks[454];
                const top = landmarks[10];
                const bottom = landmarks[152];

                // Yaw ratio (Horizontal)
                const leftDist = Math.abs(nose.x - leftCheek.x);
                const rightDist = Math.abs(rightCheek.x - nose.x);
                const yawRatio = leftDist / (rightDist + 0.0001);

                if (yawRatio > 2.0) isTurnRight = true;
                if (yawRatio < 0.5) isTurnLeft = true;

                // Pitch ratio (Vertical)
                const topDist = Math.abs(nose.y - top.y);
                const bottomDist = Math.abs(bottom.y - nose.y);
                const pitchRatio = topDist / (bottomDist + 0.0001);

                if (pitchRatio > 1.5) isNodDown = true;
                if (pitchRatio < 0.7) isNodUp = true;
              }

              const faceState = {
                blink: isBlink,
                lookLeft: isLookLeft,
                lookRight: isLookRight,
                nodUp: isNodUp,
                nodDown: isNodDown,
                turnLeft: isTurnLeft,
                turnRight: isTurnRight,
              };

              // Emit detailed face state
              window.dispatchEvent(
                new CustomEvent('vision:raw-face-state', { detail: faceState }),
              );

              // Legacy trigger
              if (isBlink || isNodDown) {
                shouldWake = true;
              }

              if (faceResults.faceLandmarks) {
                for (const landmarks of faceResults.faceLandmarks) {
                  ctx.fillStyle = '#00FFFF';
                  for (let i = 0; i < landmarks.length; i += 10) {
                    const x = landmarks[i].x * canvas.width;
                    const y = landmarks[i].y * canvas.height;
                    ctx.beginPath();
                    ctx.arc(x, y, 1, 0, 2 * Math.PI);
                    ctx.fill();
                  }
                }
              }
            }

            ctx.restore();

            if (
              (shouldWake || detectedGesture) &&
              Date.now() - lastWakeTimeRef.current > 3000
            ) {
              lastWakeTimeRef.current = Date.now();

              if (detectedGesture) {
                window.dispatchEvent(
                  new CustomEvent('vision:gesture-triggered', {
                    detail: detectedGesture,
                  }),
                );
              } else {
                window.dispatchEvent(new CustomEvent('vision:wake-triggered'));
              }

              if (canvasRef.current) {
                canvasRef.current.style.boxShadow = '0 0 20px #4ade80';
                setTimeout(() => {
                  if (canvasRef.current)
                    canvasRef.current.style.boxShadow = 'none';
                }, 1000);
              }
            }
          }

          animationRef.current = requestAnimationFrame(renderLoop);
        };

        renderLoop();
      } catch (err: any) {
        console.error('Camera access failed', err);
        setErrorState('Camera Error: ' + err.message);
      }
    };

    startCamera();

    return () => {
      active = false;
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [isVisionEnabled, engineReady, isPreviewEnabled]);

  const handleRetry = () => {
    setErrorState(null);
    setInitRetryKey((k) => k + 1);
  };

  return (
    <div
      className="vision-panel glass-panel"
      style={{
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        background: 'rgba(15, 23, 42, 0.8)',
        backdropFilter: 'blur(12px)',
        borderRadius: '12px',
        color: 'white',
        width: '320px',
        pointerEvents: 'auto',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <h3
          style={{
            margin: 0,
            fontSize: '14px',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
          }}
        >
          {isVisionEnabled ? (
            <Eye size={16} style={{ color: '#4ade80' }} />
          ) : (
            <EyeOff size={16} style={{ color: '#94a3b8' }} />
          )}
          Visual Wake Modality
        </h3>
        <label className="vision-switch">
          <input
            type="checkbox"
            checked={isVisionEnabled}
            onChange={(e) => setIsVisionEnabled(e.target.checked)}
          />
          <span className="vision-slider"></span>
        </label>
      </div>

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          opacity: isVisionEnabled ? 1 : 0.5,
        }}
      >
        <h3
          style={{
            margin: 0,
            fontSize: '14px',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
          }}
        >
          {isPreviewEnabled ? (
            <Video size={16} style={{ color: '#60a5fa' }} />
          ) : (
            <VideoOff size={16} style={{ color: '#94a3b8' }} />
          )}
          Live Mirror Preview
        </h3>
        <label className="vision-switch">
          <input
            type="checkbox"
            disabled={!isVisionEnabled}
            checked={isPreviewEnabled}
            onChange={(e) => setIsPreviewEnabled(e.target.checked)}
          />
          <span className="vision-slider"></span>
        </label>
      </div>

      {/* Engine Status Indicator */}
      {engineReady && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '6px 10px',
            background: 'rgba(30, 41, 59, 0.7)',
            borderRadius: '6px',
            fontSize: '11px',
            color: '#94a3b8',
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <CheckCircle size={13} style={{ color: '#4ade80' }} />
            <span>AI Vision Engine Ready</span>
          </span>
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              color: '#38bdf8',
              fontWeight: 500,
            }}
          >
            <Cpu size={12} />
            {engineSource === 'local' ? 'Local WASM' : 'CDN WASM'} •{' '}
            {engineDelegate || 'GPU'}
          </span>
        </div>
      )}

      {lowLightWarning && isVisionEnabled && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '8px',
            background: 'rgba(239, 68, 68, 0.2)',
            color: '#fca5a5',
            borderRadius: '6px',
            fontSize: '12px',
          }}
        >
          <AlertTriangle size={14} />
          Low light detected! Gaze tracking may be inaccurate.
        </div>
      )}

      {isTranslating && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '8px',
            background: 'rgba(168, 85, 247, 0.2)',
            color: '#d8b4fe',
            borderRadius: '6px',
            fontSize: '12px',
            fontWeight: 'bold',
            border: '1px solid rgba(168, 85, 247, 0.5)',
          }}
        >
          <span
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: '#a855f7',
              animation: 'pulse 1.5s infinite',
            }}
          ></span>
          Gesture Translation Active...
        </div>
      )}

      <video
        id="global-vision-video"
        ref={videoRef}
        playsInline
        autoPlay
        style={{ display: 'none' }}
      />

      {isVisionEnabled && (
        <div
          style={{
            position: 'relative',
            width: '100%',
            height: '200px',
            background: '#000',
            borderRadius: '8px',
            overflow: 'hidden',
            transition: 'box-shadow 0.3s',
          }}
          ref={(node) => {
            if (node && canvasRef.current)
              canvasRef.current.style.boxShadow = node.style.boxShadow;
          }}
        >
          {errorState ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                color: '#ef4444',
                fontSize: '12px',
                textAlign: 'center',
                padding: '16px',
                gap: '8px',
              }}
            >
              <AlertTriangle size={24} />
              <span>{errorState}</span>
              <button
                type="button"
                onClick={handleRetry}
                style={{
                  marginTop: '4px',
                  padding: '6px 12px',
                  background: '#2563eb',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '6px',
                  fontSize: '11px',
                  fontWeight: 500,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                <RefreshCw size={12} /> Retry Initialization
              </button>
            </div>
          ) : engineReady ? (
            <>
              <canvas
                id="global-vision-canvas"
                ref={canvasRef}
                width={320}
                height={240}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />

              {/* Immediate feedback for gesture holding */}
              {activeHoldProgress > 0 && activeCandidate && (
                <div
                  style={{
                    position: 'absolute',
                    bottom: '8px',
                    left: '8px',
                    right: '8px',
                    background: 'rgba(15, 23, 42, 0.85)',
                    padding: '6px 10px',
                    borderRadius: '6px',
                    border: '1px solid rgba(59, 130, 246, 0.4)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: '11px',
                      color: '#93c5fd',
                    }}
                  >
                    <span>
                      Holding: {activeCandidate.name || activeCandidate.id}
                    </span>
                    <span>{Math.round(activeHoldProgress * 100)}%</span>
                  </div>
                  <div
                    style={{
                      width: '100%',
                      height: '4px',
                      background: 'rgba(255, 255, 255, 0.2)',
                      borderRadius: '2px',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        width: `${activeHoldProgress * 100}%`,
                        height: '100%',
                        background: '#3b82f6',
                        transition: 'width 0.05s linear',
                      }}
                    />
                  </div>
                </div>
              )}
            </>
          ) : (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                color: '#94a3b8',
                fontSize: '12px',
                textAlign: 'center',
                padding: '16px',
                gap: '8px',
              }}
            >
              <RefreshCw
                size={18}
                className="animate-spin"
                style={{ color: '#3b82f6' }}
              />
              <span>Warming up AI engine (offline first)...</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
