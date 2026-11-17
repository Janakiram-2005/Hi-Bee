import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Eye,
  EyeOff,
  Video,
  VideoOff,
  AlertTriangle,
  Lock,
  Unlock,
  CheckCircle2,
  Zap,
  RefreshCw,
  Cpu,
  CheckCircle,
} from 'lucide-react';
import {
  HandLandmarker,
  FaceLandmarker,
  DrawingUtils,
} from '@mediapipe/tasks-vision';
import { UIGestureGatekeeper, EngagementState } from './gestureGatekeeper';
import {
  MultiHandHoldTracker,
  HandLandmarkerResults,
} from './multiHandHoldTracker';
import {
  getCanvasDprMetrics,
  calculateDprPreviewCoordinates,
} from '../../utils/gestureDpr';
import {
  getWebcamCropMetrics,
  correctHandLandmarks,
  checkHandBounds,
  computeFingerStates,
  GestureStateSmoother,
} from '../../utils/gestureLandmarks';
import {
  resolveVisionWasmFileset,
  createHandLandmarkerWithFallback,
  createFaceLandmarkerWithFallback,
} from '../../utils/visionLoader';
import { GestureConfig } from '../../utils/gestureEngine';
import './VoiceAvatar.css';

export function VisionWakePanel({
  autoStart = false,
  testGestures = null,
  holdThresholdMs = 1000,
  cooldownMs = 2000,
}: {
  autoStart?: boolean;
  testGestures?: any[] | null;
  holdThresholdMs?: number;
  cooldownMs?: number;
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
  const [holdProgress, setHoldProgress] = useState(0);

  // Engagement gating states & indicators
  const [gateState, setGateState] = useState<EngagementState>('DISENGAGED');
  const [engagementProgress, setEngagementProgress] = useState(0);
  const [gestureHoldProgress, setGestureHoldProgress] = useState(0);
  const [activeGestureName, setActiveGestureName] = useState<string | null>(
    null,
  );
  const [lastTriggeredName, setLastTriggeredName] = useState<string | null>(
    null,
  );

  const gatekeeperRef = useRef<UIGestureGatekeeper>(
    new UIGestureGatekeeper({
      targetMin: 0.4,
      targetMax: 0.6,
      engagementHoldMs: 800,
      gestureHoldMs: 1000,
      inactivityTimeoutMs: 3000,
      cooldownMs: 1200,
    }),
  );

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const handLandmarkerRef = useRef<HandLandmarker | null>(null);
  const faceLandmarkerRef = useRef<FaceLandmarker | null>(null);
  const animationRef = useRef<number | undefined>(undefined);
  const lastVideoTimeRef = useRef<number>(-1);
  const lastWakeTimeRef = useRef<number>(0);
  const configuredGesturesRef = useRef<any[]>([]);
  const testGesturesRef = useRef<any[] | null>(null);

  const isTranslatingRef = useRef(false);
  const translationBufferRef = useRef<string[]>([]);
  const lastAddedGestureRef = useRef<{ name: string; time: number }>({
    name: '',
    time: 0,
  });
  const openPalmHoldStartRef = useRef<number>(0);
  const gestureHoldStartRef = useRef<number>(0);
  const activeGestureRef = useRef<any>(null);
  const gestureSessionFocusRef = useRef<boolean>(false);
  const activeHoldRef = useRef<{
    gestureId: string;
    gesture: any;
    startTime: number;
    lastSeenTime: number;
    triggered: boolean;
    startWrist: { x: number; y: number };
  } | null>(null);
  const lastGestureTriggerTimeRef = useRef<Record<string, number>>({});

  const idleFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const IDLE_FLUSH_TIMEOUT_MS = 3000;
  const MAX_TRANSLATION_BUFFER_SIZE = 50;

  const flushTranslationBuffer = (reason: string = 'idle') => {
    if (idleFlushTimerRef.current) {
      clearTimeout(idleFlushTimerRef.current);
      idleFlushTimerRef.current = null;
    }
    if (translationBufferRef.current.length > 0) {
      const keywords = [...translationBufferRef.current];
      translationBufferRef.current = [];
      console.log(
        `[VisionWakePanel] Flushing translation buffer (reason: ${reason}):`,
        keywords,
      );
      window.electron?.ipcRenderer
        ?.invoke('visionRoute.processGestureSentence', {
          keywords,
        })
        .catch(console.error);

      // Flash canvas with emerald glow on flush
      if (canvasRef.current && reason !== 'toggle_off') {
        canvasRef.current.style.boxShadow = '0 0 15px #10b981';
        setTimeout(() => {
          if (canvasRef.current) canvasRef.current.style.boxShadow = 'none';
        }, 600);
      }
    }
  };

  const handleToggleMode = useCallback((handKey?: string) => {
    const newTranslatingState = !isTranslatingRef.current;
    isTranslatingRef.current = newTranslatingState;
    setIsTranslating(newTranslatingState);
    console.log(
      `[VisionWake] Mode toggled: isTranslating=${newTranslatingState} by hand ${handKey}`,
    );

    if (!newTranslatingState) {
      flushTranslationBuffer('toggle_off');
    }

    if (canvasRef.current) {
      canvasRef.current.style.boxShadow = newTranslatingState
        ? '0 0 20px #a855f7'
        : '0 0 20px #ef4444';
      setTimeout(() => {
        if (canvasRef.current) canvasRef.current.style.boxShadow = 'none';
      }, 1000);
    }
  }, []);

  const trackerRef = useRef<MultiHandHoldTracker>(
    new MultiHandHoldTracker({
      holdDurationMs: holdThresholdMs,
      cooldownMs: cooldownMs,
      fingerExtensionRatio: 1.0,
      frameDropGraceMs: 150,
      onTrigger: (handKey) => {
        handleToggleMode(handKey);
      },
    }),
  );

  const smootherRef = useRef<GestureStateSmoother>(
    new GestureStateSmoother(2, 3),
  );

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
          await createHandLandmarkerWithFallback(
            fileset,
            {
              numHands: 2,
              minHandDetectionConfidence: 0.5,
              minHandPresenceConfidence: 0.5,
              minTrackingConfidence: 0.5,
            },
            (msg) => console.info('[VisionWakePanel]', msg),
          );

        if (!active) {
          handLandmarker.close();
          return;
        }

        // FaceLandmarker with GPU -> CPU delegate fallback
        const { landmarker: faceLandmarker } =
          await createFaceLandmarkerWithFallback(
            fileset,
            {
              outputFaceBlendshapes: true,
              outputFacialTransformationMatrixes: true,
              minFaceDetectionConfidence: 0.5,
              minFacePresenceConfidence: 0.5,
              minTrackingConfidence: 0.5,
            },
            (msg) => console.info('[VisionWakePanel]', msg),
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

  const handleRetry = () => {
    setErrorState(null);
    setInitRetryKey((k) => k + 1);
  };

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

    const unsubscribe = (window.electron?.ipcRenderer as any)?.on?.(
      'gesture:updated',
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

            // Calculate display and DPR metrics
            const dpr =
              typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
            const dprMetrics = getCanvasDprMetrics(320, 240, dpr);

            // Synchronize canvas buffer resolution with DPR scaling
            if (
              canvas.width !== dprMetrics.bufferWidth ||
              canvas.height !== dprMetrics.bufferHeight
            ) {
              canvas.width = dprMetrics.bufferWidth;
              canvas.height = dprMetrics.bufferHeight;
            }
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

            // Aspect ratio crop metrics
            const vWidth = video.videoWidth || canvas.width || 640;
            const vHeight = video.videoHeight || canvas.height || 480;
            const cropMetrics = getWebcamCropMetrics(vWidth, vHeight, 16 / 9);

            // Process Hands
            if (handResults.landmarks && handResults.landmarks.length > 0) {
              const holdResult = trackerRef.current.processFrame(
                handResults as HandLandmarkerResults,
                Date.now(),
              );
              setHoldProgress(
                holdResult.isHolding ? holdResult.activeHoldProgress : 0,
              );

              // Dispatch global hold progress event for UI layers
              window.dispatchEvent(
                new CustomEvent('vision:hold-progress', {
                  detail: {
                    isHolding: holdResult.isHolding,
                    progress: holdResult.activeHoldProgress,
                    activeHandKey: holdResult.activeHandKey,
                    inCooldown: holdResult.inCooldown,
                  },
                }),
              );

              // Dispatch primary finger state for gestures page
              if (holdResult.primaryFingerState) {
                window.dispatchEvent(
                  new CustomEvent('vision:raw-hand-state', {
                    detail: holdResult.primaryFingerState,
                  }),
                );
              }

              for (const rawLandmarks of handResults.landmarks) {
                // Correct coordinates for webcam aspect ratio cropping
                const correctedLandmarks = correctHandLandmarks(
                  rawLandmarks,
                  cropMetrics,
                );
                const boundsResult = checkHandBounds(correctedLandmarks);

                // Calculate preview coordinates for canvas DPR scaling
                const previewCoordinates = calculateDprPreviewCoordinates(
                  correctedLandmarks,
                  dprMetrics,
                );

                const drawingUtils = new DrawingUtils(ctx);
                drawingUtils.drawConnectors(
                  rawLandmarks,
                  HandLandmarker.HAND_CONNECTIONS,
                  {
                    color: '#00FF00',
                    lineWidth: 2,
                  },
                );

                // Draw fingertips scaled for DPR
                const radius = Math.max(4, Math.round(4 * dprMetrics.dpr));
                for (let i = 0; i < previewCoordinates.length; i++) {
                  const x = previewCoordinates[i].canvas.x;
                  const y = previewCoordinates[i].canvas.y;
                  ctx.beginPath();
                  ctx.arc(x, y, radius, 0, 2 * Math.PI);
                  if ([4, 8, 12, 16, 20].includes(i)) {
                    ctx.fillStyle = '#FF0000';
                  } else {
                    ctx.fillStyle = '#0000FF';
                  }
                  ctx.fill();
                  ctx.lineWidth = Math.max(1, Math.round(1 * dprMetrics.dpr));
                  ctx.strokeStyle = '#FFFFFF';
                  ctx.stroke();
                }

                // Compute Finger States with aspect-corrected metric distance
                const rawFingerState = computeFingerStates(
                  correctedLandmarks,
                  cropMetrics.targetAspectRatio,
                );
                const smoothed = smootherRef.current.update(
                  rawFingerState,
                  boundsResult.inBounds,
                );
                const currentState = smoothed.state || rawFingerState;

                // Propagate corrected metrics across vision engine boundary
                window.dispatchEvent(
                  new CustomEvent('vision:raw-hand-state', {
                    detail: {
                      ...currentState,
                      fingers: currentState,
                      landmarks: correctedLandmarks,
                      previewCoordinates,
                      rawLandmarks,
                      inBounds: boundsResult.inBounds,
                      dprMetrics,
                      data: correctedLandmarks,
                      cropMetrics,
                    },
                  }),
                );

                // Only evaluate interactive triggers if hand is within visible preview bounds
                if (boundsResult.inBounds) {
                  const isOpenPalm =
                    currentState.thumb === 'open' &&
                    currentState.index === 'open' &&
                    currentState.middle === 'open' &&
                    currentState.ring === 'open' &&
                    currentState.pinky === 'open';

                  // Match against configured gestures
                  const gesturesToUse =
                    testGesturesRef.current || configuredGesturesRef.current;
                  if (gesturesToUse && gesturesToUse.length > 0) {
                    for (const g of gesturesToUse) {
                      const match = [
                        'thumb',
                        'index',
                        'middle',
                        'ring',
                        'pinky',
                      ].every((finger) => {
                        const req = g.fingers[finger];
                        return (
                          req === 'any' ||
                          req ===
                            currentState[finger as keyof typeof currentState]
                        );
                      });
                      if (match) {
                        detectedGesture = g;
                        break;
                      }
                    }
                  }

                  // Temporal gesture dynamics & hold validation
                  const now = Date.now();
                  if (detectedGesture) {
                    const configuredHoldDuration =
                      detectedGesture.holdDuration || 800; // ms
                    const wrist = previewCoordinates[0]?.canvas || {
                      x: correctedLandmarks[0].x * canvas.width,
                      y: correctedLandmarks[0].y * canvas.height,
                    };

                    const currentHold = activeHoldRef.current;
                    if (
                      currentHold &&
                      currentHold.gestureId === detectedGesture.id
                    ) {
                      currentHold.lastSeenTime = now;
                      const elapsed = now - currentHold.startTime;
                      const progress = Math.min(
                        1.0,
                        elapsed / configuredHoldDuration,
                      );

                      // Immediate visual feedback: circular progress ring around wrist
                      const wx = wrist.x;
                      const wy = wrist.y;
                      ctx.save();
                      ctx.beginPath();
                      ctx.arc(wx, wy, 26, 0, 2 * Math.PI);
                      ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
                      ctx.lineWidth = 4;
                      ctx.stroke();

                      ctx.beginPath();
                      ctx.arc(
                        wx,
                        wy,
                        26,
                        -Math.PI / 2,
                        -Math.PI / 2 + progress * 2 * Math.PI,
                      );
                      ctx.strokeStyle = progress >= 1.0 ? '#22c55e' : '#38bdf8';
                      ctx.lineWidth = 4;
                      ctx.stroke();

                      ctx.fillStyle = '#ffffff';
                      ctx.font = 'bold 12px Inter, sans-serif';
                      ctx.fillText(
                        `${detectedGesture.name || 'Gesture'} (${Math.round(progress * 100)}%)`,
                        wx + 34,
                        wy + 5,
                      );
                      ctx.restore();

                      // State boundary: trigger once threshold bound is reached
                      if (
                        !currentHold.triggered &&
                        elapsed >= configuredHoldDuration
                      ) {
                        const lastTrigger =
                          lastGestureTriggerTimeRef.current[
                            detectedGesture.id
                          ] || 0;
                        if (now - lastTrigger > 1500) {
                          currentHold.triggered = true;
                          lastGestureTriggerTimeRef.current[
                            detectedGesture.id
                          ] = now;
                          console.log(
                            `[VisionWakePanel] Gesture state transition: HOLDING -> TRIGGERED: ${detectedGesture.name} (${detectedGesture.action}) held for ${elapsed}ms`,
                          );
                          window.dispatchEvent(
                            new CustomEvent('vision:gesture-triggered', {
                              detail: detectedGesture,
                            }),
                          );
                          window.dispatchEvent(
                            new CustomEvent('vision:gesture-state-change', {
                              detail: {
                                state: 'triggered',
                                gesture: detectedGesture,
                                elapsed,
                              },
                            }),
                          );

                          if (canvasRef.current) {
                            canvasRef.current.style.boxShadow =
                              '0 0 25px #22c55e';
                            setTimeout(() => {
                              if (canvasRef.current)
                                canvasRef.current.style.boxShadow = 'none';
                            }, 800);
                          }
                        }
                      } else if (!currentHold.triggered) {
                        window.dispatchEvent(
                          new CustomEvent('vision:gesture-state-change', {
                            detail: {
                              state: 'holding',
                              gesture: detectedGesture,
                              progress,
                              elapsed,
                            },
                          }),
                        );
                      }
                    } else {
                      // New gesture detected - start hold state if not on cooldown
                      const lastTrigger =
                        lastGestureTriggerTimeRef.current[detectedGesture.id] ||
                        0;
                      if (now - lastTrigger > 1500) {
                        activeHoldRef.current = {
                          gestureId: detectedGesture.id,
                          gesture: detectedGesture,
                          startTime: now,
                          lastSeenTime: now,
                          triggered: false,
                          startWrist: { x: wrist.x, y: wrist.y },
                        };
                        console.log(
                          `[VisionWakePanel] Gesture state transition: IDLE -> HOLDING: ${detectedGesture.name}`,
                        );
                        window.dispatchEvent(
                          new CustomEvent('vision:gesture-state-change', {
                            detail: {
                              state: 'holding',
                              gesture: detectedGesture,
                              progress: 0,
                              elapsed: 0,
                            },
                          }),
                        );
                      }
                    }
                  } else if (activeHoldRef.current) {
                    // Fallback Scenario: Recover gracefully when gesture is interrupted
                    if (now - activeHoldRef.current.lastSeenTime > 200) {
                      if (!activeHoldRef.current.triggered) {
                        console.log(
                          `[VisionWakePanel] Gesture state transition: HOLDING -> IDLE (Interrupted): ${activeHoldRef.current.gesture.name}`,
                        );
                        window.dispatchEvent(
                          new CustomEvent('vision:gesture-state-change', {
                            detail: {
                              state: 'interrupted',
                              gesture: activeHoldRef.current.gesture,
                            },
                          }),
                        );
                      }
                      activeHoldRef.current = null;
                    }
                  }

                  // If in translation mode, buffer the gesture
                  if (
                    isTranslatingRef.current &&
                    detectedGesture &&
                    !isOpenPalm
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
                      if (
                        translationBufferRef.current.length <
                        MAX_TRANSLATION_BUFFER_SIZE
                      ) {
                        translationBufferRef.current.push(label);
                        lastAddedGestureRef.current = {
                          name: label,
                          time: Date.now(),
                        };
                        console.log(
                          '[VisionWakePanel] Gesture buffered:',
                          label,
                          'Buffer:',
                          translationBufferRef.current,
                        );

                        // Brief flash to indicate word recorded
                        if (canvasRef.current) {
                          canvasRef.current.style.boxShadow =
                            '0 0 10px #60a5fa';
                          setTimeout(() => {
                            if (canvasRef.current)
                              canvasRef.current.style.boxShadow = 'none';
                          }, 300);
                        }

                        // Reset idle flush timer for inactivity timeout
                        if (idleFlushTimerRef.current) {
                          clearTimeout(idleFlushTimerRef.current);
                        }
                        idleFlushTimerRef.current = setTimeout(() => {
                          flushTranslationBuffer('inactivity');
                        }, IDLE_FLUSH_TIMEOUT_MS);
                      } else {
                        console.warn(
                          '[VisionWakePanel] Translation buffer reached maximum bounds, auto-flushing.',
                        );
                        flushTranslationBuffer('max_buffer');
                      }
                    }
                  }

                  // Fallback L-shape wake (if no config matched but matches L-shape roughly)
                  const thumbTip = correctedLandmarks[4];
                  const indexTip = correctedLandmarks[8];
                  const middleTip = correctedLandmarks[12];
                  if (
                    !detectedGesture &&
                    indexTip.y < middleTip.y - 0.1 &&
                    Math.abs(
                      (thumbTip.x - indexTip.x) * cropMetrics.targetAspectRatio,
                    ) > 0.1
                  ) {
                    shouldWake = true;
                  }
                }
              }
            } else {
              // Smooth frame drop when no hands detected
              smootherRef.current.update(null, false);
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
              const isLookLeft = eyeLookOutLeft > 0.5; // very rough heuristic
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
              if (faceState.blink || faceState.nodDown) {
                shouldWake = true;
              }

              if (faceResults.faceLandmarks) {
                const facePointRadius = Math.max(
                  1,
                  Math.round(1.5 * dprMetrics.dpr),
                );
                for (const landmarks of faceResults.faceLandmarks) {
                  ctx.fillStyle = '#00FFFF';
                  for (let i = 0; i < landmarks.length; i += 10) {
                    const x = landmarks[i].x * canvas.width;
                    const y = landmarks[i].y * canvas.height;
                    ctx.beginPath();
                    ctx.arc(x, y, facePointRadius, 0, 2 * Math.PI);
                    ctx.fill();
                  }
                }
              }
            }

            ctx.restore();

            // Compute relative iris position if face landmarks present
            let relativePosition: number | null = null;
            if (
              faceResults.faceLandmarks &&
              faceResults.faceLandmarks.length > 0
            ) {
              const flm = faceResults.faceLandmarks[0];
              if (flm[33] && flm[133] && flm[468]) {
                const leftX = Math.min(flm[33].x, flm[133].x);
                const rightX = Math.max(flm[33].x, flm[133].x);
                if (rightX > leftX) {
                  relativePosition = (flm[468].x - leftX) / (rightX - leftX);
                }
              }
            }

            // Process through engagement gatekeeper
            const now = Date.now();
            const gateResult = gatekeeperRef.current.processFrame(
              relativePosition,
              detectedGesture,
              shouldWake,
              now,
            );

            // Update state indicators for UI
            setGateState(gateResult.state);
            setEngagementProgress(gateResult.engagementProgress);
            setGestureHoldProgress(gateResult.holdProgress);
            setActiveGestureName(gateResult.activeGesture?.name || null);

            // Gated wake trigger
            if (gateResult.shouldWake && now - lastWakeTimeRef.current > 3000) {
              lastWakeTimeRef.current = now;
              window.dispatchEvent(new CustomEvent('vision:wake-triggered'));
            }

            // Gated deliberate gesture trigger
            if (gateResult.triggeredGesture) {
              setLastTriggeredName(
                gateResult.triggeredGesture.name || 'Gesture',
              );
              setTimeout(() => setLastTriggeredName(null), 1500);

              window.dispatchEvent(
                new CustomEvent('vision:gesture-triggered', {
                  detail: gateResult.triggeredGesture,
                }),
              );

              if (shouldWake && Date.now() - lastWakeTimeRef.current > 3000) {
                lastWakeTimeRef.current = Date.now();
                window.dispatchEvent(new CustomEvent('vision:wake-triggered'));

                if (canvasRef.current) {
                  canvasRef.current.style.boxShadow = '0 0 20px #4ade80';
                  setTimeout(() => {
                    if (canvasRef.current)
                      canvasRef.current.style.boxShadow = 'none';
                  }, 1000);
                }
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
      if (idleFlushTimerRef.current) {
        clearTimeout(idleFlushTimerRef.current);
        idleFlushTimerRef.current = null;
      }
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [isVisionEnabled, engineReady, isPreviewEnabled]);

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

      {/* Engagement Gating Status & Control */}
      {isVisionEnabled && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            background: 'rgba(30, 41, 59, 0.6)',
            padding: '8px 12px',
            borderRadius: '8px',
            border: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {gateState === 'ENGAGED' ? (
              <Unlock size={16} style={{ color: '#4ade80' }} />
            ) : gateState === 'ENGAGING' ? (
              <Zap
                size={16}
                style={{ color: '#f59e0b', animation: 'pulse 1s infinite' }}
              />
            ) : gateState === 'COOLDOWN' ? (
              <Zap size={16} style={{ color: '#a855f7' }} />
            ) : (
              <Lock size={16} style={{ color: '#94a3b8' }} />
            )}
            <div>
              <div
                style={{
                  fontSize: '12px',
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                Engagement Gate
                <span
                  style={{
                    fontSize: '10px',
                    padding: '2px 6px',
                    borderRadius: '4px',
                    fontWeight: 700,
                    background:
                      gateState === 'ENGAGED'
                        ? 'rgba(74, 222, 128, 0.2)'
                        : gateState === 'ENGAGING'
                          ? 'rgba(245, 158, 11, 0.2)'
                          : 'rgba(148, 163, 184, 0.2)',
                    color:
                      gateState === 'ENGAGED'
                        ? '#4ade80'
                        : gateState === 'ENGAGING'
                          ? '#f59e0b'
                          : '#94a3b8',
                    border: `1px solid ${gateState === 'ENGAGED' ? 'rgba(74, 222, 128, 0.4)' : gateState === 'ENGAGING' ? 'rgba(245, 158, 11, 0.4)' : 'rgba(148, 163, 184, 0.4)'}`,
                  }}
                >
                  {gateState === 'ENGAGED'
                    ? 'ENGAGED'
                    : gateState === 'ENGAGING'
                      ? `ENGAGING ${(engagementProgress * 100).toFixed(0)}%`
                      : gateState === 'COOLDOWN'
                        ? 'COOLDOWN'
                        : 'GATED'}
                </span>
              </div>
              <div style={{ fontSize: '10px', color: '#94a3b8' }}>
                {gateState === 'ENGAGED'
                  ? 'Actions active'
                  : gateState === 'ENGAGING'
                    ? 'Hold gaze to engage'
                    : 'Spurious gestures blocked'}
              </div>
            </div>
          </div>
          <button
            onClick={() => {
              const next = gateState !== 'ENGAGED';
              gatekeeperRef.current.setEngaged(next, Date.now(), 'user_toggle');
              setGateState(next ? 'ENGAGED' : 'DISENGAGED');
            }}
            style={{
              background:
                gateState === 'ENGAGED'
                  ? 'rgba(239, 68, 68, 0.2)'
                  : 'rgba(59, 130, 246, 0.2)',
              border: `1px solid ${gateState === 'ENGAGED' ? 'rgba(239, 68, 68, 0.5)' : 'rgba(59, 130, 246, 0.5)'}`,
              color: gateState === 'ENGAGED' ? '#fca5a5' : '#93c5fd',
              borderRadius: '6px',
              padding: '4px 8px',
              fontSize: '11px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {gateState === 'ENGAGED' ? 'Disengage' : 'Engage'}
          </button>
        </div>
      )}

      {/* Immediate Feedback for In-Progress Hold Gestures */}
      {isVisionEnabled && gateState === 'ENGAGED' && activeGestureName && (
        <div
          style={{
            background: 'rgba(30, 41, 59, 0.8)',
            padding: '6px 10px',
            borderRadius: '6px',
            border: '1px solid rgba(59, 130, 246, 0.3)',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: '11px',
              marginBottom: '4px',
            }}
          >
            <span style={{ color: '#93c5fd', fontWeight: 600 }}>
              Holding: {activeGestureName}
            </span>
            <span style={{ color: '#94a3b8' }}>
              {(gestureHoldProgress * 100).toFixed(0)}%
            </span>
          </div>
          <div
            style={{
              width: '100%',
              height: '4px',
              background: 'rgba(255,255,255,0.1)',
              borderRadius: '2px',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${gestureHoldProgress * 100}%`,
                height: '100%',
                background: '#3b82f6',
                transition: 'width 0.05s linear',
              }}
            />
          </div>
        </div>
      )}

      {lastTriggeredName && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            background: 'rgba(34, 197, 94, 0.2)',
            border: '1px solid rgba(34, 197, 94, 0.5)',
            color: '#86efac',
            padding: '6px 10px',
            borderRadius: '6px',
            fontSize: '11px',
            fontWeight: 600,
          }}
        >
          <CheckCircle2 size={14} />
          Triggered action for {lastTriggeredName}!
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

      {holdProgress > 0 && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
            padding: '8px',
            background: 'rgba(59, 130, 246, 0.2)',
            color: '#93c5fd',
            borderRadius: '6px',
            fontSize: '12px',
            border: '1px solid rgba(59, 130, 246, 0.4)',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span style={{ fontWeight: 600 }}>Hold to toggle mode...</span>
            <span>{Math.round(holdProgress * 100)}%</span>
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
                width: `${Math.round(holdProgress * 100)}%`,
                height: '100%',
                background: '#60a5fa',
                transition: 'width 0.1s linear',
              }}
            ></div>
          </div>
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
                color: '#f87171',
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
            <canvas
              id="global-vision-canvas"
              ref={canvasRef}
              width={
                320 *
                (typeof window !== 'undefined'
                  ? window.devicePixelRatio || 1
                  : 1)
              }
              height={
                240 *
                (typeof window !== 'undefined'
                  ? window.devicePixelRatio || 1
                  : 1)
              }
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
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
