import { lazy, Suspense, useEffect } from 'react';
import type { ViewportContext } from '@agentis/core';
import { useChatPanelStore } from './ChatPanelStore';

const LazyChatPanel = lazy(() => import('./ChatPanel').then((m) => ({ default: m.ChatPanel })));

interface ChatPanelOpenDetail {
  agentId?: string;
  roomId?: string;
  name?: string;
  initialDraft?: string;
  initialViewportOverride?: ViewportContext | null;
  viewportOverride?: ViewportContext | null;
  autoSendInitialDraft?: boolean;
  buildSession?: { appId?: string; slug?: string; name?: string };
}

export function ChatPanelMount() {
  const state = useChatPanelStore((store) => store.state);
  const dockedWidth = useChatPanelStore((store) => store.dockedWidth);
  const setState = useChatPanelStore((store) => store.setState);
  const selectThread = useChatPanelStore((store) => store.selectThread);
  const setLaunchContext = useChatPanelStore((store) => store.setLaunchContext);
  const markOpenRequested = useChatPanelStore((store) => store.markOpenRequested);

  useEffect(() => {
    function onOpen(event: Event) {
      const detail = (event as CustomEvent<ChatPanelOpenDetail>).detail;
      setState('docked');
      markOpenRequested();
      setLaunchContext(detail?.initialDraft || detail?.viewportOverride || detail?.initialViewportOverride || detail?.buildSession
        ? {
            initialDraft: detail.initialDraft,
            initialViewportOverride: detail.initialViewportOverride ?? detail.viewportOverride ?? null,
            autoSendInitialDraft: detail.autoSendInitialDraft,
            buildSession: detail.buildSession,
          }
        : null);
      if (detail?.agentId) {
        selectThread({ kind: 'agent', id: detail.agentId, name: detail.name ?? 'Conversation' });
      } else if (detail?.roomId) {
        selectThread({ kind: 'room', id: detail.roomId, name: detail.name ?? 'Room' });
      } else {
        selectThread(null);
      }
    }
    window.addEventListener('agentis:chat-panel-open', onOpen);
    return () => window.removeEventListener('agentis:chat-panel-open', onOpen);
  }, [markOpenRequested, selectThread, setLaunchContext, setState]);

  if (state === 'hidden') return null;

  return (
    <Suspense fallback={<ChatPanelFallback width={dockedWidth} />}>
      <LazyChatPanel />
    </Suspense>
  );
}

function ChatPanelFallback({ width }: { width: number }) {
  return (
    <aside
      className="relative z-30 flex shrink-0 flex-col border-l border-line bg-surface"
      style={{ width }}
      role="complementary"
      aria-label="Chat panel"
    >
      <div className="flex h-12 shrink-0 items-center border-b border-line px-3">
        <div className="h-3 w-28 rounded bg-surface-2" />
      </div>
      <div className="space-y-2 p-3">
        <div className="h-8 rounded bg-surface-2" />
        <div className="h-20 rounded bg-surface-2" />
      </div>
    </aside>
  );
}
