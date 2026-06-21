import React, { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Video, VideoOff, AlertTriangle } from 'lucide-react';
import { FilesetResolver, HandLandmarker, FaceLandmarker, DrawingUtils } from '@mediapipe/tasks-vision';
import './VoiceAvatar.css';

export function VisionWakePanel({ autoStart = false, testGestures = null }: { autoStart?: boolean, testGestures?: any[] | null }) {
  const [isVisionEnabled, setIsVisionEnabled] = useState(autoStart);
  const [isPreviewEnabled, setIsPreviewEnabled] = useState(autoStart);
  const [lowLightWarning, setLowLightWarning] = useState(false);
  const [engineReady, setEngineReady] = useState(false);
  const [errorState, setErrorState] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const handLandmarkerRef = useRef<HandLandmarker | null>(null);
  const faceLandmarkerRef = useRef<FaceLandmarker | null>(null);
  const animationRef = useRef<number>();
  const lastVideoTimeRef = useRef<number>(-1);
  const lastWakeTimeRef = useRef<number>(0);
  const configuredGesturesRef = useRef<any[]>([]);
  const testGesturesRef = useRef<any[] | null>(null);

  useEffect(() => {
    testGesturesRef.current = testGestures;
  }, [testGestures]);

  // Initialize MediaPipe Models
  useEffect(() => {
    let active = true;
    const initModels = async () => {
      try {
        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm"
        );
        
        if (!active) return;

        const handLandmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: `/models/hand_landmarker.task`,
            delegate: "GPU"
          },
          runningMode: "VIDEO",
          numHands: 2,
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5
        });

        const faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: `/models/face_landmarker.task`,
            delegate: "GPU"
          },
          runningMode: "VIDEO",
          numFaces: 1,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: true,
          minFaceDetectionConfidence: 0.5,
          minFacePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5
        });

        if (!active) {
          handLandmarker.close();
          faceLandmarker.close();
          return;
        }

        handLandmarkerRef.current = handLandmarker;
        faceLandmarkerRef.current = faceLandmarker;
        setEngineReady(true);
        setErrorState(null);
      } catch (error: any) {
        console.error("Failed to load MediaPipe models:", error);
        setErrorState("AI Model Error: " + error.message);
      }
    };
    
    initModels();
    
    return () => {
      active = false;
      handLandmarkerRef.current?.close();
      faceLandmarkerRef.current?.close();
    };
  }, []);

  // Load configured gestures
  useEffect(() => {
    const loadGestures = () => {
      window.electron?.ipcRenderer?.invoke('gesture:load').then((loaded: any[]) => {
        if (loaded && loaded.length > 0) configuredGesturesRef.current = loaded;
      }).catch(console.error);
    };
    
    loadGestures();

    const unsubscribe = window.electron?.ipcRenderer?.on('gesture:updated', loadGestures);
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
          video: true
        });
        if (!active || !videoRef.current) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }
        videoRef.current.srcObject = stream;
        videoRef.current.onloadedmetadata = () => {
          videoRef.current?.play().catch(err => console.error("Video play failed:", err));
        };
        
        // Start Render Loop
        const renderLoop = () => {
          if (!active || !videoRef.current || !canvasRef.current || !handLandmarkerRef.current || !faceLandmarkerRef.current) return;
          
          const video = videoRef.current;
          const canvas = canvasRef.current;
          const ctx = canvas.getContext('2d');
          
          if (video.currentTime !== lastVideoTimeRef.current && video.readyState >= 2 && ctx) {
            lastVideoTimeRef.current = video.currentTime;
            
            // Detect
            const handResults = handLandmarkerRef.current.detectForVideo(video, performance.now());
            const faceResults = faceLandmarkerRef.current.detectForVideo(video, performance.now());
            
            // Check brightness roughly
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            let sum = 0;
            for (let i = 0; i < imgData.length; i += 4 * 100) {
              sum += (imgData[i] + imgData[i+1] + imgData[i+2]) / 3;
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

            // Process Hands
            if (handResults.landmarks) {
              for (const landmarks of handResults.landmarks) {
                const drawingUtils = new DrawingUtils(ctx);
                drawingUtils.drawConnectors(landmarks, HandLandmarker.HAND_CONNECTIONS, { color: '#00FF00', lineWidth: 2 });
                
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

                // Compute Finger States (Improved heuristics)
                const dist = (p1: any, p2: any) => Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));
                
                // For fingers: Tip should be further from wrist (0) than PIP (second joint)
                const isFingerOpen = (tipIdx: number, pipIdx: number) => dist(landmarks[tipIdx], landmarks[0]) > dist(landmarks[pipIdx], landmarks[0]);
                
                // For thumb: Tip (4) should be further from Pinky MCP (17) than the Thumb IP (3) is from Pinky MCP (17)
                const isThumbOpen = dist(landmarks[4], landmarks[17]) > dist(landmarks[3], landmarks[17]);
                
                const currentState = {
                  thumb: isThumbOpen ? 'open' : 'closed',
                  index: isFingerOpen(8, 6) ? 'open' : 'closed',
                  middle: isFingerOpen(12, 10) ? 'open' : 'closed',
                  ring: isFingerOpen(16, 14) ? 'open' : 'closed',
                  pinky: isFingerOpen(20, 18) ? 'open' : 'closed'
                };

                // Emit raw state so Gestures page can capture it
                window.dispatchEvent(new CustomEvent('vision:raw-hand-state', { detail: currentState }));

                // Match against configured gestures
                const gesturesToUse = testGesturesRef.current || configuredGesturesRef.current;
                if (gesturesToUse && gesturesToUse.length > 0) {
                  for (const g of gesturesToUse) {
                    const match = ['thumb', 'index', 'middle', 'ring', 'pinky'].every(finger => {
                      const req = g.fingers[finger];
                      return req === 'any' || req === currentState[finger as keyof typeof currentState];
                    });
                    if (match) {
                      detectedGesture = g;
                      break;
                    }
                  }
                }

                // Fallback L-shape wake (if no config matched but matches L-shape roughly)
                const thumbTip = landmarks[4];
                const indexTip = landmarks[8];
                const middleTip = landmarks[12];
                if (!detectedGesture && indexTip.y < middleTip.y - 0.1 && Math.abs(thumbTip.y - indexTip.y) > 0.1) {
                   shouldWake = true;
                }
              }
            }

            // Process Face
            if (faceResults.faceBlendshapes && faceResults.faceBlendshapes.length > 0) {
              const blendshapes = faceResults.faceBlendshapes[0].categories;
              
              const blinkLeft = blendshapes.find(b => b.categoryName === 'eyeBlinkLeft')?.score || 0;
              const blinkRight = blendshapes.find(b => b.categoryName === 'eyeBlinkRight')?.score || 0;
              
              if (blinkLeft > 0.6 && blinkRight > 0.6) {
                shouldWake = true;
              }

              if (faceResults.facialTransformationMatrixes && faceResults.facialTransformationMatrixes.length > 0) {
                const matrix = faceResults.facialTransformationMatrixes[0].data;
                const pitch = Math.asin(-matrix[6]); 
                if (pitch > 0.4) {
                  shouldWake = true;
                }
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

            if ((shouldWake || detectedGesture) && (Date.now() - lastWakeTimeRef.current > 3000)) {
               lastWakeTimeRef.current = Date.now();
               
               if (detectedGesture) {
                 window.dispatchEvent(new CustomEvent('vision:gesture-triggered', { detail: detectedGesture }));
               } else {
                 window.dispatchEvent(new CustomEvent('vision:wake-triggered'));
               }
               
               if (canvasRef.current) {
                 canvasRef.current.style.boxShadow = '0 0 20px #4ade80';
                 setTimeout(() => {
                   if (canvasRef.current) canvasRef.current.style.boxShadow = 'none';
                 }, 1000);
               }
            }
          }
          
          animationRef.current = requestAnimationFrame(renderLoop);
        };
        
        renderLoop();
        
      } catch (err: any) {
        console.error("Camera access failed", err);
        setErrorState("Camera Error: " + err.message);
      }
    };
    
    startCamera();
    
    return () => {
      active = false;
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      if (stream) stream.getTracks().forEach(t => t.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [isVisionEnabled, engineReady, isPreviewEnabled]);

  return (
    <div className="vision-panel glass-panel" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px', background: 'rgba(15, 23, 42, 0.8)', backdropFilter: 'blur(12px)', borderRadius: '12px', color: 'white', width: '320px', pointerEvents: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
          {isVisionEnabled ? <Eye size={16} style={{ color: '#4ade80' }} /> : <EyeOff size={16} style={{ color: '#94a3b8' }} />}
          Visual Wake Modality
        </h3>
        <label className="vision-switch">
          <input type="checkbox" checked={isVisionEnabled} onChange={e => setIsVisionEnabled(e.target.checked)} />
          <span className="vision-slider"></span>
        </label>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', opacity: isVisionEnabled ? 1 : 0.5 }}>
        <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
          {isPreviewEnabled ? <Video size={16} style={{ color: '#60a5fa' }} /> : <VideoOff size={16} style={{ color: '#94a3b8' }} />}
          Live Mirror Preview
        </h3>
        <label className="vision-switch">
          <input type="checkbox" disabled={!isVisionEnabled} checked={isPreviewEnabled} onChange={e => setIsPreviewEnabled(e.target.checked)} />
          <span className="vision-slider"></span>
        </label>
      </div>

      {lowLightWarning && isVisionEnabled && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px', background: 'rgba(239, 68, 68, 0.2)', color: '#fca5a5', borderRadius: '6px', fontSize: '12px' }}>
          <AlertTriangle size={14} />
          Low light detected! Gaze tracking may be inaccurate.
        </div>
      )}

      <video ref={videoRef} playsInline autoPlay style={{ display: 'none' }} />

      {isVisionEnabled && (
        <div style={{ position: 'relative', width: '100%', height: '200px', background: '#000', borderRadius: '8px', overflow: 'hidden', transition: 'box-shadow 0.3s' }} ref={(node) => { if(node && canvasRef.current) canvasRef.current.style.boxShadow = node.style.boxShadow }}>
          {errorState ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#ef4444', fontSize: '12px', textAlign: 'center', padding: '16px' }}>
              {errorState}
            </div>
          ) : engineReady ? (
            <canvas
              ref={canvasRef}
              width={320}
              height={240}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#94a3b8', fontSize: '12px', textAlign: 'center', padding: '16px' }}>
              Warming up AI engine...
            </div>
          )}
        </div>
      )}
    </div>
  );
}
