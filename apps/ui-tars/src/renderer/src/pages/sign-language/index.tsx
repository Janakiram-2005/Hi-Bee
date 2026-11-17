import { useEffect, useRef, useState, useCallback } from 'react';
import { FilesetResolver, GestureRecognizer } from '@mediapipe/tasks-vision';
import gestureDb from '../../const/gesture_db.json';
import { useVoiceStore } from '../../store/voiceStore';
import { SignLanguageBufferManager } from './bufferManager';

export default function SignLanguagePage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [recognizer, setRecognizer] = useState<GestureRecognizer | null>(null);
  const [isWebcamRunning, setIsWebcamRunning] = useState(false);
  const [rawSigns, setRawSigns] = useState<string[]>([]);
  const [isAutoFlushActive, setIsAutoFlushActive] = useState(false);
  const [isFlushing, setIsFlushing] = useState(false);
  const [lastDetectedSign, setLastDetectedSign] = useState<string | null>(null);

  const { selectedLanguage, setAvatarState } = useVoiceStore();

  const processBuffer = useCallback(
    (signsToProcess: string[]) => {
      if (signsToProcess.length === 0) return;
      setIsFlushing(true);
      setAvatarState('thinking');
      console.log(
        '[SignLanguage] Sending buffer to voiceRoute.processGestures:',
        signsToProcess,
      );

      const electronIpc = window.electron?.ipcRenderer;
      if (!electronIpc) {
        console.warn(
          '[SignLanguage] electron.ipcRenderer not available in this environment',
        );
        setIsFlushing(false);
        setAvatarState('idle');
        return;
      }

      electronIpc
        .invoke('voiceRoute.processGestures', {
          rawSigns: signsToProcess,
          language: selectedLanguage,
          runInBackground: false,
        })
        .then((response: any) => {
          setIsFlushing(false);
          if (response?.success) {
            console.log(
              '[SignLanguage] Gesture processing complete:',
              response,
            );
          } else {
            console.error(
              '[SignLanguage] Gesture processing failed:',
              response?.error,
            );
            setAvatarState('idle');
          }
        })
        .catch((err) => {
          setIsFlushing(false);
          console.error('[SignLanguage] IPC processGestures error:', err);
          setAvatarState('idle');
        });
    },
    [selectedLanguage, setAvatarState],
  );

  const processBufferRef = useRef(processBuffer);
  useEffect(() => {
    processBufferRef.current = processBuffer;
  }, [processBuffer]);

  // Buffer manager reference with configured threshold bounds
  const bufferManagerRef = useRef<SignLanguageBufferManager | null>(null);

  useEffect(() => {
    const manager = new SignLanguageBufferManager(
      {
        minConfidence: 0.6,
        cooldownMs: 1000,
        idleFlushTimeoutMs: 3000,
        maxBufferSize: 50,
      },
      {
        onBufferChange: (signs) => {
          setRawSigns(signs);
        },
        onTimerStateChange: (active) => {
          setIsAutoFlushActive(active);
        },
        onFlush: (signs, reason) => {
          console.log(`[SignLanguage] onFlush triggered (${reason}):`, signs);
          processBufferRef.current(signs);
        },
      },
    );
    bufferManagerRef.current = manager;

    return () => {
      manager.destroy();
    };
  }, []);

  // Manual fallback controls
  const handleClearBuffer = () => {
    bufferManagerRef.current?.clear();
    setLastDetectedSign(null);
  };

  const handleManualFlush = () => {
    bufferManagerRef.current?.flush('manual');
  };

  // Load MediaPipe GestureRecognizer
  useEffect(() => {
    const loadRecognizer = async () => {
      try {
        const vision = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm',
        );
        const gestureRecognizer = await GestureRecognizer.createFromOptions(
          vision,
          {
            baseOptions: {
              modelAssetPath: '/models/custom_gestures.task',
              delegate: 'GPU',
            },
            runningMode: 'VIDEO',
            numHands: 2,
          },
        );
        setRecognizer(gestureRecognizer);
      } catch (err) {
        console.warn(
          'Failed to load custom_gestures.task, falling back to standard gesture_recognizer.task:',
          err,
        );
        // Fallback to standard model if custom_gestures.task is missing
        try {
          const vision = await FilesetResolver.forVisionTasks(
            'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm',
          );
          const fallbackRecognizer = await GestureRecognizer.createFromOptions(
            vision,
            {
              baseOptions: {
                modelAssetPath:
                  'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task',
                delegate: 'GPU',
              },
              runningMode: 'VIDEO',
              numHands: 2,
            },
          );
          setRecognizer(fallbackRecognizer);
        } catch (e) {
          console.error('Failed to load fallback GestureRecognizer:', e);
        }
      }
    };
    loadRecognizer();
  }, []);

  // Webcam Setup
  useEffect(() => {
    if (!videoRef.current) return;
    navigator.mediaDevices
      .getUserMedia({ video: true })
      .then((stream) => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          setIsWebcamRunning(true);
        }
      })
      .catch((err) => console.error('Error accessing webcam:', err));

    return () => {
      if (videoRef.current?.srcObject) {
        const stream = videoRef.current.srcObject as MediaStream;
        stream.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  // Inference Loop: evaluates synchronously against bufferManager (no async React state in loop)
  useEffect(() => {
    let animationFrameId: number;
    let lastVideoTime = -1;

    const renderLoop = async () => {
      if (!isWebcamRunning || !videoRef.current || !recognizer) {
        animationFrameId = requestAnimationFrame(renderLoop);
        return;
      }

      const video = videoRef.current;
      if (video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;

        try {
          const result = recognizer.recognizeForVideo(video, Date.now());

          if (result.gestures && result.gestures.length > 0) {
            const topGesture = result.gestures[0][0]; // Single hand priority
            if (topGesture && topGesture.categoryName) {
              const categoryName = topGesture.categoryName;
              const dbMap = gestureDb as Record<string, string>;
              const translatedWord = dbMap[categoryName] || categoryName;

              const res = bufferManagerRef.current?.processGesture(
                topGesture,
                translatedWord,
                Date.now(),
              );

              if (res && res.action === 'accepted') {
                setLastDetectedSign(res.word || null);
              }
            }
          }
        } catch (err) {
          // Ignore temporary frame errors
        }
      }
      animationFrameId = requestAnimationFrame(renderLoop);
    };

    renderLoop();
    return () => cancelAnimationFrame(animationFrameId);
  }, [isWebcamRunning, recognizer]);

  return (
    <div
      style={{
        padding: '20px',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        boxSizing: 'border-box',
        background: '#0B0F19',
        color: 'white',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '16px',
        }}
      >
        <h2 style={{ fontSize: '20px', fontWeight: 600, margin: 0 }}>
          Sign Language Translation
        </h2>
        {/* Status Indicators */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {isFlushing ? (
            <span
              style={{
                fontSize: '12px',
                background: '#eab30822',
                color: '#facc15',
                border: '1px solid #eab30844',
                padding: '4px 10px',
                borderRadius: '12px',
              }}
            >
              AI Processing...
            </span>
          ) : isAutoFlushActive ? (
            <span
              style={{
                fontSize: '12px',
                background: '#10b98122',
                color: '#34d399',
                border: '1px solid #10b98144',
                padding: '4px 10px',
                borderRadius: '12px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              <span
                style={{
                  width: '6px',
                  height: '6px',
                  borderRadius: '50%',
                  background: '#34d399',
                  display: 'inline-block',
                }}
              />
              Auto-flush active (3s idle)
            </span>
          ) : (
            <span
              style={{
                fontSize: '12px',
                background: '#33415544',
                color: '#94a3b8',
                border: '1px solid #33415588',
                padding: '4px 10px',
                borderRadius: '12px',
              }}
            >
              Idle
            </span>
          )}
        </div>
      </div>

      <div
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: '640px',
          borderRadius: '12px',
          overflow: 'hidden',
          background: '#000',
          marginBottom: '20px',
        }}
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          style={{
            width: '100%',
            height: 'auto',
            display: 'block',
            transform: 'scaleX(-1)',
          }}
        />
        {!recognizer && (
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              color: '#fff',
            }}
          >
            Loading AI Model...
          </div>
        )}
        {lastDetectedSign && (
          <div
            style={{
              position: 'absolute',
              bottom: '12px',
              left: '12px',
              background: 'rgba(0, 0, 0, 0.75)',
              backdropFilter: 'blur(4px)',
              padding: '4px 12px',
              borderRadius: '6px',
              fontSize: '13px',
              color: '#38bdf8',
              border: '1px solid #0284c7',
            }}
          >
            Detected: <strong>{lastDetectedSign}</strong>
          </div>
        )}
      </div>

      <div
        style={{
          background: '#131B2C',
          padding: '16px',
          borderRadius: '8px',
          border: '1px solid #1e293b',
          minHeight: '110px',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '8px',
          }}
        >
          <h3
            style={{
              fontSize: '14px',
              color: '#94a3b8',
              margin: 0,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            Live Translation Buffer ({rawSigns.length})
          </h3>
          {rawSigns.length > 0 && (
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={handleManualFlush}
                style={{
                  background: '#2563eb',
                  color: '#fff',
                  border: 'none',
                  padding: '4px 10px',
                  borderRadius: '6px',
                  fontSize: '12px',
                  cursor: 'pointer',
                }}
              >
                Send Now
              </button>
              <button
                onClick={handleClearBuffer}
                style={{
                  background: '#334155',
                  color: '#cbd5e1',
                  border: 'none',
                  padding: '4px 10px',
                  borderRadius: '6px',
                  fontSize: '12px',
                  cursor: 'pointer',
                }}
              >
                Clear
              </button>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
          {rawSigns.length === 0 ? (
            <span style={{ color: '#475569', fontStyle: 'italic' }}>
              Waiting for gestures...
            </span>
          ) : (
            rawSigns.map((sign, idx) => (
              <span
                key={idx}
                style={{
                  background: '#3b82f6',
                  color: '#fff',
                  padding: '6px 12px',
                  borderRadius: '16px',
                  fontSize: '14px',
                }}
              >
                {sign}
              </span>
            ))
          )}
        </div>
      </div>

      <p style={{ marginTop: '12px', fontSize: '12px', color: '#64748b' }}>
        Buffer flushes automatically after <b>3 seconds</b> of inactivity, or
        sign <b>"stop"</b> / <b>"end"</b> to send immediately.
      </p>
    </div>
  );
}
