import React, { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router';
import { Card } from '@renderer/components/ui/card';
import { Button } from '@renderer/components/ui/button';
import { NavHeader } from '@renderer/components/Detail/NavHeader';
import { Plus, Trash2, Save, Hand, Play, Volume2, Volume1, Mic, Briefcase, MonitorPlay, Camera, Video, CheckCircle2, Library } from 'lucide-react';
import { ScrollArea } from '@renderer/components/ui/scroll-area';
import { VisionWakePanel } from '../../components/VoiceAvatar/VisionWakePanel';

interface FingerConfig {
  thumb: 'open' | 'closed' | 'any';
  index: 'open' | 'closed' | 'any';
  middle: 'open' | 'closed' | 'any';
  ring: 'open' | 'closed' | 'any';
  pinky: 'open' | 'closed' | 'any';
}

type GestureType = 'hand' | 'eye' | 'head';

interface Gesture {
  id: string;
  name: string;
  type?: GestureType;
  action: string;
  actionArg?: string; // e.g. which app to open
  
  fingers?: FingerConfig;
  eyeAction?: 'double_blink' | 'wink_left' | 'wink_right';
  headAction?: 'nod' | 'shake';
}

const ACTION_OPTIONS = [
  { value: 'volume_up', label: 'Volume Up', icon: Volume2 },
  { value: 'volume_down', label: 'Volume Down', icon: Volume1 },
  { value: 'play_pause', label: 'Play / Pause', icon: Play },
  { value: 'start_listening', label: 'Start Listening', icon: Mic },
  { value: 'start_task', label: 'Start Task', icon: Briefcase },
  { value: 'open_app', label: 'Open Application', icon: MonitorPlay },
];

const FINGER_STATES = ['open', 'closed', 'any'];

function DatasetStudio({ onSave }: { onSave?: () => void }) {
  const [label, setLabel] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [recordedData, setRecordedData] = useState<{ base64: string, blobUrl: string, landmarks: any[] } | null>(null);
  const [lastSaved, setLastSaved] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const landmarksTimelineRef = useRef<any[]>([]);

  useEffect(() => {
    const handleFace = (e: any) => {
      if (isRecording) {
        landmarksTimelineRef.current.push({ type: 'face', timestamp: Date.now(), data: e.detail });
      }
    };
    const handleHand = (e: any) => {
      if (isRecording) {
        landmarksTimelineRef.current.push({ type: 'hand', timestamp: Date.now(), data: e.detail });
      }
    };
    window.addEventListener('vision:raw-face-state', handleFace);
    window.addEventListener('vision:raw-hand-state', handleHand);
    return () => {
      window.removeEventListener('vision:raw-face-state', handleFace);
      window.removeEventListener('vision:raw-hand-state', handleHand);
    };
  }, [isRecording]);

  const startRecording = async () => {
    if (!label.trim()) {
      alert('Please enter a gesture label first (e.g. "Hello").');
      return;
    }
    
    try {
      landmarksTimelineRef.current = []; // reset timeline
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
      mediaRecorderRef.current = mediaRecorder;
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
          setIsRecording(false);
        };
        reader.readAsDataURL(blob);
      };

      setIsRecording(true);
      mediaRecorder.start(100); // 100ms timeslice to force chunk emission

      // Automatically stop after 2 seconds
      setTimeout(() => {
        if (mediaRecorder.state === 'recording') {
          mediaRecorder.stop();
        }
      }, 2000);

    } catch (err) {
      console.error('Could not start recording:', err);
      alert('Could not access webcam for recording.');
    }
  };

  return (
    <div className="bg-[#131B2C] border border-slate-800 rounded-lg p-3 flex flex-col gap-3 mt-4">
      <div className="flex items-center gap-2 text-slate-300 font-semibold text-sm">
        <Video className="size-4 text-purple-400" />
        Dataset Studio
      </div>
      <p className="text-[10px] text-slate-500 leading-tight">
        Record 2-second webcam clips to build a dataset for custom MediaPipe training.
      </p>
      
      {recordedData ? (
        <div className="flex flex-col gap-2">
          <div className="relative w-full rounded overflow-hidden aspect-video bg-black flex items-center justify-center">
            <video src={recordedData.blobUrl} autoPlay loop controls className="w-full h-full object-cover transform scale-x-[-1]" />
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1 text-xs h-8 border-slate-700 bg-[#1A233A] text-slate-300 hover:bg-slate-800" onClick={() => {
              URL.revokeObjectURL(recordedData.blobUrl);
              setRecordedData(null);
            }}>
              Retake
            </Button>
            <Button 
              className="flex-1 text-xs h-8 bg-green-600 hover:bg-green-500 text-white shadow-[0_0_10px_rgba(34,197,94,0.3)]" 
              onClick={async () => {
                try {
                  const res = await window.electron?.ipcRenderer?.invoke('visionRoute.saveGestureVideo', {
                    videoBase64: recordedData.base64,
                    landmarksJson: JSON.stringify(recordedData.landmarks),
                    label: label.trim().toLowerCase().replace(/\s+/g, '_')
                  });
                  if (res?.success) {
                    setLastSaved(res.filePath);
                    setRecordedData(null);
                    setTimeout(() => setLastSaved(''), 5000);
                    onSave?.();
                  } else {
                    alert('Failed to save video: ' + res?.error);
                  }
                } catch (err: any) {
                  alert('IPC error: ' + err.message);
                }
              }}
            >
              <Save className="size-3 mr-1" /> Save to Dataset
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className={`relative w-full rounded overflow-hidden aspect-video bg-black flex items-center justify-center ${isRecording ? 'block' : 'hidden'}`}>
            <video ref={videoRef} autoPlay muted className="w-full h-full object-cover transform scale-x-[-1]" />
            <div className="absolute top-2 right-2 flex items-center gap-1 bg-red-500/20 text-red-400 text-[10px] px-2 py-0.5 rounded-full border border-red-500/50 animate-pulse">
              <div className="size-2 rounded-full bg-red-500" /> Recording...
            </div>
          </div>

          {!isRecording && (
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Gesture Label (e.g. 'hello')"
              className="w-full bg-[#1A233A] border border-slate-700 text-xs py-1.5 px-2 rounded text-white outline-none focus:border-purple-500"
            />
          )}

          <Button 
            onClick={startRecording} 
            disabled={isRecording || !label.trim()}
            className={`w-full text-xs h-8 ${isRecording ? 'bg-slate-700 text-slate-400' : 'bg-purple-600 hover:bg-purple-700 text-white'}`}
          >
            {isRecording ? 'Capturing (2s)...' : 'Record 2s Clip'}
          </Button>
        </>
      )}

      {lastSaved && (
        <div className="flex items-center gap-1 text-[10px] text-green-400 bg-green-500/10 p-1.5 rounded border border-green-500/20 break-all">
          <CheckCircle2 className="size-3 shrink-0" />
          Saved to dataset!
        </div>
      )}
    </div>
  );
}

