import { MessageCirclePlus } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Card } from '@renderer/components/ui/card';
import { Button } from '@renderer/components/ui/button';
import { SidebarTrigger, useSidebar } from '@renderer/components/ui/sidebar';
import { NavHeader } from '@renderer/components/Detail/NavHeader';
import { ScrollArea } from '@renderer/components/ui/scroll-area';

import { useStore } from '@renderer/hooks/useStore';
import { useSession } from '@renderer/hooks/useSession';
import Prompts from '../../components/Prompts';
import { IMAGE_PLACEHOLDER } from '@ui-tars/shared/constants';
import {
  AssistantTextMessage,
  HumanTextMessage,
  ScreenshotMessage,
} from '../../components/RunMessages/Messages';
import ThoughtChain from '../../components/ThoughtChain';
import { api } from '../../api';
import { PredictionParsed, StatusEnum } from '@ui-tars/shared/types';
import { RouterState } from '../../typings';
import ChatInput from '../../components/ChatInput';
import { NavDialog } from '../../components/AlertDialog/navDialog';
import {
  checkVLMSettings,
  LocalSettingsDialog,
} from '../../components/Settings/local';
import { sleep } from '@ui-tars/shared/utils';

const getFinishedContent = (predictionParsed?: PredictionParsed[]) =>
  predictionParsed?.find(
    (step) =>
      step.action_type === 'finished' &&
      typeof step.action_inputs?.content === 'string' &&
      step.action_inputs.content.trim() !== '',
  )?.action_inputs?.content as string | undefined;

