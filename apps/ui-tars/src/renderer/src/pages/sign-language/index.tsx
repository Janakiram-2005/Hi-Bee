import React, { useEffect, useRef, useState } from 'react';
import { FilesetResolver, GestureRecognizer } from '@mediapipe/tasks-vision';
import gestureDb from '../../const/gesture_db.json';
import { useVoiceStore } from '../../store/voiceStore';

export default function SignLanguagePage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [recognizer, setRecognizer] = useState<GestureRecognizer | null>(null);
  const [isWebcamRunning, setIsWebcamRunning] = useState(false);
  const [rawSigns, setRawSigns] = useState<string[]>([]);
  const [lastProcessedTime, setLastProcessedTime] = useState<number>(0);
  
  const rawSignsRef = useRef<string[]>([]);
  const { selectedLanguage, setAvatarState } = useVoiceStore();

  const processBuffer = (signsToProcess: string[]) => {
    if (signsToProcess.length === 0) return;
    setAvatarState('thinking');
    
    window.electron.ipcRenderer.invoke('voiceRoute.processGestures', {
      rawSigns: signsToProcess,
      language: selectedLanguage,
      runInBackground: false,
    }).then((response: any) => {
      if (response.success) {
          console.log('Gesture processing complete:', response);
      } else {
          console.error('Gesture processing failed:', response.error);
          setAvatarState('idle');
      }
    }).catch((err) => {
      console.error('IPC processGestures error:', err);
      setAvatarState('idle');
    });
  };

  // Load MediaPipe GestureRecognizer
  useEffect(() => {
    const loadRecognizer = async () => {
      try {
        const vision = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm'
        );
        const gestureRecognizer = await GestureRecognizer.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: '/models/custom_gestures.task',
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          numHands: 2,
        });
        setRecognizer(gestureRecognizer);
      } catch (err) {
        console.warn('Failed to load custom_gestures.task, falling back to standard gesture_recognizer.task:', err);
        // Fallback to standard model if custom_gestures.task is missing
        try {
            const vision = await FilesetResolver.forVisionTasks(
                'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm'
            );
            const fallbackRecognizer = await GestureRecognizer.createFromOptions(vision, {
                baseOptions: {
                    modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task',
                    delegate: 'GPU',
                },
                runningMode: 'VIDEO',
                numHands: 2,
            });
            setRecognizer(fallbackRecognizer);
        } catch (e) {
            console.error('Failed to load fallback GestureRecognizer:', e);
        }
      }
    };
    loadRecognizer();
  }, []);

  // Sync ref with state
  useEffect(() => {
    rawSignsRef.current = rawSigns;
  }, [rawSigns]);

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
      if (video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        
        try {
            const result = recognizer.recognizeForVideo(video, Date.now());

            if (result.gestures && result.gestures.length > 0) {
            const topGesture = result.gestures[0][0]; // Assuming single hand priority for now
            if (topGesture && topGesture.score > 0.6) {
                const categoryName = topGesture.categoryName;
                const dbMap = gestureDb as Record<string, string>;
                const translatedWord = dbMap[categoryName] || categoryName;

                // Ignore "None"
                if (translatedWord.toLowerCase() !== 'none') {
                  const now = Date.now();
                  // Cooldown: 1 second per unique sign to avoid spam
                  if (now - lastProcessedTime > 1000) {
                      const lowerWord = translatedWord.toLowerCase();
                      
                      if (lowerWord === 'stop' || lowerWord === 'end' || lowerWord === 'end_sign') {
                        // TRIGGER AI PROCESSING
                        processBuffer([...rawSignsRef.current]);
                        setRawSigns([]);
                      } else {
                        setRawSigns((prev) => {
                          // Prevent immediate duplicate
                          if (prev.length > 0 && prev[prev.length - 1] === translatedWord) return prev;
                          return [...prev, translatedWord];
                        });
                      }
                      setLastProcessedTime(now);
                  }
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
  }, [isWebcamRunning, recognizer, lastProcessedTime, selectedLanguage, setAvatarState]);

  // Removed inactivity timeout interval as requested

  return (
    <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', height: '100%', boxSizing: 'border-box', background: '#0B0F19', color: 'white' }}>
      <h2 style={{ fontSize: '20px', fontWeight: 600, marginBottom: '16px' }}>
        Sign Language Translation
      </h2>

      <div style={{ position: 'relative', width: '100%', maxWidth: '640px', borderRadius: '12px', overflow: 'hidden', background: '#000', marginBottom: '20px' }}>
        <video
          ref={videoRef}
          autoPlay
          playsInline
          style={{ width: '100%', height: 'auto', display: 'block', transform: 'scaleX(-1)' }}
        />
        {!recognizer && (
            <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', color: '#fff' }}>
                Loading AI Model...
            </div>
        )}
      </div>

      <div style={{ background: '#131B2C', padding: '16px', borderRadius: '8px', border: '1px solid #1e293b', minHeight: '100px' }}>
        <h3 style={{ fontSize: '14px', color: '#94a3b8', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Live Translation Buffer
        </h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
          {rawSigns.length === 0 ? (
            <span style={{ color: '#475569', fontStyle: 'italic' }}>Waiting for gestures...</span>
          ) : (
            rawSigns.map((sign, idx) => (
              <span key={idx} style={{ background: '#3b82f6', color: '#fff', padding: '6px 12px', borderRadius: '16px', fontSize: '14px' }}>
                {sign}
              </span>
            ))
          )}
        </div>
      </div>
      
      <p style={{ marginTop: '12px', fontSize: '12px', color: '#64748b' }}>
        Sign the special gesture <b>"stop"</b> or <b>"end"</b> to send the buffered sentence to the AI Brain.
      </p>
    </div>
  );
}