function GestureLibrary() {
  const [library, setLibrary] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [isTraining, setIsTraining] = useState(false);

  const fetchLibrary = async () => {
    try {
      const res = await window.electron?.ipcRenderer?.invoke('visionRoute.getGestureLibrary');
      if (res?.success) {
        setLibrary(res.library);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLibrary();
  }, []);

  const handleTrainModel = async () => {
    setIsTraining(true);
    try {
      const res = await window.electron?.ipcRenderer?.invoke('visionRoute.trainCustomModel');
      if (res?.success) {
        alert("Training Complete!\n\n" + (res.output || "Model updated successfully."));
      } else {
        alert("Training Failed:\n" + res?.error);
      }
    } catch (e: any) {
      alert("Error triggering training: " + e.message);
    }
    setIsTraining(false);
  };

  const handleDeleteGesture = async (label: string) => {
    if (confirm(`Are you sure you want to completely delete the gesture '${label}'?`)) {
      await window.electron?.ipcRenderer?.invoke('visionRoute.deleteGestureLabel', { label });
      fetchLibrary();
    }
  };

  const handleRenameGesture = async (oldLabel: string, newLabel: string) => {
    if (oldLabel === newLabel || !newLabel.trim()) return;
    await window.electron?.ipcRenderer?.invoke('visionRoute.renameGestureLabel', { oldLabel, newLabel });
    fetchLibrary();
  };

  const handleUpdateText = async (label: string, text: string) => {
    await window.electron?.ipcRenderer?.invoke('visionRoute.updateGestureTranslation', { label, text });
    fetchLibrary();
  };

  const handleDeleteVideo = async (videoPath: string) => {
    if (confirm('Are you sure you want to delete this recording?')) {
      await window.electron?.ipcRenderer?.invoke('visionRoute.deleteGestureVideo', { videoPath });
      fetchLibrary();
    }
  };

  if (loading) return <div className="p-8 text-center text-slate-400">Loading library...</div>;

  return (
    <div className="flex flex-col gap-6">
      <DatasetStudio onSave={fetchLibrary} />
      
      <div className="bg-[#1A233A] p-4 rounded-lg border border-purple-500/30 flex items-center justify-between shadow-[0_0_15px_rgba(168,85,247,0.1)]">
        <div>
          <h3 className="text-white font-bold mb-1">Custom AI Model</h3>
          <p className="text-xs text-slate-400">Train your local scikit-learn model on the {library.length} gesture categories below.</p>
        </div>
        <Button 
          onClick={handleTrainModel} 
          disabled={isTraining || library.length === 0}
          className={`min-w-[150px] font-bold ${isTraining ? 'bg-purple-800' : 'bg-purple-600 hover:bg-purple-500 text-white shadow-[0_0_10px_rgba(168,85,247,0.4)]'}`}
        >
          {isTraining ? 'Training...' : 'Train AI Model'}
        </Button>
      </div>

      {library.length === 0 ? (
        <div className="p-8 text-center text-slate-400 border border-dashed border-slate-700 rounded-lg">
          Your gesture library is empty. Record some gestures above!
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {library.map((g, idx) => (
            <Card key={idx} className="bg-[#131B2C] border-slate-800 flex flex-col overflow-hidden">
          <div className="bg-[#1A233A] p-2 flex justify-between items-center border-b border-slate-800">
            <input
              type="text"
              defaultValue={g.label}
              onBlur={(e) => handleRenameGesture(g.label, e.target.value)}
              className="font-bold text-sm text-purple-400 uppercase tracking-wider bg-transparent border-none outline-none focus:ring-1 ring-purple-500/50 rounded px-1 max-w-[140px]"
              title="Rename Label"
            />
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded">{g.videos.length} videos</span>
              <button 
                onClick={() => handleDeleteGesture(g.label)}
                className="text-red-400 hover:text-red-300 hover:bg-red-500/10 p-1 rounded transition-colors"
                title="Delete Gesture"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          </div>
          <div className="p-3 flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-slate-400 font-semibold">Dictionary Translation</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  defaultValue={g.text}
                  placeholder="e.g. I need coffee"
                  onBlur={(e) => handleUpdateText(g.label, e.target.value)}
                  className="flex-1 bg-[#1A233A] border border-slate-700 text-sm py-1.5 px-2 rounded text-white outline-none focus:border-purple-500"
                />
              </div>
            </div>
            {g.videos.length > 0 && (
              <div className="grid grid-cols-2 gap-2 mt-2">
                {g.videos.map((vid: string, i: number) => (
                  <div key={i} className="relative aspect-video rounded overflow-hidden bg-black group">
                    <video src={vid} controls={false} autoPlay loop muted className="w-full h-full object-cover" />
                    <button 
                      onClick={() => handleDeleteVideo(vid)}
                      className="absolute top-1 right-1 p-1 bg-red-500/80 hover:bg-red-500 text-white rounded opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>
      ))}
        </div>
      )}
    </div>
  );
}

export default function GestureConfig() {
  const navigate = useNavigate();
  const [gestures, setGestures] = useState<Gesture[]>([]);
  const [saving, setSaving] = useState(false);
  const [testMode, setTestMode] = useState(false);

  const [activeGestureId, setActiveGestureId] = useState<string | null>(null);
  const latestHandStateRef = useRef<FingerConfig | null>(null);
  const [faceState, setFaceState] = useState<any>(null);
  const [showLibrary, setShowLibrary] = useState(false);

  useEffect(() => {
    window.electron?.ipcRenderer?.invoke('gesture:load').then((loaded: Gesture[]) => {
      if (loaded && loaded.length > 0) {
        setGestures(loaded);
      } else {
        // defaults
        setGestures([
          {
            id: 'g-lshape',
            name: 'L Shape',
            type: 'hand',
            fingers: { thumb: 'open', index: 'open', middle: 'closed', ring: 'closed', pinky: 'closed' },
            action: 'volume_up'
          },
          {
            id: 'g-openpalm',
            name: 'Open Palm',
            type: 'hand',
            fingers: { thumb: 'open', index: 'open', middle: 'open', ring: 'open', pinky: 'open' },
            action: 'play_pause'
          },
          {
            id: 'g-fist',
            name: 'Closed Fist',
            type: 'hand',
            fingers: { thumb: 'closed', index: 'closed', middle: 'closed', ring: 'closed', pinky: 'closed' },
            action: 'start_listening'
          }
        ]);
      }
    });

    const handleGesture = (e: any) => {
      if (e.detail?.id) {
        setActiveGestureId(e.detail.id);
        setTimeout(() => setActiveGestureId(null), 2500);
      }
    };
    
    const handleRawHandState = (e: any) => {
      if (e.detail) {
        latestHandStateRef.current = e.detail;
      }
    };
    
    const handleFaceState = (e: any) => {
      if (e.detail) {
        setFaceState(e.detail);
      }
    };

    window.addEventListener('vision:gesture-triggered', handleGesture);
    window.addEventListener('vision:raw-hand-state', handleRawHandState);
    window.addEventListener('vision:raw-face-state', handleFaceState);
    return () => {
      window.removeEventListener('vision:gesture-triggered', handleGesture);
      window.removeEventListener('vision:raw-hand-state', handleRawHandState);
      window.removeEventListener('vision:raw-face-state', handleFaceState);
    };
  }, []);

  const captureGesture = (id: string) => {
    if (latestHandStateRef.current) {
      updateGesture(id, { fingers: latestHandStateRef.current });
    }
  };

  const handleBack = () => {
    navigate(-1);
  };

  const handleSave = async () => {
    setSaving(true);
    await window.electron?.ipcRenderer?.invoke('gesture:save', gestures);
    setTimeout(() => setSaving(false), 500);
  };

  const addGesture = () => {
    setGestures((prev) => [
      ...prev,
      {
        id: `g-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        name: 'New Gesture',
        type: 'hand',
        fingers: { thumb: 'any', index: 'any', middle: 'any', ring: 'any', pinky: 'any' },
        action: 'volume_up'
      }
    ]);
  };

  const updateGesture = (id: string, updates: Partial<Gesture>) => {
    setGestures((prev) => prev.map((g) => (g.id === id ? { ...g, ...updates } : g)));
  };

  const updateFinger = (id: string, finger: keyof FingerConfig, value: any) => {
    setGestures((prev) => prev.map((g) => {
      if (g.id === id) {
        return { ...g, fingers: { ...g.fingers, [finger]: value } };
      }
      return g;
    }));
  };

  const deleteGesture = (id: string) => {
    setGestures((prev) => prev.filter((g) => g.id !== id));
  };

  return (
    <div className="flex flex-col w-full h-screen bg-[#0B0F19] text-white">
      <NavHeader title="Gesture Management" onBack={handleBack} />
      
      <div className="flex justify-between items-center px-6 pt-4 pb-2 border-b border-slate-800">
        <div>
          <h2 className="text-xl font-bold flex items-center gap-2"><Hand className="text-blue-400" /> Custom Gestures</h2>
          <p className="text-sm text-slate-400 mt-1">Map physical hand gestures to system actions. Changes apply instantly.</p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => setShowLibrary(!showLibrary)} className={`gap-2 ${showLibrary ? 'bg-purple-600 text-white' : 'bg-[#1A233A] hover:bg-[#2A3441] text-slate-300'}`}>
            <Library className="size-4" />
            {showLibrary ? 'Hide Library' : 'Custom Gesture Library'}
          </Button>
          <Button onClick={addGesture} className="gap-2 bg-blue-600 hover:bg-blue-700 text-white">
            <Plus className="size-4" />
            New Rule
          </Button>
          <Button onClick={handleSave} disabled={saving} className="bg-blue-600 hover:bg-blue-700 text-white">
            <Save className="mr-2 size-4" /> {saving ? 'Saved!' : 'Save Config'}
          </Button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <ScrollArea className="flex-1 p-6">
          {showLibrary ? (
            <div className="flex flex-col gap-4 max-w-4xl mx-auto">
              <div>
                <h2 className="text-xl font-bold text-white flex items-center gap-2">
                  <Library className="size-5 text-purple-400" />
                  Custom Gesture Library
                </h2>
                <p className="text-sm text-slate-400">
                  Manage the video clips you recorded in the Dataset Studio. You can set the dictionary translation here, which the AI will speak when you sign this custom gesture.
                </p>
              </div>
              <GestureLibrary />
            </div>
          ) : (
            <div className="flex flex-col gap-4 max-w-4xl mx-auto">
              {gestures.map(g => (
                <Card 
                  key={g.id} 
                  className={`bg-[#131B2C] border-slate-800 flex flex-col overflow-hidden transition-all duration-300 ${activeGestureId === g.id ? 'ring-2 ring-green-500 shadow-[0_0_15px_rgba(34,197,94,0.3)] transform scale-[1.01]' : ''}`}
                >
                  <div className="bg-[#1A233A] p-3 flex justify-between items-center border-b border-slate-800">
                    <div className="flex items-center gap-3">
                      <span className="font-bold text-sm text-slate-300">Rule #{g.id.slice(0,4)}</span>
                      {activeGestureId === g.id && (
                        <span className="text-xs font-bold text-green-400 animate-pulse flex items-center gap-1">
                          <CheckCircle2 className="size-3" /> MATCHED!
                        </span>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <Button variant="ghost" size="sm" onClick={() => deleteGesture(g.id)} className="text-red-400 hover:text-red-300 hover:bg-red-400/10 p-1 h-7">
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </div>
                  
                  <div className="p-4 flex gap-6">
                    <div className="flex-1">
                      <div className="mb-4">
                        <h4 className="text-xs font-semibold text-slate-500 uppercase mb-2">Gesture Type</h4>
                        <select
                          value={g.type || 'hand'}
                          onChange={(e) => updateGesture(g.id, { type: e.target.value as GestureType })}
                          className="w-full bg-[#1A233A] border border-slate-700 text-sm py-2 px-3 rounded text-white outline-none focus:border-blue-500 cursor-pointer"
                        >
                            <option value="hand">Hand Gesture</option>
                            <option value="eye">Eye Gesture</option>
                            <option value="head">Head Gesture</option>
                        </select>
                      </div>

                      {(!g.type || g.type === 'hand') && (
                        <>
                          <h4 className="text-xs font-semibold text-slate-500 uppercase mb-3 flex items-center gap-2">
                            <Hand className="size-3" /> Hand Configuration
                          </h4>
                          <div className="grid grid-cols-5 gap-2">
                            {Object.entries(g.fingers || { thumb: 'any', index: 'any', middle: 'any', ring: 'any', pinky: 'any' }).map(([finger, state]) => (
                              <div key={finger} className="flex flex-col gap-1">
                                <span className="text-[10px] text-slate-400 capitalize text-center">{finger}</span>
                                <select
                                  value={state}
                                  onChange={(e) => updateFinger(g.id, finger as keyof FingerConfig, e.target.value)}
                                  className="bg-[#1A233A] border border-slate-700 text-xs py-1 px-1 rounded text-white outline-none focus:border-blue-500"
                                >
                                  {FINGER_STATES.map(s => <option key={s} value={s}>{s}</option>)}
                                </select>
                              </div>
                            ))}
                          </div>
                          <div className="mt-3">
                            <Button 
                              variant="outline" 
                              size="sm" 
                              className="w-full text-xs border-slate-700 text-slate-300 hover:bg-blue-500/10 hover:text-blue-400"
                              onClick={() => captureGesture(g.id)}
                            >
                              <Camera className="size-3 mr-2" />
                              Capture current hand pose
                            </Button>
                          </div>
                        </>
                      )}

                      {g.type === 'eye' && (
                        <div className="mt-2">
                          <span className="text-[10px] text-slate-500 uppercase mb-1 block">Eye Movement</span>
                          <select
                            value={g.eyeAction || 'double_blink'}
                            onChange={(e) => updateGesture(g.id, { eyeAction: e.target.value as any })}
                            className="w-full bg-[#1A233A] border border-slate-700 text-sm py-2 px-3 rounded text-white outline-none focus:border-blue-500 cursor-pointer"
                          >
                            <option value="double_blink">Double Blink</option>
                            <option value="wink_left">Wink Left Eye</option>
                            <option value="wink_right">Wink Right Eye</option>
                          </select>
                        </div>
                      )}

                      {g.type === 'head' && (
                        <div className="mt-2">
                          <span className="text-[10px] text-slate-500 uppercase mb-1 block">Head Movement</span>
                          <select
                            value={g.headAction || 'nod'}
                            onChange={(e) => updateGesture(g.id, { headAction: e.target.value as any })}
                            className="w-full bg-[#1A233A] border border-slate-700 text-sm py-2 px-3 rounded text-white outline-none focus:border-blue-500 cursor-pointer"
                          >
                            <option value="nod">Nod (Up/Down)</option>
                            <option value="shake">Shake (Left/Right)</option>
                          </select>
                        </div>
                      )}
                    </div>

                    <div className="w-px bg-slate-800" />

                    <div className="flex-1">
                      <h4 className="text-xs font-semibold text-slate-500 uppercase mb-3 flex items-center gap-2">
                        <Briefcase className="size-3" /> Action
                      </h4>
                      <div className="flex flex-col gap-3">
                        <div className="flex gap-2">
                          <select
                            value={g.action}
                            onChange={(e) => updateGesture(g.id, { action: e.target.value as any, actionArg: '' })}
                            className="flex-1 bg-[#1A233A] border border-slate-700 text-sm py-2 px-3 rounded text-white outline-none focus:border-blue-500 cursor-pointer"
                          >
                            {ACTION_OPTIONS.map(a => (
                              <option key={a.value} value={a.value}>{a.label}</option>
                            ))}
                          </select>
                        </div>
                        {(g.action === 'open_app' || g.action === 'start_task') && (
                          <input
                            type="text"
                            value={g.actionArg || ''}
                            onChange={(e) => updateGesture(g.id, { actionArg: e.target.value })}
                            className="w-full bg-[#1A233A] border border-slate-700 text-sm py-2 px-3 rounded text-white outline-none focus:border-blue-500"
                            placeholder={g.action === 'start_task' ? "e.g. increase volume by 5 points" : "e.g. notepad.exe or https://google.com"}
                          />
                        )}
                      </div>
                    </div>
                  </div>
                </Card>
              ))}
              {gestures.length === 0 && (
                <div className="text-center py-12 text-slate-500">
                  <Hand className="size-12 mx-auto mb-3 opacity-20" />
                  <p>No gestures configured.</p>
                  <Button variant="link" onClick={addGesture} className="text-blue-400 mt-2">Create your first gesture</Button>
                </div>
              )}
            </div>
          )}
        </ScrollArea>
        
        <div className="w-[350px] border-l border-slate-800 bg-[#0B0F19]/80 p-4 flex flex-col gap-4">
          <h3 className="text-sm font-bold text-slate-300">Live Camera Preview</h3>
          <p className="text-xs text-slate-500 mb-2">Test your configured gestures here! The engine will highlight the matching gesture card.</p>
          
          <div className="flex items-center justify-between bg-[#131B2C] p-3 rounded-lg border border-slate-800">
            <div className="flex flex-col">
              <span className="text-sm font-semibold text-slate-300">Active Test Mode</span>
              <span className="text-[10px] text-slate-500">Test unsaved gestures instantly</span>
            </div>
            <label className="vision-switch">
              <input type="checkbox" checked={testMode} onChange={(e) => setTestMode(e.target.checked)} />
              <span className="vision-slider"></span>
            </label>
          </div>

          {faceState && (
            <div className="bg-[#131B2C] border border-slate-800 rounded-lg p-3 text-xs grid grid-cols-2 gap-2 text-slate-300">
              <div className="flex flex-col">
                <span className="text-slate-500 uppercase text-[9px] font-bold tracking-wider">Eye State</span>
                {faceState.blink && <span className="text-purple-400">● Blinking</span>}
                {faceState.lookLeft && <span className="text-blue-400">← Looking Left</span>}
                {faceState.lookRight && <span className="text-blue-400">→ Looking Right</span>}
                {!faceState.blink && !faceState.lookLeft && !faceState.lookRight && <span>Center</span>}
              </div>
              <div className="flex flex-col border-l border-slate-800 pl-2">
                <span className="text-slate-500 uppercase text-[9px] font-bold tracking-wider">Head Pose</span>
                {faceState.nodUp && <span className="text-green-400">↑ Up</span>}
                {faceState.nodDown && <span className="text-green-400">↓ Down</span>}
                {faceState.turnLeft && <span className="text-green-400">← Left</span>}
                {faceState.turnRight && <span className="text-green-400">→ Right</span>}
                {!faceState.nodUp && !faceState.nodDown && !faceState.turnLeft && !faceState.turnRight && <span>Center</span>}
              </div>
            </div>
          )}

          <VisionWakePanel autoStart={true} testGestures={testMode ? gestures : null} />
          
          <DatasetStudio />
        </div>
      </div>
    </div>
  );
}
