/**
 * ChatPage is a compatibility shim.
 *
 * The real chat surface is the persistent ChatPanel mounted by App. Visiting
 * /chat or /chat/agent/:agentId opens that surface in fullscreen mode, then
 * returns the URL to the previous app page so expanding chat never remounts the
 * active ThreadView.
 */

import { useEffect, useMemo } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { ViewportContext } from '@agentis/core';
import { useChatPanelStore, type ChatPanelLaunchContext, type ChatPanelThread } from '../components/chat/ChatPanelStore';
import { api } from '../lib/api';

type ChatRouteState = {
  returnTo?: string | null;
  viewportOverride?: ViewportContext | null;
};

function safeReturnPath(path: string | null | undefined): string {
  if (!path || !path.startsWith('/') || path.startsWith('//') || path.startsWith('/chat')) {
    return '/home';
  }
  return path;
}

export function ChatPage() {
  const { agentId } = useParams<{ agentId?: string }>();
  const nav = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const openChat = useChatPanelStore((store) => store.openChat);
  const storedReturnPath = useMemo(() => useChatPanelStore.getState().returnPath, []);
  const routeState = (location.state as ChatRouteState | null) ?? null;

  const launchContext = useMemo<ChatPanelLaunchContext | null>(() => {
    const draft = searchParams.get('draft')?.trim() ?? '';
    const viewportOverride = routeState?.viewportOverride ?? null;
    if (!draft && !viewportOverride && searchParams.get('send') !== '1') return null;
    return {
      initialDraft: draft || undefined,
      initialViewportOverride: viewportOverride,
      autoSendInitialDraft: searchParams.get('send') === '1',
    };
  }, [routeState?.viewportOverride, searchParams]);

  useEffect(() => {
    let cancelled = false;
    const returnPath = safeReturnPath(routeState?.returnTo ?? storedReturnPath);

    async function openPersistentChat() {
      let thread: ChatPanelThread = null;
      if (agentId) {
        thread = { kind: 'agent', id: agentId, name: 'Agent' };
        try {
          const data = await api<{ agent: { id: string; name: string } }>(`/v1/agents/${agentId}`);
          thread = { kind: 'agent', id: data.agent.id, name: data.agent.name };
        } catch {
          // Keep the route useful even when the agent lookup is unavailable.
        }
      }

      if (cancelled) return;
      openChat({
        state: 'fullscreen',
        thread,
        launchContext,
        returnPath,
      });
      nav(returnPath, { replace: true });
    }

    void openPersistentChat();

    return () => {
      cancelled = true;
    };
  }, [agentId, launchContext, nav, openChat, routeState?.returnTo, storedReturnPath]);

  return (
    <main className="grid min-h-full place-items-center bg-canvas px-6 text-center text-[13px] text-text-muted">
      Opening chat...
    </main>
  );
}
