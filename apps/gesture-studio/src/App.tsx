import { useEffect, useRef, useState } from 'react';
import './App.css';

import { FilesetResolver, HandLandmarker, DrawingUtils } from '@mediapipe/tasks-vision';
import { Camera, ArrowLeft, Trash2, Mic, Activity, Radio, Sparkles } from 'lucide-react';

function App() {
  const [appMode, setAppMode] = useState<'studio' | 'translator'>('studio');

  // Studio State
  const [label, setLabel] = useState('');
  const [status, setStatus] = useState('Idle');
  const [wordsLibrary, setWordsLibrary] = useState<{ label: string, videos: string[] }[]>([]);
  const [recordedData, setRecordedData] = useState<{ base64: string, blobUrl: string, landmarks: any[] } | null>(null);
  const [isTraining, setIsTraining] = useState(false);
  const [wordModelJson, setWordModelJson] = useState<any>(null);

  // Translator State
  const [translatorActive, setTranslatorActive] = useState(false);
  const [translationLog, setTranslationLog] = useState<{ time: string, text: string }[]>([]);
  const [currentStatus, setCurrentStatus] = useState('Not Recognized');

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const landmarkerRef = useRef<any>(null);
  const landmarksTimelineRef = useRef<any[]>([]);
  const rollingTimelineRef = useRef<any[]>([]);
  const lastRecognizedRef = useRef<{ label: string, time: number }>({ label: '', time: 0 });
  const sentenceWordsRef = useRef<string[]>([]);
  const lastPalmTimeRef = useRef<number>(0);

  useEffect(() => {
    fetchLibrary();
    fetchModel();
    initMediaPipe();
  }, []);

  const fetchModel = async () => {
    try {
      const res = await fetch('http://localhost:3001/api/word-model');
      const data = await res.json();
      if (data.success && data.model) setWordModelJson(data.model);
    } catch (e) {
      console.error(e);
    }
  };

  const fetchLibrary = async () => {
    try {
      const res = await fetch('http://localhost:3001/api/words-library');
      const data = await res.json();
      if (data.success) {
        setWordsLibrary(data.library);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const initMediaPipe = async () => {
    try {
      const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
      );
      const handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
          delegate: "GPU"
        },
        numHands: 2,
        runningMode: "VIDEO"
      });
      landmarkerRef.current = handLandmarker;
      console.log('MediaPipe loaded');
    } catch (e) {
      console.error('Failed to load MediaPipe', e);
    }
  };

  const extractFeaturesJS = (timelineData: any[]) => {
    const handStates = timelineData.filter(item => item.type === 'hand' && item.data).map(item => item.data);
    const features: number[] = [];
    if (handStates.length > 0) {
        const avgLandmarks: any[] = [];
        for (let i = 0; i < 21; i++) {
            let sumX = 0, sumY = 0, sumZ = 0;
            let count = 0;
            for (const frame of handStates) {
                if (frame && frame.length === 21) {
                    sumX += frame[i].x; sumY += frame[i].y; sumZ += frame[i].z;
                    count++;
                }
            }
            if (count > 0) {
                avgLandmarks.push({ x: sumX/count, y: sumY/count, z: sumZ/count });
            } else {
                avgLandmarks.push({ x: 0, y: 0, z: 0 });
            }
        }
        
        if (avgLandmarks.length === 21 && avgLandmarks.some(lm => lm.x !== 0)) {
            const dists: number[] = [];
            for (let i = 0; i < 21; i++) {
                for (let j = i + 1; j < 21; j++) {
                    const dx = avgLandmarks[i].x - avgLandmarks[j].x;
                    const dy = avgLandmarks[i].y - avgLandmarks[j].y;
                    const dz = avgLandmarks[i].z - avgLandmarks[j].z;
                    dists.push(Math.sqrt(dx*dx + dy*dy + dz*dz));
                }
            }
            const maxDist = Math.max(...dists, 1.0);
            for (const d of dists) {
                features.push(d / maxDist);
            }
        } else {
            for(let i=0; i<210; i++) features.push(0.0);
        }
    } else {
        for(let i=0; i<210; i++) features.push(0.0);
    }
    return features;
  };

  const predictRF = (features: number[], model: any) => {
    if (!model || !model.trees || features.every(f => f === 0.0)) return { prediction: 'none', confidence: 0.0 };
    
    const classVotes = new Array(model.classes.length).fill(0);
    
    for (const tree of model.trees) {
        let node = 0;
        // -1 indicates a leaf node in scikit-learn trees
        while (tree.children_left[node] !== -1 && tree.children_left[node] !== tree.children_right[node]) {
            if (features[tree.feature[node]] <= tree.threshold[node]) {
                node = tree.children_left[node];
            } else {
                node = tree.children_right[node];
            }
        }
        const values = tree.value[node][0];
        let maxIdx = 0;
        for (let i = 1; i < values.length; i++) {
            if (values[i] > values[maxIdx]) maxIdx = i;
        }
        classVotes[maxIdx]++;
    }
    
    let bestClassIdx = 0;
    for (let i = 1; i < classVotes.length; i++) {
        if (classVotes[i] > classVotes[bestClassIdx]) bestClassIdx = i;
    }
    
    return {
        prediction: model.classes[bestClassIdx],
        confidence: classVotes[bestClassIdx] / model.trees.length
    };
  };

  const startRecording = async () => {
    if (!label.trim()) {
      alert("Please enter a gesture label!");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      
      landmarksTimelineRef.current = [];
      setStatus('Recording...');
      
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
      const chunks: BlobPart[] = [];
      
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunks, { type: 'video/webm' });
        const reader = new FileReader();
        reader.onloadend = () => {
          setRecordedData({
            base64: reader.result as string,
            blobUrl: URL.createObjectURL(blob),
            landmarks: [...landmarksTimelineRef.current]
          });
          stream.getTracks().forEach(t => t.stop());
          setStatus('Review');
        };
        reader.readAsDataURL(blob);
      };

      // Inference loop
      const detectFrame = () => {
        if (mediaRecorder.state !== 'recording' || !videoRef.current) return;
        if (landmarkerRef.current && videoRef.current.readyState >= 2) {
          const results = landmarkerRef.current.detectForVideo(videoRef.current, performance.now());
          
          let handData = null;
          if (results.landmarks && results.landmarks.length > 0) {
            handData = results.landmarks[0]; // Array of 21 {x, y, z} coordinates
          }

          landmarksTimelineRef.current.push({ type: 'hand', timestamp: Date.now(), data: handData });
        }
        requestAnimationFrame(detectFrame);
      };

      mediaRecorder.start(100);
      detectFrame();

      setTimeout(() => {
        if (mediaRecorder.state === 'recording') {
          mediaRecorder.stop();
        }
      }, 2000);

    } catch (e: any) {
      alert("Camera error: " + e.message);
      setStatus('Error');
    }
  };

  const handleSave = async () => {
    if (!recordedData) return;
    setStatus('Saving...');
    try {
      const res = await fetch(`http://localhost:3001/api/save-word`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoBase64: recordedData.base64,
          landmarksJson: JSON.stringify(recordedData.landmarks),
          label: label.trim().toLowerCase().replace(/\s+/g, '_')
        })
      });
      const data = await res.json();
      if (data.success) {
        setStatus('Saved!');
        setRecordedData(null);
        fetchLibrary();
      } else {
        alert("Failed to save: " + data.error);
        setStatus('Idle');
      }
    } catch (e) {
      alert("Network error");
      setStatus('Idle');
    }
  };

  const handleTrain = async () => {
    setIsTraining(true);
    setStatus(`Training model...`);
    try {
      const res = await fetch(`http://localhost:3001/api/train-words`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        alert("Training complete!\n" + data.output);
        fetchModel(); // Reload the new model instantly!
        setStatus('Idle');
      } else {
        alert("Training failed!\n" + data.error);
        setStatus('Idle');
      }
    } catch (e) {
      alert("Network error");
      setStatus('Idle');
    }
    setIsTraining(false);
  };

  // --- Translator Logic ---
  useEffect(() => {
    let active = translatorActive;
    let stream: MediaStream | null = null;
    let inferInterval: any = null;

    const startTranslator = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }

        let drawingUtils: any = null;

        const renderLoop = () => {
          if (!active) return;
          if (videoRef.current && landmarkerRef.current && videoRef.current.readyState >= 2) {
            const canvas = canvasRef.current;
            const ctx = canvas?.getContext('2d');
            
            if (canvas && ctx && videoRef.current) {
              canvas.width = videoRef.current.videoWidth;
              canvas.height = videoRef.current.videoHeight;
              
              if (!drawingUtils) {
                drawingUtils = new DrawingUtils(ctx);
              }

              const results = landmarkerRef.current.detectForVideo(videoRef.current, performance.now());
              
              let handData = null;
              if (results.landmarks && results.landmarks.length > 0) {
                handData = results.landmarks[0]; // Array of 21 {x, y, z} coordinates
                
                // Palm Detection Heuristic
                const isFingerOpen = (tipIdx: number, pipIdx: number) => handData[tipIdx].y < handData[pipIdx].y;
                // If the 4 main fingers are pointed straight up, consider it a Palm
                const isPalm = isFingerOpen(8, 6) && isFingerOpen(12, 10) && isFingerOpen(16, 14) && isFingerOpen(20, 18);
                
                if (isPalm && Date.now() - lastPalmTimeRef.current > 3000) {
                  const words = sentenceWordsRef.current;
                  if (words.length > 0) {
                    lastPalmTimeRef.current = Date.now();
                    console.log('[App] Palm detected! Triggering sentence parsing for:', words);
                    setTranslationLog(prev => [...prev, { time: new Date().toLocaleTimeString(), text: `[PALM] Sending: ${words.join(' ')}` }]);
                    
                    fetch('http://127.0.0.1:8765/status', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        event: 'hibee:gesture-sentence',
                        data: { words }
                      })
                    }).catch(e => console.error('Failed to send to UI-TARS:', e));
                    
                    sentenceWordsRef.current = [];
                  }
                }
              }
              
              const now = Date.now();
              rollingTimelineRef.current.push({ type: 'hand', timestamp: now, data: handData });
              rollingTimelineRef.current = rollingTimelineRef.current.filter(d => now - d.timestamp < 2000);

              ctx.clearRect(0, 0, canvas.width, canvas.height);
              ctx.save();
              if (results.landmarks) {
                for (const landmarks of results.landmarks) {
                  drawingUtils.drawConnectors(landmarks, HandLandmarker.HAND_CONNECTIONS, {
                    color: "#00FF00",
                    lineWidth: 5
                  });
                  drawingUtils.drawLandmarks(landmarks, { color: "#FF0000", lineWidth: 2 });
                }
              }
              ctx.restore();
            }
          }
          requestAnimationFrame(renderLoop);
        };
        requestAnimationFrame(renderLoop);

        // Zero-Latency Local JS Inference Loop
        inferInterval = setInterval(() => {
          if (!active || rollingTimelineRef.current.length < 10 || !wordModelJson) return;
          
          try {
            const features = extractFeaturesJS(rollingTimelineRef.current);
            const data = predictRF(features, wordModelJson);
            
            if (data.confidence >= 0.50) {
              const label = String(data.prediction);
              setCurrentStatus(`Recognized: ${label} (${(data.confidence * 100).toFixed(0)}%)`);
              
              if (label !== 'None' && label !== 'none') {
                if (label !== lastRecognizedRef.current.label || Date.now() - lastRecognizedRef.current.time > 2000) {
                  setTranslationLog(prev => [...prev, { time: new Date().toLocaleTimeString(), text: label }]);
                  sentenceWordsRef.current.push(label);
                  lastRecognizedRef.current = { label, time: Date.now() };
                }
              }
            } else {
              setCurrentStatus('Not Recognized');
            }
          } catch (e) {
            console.error("Inference interval error", e);
          }
        }, 100); // 100ms super fast interval instead of 1000ms!

      } catch (e) {
        console.error("Translator camera error", e);
      }
    };

    if (translatorActive) {
      startTranslator();
    }

    return () => {
      active = false;
      if (stream) stream.getTracks().forEach(t => t.stop());
      if (inferInterval) clearInterval(inferInterval);
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [translatorActive]);

  if (appMode === 'translator') {
    return (
      <div style={{ position: 'relative', width: '100vw', height: '100vh', background: '#020617', color: 'white', overflow: 'hidden', fontFamily: "'Inter', sans-serif" }}>
        
        {/* Animated Grid Background */}
        <div style={{ position: 'absolute', inset: 0, backgroundImage: 'linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)', backgroundSize: '40px 40px', animation: 'gridPan 15s linear infinite', pointerEvents: 'none', zIndex: 0 }}></div>

        {/* FULLSCREEN Video & Canvas */}
        <div style={{ position: 'absolute', inset: 0, zIndex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {/* If camera is OFF, show a beautiful standby orb */}
            {!translatorActive && (
              <div style={{ position: 'absolute', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', zIndex: 5 }}>
                 <div style={{ width: '150px', height: '150px', background: 'radial-gradient(circle, #3b82f6, #1e3a8a)', borderRadius: '50%', boxShadow: '0 0 50px #3b82f6, inset 0 0 30px #93c5fd', animation: 'pulseGlow 3s infinite', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '40px' }}>
                    <Camera size={64} color="white" strokeWidth={1.5} />
                 </div>
              </div>
            )}

            {/* Video Feed */}
            <video 
              ref={videoRef} 
              autoPlay 
              playsInline 
              style={{ position: 'absolute', width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)', opacity: translatorActive ? 1 : 0, transition: 'opacity 1s', filter: 'contrast(1.1) brightness(1.1)' }} 
            />
            {/* Drawing Canvas */}
            <canvas 
              ref={canvasRef} 
              style={{ position: 'absolute', width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)', pointerEvents: 'none', opacity: translatorActive ? 1 : 0 }} 
            />

            {/* AI Scanning Line Overlay */}
            {translatorActive && <div style={{ position: 'absolute', width: '100%', height: '100%', background: 'linear-gradient(to bottom, transparent, rgba(59, 130, 246, 0.2) 50%, transparent)', top: '-50%', pointerEvents: 'none', zIndex: 5, animation: 'scanningLine 4s linear infinite' }}></div>}
        </div>

        {/* HUD OVERLAYS */}

        {/* Top Navigation Bar */}
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, padding: '24px 40px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', zIndex: 10, pointerEvents: 'none' }}>
          
          <button 
            onClick={() => { setTranslatorActive(false); setAppMode('studio'); }}
            style={{ pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(15, 23, 42, 0.6)', backdropFilter: 'blur(20px)', border: '1px solid rgba(255, 255, 255, 0.1)', color: 'white', padding: '12px 24px', borderRadius: '16px', cursor: 'pointer', fontWeight: 600, transition: 'all 0.3s', boxShadow: '0 10px 30px rgba(0,0,0,0.5)' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'; e.currentTarget.style.transform = 'translateY(-2px)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(15, 23, 42, 0.6)'; e.currentTarget.style.transform = 'translateY(0)'; }}
          >
            <ArrowLeft size={18} /> Exit HUD
          </button>

          {/* Dynamic Status Island */}
          <div style={{ 
            display: 'flex', alignItems: 'center', gap: '12px',
            background: currentStatus.startsWith('Recognized') ? 'rgba(16, 185, 129, 0.2)' : 'rgba(15, 23, 42, 0.6)',
            backdropFilter: 'blur(20px)',
            border: `1px solid ${currentStatus.startsWith('Recognized') ? 'rgba(16, 185, 129, 0.5)' : 'rgba(255, 255, 255, 0.1)'}`,
            boxShadow: currentStatus.startsWith('Recognized') ? '0 0 30px rgba(16, 185, 129, 0.2)' : '0 10px 30px rgba(0,0,0,0.5)',
            padding: '12px 30px',
            borderRadius: '40px',
            color: currentStatus.startsWith('Recognized') ? '#a7f3d0' : 'white',
            fontWeight: 700,
            fontSize: '18px',
            transition: 'all 0.4s cubic-bezier(0.16, 1, 0.3, 1)'
          }}>
            {currentStatus.startsWith('Recognized') ? <Activity size={20} color="#34d399" /> : <Radio size={20} color={translatorActive ? "#60a5fa" : "#ef4444"} />}
            {currentStatus === 'Not Recognized' ? (translatorActive ? 'Analyzing Gestures...' : 'System Standby') : currentStatus}
          </div>
        </div>

        {/* Translation History Sidebar (Right) */}
        <div style={{ position: 'absolute', top: '100px', bottom: '120px', right: '40px', width: '340px', background: 'rgba(15, 23, 42, 0.6)', backdropFilter: 'blur(30px)', border: '1px solid rgba(255, 255, 255, 0.1)', borderRadius: '24px', display: 'flex', flexDirection: 'column', padding: '24px', boxShadow: '0 20px 50px rgba(0,0,0,0.5)', zIndex: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '20px', paddingBottom: '15px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
            <Mic size={20} color="#94a3b8" />
            <h3 style={{ fontSize: '13px', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '2px', margin: 0, fontWeight: 700 }}>Translation Stream</h3>
          </div>
          
          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '12px', paddingRight: '10px' }} className="custom-scrollbar">
            {translationLog.length === 0 && (
              <div style={{ color: '#64748b', fontSize: '14px', fontStyle: 'italic', textAlign: 'center', marginTop: '60px', opacity: 0.7 }}>Waiting for input stream...</div>
            )}
            {translationLog.map((log, idx) => {
              const isPalm = log.text.startsWith('[PALM]');
              return (
                <div key={idx} style={{ 
                  background: isPalm ? 'rgba(245, 158, 11, 0.1)' : 'rgba(255, 255, 255, 0.03)', 
                  border: `1px solid ${isPalm ? 'rgba(245, 158, 11, 0.3)' : 'rgba(255, 255, 255, 0.05)'}`, 
                  borderLeft: `4px solid ${isPalm ? '#f59e0b' : '#3b82f6'}`,
                  padding: '16px', 
                  borderRadius: '16px', 
                  display: 'flex', 
                  flexDirection: 'column', 
                  animation: 'slideInRight 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
                  boxShadow: '0 4px 20px rgba(0,0,0,0.15)'
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <span style={{ fontSize: '11px', color: isPalm ? '#fcd34d' : '#94a3b8', fontWeight: 600, letterSpacing: '0.5px' }}>{log.time}</span>
                    {isPalm && <Sparkles size={14} color="#fcd34d" />}
                  </div>
                  <span className={isPalm ? 'glow-text' : ''} style={{ fontSize: '16px', color: '#fff', fontWeight: 600, letterSpacing: '0.5px' }}>{isPalm ? log.text.replace('[PALM] Sending: ', '') : log.text}</span>
                  {isPalm && <span style={{ fontSize: '10px', color: '#f59e0b', marginTop: '6px', textTransform: 'uppercase', letterSpacing: '1px' }}>Grammar Parsed & Spoken</span>}
                </div>
              );
            })}
          </div>
          
          <button 
            onClick={() => setTranslationLog([])}
            style={{ marginTop: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', background: 'rgba(255, 255, 255, 0.05)', border: '1px solid rgba(255, 255, 255, 0.1)', color: '#cbd5e1', padding: '14px', borderRadius: '16px', cursor: 'pointer', fontWeight: 600, transition: 'all 0.2s' }}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(239, 68, 68, 0.1)'}
            onMouseLeave={e => e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'}
          >
            <Trash2 size={16} /> Clear Stream
          </button>
        </div>

        {/* Bottom Floating Start Button */}
        {!translatorActive && (
          <div style={{ position: 'absolute', bottom: '60px', left: 0, right: 0, display: 'flex', justifyContent: 'center', zIndex: 20 }}>
            <button 
              onClick={() => setTranslatorActive(true)}
              style={{ display: 'flex', alignItems: 'center', gap: '12px', background: 'linear-gradient(135deg, #3b82f6, #2563eb)', color: 'white', border: '1px solid rgba(255,255,255,0.2)', padding: '20px 48px', borderRadius: '40px', fontSize: '20px', cursor: 'pointer', fontWeight: 800, letterSpacing: '1px', textTransform: 'uppercase', boxShadow: '0 20px 40px rgba(37, 99, 235, 0.4), inset 0 2px 0 rgba(255,255,255,0.2)', transition: 'all 0.3s', animation: 'pulseGlow 2s infinite' }}
              onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.05) translateY(-5px)'; e.currentTarget.style.animation = 'none'; e.currentTarget.style.boxShadow = '0 30px 50px rgba(37, 99, 235, 0.6), inset 0 2px 0 rgba(255,255,255,0.2)'; }}
              onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1) translateY(0)'; e.currentTarget.style.animation = 'pulseGlow 2s infinite'; e.currentTarget.style.boxShadow = '0 20px 40px rgba(37, 99, 235, 0.4), inset 0 2px 0 rgba(255,255,255,0.2)'; }}
            >
              <Camera size={24} /> Initialize HUD
            </button>
          </div>
        )}
      </div>
    );
  }

  // --- Default Studio View ---
  return (
    <div style={{ padding: '20px', fontFamily: 'sans-serif', maxWidth: '800px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h1>Sign Language Studio</h1>
        <button 
          onClick={() => setAppMode('translator')}
          style={{ background: '#3b82f6', color: 'white', border: 'none', padding: '10px 20px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}
        >
          Open Live Translator →
        </button>
      </div>
      <p style={{ color: '#666' }}>Standalone tool to record sign language vocabulary and train your Live Translator.</p>
      
      <div style={{ padding: '20px', background: '#f5f5f5', borderRadius: '8px', marginBottom: '20px' }}>
        <h2>Dataset Studio</h2>
        
        <div style={{ display: 'flex', gap: '10px', marginBottom: '10px', marginTop: '10px' }}>
          <input 
            type="text" 
            placeholder="Gesture Label (e.g. 'hello')" 
            value={label} 
            onChange={e => setLabel(e.target.value)}
            style={{ padding: '8px', flex: 1 }}
            disabled={status === 'Recording...'}
          />
          {!recordedData && (
            <button onClick={startRecording} disabled={status === 'Recording...'} style={{ padding: '8px 16px', background: 'purple', color: 'white', border: 'none', borderRadius: '4px' }}>
              {status === 'Recording...' ? 'Capturing...' : 'Record 2s Clip'}
            </button>
          )}
        </div>

        {!recordedData && status !== 'Recording...' && (
          <p style={{ fontSize: '12px' }}>Enter a label and click record. Make sure your hands are visible!</p>
        )}

        {/* ALWAYS mounted so videoRef is never null, but hidden when not recording */}
        <div style={{ background: 'black', width: '320px', height: '240px', borderRadius: '8px', overflow: 'hidden', display: status === 'Recording...' ? 'block' : 'none' }}>
          <video ref={videoRef} autoPlay muted style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }} />
        </div>

        {recordedData && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', width: '320px' }}>
            <div style={{ background: 'black', width: '320px', height: '240px', borderRadius: '8px', overflow: 'hidden' }}>
              <video src={recordedData.blobUrl} autoPlay loop controls style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }} />
            </div>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button onClick={() => setRecordedData(null)} style={{ flex: 1, padding: '8px' }}>Retake</button>
              <button onClick={handleSave} style={{ flex: 1, padding: '8px', background: 'green', color: 'white', border: 'none' }}>Save to Dataset</button>
            </div>
          </div>
        )}
      </div>

      <div style={{ padding: '20px', background: '#e0f2fe', borderRadius: '8px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ color: '#0369a1' }}>Sign Words AI Model</h2>
          <button onClick={() => handleTrain()} disabled={isTraining || wordsLibrary.length === 0} style={{ padding: '10px 20px', background: '#0284c7', color: 'white', border: 'none', borderRadius: '4px', fontWeight: 'bold' }}>
            {isTraining ? 'Training...' : 'Train Words'}
          </button>
        </div>
        <p style={{ color: '#0369a1' }}>Current library has {wordsLibrary.length} words.</p>
        
        {wordsLibrary.length > 0 && (
          <ul style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', padding: 0, listStyle: 'none' }}>
            {wordsLibrary.map(g => (
              <li key={g.label} style={{ background: 'white', padding: '10px', borderRadius: '4px', border: '1px solid #7dd3fc', color: '#0369a1' }}>
                <strong>{g.label}</strong> ({g.videos.length} videos)
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default App;
