import React, { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router';
import { Card } from '@renderer/components/ui/card';
import { Button } from '@renderer/components/ui/button';
import { NavHeader } from '@renderer/components/Detail/NavHeader';
import { Plus, Trash2, Save, Hand, Play, Volume2, Volume1, Mic, Briefcase, MonitorPlay, Camera } from 'lucide-react';
import { ScrollArea } from '@renderer/components/ui/scroll-area';
import { VisionWakePanel } from '../../components/VoiceAvatar/VisionWakePanel';

interface FingerConfig {
  thumb: 'open' | 'closed' | 'any';
  index: 'open' | 'closed' | 'any';
  middle: 'open' | 'closed' | 'any';
  ring: 'open' | 'closed' | 'any';
  pinky: 'open' | 'closed' | 'any';
}

interface Gesture {
  id: string;
  name: string;
  fingers: FingerConfig;
  action: string;
  actionArg?: string; // e.g. which app to open
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

export default function GestureConfig() {
  const navigate = useNavigate();
  const [gestures, setGestures] = useState<Gesture[]>([]);
  const [saving, setSaving] = useState(false);
  const [testMode, setTestMode] = useState(false);

  const [activeGestureId, setActiveGestureId] = useState<string | null>(null);
  const latestHandStateRef = useRef<FingerConfig | null>(null);

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
            fingers: { thumb: 'open', index: 'open', middle: 'closed', ring: 'closed', pinky: 'closed' },
            action: 'volume_up'
          },
          {
            id: 'g-openpalm',
            name: 'Open Palm',
            fingers: { thumb: 'open', index: 'open', middle: 'open', ring: 'open', pinky: 'open' },
            action: 'play_pause'
          },
          {
            id: 'g-fist',
            name: 'Closed Fist',
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

    window.addEventListener('vision:gesture-triggered', handleGesture);
    window.addEventListener('vision:raw-hand-state', handleRawHandState);
    return () => {
      window.removeEventListener('vision:gesture-triggered', handleGesture);
      window.removeEventListener('vision:raw-hand-state', handleRawHandState);
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
        <div className="flex gap-3">
          <Button variant="outline" onClick={addGesture} className="border-blue-500/30 text-blue-400 hover:bg-blue-500/10">
            <Plus className="mr-2 size-4" /> Add Gesture
          </Button>
          <Button onClick={handleSave} disabled={saving} className="bg-blue-600 hover:bg-blue-700 text-white">
            <Save className="mr-2 size-4" /> {saving ? 'Saved!' : 'Save Config'}
          </Button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <ScrollArea className="flex-1 px-6 py-4">
          <div className="space-y-4 pb-20">
            {gestures.map((g) => (
            <Card key={g.id} className={`bg-[#131B2C] border-slate-700/50 p-5 shadow-lg flex flex-col gap-4 transition-all duration-500 ${activeGestureId === g.id ? 'ring-2 ring-green-500 shadow-green-500/20 bg-green-900/20 transform scale-[1.02]' : ''}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <input
                    type="text"
                    value={g.name}
                    onChange={(e) => updateGesture(g.id, { name: e.target.value })}
                    className="bg-transparent border-b border-transparent hover:border-slate-600 focus:border-blue-500 outline-none text-lg font-semibold text-white px-1 w-64 transition-colors"
                    placeholder="Gesture Name"
                  />
                  {activeGestureId === g.id && <span className="text-xs font-bold text-green-400 animate-pulse uppercase tracking-wider">Detected!</span>}
                </div>
                <Button variant="ghost" size="icon" onClick={() => deleteGesture(g.id)} className="text-red-400 hover:text-red-300 hover:bg-red-400/10 h-8 w-8">
                  <Trash2 className="size-4" />
                </Button>
              </div>

              <div className="grid grid-cols-2 gap-8">
                {/* Fingers Config */}
                <div className="bg-[#0B0F19]/50 rounded-lg p-4 border border-slate-800/80 relative">
                  <div className="flex justify-between items-center mb-3">
                    <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Finger States</h4>
                    <Button 
                      variant="outline" 
                      size="sm" 
                      className="h-6 px-2 text-[10px] bg-blue-500/10 text-blue-400 border-blue-500/30 hover:bg-blue-500/20"
                      onClick={() => captureGesture(g.id)}
                    >
                      <Camera className="size-3 mr-1" /> Capture
                    </Button>
                  </div>
                  <div className="grid grid-cols-5 gap-2">
                    {['thumb', 'index', 'middle', 'ring', 'pinky'].map((finger) => (
                      <div key={finger} className="flex flex-col gap-1 items-center">
                        <span className="text-[10px] text-slate-500 uppercase">{finger}</span>
                        <select
                          value={g.fingers[finger as keyof FingerConfig]}
                          onChange={(e) => updateFinger(g.id, finger as keyof FingerConfig, e.target.value)}
                          className={`w-full bg-[#1A233A] border text-xs py-1.5 px-1 rounded appearance-none text-center cursor-pointer outline-none transition-colors
                            ${g.fingers[finger as keyof FingerConfig] === 'open' ? 'border-green-500/50 text-green-400' : 
                              g.fingers[finger as keyof FingerConfig] === 'closed' ? 'border-red-500/50 text-red-400' : 
                              'border-slate-700 text-slate-400'}`}
                        >
                          {FINGER_STATES.map(s => (
                            <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Action Config */}
                <div className="bg-[#0B0F19]/50 rounded-lg p-4 border border-slate-800/80">
                  <h4 className="text-xs font-semibold text-slate-400 mb-3 uppercase tracking-wider">Trigger Action</h4>
                  <div className="flex flex-col gap-3">
                    <div className="flex gap-2">
                      <select
                        value={g.action}
                        onChange={(e) => updateGesture(g.id, { action: e.target.value })}
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

          <VisionWakePanel autoStart={true} testGestures={testMode ? gestures : null} />
        </div>
      </div>
    </div>
  );
}
