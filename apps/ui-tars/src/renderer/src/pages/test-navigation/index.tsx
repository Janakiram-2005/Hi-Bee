import { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router';
import { 
  Play, Square, CheckCircle, XCircle, RefreshCw, Timer, Target, 
  Check, X, ChevronDown, Award, AlertCircle, ArrowLeft
} from 'lucide-react';

import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@renderer/components/ui/card';
import { Button } from '@renderer/components/ui/button';
import { Switch } from '@renderer/components/ui/switch';

import { useRunAgent } from '@renderer/hooks/useRunAgent';
import { useStore } from '@renderer/hooks/useStore';
import { useSetting } from '@renderer/hooks/useSetting';
import { api } from '@renderer/api';
import { Operator } from '@main/store/types';
import { toast } from 'sonner';

interface BenchmarkTask {
  id: string;
  name: string;
  instruction: string;
  targetId: string;
  description: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const TASKS_POOL: BenchmarkTask[] = [
  {
    id: 'close_btn',
    name: 'Precision Close Alert',
    instruction: 'In the UI-TARS app window, locate and click the small close button ✕ in the pink alert box.',
    targetId: 'test-close-btn',
    description: 'Tests precision hitting of small objects (less than 16px size).',
  },
  {
    id: 'dropdown',
    name: 'Interactive Select Dropdown',
    instruction: 'In the UI-TARS app window, click the dropdown arrow widget (chevron down) to open the select menu.',
    targetId: 'test-dropdown-trigger',
    description: 'Tests multi-state element interaction and location.',
  },
  {
    id: 'stroop_circle',
    name: 'Stroop Color Contrast',
    instruction: 'In the UI-TARS app window, locate the row of colored circles and click the blue circle that contains the word "red" written in red.',
    targetId: 'test-blue-circle-red-text',
    description: 'Tests semantic visual reasoning: resolving contrast between background color, text color, and text content.',
  },
  {
    id: 'collapsible',
    name: 'Collapsible Panel Expansion',
    instruction: 'In the UI-TARS app window, click the collapsible button labeled "Expand Panel" to show the hidden content.',
    targetId: 'test-collapsible-btn',
    description: 'Tests layout change navigation and accordion controls.',
  },
  {
    id: 'shrinking_bar',
    name: 'Dynamic Shrinking Target',
    instruction: 'In the UI-TARS app window, click directly on the shrinking progress bar.',
    targetId: 'test-shrinking-bar',
    description: 'Tests timing-sensitive navigation on elements with shrinking width.',
  },
  {
    id: 'pulsing_item',
    name: 'Resizing Layout Targets',
    instruction: 'In the UI-TARS app window, click on the growing and shrinking red pulsing circle.',
    targetId: 'test-pulsing-item',
    description: 'Tests clicking moving/pulsing elements experiencing layout shifts.',
  },
  {
    id: 'toggle_switch',
    name: 'State Toggle Switch',
    instruction: 'In the UI-TARS app window, toggle the green switch button to the ON position.',
    targetId: 'test-green-toggle',
    description: 'Tests precise execution on switch toggle controls.',
  },
  {
    id: 'next_page_btn',
    name: 'Bottom Footer Button',
    instruction: 'In the UI-TARS app window, scroll down if needed and click the "Next Page / Step" button at the very bottom.',
    targetId: 'test-next-page-btn',
    description: 'Tests scrolling capability and footer component placement recognition.',
  },
];

const EVAL_DURATION_SECONDS = 120; // 2 minutes
const PER_TASK_TIMEOUT = 25; // 25 seconds per task

export default function TestNavigation() {
  const navigate = useNavigate();
  const { settings, updateSetting } = useSetting();
  const { run, stopAgentRuning } = useRunAgent();
  const { thinking } = useStore();

  // Test Runner States
  const [isRunning, setIsRunning] = useState(false);
  const [timeRemaining, setTimeRemaining] = useState(EVAL_DURATION_SECONDS);
  const [currentTaskIndex, setCurrentTaskIndex] = useState(-1);
  const [shuffledTasks, setShuffledTasks] = useState<BenchmarkTask[]>([]);
  const [taskRemainingTime, setTaskRemainingTime] = useState(PER_TASK_TIMEOUT);
  const [results, setResults] = useState<Record<string, 'success' | 'failed' | 'timeout' | null>>({});
  const [showSummary, setShowSummary] = useState(false);

  // Widget States
  const [alertVisible, setAlertVisible] = useState(true);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [collapsibleOpen, setCollapsibleOpen] = useState(false);
  const [greenToggle, setGreenToggle] = useState(false);
  const [selectedDropdownOption, setSelectedDropdownOption] = useState<string | null>(null);

  // Refs to prevent closure stale states
  const activeTaskRef = useRef<BenchmarkTask | null>(null);
  const isRunningRef = useRef(false);
  const taskCompletedRef = useRef(false);
  const prevThinkingRef = useRef(false);

  // Sync refs
  useEffect(() => {
    isRunningRef.current = isRunning;
  }, [isRunning]);

  const hasAutoStartedRef = useRef(false);

  // Auto start evaluation on component mount
  useEffect(() => {
    // Wait until settings are loaded from Electron store
    if (!settings || Object.keys(settings).length === 0) return () => {};
    if (hasAutoStartedRef.current) return () => {};

    const shouldAutoStart = sessionStorage.getItem('auto-start-test');
    if (shouldAutoStart === 'true') {
      sessionStorage.removeItem('auto-start-test');
      hasAutoStartedRef.current = true;

      const timer = setTimeout(() => {
        startEvaluation();
      }, 1500);

      return () => {
        clearTimeout(timer);
      };
    }
    return () => {};
  }, [settings]);

  // Listen to test-navigation:start from main process if already on the page
  useEffect(() => {
    const handler = () => {
      toast.info('Starting navigation evaluation...');
      startEvaluation();
    };
    const unsubscribe = window.electron?.ipcRenderer?.on('test-navigation:start', handler);
    return () => {
      unsubscribe?.();
    };
  }, [settings]);

  // Overall Timer Effect (2 minutes countdown)
  useEffect(() => {
    if (!isRunning) return () => {};

    const timer = setInterval(() => {
      setTimeRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          finishEvaluation();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [isRunning]);

  // Per-task Timer Effect (25 seconds countdown)
  useEffect(() => {
    if (!isRunning || currentTaskIndex < 0) return () => {};

    setTaskRemainingTime(PER_TASK_TIMEOUT);

    const taskTimer = setInterval(() => {
      setTaskRemainingTime((prev) => {
        if (prev <= 1) {
          clearInterval(taskTimer);
          handleTaskFailure('timeout');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(taskTimer);
  }, [isRunning, currentTaskIndex]);

  // Auto-fail or transition when VLM stops executing
  useEffect(() => {
    let checkTimer: ReturnType<typeof setTimeout> | undefined;

    if (isRunning && prevThinkingRef.current === true && thinking === false) {
      // VLM stopped running thinking/executing loop
      checkTimer = setTimeout(() => {
        if (!taskCompletedRef.current && isRunningRef.current) {
          handleTaskFailure('failed');
        }
      }, 2000);
    }
    prevThinkingRef.current = thinking;

    return () => {
      if (checkTimer) clearTimeout(checkTimer);
    };
  }, [thinking, isRunning]);

  // Active Task
  const currentTask = useMemo(() => {
    if (currentTaskIndex >= 0 && currentTaskIndex < shuffledTasks.length) {
      const task = shuffledTasks[currentTaskIndex];
      activeTaskRef.current = task;
      return task;
    }
    activeTaskRef.current = null;
    return null;
  }, [currentTaskIndex, shuffledTasks]);

  // Shuffle and Start
  const startEvaluation = async () => {
    // 1. Force settings to LocalComputer so the agent drives desktop clicks on this Electron window
    if (settings.operator !== Operator.LocalComputer) {
      await updateSetting({ ...settings, operator: Operator.LocalComputer });
      toast.info('Switched operator mode to Local Computer for testing.');
      await sleep(500);
    }

    // 2. Clear state
    await api.clearHistory();
    setAlertVisible(true);
    setDropdownOpen(false);
    setCollapsibleOpen(false);
    setGreenToggle(false);
    setSelectedDropdownOption(null);

    // Shuffle the tasks
    const shuffled = [...TASKS_POOL].sort(() => Math.random() - 0.5);
    setShuffledTasks(shuffled);

    const initialResults: Record<string, 'success' | 'failed' | 'timeout' | null> = {};
    shuffled.forEach((task) => {
      initialResults[task.id] = null;
    });
    setResults(initialResults);

    setTimeRemaining(EVAL_DURATION_SECONDS);
    setShowSummary(false);
    setIsRunning(true);
    taskCompletedRef.current = false;
    setCurrentTaskIndex(0);

    // Run first task
    await runTask(shuffled[0]);
  };

  const runTask = async (task: BenchmarkTask) => {
    taskCompletedRef.current = false;
    toast.promise(
      run(task.instruction, []),
      {
        loading: `Initiating active task: ${task.name}...`,
        success: `VLM Agent started executing task.`,
        error: `Could not trigger VLM Agent.`,
      }
    );
  };

  const stopEvaluation = async () => {
    setIsRunning(false);
    setCurrentTaskIndex(-1);
    activeTaskRef.current = null;
    taskCompletedRef.current = false;
    await stopAgentRuning();
    await api.clearHistory();
    toast.error('Evaluation canceled by user.');
  };

  const finishEvaluation = async () => {
    setIsRunning(false);
    setCurrentTaskIndex(-1);
    activeTaskRef.current = null;
    taskCompletedRef.current = false;
    await stopAgentRuning();
    await api.clearHistory();
    setShowSummary(true);
    toast.success('Evaluation Completed!');
  };

  // Event validation hook
  const checkClickSuccess = (clickedId: string) => {
    if (!isRunningRef.current || taskCompletedRef.current) return;
    const activeTask = activeTaskRef.current;
    if (!activeTask) return;

    if (clickedId === activeTask.targetId) {
      handleTaskSuccess();
    }
  };

  const handleTaskSuccess = async () => {
    taskCompletedRef.current = true;
    const taskId = activeTaskRef.current?.id;
    if (taskId) {
      setResults((prev) => ({ ...prev, [taskId]: 'success' }));
    }

    toast.success(`Task "${activeTaskRef.current?.name}" completed successfully!`, {
      icon: '🎉',
    });

    // Stop active agent immediately
    await stopAgentRuning();
    await api.clearHistory();

    // Small sleep so visual success feedback is visible
    await sleep(1500);

    moveToNextTask();
  };

  const handleTaskFailure = async (type: 'failed' | 'timeout') => {
    if (taskCompletedRef.current || !isRunningRef.current) return;
    taskCompletedRef.current = true;

    const activeTask = activeTaskRef.current;
    if (!activeTask) return;

    setResults((prev) => ({ ...prev, [activeTask.id]: type }));
    toast.error(`Task "${activeTask.name}" failed (${type}).`);

    await stopAgentRuning();
    await api.clearHistory();

    await sleep(1000);
    moveToNextTask();
  };

  const moveToNextTask = () => {
    if (!isRunningRef.current) return;

    setCurrentTaskIndex((prevIndex) => {
      const nextIndex = prevIndex + 1;
      if (nextIndex >= shuffledTasks.length) {
        finishEvaluation();
        return prevIndex;
      }
      // Trigger next task execution
      runTask(shuffledTasks[nextIndex]);
      return nextIndex;
    });
  };

  // Widget actions
  const handleAlertClose = () => {
    setAlertVisible(false);
    checkClickSuccess('test-close-btn');
  };

  const handleCollapsibleClick = () => {
    setCollapsibleOpen(!collapsibleOpen);
    checkClickSuccess('test-collapsible-btn');
  };

  const handleToggleChange = (checked: boolean) => {
    setGreenToggle(checked);
    if (checked) {
      checkClickSuccess('test-green-toggle');
    }
  };

  // Click Interceptor (bubbles up to check targets starting with "test-")
  const handlePageClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const targetElement = target.closest('[id^="test-"]');
    if (targetElement) {
      checkClickSuccess(targetElement.id);
    }
  };

  // Score stats
  const stats = useMemo(() => {
    const total = shuffledTasks.length;
    const completed = Object.values(results).filter(Boolean).length;
    const successes = Object.values(results).filter((r) => r === 'success').length;
    const accuracy = completed > 0 ? Math.round((successes / total) * 100) : 0;
    return { total, completed, successes, accuracy };
  }, [results, shuffledTasks]);

  const handleBack = () => {
    if (isRunning) {
      stopEvaluation();
    }
    navigate('/home');
  };

  return (
    <div 
      className="flex flex-col w-full h-full bg-[#0b0f19] text-gray-200 select-none overflow-y-auto"
      onClick={handlePageClick}
    >
      <style>{`
        @keyframes shrink-bar-anim {
          0% { width: 100%; }
          100% { width: 10%; }
        }
        .animate-shrink-bar {
          animation: shrink-bar-anim 4s linear infinite;
        }
        @keyframes pulsing-scale {
          0% { transform: scale(0.85); }
          50% { transform: scale(1.15); }
          100% { transform: scale(0.85); }
        }
        .animate-pulsing {
          animation: pulsing-scale 2.5s ease-in-out infinite;
        }
      `}</style>

      {/* Glassmorphic custom header */}
      <div className="flex items-center justify-between px-6 py-4 bg-[#111827]/80 backdrop-blur-md border-b border-gray-800/60 sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <Button 
            variant="ghost" 
            size="icon" 
            className="hover:bg-gray-800 text-gray-300 rounded-full"
            onClick={handleBack}
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
              VLM Vision Navigation Test
              <span className="text-xs bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 px-2 py-0.5 rounded-full font-normal">
                Sandbox
              </span>
            </h1>
            <p className="text-xs text-gray-400">Evaluate vision capabilities on high-difficulty interactive UI widgets</p>
          </div>
        </div>

        {/* Dashboard Status Controls */}
        <div className="flex items-center gap-4">
          {isRunning ? (
            <div className="flex items-center gap-3 bg-gray-900/90 px-4 py-2 rounded-xl border border-gray-800 shadow-inner">
              <div className="flex items-center gap-1.5 text-orange-400 font-mono text-sm">
                <Timer className="h-4 w-4 animate-pulse" />
                {Math.floor(timeRemaining / 60)}:{(timeRemaining % 60).toString().padStart(2, '0')}
              </div>
              <div className="h-4 w-px bg-gray-800" />
              <div className="text-xs text-gray-400">
                Task {currentTaskIndex + 1}/{stats.total} 
                <span className="ml-2 text-indigo-400 font-mono">({taskRemainingTime}s remaining)</span>
              </div>
              <Button 
                variant="destructive" 
                size="sm" 
                className="h-8 bg-red-600 hover:bg-red-700 font-medium"
                onClick={stopEvaluation}
              >
                <Square className="h-3.5 w-3.5 mr-1" />
                Stop
              </Button>
            </div>
          ) : (
            <Button 
              onClick={startEvaluation}
              className="bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-700 hover:to-indigo-700 text-white font-medium shadow-md shadow-indigo-950/40"
            >
              <Play className="h-4 w-4 mr-1.5 fill-current" />
              Start Evaluation
            </Button>
          )}
        </div>
      </div>

      <div className="max-w-7xl mx-auto w-full p-6 space-y-6 flex-1 flex flex-col justify-between">
        
        {/* Active Task Instruction Bar */}
        {isRunning && currentTask && (
          <div className="bg-gradient-to-r from-indigo-950/80 to-purple-950/80 backdrop-blur-sm border border-indigo-500/30 rounded-2xl p-5 shadow-xl relative overflow-hidden">
            <div className="absolute top-0 right-0 w-24 h-24 bg-indigo-500/10 rounded-full blur-xl pointer-events-none" />
            <div className="flex items-start gap-4">
              <div className="bg-indigo-500/20 text-indigo-400 p-2.5 rounded-xl border border-indigo-500/30">
                <Target className="h-5 w-5 animate-spin-slow" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs uppercase tracking-wider text-indigo-400 font-bold">VLM Active Target Instruction</div>
                <h3 className="text-lg font-bold text-white mt-0.5">{currentTask.name}</h3>
                <p className="text-sm text-gray-300 mt-1.5 font-medium bg-black/30 px-3 py-2 rounded-lg border border-white/5 font-mono select-text">
                  "{currentTask.instruction}"
                </p>
                <div className="text-xs text-gray-400 mt-2 flex items-center gap-1.5">
                  <AlertCircle className="h-3.5 w-3.5 text-gray-400" />
                  {currentTask.description}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Evaluation Summary Report Overlay/Screen */}
        {showSummary && (
          <Card className="bg-[#111827] border-indigo-500/20 shadow-2xl overflow-hidden max-w-2xl mx-auto my-8">
            <div className="bg-gradient-to-r from-violet-900/40 to-indigo-900/40 px-6 py-8 text-center border-b border-gray-800 relative">
              <Award className="h-16 w-16 text-indigo-400 mx-auto animate-bounce" />
              <CardTitle className="text-2xl font-black text-white mt-4">VLM Benchmark Completed</CardTitle>
              <CardDescription className="text-gray-400 mt-1">Vision navigation accuracy dashboard</CardDescription>
              <div className="absolute top-4 right-4">
                <Button variant="ghost" size="icon" className="text-gray-400 hover:text-white" onClick={() => setShowSummary(false)}>
                  <X className="h-5 w-5" />
                </Button>
              </div>
            </div>
            <CardContent className="p-6 space-y-6">
              <div className="grid grid-cols-3 gap-4 text-center">
                <div className="bg-[#1f2937]/50 p-4 rounded-xl border border-gray-800">
                  <div className="text-xs text-gray-400 uppercase tracking-wider">Correctness</div>
                  <div className="text-3xl font-black text-indigo-400 mt-1 font-mono">{stats.accuracy}%</div>
                </div>
                <div className="bg-[#1f2937]/50 p-4 rounded-xl border border-gray-800">
                  <div className="text-xs text-gray-400 uppercase tracking-wider">Completed</div>
                  <div className="text-3xl font-black text-emerald-400 mt-1 font-mono">{stats.successes} / {stats.total}</div>
                </div>
                <div className="bg-[#1f2937]/50 p-4 rounded-xl border border-gray-800">
                  <div className="text-xs text-gray-400 uppercase tracking-wider">Failures</div>
                  <div className="text-3xl font-black text-rose-400 mt-1 font-mono">
                    {Object.values(results).filter((r) => r === 'failed' || r === 'timeout').length}
                  </div>
                </div>
              </div>

              {/* Task Breakdown list */}
              <div className="space-y-2.5">
                <div className="text-xs font-bold uppercase tracking-wider text-gray-400 px-1">Task Breakdown</div>
                {shuffledTasks.map((task) => {
                  const result = results[task.id];
                  return (
                    <div 
                      key={task.id} 
                      className="flex items-center justify-between p-3 rounded-lg bg-[#1f2937]/30 border border-gray-800/80 hover:bg-[#1f2937]/50 transition-colors"
                    >
                      <div className="flex items-center gap-2.5">
                        {result === 'success' ? (
                          <CheckCircle className="h-4.5 w-4.5 text-emerald-400" />
                        ) : result === 'failed' || result === 'timeout' ? (
                          <XCircle className="h-4.5 w-4.5 text-red-400" />
                        ) : (
                          <div className="h-4.5 w-4.5 rounded-full border border-gray-700 border-dashed" />
                        )}
                        <div>
                          <div className="text-sm font-semibold text-gray-200">{task.name}</div>
                          <div className="text-xs text-gray-400 font-mono truncate max-w-sm">{task.instruction}</div>
                        </div>
                      </div>
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full uppercase ${
                        result === 'success' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' :
                        result === 'timeout' ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' :
                        result === 'failed' ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20' :
                        'bg-gray-800 text-gray-400'
                      }`}>
                        {result || 'skipped'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </CardContent>
            <CardFooter className="bg-[#1f2937]/20 border-t border-gray-800 p-4 justify-center">
              <Button onClick={startEvaluation} className="bg-indigo-600 hover:bg-indigo-700 text-white">
                <RefreshCw className="h-4 w-4 mr-1.5" />
                Retry Evaluation
              </Button>
            </CardFooter>
          </Card>
        )}

        {/* Main Grid containing Benchmark widgets */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 flex-1 mt-6">
          
          {/* Card 1: Precision Close (Alert box x button) */}
          <Card className={`bg-[#111827] border-gray-800/80 hover:border-gray-700/80 transition-all duration-300 relative overflow-hidden flex flex-col justify-between ${
            currentTask?.id === 'close_btn' ? 'ring-2 ring-indigo-500 border-indigo-500 bg-indigo-950/10 scale-[1.01]' : ''
          }`}>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-bold tracking-tight text-white uppercase text-gray-400">01. Precision Close Alert</CardTitle>
              <CardDescription className="text-xs text-gray-400">Tests precision landing on small targets (under 16px)</CardDescription>
            </CardHeader>
            <CardContent className="flex-1 flex flex-col justify-center min-h-[120px]">
              {alertVisible ? (
                <div className="bg-pink-950/20 border border-pink-500/30 text-pink-300 px-3.5 py-2.5 rounded-xl flex items-center justify-between shadow-lg">
                  <div className="flex items-center gap-2">
                    <AlertCircle className="h-4.5 w-4.5 text-pink-400 shrink-0" />
                    <span className="text-xs font-medium truncate max-w-[180px]">VLM Action Alert Grid Sandbox</span>
                  </div>
                  <button 
                    id="test-close-btn"
                    className="p-1 hover:bg-pink-800/30 text-pink-400 hover:text-pink-300 rounded-md transition-colors cursor-pointer border border-pink-500/20 size-6 flex items-center justify-center font-bold font-sans"
                    onClick={handleAlertClose}
                    title="Close alert"
                  >
                    ✕
                  </button>
                </div>
              ) : (
                <div className="text-center py-6 text-xs text-gray-500 flex flex-col items-center gap-1.5">
                  <CheckCircle className="h-8 w-8 text-emerald-400" />
                  Alert closed. Click Reset to show alert.
                  <Button 
                    variant="link" 
                    size="sm" 
                    className="h-6 text-indigo-400 hover:text-indigo-300 text-xs mt-1" 
                    onClick={() => setAlertVisible(true)}
                  >
                    Reset Alert
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Card 2: Interactive Select (Dropdown Arrow) */}
          <Card className={`bg-[#111827] border-gray-800/80 hover:border-gray-700/80 transition-all duration-300 relative overflow-hidden flex flex-col justify-between ${
            currentTask?.id === 'dropdown' ? 'ring-2 ring-indigo-500 border-indigo-500 bg-indigo-950/10 scale-[1.01]' : ''
          }`}>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-bold tracking-tight text-white uppercase text-gray-400">02. Dropdown Selector</CardTitle>
              <CardDescription className="text-xs text-gray-400">Tests chevrons clicks and dropdown options mapping</CardDescription>
            </CardHeader>
            <CardContent className="flex-1 flex flex-col justify-center min-h-[120px] relative">
              <div className="relative">
                <button
                  id="test-dropdown-trigger"
                  onClick={() => {
                    setDropdownOpen(!dropdownOpen);
                    checkClickSuccess('test-dropdown-trigger');
                  }}
                  className="w-full flex items-center justify-between bg-gray-900 border border-gray-800 hover:border-gray-700 text-gray-200 px-3 py-2 rounded-xl text-xs font-semibold shadow-inner focus:outline-none transition-all cursor-pointer"
                >
                  <span className="truncate">{selectedDropdownOption || 'Select benchmark operator option...'}</span>
                  <ChevronDown className={`h-4 w-4 text-gray-500 transition-transform ${dropdownOpen ? 'transform rotate-180' : ''}`} />
                </button>
                
                {dropdownOpen && (
                  <div className="absolute top-[calc(100%+4px)] left-0 w-full bg-gray-900 border border-gray-800 rounded-xl shadow-xl z-20 py-1 overflow-hidden animate-in fade-in slide-in-from-top-1">
                    {['VLM-FastRun-Engine', 'OpenAI-Assistant-Run', 'NutJS-Computer-Drive'].map((opt) => (
                      <button
                        key={opt}
                        id={`test-dropdown-opt-${opt}`}
                        onClick={() => {
                          setSelectedDropdownOption(opt);
                          setDropdownOpen(false);
                          toast.success(`Option selected: ${opt}`);
                        }}
                        className="w-full text-left px-3.5 py-2 text-xs text-gray-300 hover:bg-gray-800 hover:text-white transition-colors cursor-pointer"
                      >
                        {opt}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Card 3: Stroop Color Contrast (Confusing Color Circles) */}
          <Card className={`bg-[#111827] border-gray-800/80 hover:border-gray-700/80 transition-all duration-300 relative overflow-hidden flex flex-col justify-between ${
            currentTask?.id === 'stroop_circle' ? 'ring-2 ring-indigo-500 border-indigo-500 bg-indigo-950/10 scale-[1.01]' : ''
          }`}>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-bold tracking-tight text-white uppercase text-gray-400">03. Stroop Color Circles</CardTitle>
              <CardDescription className="text-xs text-gray-400">Tests visual semantic mapping (Color Contrast challenge)</CardDescription>
            </CardHeader>
            <CardContent className="flex-1 flex items-center justify-center gap-3 min-h-[120px]">
              {/* Circle 1: Red circle with Blue text "green" */}
              <div 
                id="test-red-circle-blue-text"
                className="w-12 h-12 rounded-full bg-red-600 border border-red-500 shadow-md flex items-center justify-center cursor-pointer hover:opacity-90 active:scale-95 transition-all text-blue-300 text-xs font-black"
                title="Red circle with blue text green"
              >
                green
              </div>
              {/* Circle 2: Blue circle with Red text "red" (Target) */}
              <div 
                id="test-blue-circle-red-text"
                className="w-12 h-12 rounded-full bg-blue-600 border border-blue-500 shadow-lg flex items-center justify-center cursor-pointer hover:opacity-90 active:scale-95 transition-all text-red-500 text-xs font-bold ring-2 ring-transparent hover:ring-indigo-400"
                title="Blue circle with red text red"
              >
                red
              </div>
              {/* Circle 3: Green circle with Yellow text "blue" */}
              <div 
                id="test-green-circle-yellow-text"
                className="w-12 h-12 rounded-full bg-green-600 border border-green-500 shadow-md flex items-center justify-center cursor-pointer hover:opacity-90 active:scale-95 transition-all text-yellow-300 text-xs font-black"
                title="Green circle with yellow text blue"
              >
                blue
              </div>
              {/* Circle 4: Yellow circle with Black text "yellow" */}
              <div 
                id="test-yellow-circle-black-text"
                className="w-12 h-12 rounded-full bg-yellow-500 border border-yellow-400 shadow-md flex items-center justify-center cursor-pointer hover:opacity-90 active:scale-95 transition-all text-black text-xs font-black"
                title="Yellow circle with black text yellow"
              >
                yellow
              </div>
            </CardContent>
          </Card>

          {/* Card 4: Collapsible Panel (Expandable accordion) */}
          <Card className={`bg-[#111827] border-gray-800/80 hover:border-gray-700/80 transition-all duration-300 relative overflow-hidden flex flex-col justify-between ${
            currentTask?.id === 'collapsible' ? 'ring-2 ring-indigo-500 border-indigo-500 bg-indigo-950/10 scale-[1.01]' : ''
          }`}>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-bold tracking-tight text-white uppercase text-gray-400">04. Collapsible Panels</CardTitle>
              <CardDescription className="text-xs text-gray-400">Tests layout state expansion trigger</CardDescription>
            </CardHeader>
            <CardContent className="flex-1 flex flex-col justify-center min-h-[120px]">
              <Button
                id="test-collapsible-btn"
                variant="outline"
                className="w-full flex justify-between bg-gray-900 border-gray-800 hover:bg-gray-800 text-gray-300 text-xs font-semibold cursor-pointer rounded-xl h-9"
                onClick={handleCollapsibleClick}
              >
                <span>{collapsibleOpen ? 'Collapse Content' : 'Expand Panel'}</span>
                <ChevronDown className={`h-4 w-4 text-gray-500 transition-transform ${collapsibleOpen ? 'transform rotate-180' : ''}`} />
              </Button>
              {collapsibleOpen && (
                <div className="mt-2.5 p-2.5 bg-gray-950/60 rounded-xl border border-gray-800 text-[10px] text-gray-400 leading-relaxed animate-in slide-in-from-top-2 duration-200">
                  Collapsible content loaded successfully. VLM navigation can read the expanded nodes, triggering target inputs cleanly.
                </div>
              )}
            </CardContent>
          </Card>

          {/* Card 5: Shrinking Progress Bar */}
          <Card className={`bg-[#111827] border-gray-800/80 hover:border-gray-700/80 transition-all duration-300 relative overflow-hidden flex flex-col justify-between ${
            currentTask?.id === 'shrinking_bar' ? 'ring-2 ring-indigo-500 border-indigo-500 bg-indigo-950/10 scale-[1.01]' : ''
          }`}>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-bold tracking-tight text-white uppercase text-gray-400">05. Shrinking Progress Bar</CardTitle>
              <CardDescription className="text-xs text-gray-400">Tests timing and click landing on shrinking width bars</CardDescription>
            </CardHeader>
            <CardContent className="flex-1 flex flex-col justify-center min-h-[120px] px-2">
              <div 
                className="w-full bg-gray-950 h-8 rounded-xl border border-gray-800 overflow-hidden relative cursor-pointer group hover:border-indigo-500/30"
                id="test-shrinking-bar-wrapper"
              >
                <div 
                  id="test-shrinking-bar"
                  className="bg-gradient-to-r from-cyan-500 to-indigo-500 h-full rounded-xl animate-shrink-bar absolute left-0 top-0 shadow-lg shadow-cyan-950/20"
                />
                <div className="absolute inset-0 flex items-center justify-center text-[10px] font-bold tracking-wider text-white mix-blend-difference pointer-events-none uppercase">
                  Shrinking Target Bar
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Card 6: Pulsing and Layout Moving Items */}
          <Card className={`bg-[#111827] border-gray-800/80 hover:border-gray-700/80 transition-all duration-300 relative overflow-hidden flex flex-col justify-between ${
            currentTask?.id === 'pulsing_item' ? 'ring-2 ring-indigo-500 border-indigo-500 bg-indigo-950/10 scale-[1.01]' : ''
          }`}>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-bold tracking-tight text-white uppercase text-gray-400">06. Resizing Targets</CardTitle>
              <CardDescription className="text-xs text-gray-400">Tests tracking precision on pulsing, layout-shifting shapes</CardDescription>
            </CardHeader>
            <CardContent className="flex-1 flex items-center justify-center gap-6 min-h-[120px]">
              <div 
                id="test-pulsing-item"
                className="w-12 h-12 rounded-full bg-gradient-to-br from-rose-500 to-red-600 border border-rose-400 shadow-xl cursor-pointer hover:opacity-90 transition-all animate-pulsing hover:ring-2 hover:ring-rose-400 flex items-center justify-center text-[9px] font-black text-white uppercase tracking-wider"
                title="Pulsing red target"
              >
                pulsing
              </div>
              <div 
                id="test-static-item"
                className="w-12 h-12 rounded-full bg-gray-800 border border-gray-700 flex items-center justify-center text-[9px] font-bold text-gray-500 uppercase tracking-wider"
                title="Static circle"
              >
                static
              </div>
            </CardContent>
          </Card>

          {/* Card 7: Toggle Switch Targets */}
          <Card className={`bg-[#111827] border-gray-800/80 hover:border-gray-700/80 transition-all duration-300 relative overflow-hidden flex flex-col justify-between ${
            currentTask?.id === 'toggle_switch' ? 'ring-2 ring-indigo-500 border-indigo-500 bg-indigo-950/10 scale-[1.01]' : ''
          }`}>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-bold tracking-tight text-white uppercase text-gray-400">07. Toggle Switches</CardTitle>
              <CardDescription className="text-xs text-gray-400">Tests state switch targeting and toggle state trigger</CardDescription>
            </CardHeader>
            <CardContent className="flex-1 flex flex-col gap-4 justify-center min-h-[120px]">
              <div className="flex items-center justify-between bg-[#1f2937]/20 p-2 px-3 rounded-xl border border-gray-800/50">
                <span className="text-xs text-gray-300 font-semibold">Stroop Run Filter</span>
                <Switch id="test-blue-toggle" />
              </div>
              <div className="flex items-center justify-between bg-[#1f2937]/20 p-2 px-3 rounded-xl border border-gray-800/50">
                <span className="text-xs text-gray-300 font-semibold">Precision Test Run</span>
                <Switch 
                  id="test-green-toggle" 
                  checked={greenToggle} 
                  onCheckedChange={handleToggleChange}
                  className="data-[state=checked]:bg-emerald-500"
                />
              </div>
            </CardContent>
          </Card>

          {/* Card 8: Info / Instructions widget */}
          <Card className="bg-[#111827] border-dashed border-gray-800 hover:border-gray-700 transition-all duration-300 flex flex-col justify-between">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-bold tracking-tight text-gray-400 uppercase">Sandbox Environment</CardTitle>
              <CardDescription className="text-xs text-gray-400">Local evaluation guidelines</CardDescription>
            </CardHeader>
            <CardContent className="flex-1 flex flex-col justify-center text-xs text-gray-400 leading-relaxed gap-2">
              <div className="flex items-start gap-2">
                <Check className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
                <span>Make sure the application window is not minimized.</span>
              </div>
              <div className="flex items-start gap-2">
                <Check className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
                <span>The model uses Desktop screenshots to navigate.</span>
              </div>
              <div className="flex items-start gap-2">
                <Check className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
                <span>Clicking widgets manually triggers them normally.</span>
              </div>
            </CardContent>
          </Card>

        </div>

        {/* Footer Next Page button */}
        <div className="w-full pt-12 pb-6 border-t border-gray-900 flex flex-col items-center justify-center gap-4 bg-gradient-to-t from-gray-950 to-transparent">
          <Button
            id="test-next-page-btn"
            onClick={() => {
              checkClickSuccess('test-next-page-btn');
              toast.success('Next page action triggered!');
            }}
            className={`px-8 py-5 text-sm font-bold tracking-wide rounded-xl border bg-gray-900 border-gray-800 hover:bg-gray-800 text-gray-300 hover:text-white transition-all cursor-pointer shadow-lg hover:border-indigo-500/30 ${
              currentTask?.id === 'next_page_btn' ? 'ring-4 ring-indigo-500 ring-offset-2 ring-offset-[#0b0f19] scale-[1.03] animate-pulse' : ''
            }`}
          >
            Next Page / Step
          </Button>
          <div className="text-[10px] text-gray-500 uppercase tracking-widest font-semibold">
            VLM Benchmark Footer Widget
          </div>
        </div>

      </div>
    </div>
  );
}