const LocalOperator = () => {
  const state = useLocation().state as RouterState;
  const navigate = useNavigate();
  const { setOpen } = useSidebar();

  const { status, messages = [], thinking, errorMsg } = useStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const suggestions: string[] = [];
  const [initId, setInitId] = useState('');
  const {
    currentSessionId,
    setActiveSession,
    updateMessages,
    createSession,
    chatMessages,
  } = useSession();
  const [pendingAction, setPendingAction] = useState<'newChat' | 'back' | null>(
    null,
  );
  const [isNavDialogOpen, setNavDialogOpen] = useState(false);
  const [localOpen, setLocalOpen] = useState(false);

  useEffect(() => {
    const update = async () => {
      if (state.sessionId) {
        await setActiveSession(state.sessionId);
        setInitId(state.sessionId);
      }
    };
    update();
    setOpen(false);
  }, [state.sessionId]);

  useEffect(() => {
    if (initId !== state.sessionId) {
      return;
    }

    if (
      state.sessionId &&
      currentSessionId &&
      state.sessionId !== currentSessionId
    ) {
      return;
    }

    if (messages.length) {
      const existingMessagesSet = new Set(
        chatMessages.map(
          (msg) => `${msg.value}-${msg.from}-${msg.timing?.start}`,
        ),
      );
      const newMessages = messages.filter(
        (msg) =>
          !existingMessagesSet.has(
            `${msg.value}-${msg.from}-${msg.timing?.start}`,
          ),
      );
      const allMessages = [...chatMessages, ...newMessages];

      updateMessages(state.sessionId, allMessages);
    }
  }, [
    initId,
    state.sessionId,
    currentSessionId,
    chatMessages.length,
    messages.length,
  ]);



  useEffect(() => {
    setTimeout(() => {
      containerRef.current?.scrollIntoView(false);
    }, 100);
  }, [messages, thinking, errorMsg]);

  const handleSelect = async (suggestion: string) => {
    await api.setInstructions({ instructions: suggestion });
  };

  const handleImageSelect = async (_index: number) => {
    // No-op. The right-panel screenshot viewer has been replaced by the inline HiBeeLiveView status banner.
  };

  // check status before nav
  const needsConfirm =
    status === StatusEnum.RUNNING ||
    status === StatusEnum.CALL_USER ||
    status === StatusEnum.PAUSE;

  const onNewChat = useCallback(async () => {
    const session = await createSession('New Session', {
      operator: state.operator,
    });

    navigate('/local', {
      state: {
        operator: state.operator,
        sessionId: session?.id,
        from: 'new',
      },
    });
  }, []);

  const onBack = useCallback(async () => {
    navigate('/');
  }, []);

  const handleNewChat = useCallback(() => {
    if (needsConfirm) {
      setPendingAction('newChat');
      setNavDialogOpen(true);
    } else {
      onNewChat();
    }
  }, [needsConfirm]);

  const handleBack = useCallback(() => {
    if (needsConfirm) {
      setPendingAction('back');
      setNavDialogOpen(true);
    } else {
      onBack();
    }
  }, [needsConfirm]);

  const onConfirm = useCallback(async () => {
    await api.stopRun();
    await api.clearHistory();

    if (pendingAction === 'newChat') {
      await onNewChat();
    } else if (pendingAction === 'back') {
      await onBack();
    }
    setPendingAction(null);
    setNavDialogOpen(false);
  }, [pendingAction]);

  const onCancel = useCallback(() => {
    setPendingAction(null);
    setNavDialogOpen(false);
  }, []);

  const handleLocalSettingsSubmit = async () => {
    setLocalOpen(false);

    await sleep(200);
  };

  const handleLocalSettingsClose = () => {
    setLocalOpen(false);
  };

  const checkVLM = async () => {
    const hasVLM = await checkVLMSettings();

    if (hasVLM) {
      return true;
    } else {
      setLocalOpen(true);
      return false;
    }
  };

  const renderStatusArea = () => {
    return null;
  };

  const renderChatList = () => {
    return (
      <ScrollArea className="h-full px-4">
        <div ref={containerRef}>
          {!chatMessages?.length && suggestions?.length > 0 && (
            <Prompts suggestions={suggestions} onSelect={handleSelect} />
          )}

          {chatMessages?.map((message, idx) => {
            if (message?.from === 'human') {
              if (message?.value === IMAGE_PLACEHOLDER) {
                // screen shot
                return (
                  <ScreenshotMessage
                    key={`message-${idx}`}
                    onClick={() => handleImageSelect(idx)}
                  />
                );
              }

              return (
                <HumanTextMessage
                  key={`message-${idx}`}
                  text={message?.value}
                />
              );
            }

            const { predictionParsed, screenshotBase64WithElementMarker } =
              message;

            // Find the finished step (VL 1.5 Model)
            const finishedStep = getFinishedContent(predictionParsed);

            return (
              <div key={idx}>
                {predictionParsed?.length ? (
                  <ThoughtChain
                    steps={predictionParsed}
                    hasSomImage={!!screenshotBase64WithElementMarker}
                    onClick={() => handleImageSelect(idx)}
                  />
                ) : null}

                {!!finishedStep && <AssistantTextMessage text={finishedStep} />}
              </div>
            );
          })}

          {/* Status area replaces old generic thinking/error lines */}
          {renderStatusArea()}
        </div>
      </ScrollArea>
    );
  };

  const [isExtensionConnected, setIsExtensionConnected] = useState<boolean | null>(null);

  useEffect(() => {
    // Check initial status
    window.electron?.ipcRenderer?.invoke('isExtensionInstalled').then(setIsExtensionConnected).catch(console.error);

    // Listen for connection changes
    const handler = (_event, data: any) => {
      if (data && typeof data.installed === 'boolean') {
        setIsExtensionConnected(data.installed);
      }
    };
    const unsubscribe = window.electron?.ipcRenderer?.on('extension:status' as any, handler);
    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, []);

  const renderExtensionOnboarding = () => {
    return (
      <div className="mx-4 mt-4 p-4 bg-slate-800 rounded-lg border border-slate-700 shadow-lg flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-white flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
            </span>
            Gemini Extension Not Connected
          </h3>
          <p className="text-sm text-slate-400 mt-1">
            Background DOM automation requires the companion extension. Enable Developer Mode in <code className="bg-slate-900 px-1 py-0.5 rounded text-blue-300">chrome://extensions/</code> and Load Unpacked.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button 
            variant="secondary" 
            size="sm" 
            className="whitespace-nowrap"
            onClick={() => navigator.clipboard.writeText('c:\\Users\\msjan\\Desktop\\UI-TARS-desktop\\extension')}
          >
            Copy Extension Path
          </Button>
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col w-full h-full relative">
      <NavHeader
        title={state.operator}
        onBack={handleBack}
      ></NavHeader>
      {isExtensionConnected === false && renderExtensionOnboarding()}
      <div className="px-5 pb-5 flex flex-1 gap-5">
        {/* Single full-width panel — Hi-Bee replaces the old right screenshot viewer */}
        <Card className="flex-1 px-0 py-4 gap-4 h-[calc(100vh-76px)]">
          <div className="flex items-center justify-between w-full px-4">
            <SidebarTrigger
              variant="secondary"
              className="size-8"
            ></SidebarTrigger>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => navigate('/gestures')}>
                ✋ Gestures
              </Button>
              <Button variant="outline" size="sm" onClick={handleNewChat}>
                <MessageCirclePlus />
                New Chat
              </Button>
            </div>
          </div>
          {renderChatList()}
          <ChatInput
            disabled={false}
            operator={state.operator}
            sessionId={state.sessionId}
            checkBeforeRun={checkVLM}
          />
        </Card>
      </div>
      <NavDialog
        open={isNavDialogOpen}
        onOpenChange={onCancel}
        onConfirm={onConfirm}
      />
      <LocalSettingsDialog
        isOpen={localOpen}
        onSubmit={handleLocalSettingsSubmit}
        onClose={handleLocalSettingsClose}
      />
    </div>
  );
};

export default LocalOperator;
