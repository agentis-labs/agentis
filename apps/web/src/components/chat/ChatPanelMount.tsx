import { lazy, Suspense, useEffect } from 'react';
import type { ViewportContext } from '@agentis/core';
import { useChatPanelStore } from './ChatPanelStore';
import { FloatingTaskProgress } from './FloatingTaskProgress';

const LazyChatPanel = lazy(() => import('./ChatPanel').then((m) => ({ default: m.ChatPanel })));

interface ChatPanelOpenDetail {
  agentId?: string;
  roomId?: string;
  name?: string;
  mode?: 'docked' | 'fullscreen';
  initialDraft?: string;
  initialViewportOverride?: ViewportContext | null;
  viewportOverride?: ViewportContext | null;
  autoSendInitialDraft?: boolean;
}

export function ChatPanelMount() {
  const state = useChatPanelStore((store) => store.state);
  const dockedWidth = useChatPanelStore((store) => store.dockedWidth);
  const openChat = useChatPanelStore((store) => store.openChat);

  useEffect(() => {
    function onOpen(event: Event) {
      const detail = (event as CustomEvent<ChatPanelOpenDetail>).detail;
      const launchContext = detail?.initialDraft || detail?.viewportOverride || detail?.initialViewportOverride
        ? {
            initialDraft: detail.initialDraft,
            initialViewportOverride: detail.initialViewportOverride ?? detail.viewportOverride ?? null,
            autoSendInitialDraft: detail.autoSendInitialDraft,
          }
        : null;
      if (detail?.agentId) {
        openChat({
          state: detail.mode ?? 'docked',
          thread: { kind: 'agent', id: detail.agentId, name: detail.name ?? 'Conversation' },
          launchContext,
        });
      } else if (detail?.roomId) {
        openChat({
          state: detail.mode ?? 'docked',
          thread: { kind: 'room', id: detail.roomId, name: detail.name ?? 'Room' },
          launchContext,
        });
      } else {
        openChat({ state: detail?.mode ?? 'docked', thread: null, launchContext });
      }
    }
    window.addEventListener('agentis:chat-panel-open', onOpen);
    return () => window.removeEventListener('agentis:chat-panel-open', onOpen);
  }, [openChat]);

  return (
    <>
      {state === 'hidden' && <FloatingTaskProgress />}
      <Suspense fallback={<ChatPanelFallback width={dockedWidth} fullscreen={state === 'fullscreen'} />}>
        <LazyChatPanel />
      </Suspense>
    </>
  );
}

function ChatPanelFallback({ width, fullscreen }: { width: number; fullscreen?: boolean }) {
  return (
    <aside
      className={fullscreen
        ? 'fixed inset-3 z-50 flex min-w-0 flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-modal md:inset-5'
        : 'relative z-30 flex min-w-0 shrink-0 flex-col overflow-hidden border-l border-line bg-surface'}
      style={fullscreen ? undefined : { width: `min(${width}px, 100vw)`, maxWidth: '100vw' }}
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
