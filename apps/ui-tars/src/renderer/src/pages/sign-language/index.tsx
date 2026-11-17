import { useEffect, useRef, useState } from 'react';
import { GestureRecognizer } from '@mediapipe/tasks-vision';
import { AlertTriangle, RefreshCw, CheckCircle, Cpu } from 'lucide-react';
import gestureDb from '../../const/gesture_db.json';
import { useVoiceStore } from '../../store/voiceStore';
import {
  resolveVisionWasmFileset,
  createGestureRecognizerWithFallback,
} from '../../utils/visionLoader';

export default function SignLanguagePage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [recognizer, setRecognizer] = useState<GestureRecognizer | null>(null);
  const [modelState, setModelState] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [engineSource, setEngineSource] = useState<'local' | 'cdn' | null>(
    null,
  );
  const [engineDelegate, setEngineDelegate] = useState<'GPU' | 'CPU' | null>(
    null,
  );
  const [retryKey, setRetryKey] = useState<number>(0);

  const [isWebcamRunning, setIsWebcamRunning] = useState(false);
  const [rawSigns, setRawSigns] = useState<string[]>([]);
  const [lastProcessedTime, setLastProcessedTime] = useState<number>(0);

  const rawSignsRef = useRef<string[]>([]);
  const { selectedLanguage, setAvatarState } = useVoiceStore();

  const processBuffer = (signsToProcess: string[]) => {
    if (signsToProcess.length === 0) return;
    setAvatarState('thinking');

    window.electron.ipcRenderer
      .invoke('voiceRoute.processGestures', {
        rawSigns: signsToProcess,
        language: selectedLanguage,
        runInBackground: false,
      })
      .then((response: any) => {
        if (response.success) {
          console.log('[SignLanguage] Gesture processing complete:', response);
        } else {
          console.error(
            '[SignLanguage] Gesture processing failed:',
            response.error,
          );
          setAvatarState('idle');
        }
      })
      .catch((err) => {
        console.error('[SignLanguage] IPC processGestures error:', err);
        setAvatarState('idle');
      });
  };

  // Load MediaPipe GestureRecognizer with offline bundle and fallback
  useEffect(() => {
    let active = true;
    setModelState('loading');
    setErrorMessage(null);

    const loadRecognizer = async () => {
      try {
        console.info('[SignLanguage] Loading MediaPipe vision fileset...');
        const { fileset, source } = await resolveVisionWasmFileset((msg) =>
          console.info('[SignLanguage]', msg),
        );

        if (!active) return;
        setEngineSource(source);

        const { recognizer: rec, delegate } =
          await createGestureRecognizerWithFallback(
            fileset,
            '/models/custom_gestures.task',
            (msg) => console.info('[SignLanguage]', msg),
          );

        if (!active) {
          rec.close();
          return;
        }

        setRecognizer(rec);
        setEngineDelegate(delegate);
        setModelState('ready');
        console.info(
          `[SignLanguage] GestureRecognizer ready (${source === 'local' ? 'Local Bundle' : 'CDN'}, ${delegate} delegate).`,
        );
      } catch (err: any) {
        if (!active) return;
        console.error('[SignLanguage] Failed to load GestureRecognizer:', err);
        setModelState('error');
        setErrorMessage(
          err?.message || 'Failed to initialize gesture recognition engine',
        );
      }
    };

    loadRecognizer();

    return () => {
      active = false;
      recognizer?.close();
    };
  }, [retryKey]);

  // Sync ref with state
  useEffect(() => {
    rawSignsRef.current = rawSigns;
  }, [rawSigns]);

  // Webcam Setup
  useEffect(() => {
    if (!videoRef.current) return;
    let stream: MediaStream | null = null;

    navigator.mediaDevices
      .getUserMedia({ video: true })
      .then((mediaStream) => {
        stream = mediaStream;
        if (videoRef.current) {
          videoRef.current.srcObject = mediaStream;
          setIsWebcamRunning(true);
        }
      })
      .catch((err) =>
        console.error('[SignLanguage] Error accessing webcam:', err),
      );

    return () => {
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
      if (videoRef.current?.srcObject) {
        (videoRef.current.srcObject as MediaStream)
          .getTracks()
          .forEach((track) => track.stop());
        videoRef.current.srcObject = null;
      }
    };
  }, []);

  // Inference Loop
  useEffect(() => {
    let animationFrameId: number;
    let lastVideoTime = -1;

    const renderLoop = async () => {
      if (!isWebcamRunning || !videoRef.current || !recognizer) {
        animationFrameId = requestAnimationFrame(renderLoop);
        return;
      }

      const video = videoRef.current;
      if (video.currentTime !== lastVideoTime && video.readyState >= 2) {
        lastVideoTime = video.currentTime;

        try {
          const result = recognizer.recognizeForVideo(video, Date.now());

          if (result.gestures && result.gestures.length > 0) {
            const topGesture = result.gestures[0][0]; // Single hand priority
            // Threshold bounds validation: score must exceed 0.6 confidence bound
            if (topGesture && topGesture.score > 0.6) {
              const categoryName = topGesture.categoryName;
              const dbMap = gestureDb as Record<string, string>;
              const translatedWord = dbMap[categoryName] || categoryName;

              // Ignore "None"
              if (translatedWord.toLowerCase() !== 'none') {
                const now = Date.now();
                // Cooldown threshold: 1 second per unique sign to avoid spurious spam
                if (now - lastProcessedTime > 1000) {
                  const lowerWord = translatedWord.toLowerCase();

                  if (
                    lowerWord === 'stop' ||
                    lowerWord === 'end' ||
                    lowerWord === 'end_sign'
                  ) {
                    // TRIGGER AI PROCESSING
                    processBuffer([...rawSignsRef.current]);
                    setRawSigns([]);
                  } else {
                    setRawSigns((prev) => {
                      // Prevent immediate duplicate
                      if (
                        prev.length > 0 &&
                        prev[prev.length - 1] === translatedWord
                      )
                        return prev;
                      return [...prev, translatedWord];
                    });
                  }
                  setLastProcessedTime(now);
                }
              }
            }
          }
        } catch {
          // Ignore temporary frame errors
        }
      }
      animationFrameId = requestAnimationFrame(renderLoop);
    };

    renderLoop();
    return () => cancelAnimationFrame(animationFrameId);
  }, [
    isWebcamRunning,
    recognizer,
    lastProcessedTime,
    selectedLanguage,
    setAvatarState,
  ]);

  const handleRetry = () => {
    setModelState('loading');
    setErrorMessage(null);
    setRetryKey((k) => k + 1);
  };

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

        {/* Engine status indicator */}
        {modelState === 'ready' && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '4px 10px',
              borderRadius: '6px',
              background: 'rgba(30, 41, 59, 0.8)',
              fontSize: '12px',
              color: '#94a3b8',
            }}
          >
            <CheckCircle size={14} style={{ color: '#4ade80' }} />
            <span>AI Recognizer Ready</span>
            <span
              style={{
                color: '#38bdf8',
                display: 'flex',
                alignItems: 'center',
                gap: '3px',
              }}
            >
              <Cpu size={12} />
              {engineSource === 'local' ? 'Local WASM' : 'CDN WASM'} •{' '}
              {engineDelegate || 'GPU'}
            </span>
          </div>
        )}
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

        {modelState === 'loading' && (
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              color: '#94a3b8',
              textAlign: 'center',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            <RefreshCw
              size={24}
              className="animate-spin"
              style={{ color: '#3b82f6' }}
            />
            <span>Loading AI Model (Offline Bundle)...</span>
          </div>
        )}

        {modelState === 'error' && (
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              color: '#ef4444',
              textAlign: 'center',
              padding: '16px',
              background: 'rgba(15, 23, 42, 0.9)',
              borderRadius: '8px',
              border: '1px solid rgba(239, 68, 68, 0.4)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '8px',
              maxWidth: '80%',
            }}
          >
            <AlertTriangle size={24} />
            <span style={{ fontSize: '12px' }}>
              {errorMessage || 'Failed to load AI model'}
            </span>
            <button
              type="button"
              onClick={handleRetry}
              style={{
                marginTop: '4px',
                padding: '6px 14px',
                background: '#2563eb',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
                fontSize: '12px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              <RefreshCw size={12} /> Retry Initialization
            </button>
          </div>
        )}
      </div>

      <div
        style={{
          background: '#131B2C',
          padding: '16px',
          borderRadius: '8px',
          border: '1px solid #1e293b',
          minHeight: '100px',
        }}
      >
        <h3
          style={{
            fontSize: '14px',
            color: '#94a3b8',
            marginBottom: '8px',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          Live Translation Buffer
        </h3>
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
        Sign the special gesture <b>"stop"</b> or <b>"end"</b> to send the
        buffered sentence to the AI Brain.
      </p>
    </div>
  );
}
