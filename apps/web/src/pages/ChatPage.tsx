/**
 * ChatPage — full-screen orchestrator chat.
 *
 * Defaults to the workspace orchestrator. Space managers appear as scoped
 * alternatives. History and direct threads stay available as a secondary
 * surface instead of being the default landing state.
 */

import { useEffect, useMemo, useState } from 'react';
import { useLocation, useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { Clock, Plus, Minimize2 } from 'lucide-react';
import type { ViewportContext } from '@agentis/core';
import { ThreadView } from '../components/chat/ThreadView';
import { SessionHistoryPanel } from '../components/chat/SessionHistoryPanel';
import {
  formatChatScopeDescriptor,
  formatChatScopePlaceholder,
} from '../components/chat/scopeIdentity';
import { api } from '../lib/api';
import { usePrimaryChatScopes } from '../components/chat/usePrimaryChatScopes';
import { useChatPanelStore } from '../components/chat/ChatPanelStore';
import { clearDraft } from '../components/ChatPanel/Composer';
import { RoomCreateDialog } from '../components/chat/RoomCreateDialog';

type Selected = { kind: 'room' | 'agent'; id: string; name: string; conversationId?: string | null; archivedAt?: string | null };
type ChatRouteState = { viewportOverride?: ViewportContext | null };

export function ChatPage() {
  const { agentId } = useParams<{ agentId?: string }>();
  const nav = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const intent = searchParams.get('intent');
  const routedDraft = searchParams.get('draft')?.trim() ?? '';
  const autoSendInitialDraft = searchParams.get('send') === '1';
  const appCreationMode = intent === 'new-app';
  const routeState = (location.state as ChatRouteState | null) ?? null;
  const [selected, setSelected] = useState<Selected | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [roomCreateOpen, setRoomCreateOpen] = useState(false);
  const { loading, orchestrator, scopes, workspaceName, missingOrchestrator } = usePrimaryChatScopes();
  const { setState: setPanelState } = useChatPanelStore();

  const currentThread = selected ?? (orchestrator ? { kind: 'agent' as const, id: orchestrator.id, name: orchestrator.name } : null);
  const currentScope = currentThread?.kind === 'agent'
    ? scopes.find((scope) => scope.id === currentThread.id) ?? null
    : null;
  const scopeIds = useMemo(() => new Set(scopes.map((scope) => scope.id)), [scopes]);
  const showingSecondaryThread = Boolean(selected && !scopeIds.has(selected.id));

  useEffect(() => {
    if (agentId) {
      // Pre-select the agent — name is unknown until thread loads, use placeholder
      setSelected((current) => current?.kind === 'agent' && current.id === agentId
        ? current
        : { kind: 'agent', id: agentId, name: 'Agent' });
    } else {
      setSelected(null);
    }
  }, [agentId]);

  useEffect(() => {
    if (!agentId) return;
    void api<{ agent: { id: string; name: string } }>(`/v1/agents/${agentId}`)
      .then((data) => setSelected({ kind: 'agent', id: data.agent.id, name: data.agent.name }))
      .catch(() => {});
  }, [agentId]);

  const appCreationDraft = appCreationMode
    ? '/newapp '
    : undefined;
  const initialDraft = appCreationDraft ?? (routedDraft || undefined);

  function requestNewChat() {
    if (!currentThread) return;
    clearDraft(`${currentThread.kind}:${currentThread.id}`);
    if (currentThread.kind === 'agent') {
      window.dispatchEvent(new CustomEvent('agentis:chat-new-conversation', {
        detail: { kind: currentThread.kind, id: currentThread.id },
      }));
      return;
    }
    setRoomCreateOpen(true);
  }

  return (
    <div className="flex h-full">
      <aside className="flex w-80 shrink-0 flex-col border-r border-line bg-surface">
        <header className="flex h-12 items-center justify-between border-b border-line px-3">
          <span className="text-subheading text-text-primary">Chat</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setHistoryOpen(true)}
              aria-label="History"
              title="History"
              className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
            >
              <Clock size={14} />
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {historyOpen ? (
            <SessionHistoryPanel
              onBack={() => setHistoryOpen(false)}
              onOpenAgent={(id, name, options) => {
                setHistoryOpen(false);
                setSelected({ kind: 'agent', id, name, conversationId: options?.conversationId ?? null, archivedAt: options?.archivedAt ?? null });
                nav(`/chat/agent/${id}`, { replace: true });
              }}
              onOpenRoom={(id, name) => {
                setHistoryOpen(false);
                setSelected({ kind: 'room', id, name });
                nav('/chat', { replace: true });
              }}
              onOpenBroadcast={() => {
                setHistoryOpen(false);
                setSelected({ kind: 'room', id: '__broadcast__', name: 'Fleet broadcast' });
                nav('/chat', { replace: true });
              }}
            />
          ) : loading ? (
            <div className="space-y-2 px-3 py-4">
              <div className="h-8 rounded bg-surface-2" />
              <div className="h-8 rounded bg-surface-2" />
            </div>
          ) : missingOrchestrator && !selected ? (
            <EmptyOrchestratorState onOpenAgents={() => nav('/agents')} compact />
          ) : (
            <div className="p-3">
              {selected && (
                <button
                  type="button"
                  onClick={() => {
                    setSelected(null);
                    nav(appCreationMode ? '/chat?intent=new-app' : '/chat', { replace: true });
                  }}
                  className="mt-2 w-full rounded-btn border border-line bg-surface-2 px-3 py-2 text-[12px] text-text-secondary hover:bg-surface-3 hover:text-text-primary"
                >
                  Back to {orchestrator?.name ?? 'orchestrator'}
                </button>
              )}
            </div>
          )}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {currentThread ? (
          <>
            <header className="flex h-12 items-center justify-between border-b border-line bg-surface px-4">
              <div>
                <div className="text-subheading text-text-primary">
                  {currentThread.name}
                </div>
                <div className="text-[11px] text-text-muted">
                  {appCreationMode
                    ? 'New app creation'
                    : currentThread.kind === 'room'
                      ? 'Room'
                      : currentScope
                        ? formatChatScopeDescriptor(currentScope, workspaceName)
                          : 'Direct thread'}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {showingSecondaryThread && (
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(null);
                      nav(appCreationMode ? '/chat?intent=new-app' : '/chat', { replace: true });
                    }}
                    className="rounded-btn border border-line bg-surface-2 px-3 py-1.5 text-[11px] text-text-secondary hover:bg-surface-3 hover:text-text-primary"
                  >
                    Back to {orchestrator?.name ?? 'orchestrator'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={requestNewChat}
                  aria-label="New chat"
                  title="New chat"
                  className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
                >
                  <Plus size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPanelState('docked');
                    nav('/');
                  }}
                  aria-label="Minimize to panel"
                  title="Minimize to panel"
                  className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
                >
                  <Minimize2 size={14} />
                </button>
              </div>
            </header>
            <div className="min-h-0 flex-1">
              <ThreadView
                key={`${currentThread.kind}:${currentThread.id}:${currentThread.conversationId ?? 'active'}`}
                kind={currentThread.kind}
                id={currentThread.id}
                name={currentThread.name}
                conversationId={currentThread.kind === 'agent' ? currentThread.conversationId ?? null : null}
                archivedAt={currentThread.kind === 'agent' ? currentThread.archivedAt ?? null : null}
                initialDraft={initialDraft}
                initialViewportOverride={routeState?.viewportOverride ?? null}
                autoSendInitialDraft={autoSendInitialDraft && !appCreationMode}
                composerPlaceholder={
                  appCreationMode
                    ? 'Describe what the app should do...'
                    : currentThread.kind === 'agent'
                      ? formatChatScopePlaceholder(currentThread.name)
                      : undefined
                }
                emptyBody={appCreationMode ? 'Describe the app you want. The orchestrator can design it, confirm the plan, and create it for you.' : undefined}
                onConversationReset={(conversationId) => {
                  if (currentThread.kind !== 'agent') return;
                  setSelected({ kind: 'agent', id: currentThread.id, name: currentThread.name, conversationId, archivedAt: null });
                  nav(`/chat/agent/${currentThread.id}`, { replace: true });
                }}
              />
            </div>
          </>
        ) : loading ? (
          <div className="flex h-full items-center justify-center text-[13px] text-text-muted">Loading chat...</div>
        ) : missingOrchestrator ? (
          <EmptyOrchestratorState onOpenAgents={() => nav('/agents')} />
        ) : (
          <div className="flex h-full items-center justify-center">
            <div className="max-w-md px-8 text-center">
              <div className="mb-3 text-heading text-text-primary">{appCreationMode ? 'Finding your orchestrator' : 'Select a scope'}</div>
              <p className="text-[13px] text-text-secondary">
                {appCreationMode
                  ? 'Agentis will open the orchestrator thread for creating a new app.'
                  : 'Choose the workspace orchestrator or a space manager from the left.'}
              </p>
            </div>
          </div>
        )}
      </section>
      <RoomCreateDialog
        open={roomCreateOpen}
        onClose={() => setRoomCreateOpen(false)}
        onCreated={(room) => {
          setRoomCreateOpen(false);
          setHistoryOpen(false);
          setSelected({ kind: 'room', id: room.id, name: room.name });
          nav('/chat', { replace: true });
        }}
      />
    </div>
  );
}

function EmptyOrchestratorState({
  onOpenAgents,
  compact = false,
}: {
  onOpenAgents: () => void;
  compact?: boolean;
}) {
  return (
    <div className={compact ? 'px-4 py-6 text-center' : 'flex h-full flex-col items-center justify-center px-8 text-center'}>
      <div className="mb-2 text-sm font-medium text-text-primary">Commission your orchestrator</div>
      <p className="mb-4 text-[12px] text-text-muted">
        This workspace does not have an orchestrator yet. Create one to turn chat into the platform command surface.
      </p>
      <button
        type="button"
        onClick={onOpenAgents}
        className="rounded-btn bg-accent px-3 py-2 text-[12px] font-medium text-canvas hover:opacity-90"
      >
        Open agents
      </button>
    </div>
  );
}
