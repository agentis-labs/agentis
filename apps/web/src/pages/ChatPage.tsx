/**
 * ChatPage — full-screen orchestrator chat.
 *
 * Defaults to the workspace orchestrator. Space managers appear as scoped
 * alternatives. History and direct threads stay available as a secondary
 * surface instead of being the default landing state.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { Activity, Plus, Minimize2, X, PanelLeftClose, PanelLeftOpen, Globe, MessageSquare } from 'lucide-react';
import { REALTIME_EVENTS, type ViewportContext } from '@agentis/core';
import { ThreadView } from '../components/chat/ThreadView';
import { SessionHistoryPanel, HarnessBadge } from '../components/chat/SessionHistoryPanel';
import { ChatCanvasPreview } from '../components/chat/ChatCanvasPreview';
import {
  mergeWorkflowStageTarget,
  workflowStageTargetFromBuildPayload,
  type WorkflowStageTarget,
} from '../components/chat/workflowStage';
import {
  formatChatScopeDescriptor,
  formatChatScopePlaceholder,
} from '../components/chat/scopeIdentity';
import { api } from '../lib/api';
import { usePrimaryChatScopes } from '../components/chat/usePrimaryChatScopes';
import { useChatPanelStore } from '../components/chat/ChatPanelStore';
import { clearDraft } from '../components/chat/Composer';
import { RoomCreateDialog } from '../components/chat/RoomCreateDialog';
import { useRealtime } from '../lib/realtime';
import { ChatShortcutsModal } from '../components/chat/ChatShortcutsModal';
import { AgentModelSelector } from '../components/chat/AgentModelSelector';

type Selected = {
  kind: 'room' | 'agent';
  id: string;
  name: string;
  conversationId?: string | null;
  archivedAt?: string | null;
  adapterType?: string | null;
};
type ChatRouteState = { viewportOverride?: ViewportContext | null };

export function ChatPage() {
  const { agentId } = useParams<{ agentId?: string }>();
  const nav = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const routedDraft = searchParams.get('draft')?.trim() ?? '';
  const autoSendInitialDraft = searchParams.get('send') === '1';
  const routeState = (location.state as ChatRouteState | null) ?? null;
  const [selected, setSelected] = useState<Selected | null>(null);
  const [historyOpen, setHistoryOpen] = useState(true);
  const [roomCreateOpen, setRoomCreateOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [taskDismissed, setTaskDismissed] = useState(false);
  const [agentAdapterMap, setAgentAdapterMap] = useState<Record<string, string>>({});
  const [newChatMenuOpen, setNewChatMenuOpen] = useState(false);
  const newChatMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!newChatMenuOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (newChatMenuRef.current?.contains(e.target as Node)) return;
      setNewChatMenuOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [newChatMenuOpen]);

  const [activeCanvas, setActiveCanvas] = useState<WorkflowStageTarget | null>(null);
  const dismissedCanvasWorkflowIdsRef = useRef(new Set<string>());

  const { loading, orchestrator, scopes, workspaceName, missingOrchestrator } = usePrimaryChatScopes();
  const { setState: setPanelState } = useChatPanelStore();
  const activeTask = useChatPanelStore((store) => store.activeTask);

  const currentThread = selected ?? (orchestrator ? { kind: 'agent' as const, id: orchestrator.id, name: orchestrator.name } : null);
  const currentScope = currentThread?.kind === 'agent'
    ? scopes.find((scope) => scope.id === currentThread.id) ?? null
    : null;
  const scopeIds = useMemo(() => new Set(scopes.map((scope) => scope.id)), [scopes]);
  const showingSecondaryThread = Boolean(selected && !scopeIds.has(selected.id));

  const currentAdapterType = currentThread?.kind === 'agent'
    ? (currentThread.adapterType || agentAdapterMap[currentThread.id])
    : null;

  useEffect(() => {
    api<{ agents: Array<{ id: string; adapterType: string }> }>('/v1/agents')
      .then((data) => {
        const map: Record<string, string> = {};
        for (const a of data.agents ?? []) {
          map[a.id] = a.adapterType;
        }
        setAgentAdapterMap(map);
      })
      .catch(() => {});
  }, []);

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
    void api<{ agent: { id: string; name: string; adapterType?: string | null } }>(`/v1/agents/${agentId}`)
      .then((data) => setSelected({
        kind: 'agent',
        id: data.agent.id,
        name: data.agent.name,
        adapterType: data.agent.adapterType
      }))
      .catch(() => {});
  }, [agentId]);

  useEffect(() => {
    function onConversationDeleted() {
      setSelected(null);
      nav('/chat', { replace: true });
    }
    window.addEventListener('agentis:active-conversation-deleted', onConversationDeleted);
    return () => {
      window.removeEventListener('agentis:active-conversation-deleted', onConversationDeleted);
    };
  }, [nav]);

  // Global listener for previewing canvas in split view instead of navigating
  useEffect(() => {
    function onPreviewCanvas(event: Event) {
      const detail = (event as CustomEvent<{ workflowId: string; runId?: string }>).detail;
      if (detail?.workflowId) {
        dismissedCanvasWorkflowIdsRef.current.delete(detail.workflowId);
        setActiveCanvas((current) => mergeWorkflowStageTarget(current, detail));
      }
    }
    window.addEventListener('agentis:preview-canvas', onPreviewCanvas);
    return () => window.removeEventListener('agentis:preview-canvas', onPreviewCanvas);
  }, []);

  useRealtime([REALTIME_EVENTS.WORKFLOW_BUILD_PHASE], (env) => {
    const target = workflowStageTargetFromBuildPayload(env.payload);
    if (!target || currentThread?.kind !== 'agent') return;
    if (target.agentId && target.agentId !== currentThread.id) return;
    if (dismissedCanvasWorkflowIdsRef.current.has(target.workflowId)) return;
    setActiveCanvas((current) => mergeWorkflowStageTarget(current, target));
  });

  // Reset taskDismissed when activeTask changes or becomes null
  useEffect(() => {
    setTaskDismissed(false);
  }, [activeTask?.agentId, activeTask?.label]);

  const initialDraft = routedDraft || undefined;

  function requestNewChat() {
    const targetAgentId = currentThread?.kind === 'agent' ? currentThread.id : orchestrator?.id;
    if (!targetAgentId) {
      if (currentThread?.kind === 'room') {
        setRoomCreateOpen(true);
      }
      return;
    }
    clearDraft(`agent:${targetAgentId}`);
    window.dispatchEvent(new CustomEvent('agentis:chat-new-conversation', {
      detail: { kind: 'agent', id: targetAgentId },
    }));
  }

  // Keyboard Shortcuts Global Listener
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const isInput = target.tagName === 'INPUT' ||
                      target.tagName === 'TEXTAREA' ||
                      target.tagName === 'SELECT' ||
                      target.isContentEditable;
      if (isInput) return;

      const key = e.key.toLowerCase();
      if (key === '?') {
        e.preventDefault();
        setShortcutsOpen((o) => !o);
      } else if (key === 'n') {
        e.preventDefault();
        requestNewChat();
      } else if (key === 'h') {
        e.preventDefault();
        setHistoryOpen((h) => !h);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentThread, orchestrator]);

  return (
    <div className="flex h-full overflow-hidden bg-surface relative">
      {/* Sidebar: Styled glass sidebar with a subtle top accent gradient */}
      <aside
        className={`flex shrink-0 flex-col border-r border-glass-border bg-glass-panel backdrop-blur-xl transition-all duration-300 shadow-card relative ${
          !historyOpen
            ? 'w-0 border-r-0 opacity-0 overflow-hidden pointer-events-none'
            : activeCanvas
            ? 'w-56'
            : 'w-72'
        }`}
      >
        {/* Top accent gradient line decoration */}
        <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-accent/20 via-accent to-accent/20 z-10" />

        <header className="flex h-12 items-center justify-between border-b border-line px-3 relative z-10">
          <span className="text-subheading text-text-primary ml-1">{activeCanvas ? 'Sessions' : 'Chat Sessions'}</span>
          <div className="flex items-center gap-1 relative" ref={newChatMenuRef}>
            <button
              type="button"
              onClick={() => setNewChatMenuOpen((o) => !o)}
              aria-label="New chat options"
              title="New chat options"
              className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
            >
              <Plus size={14} />
            </button>
            {newChatMenuOpen && (
              <div className="absolute left-0 top-full z-50 mt-1 w-48 overflow-hidden rounded-card border border-line bg-surface shadow-dropdown animate-in fade-in slide-in-from-top-1 duration-200">
                <button
                  type="button"
                  onClick={() => {
                    setNewChatMenuOpen(false);
                    requestNewChat();
                  }}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-surface-2"
                >
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded border border-line bg-surface-2 text-text-muted">
                    <MessageSquare size={12} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-medium text-text-primary">New Agent Chat</span>
                  </span>
                </button>
                <div className="h-px bg-line/60 mx-2" />
                <button
                  type="button"
                  onClick={() => {
                    setNewChatMenuOpen(false);
                    setSelected({ kind: 'room', id: '__broadcast__', name: 'Global Chat' });
                    nav('/chat', { replace: true });
                  }}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-surface-2"
                >
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded border border-line bg-surface-2 text-text-muted">
                    <Globe size={12} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-medium text-text-primary">Global Chat</span>
                  </span>
                </button>
              </div>
            )}
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="space-y-2 px-3 py-4">
              <div className="h-8 rounded bg-surface-2 animate-pulse" />
              <div className="h-8 rounded bg-surface-2 animate-pulse" />
            </div>
          ) : missingOrchestrator && !selected ? (
            <EmptyOrchestratorState onOpenAgents={() => nav('/agents')} compact />
          ) : (
            <SessionHistoryPanel
              activeConversationId={currentThread?.kind === 'agent' ? currentThread.conversationId : null}
              onOpenAgent={(id, name, options) => {
                setSelected({
                  kind: 'agent',
                  id,
                  name,
                  conversationId: options?.conversationId ?? null,
                  archivedAt: options?.archivedAt ?? null,
                  adapterType: agentAdapterMap[id] ?? null
                });
                nav(`/chat/agent/${id}`, { replace: true });
              }}
              onOpenRoom={(id, name) => {
                setSelected({ kind: 'room', id, name });
                nav('/chat', { replace: true });
              }}
              onOpenBroadcast={() => {
                setSelected({ kind: 'room', id: '__broadcast__', name: 'Global Chat' });
                nav('/chat', { replace: true });
              }}
            />
          )}
        </div>
      </aside>

      {/* Center: Chat Thread — always flex-1 */}
      <section className="flex flex-col flex-1 min-w-0">
        {currentThread ? (
          <>
            <header className="flex h-12 items-center justify-between border-b border-line bg-surface px-4">
              <div className="flex items-center gap-3">
                {/* Toggle History Sidebar button */}
                <button
                  type="button"
                  onClick={() => setHistoryOpen((h) => !h)}
                  title={historyOpen ? "Hide sidebar (H)" : "Show sidebar (H)"}
                  className="rounded-lg p-1.5 text-text-muted hover:bg-surface-2 hover:text-text-primary transition-colors focus:outline-none"
                >
                  {historyOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
                </button>

                {/* Redesigned agent name + model selector pill */}
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-2.5 rounded-full border border-line-strong bg-surface-2 px-3 py-1 font-semibold text-text-primary text-[12px] shadow-sm">
                    {currentThread.kind === 'agent' && (
                      <span className="relative flex h-2 w-2">
                        {activeTask && (
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75"></span>
                        )}
                        <span
                          className={`relative inline-flex h-2 w-2 rounded-full ${
                            activeTask ? 'bg-accent' : 'bg-text-disabled'
                          }`}
                          aria-label={activeTask ? 'Agent is working' : 'Agent is idle'}
                        />
                      </span>
                    )}
                    <span>{currentThread.name}</span>
                  </div>

                  {currentThread.kind === 'agent' && (
                    <div className="flex items-center">
                      <AgentModelSelector agentId={currentThread.id} compact />
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {showingSecondaryThread && (
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(null);
                      nav('/chat', { replace: true });
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

            {/* Active task floating sticky bar */}
            {activeTask && currentThread.kind === 'agent' && !taskDismissed && (
              <div className="sticky top-0 z-30 flex items-center justify-between border-b border-accent/20 bg-accent/8 backdrop-blur-md px-4 py-2 text-xs text-accent animate-in slide-in-from-top-2 duration-200">
                <div className="flex items-center gap-2 truncate">
                  <Activity size={12} className="shrink-0 animate-pulse" />
                  <span className="font-semibold">Active Task:</span>
                  <span className="truncate text-text-secondary">{activeTask.label}</span>
                  {activeTask.total > 0 && (
                    <span className="ml-2 font-mono bg-accent/15 rounded px-1.5 py-0.5 text-[10px]">
                      {activeTask.done}/{activeTask.total}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setTaskDismissed(true)}
                  className="rounded-md p-1 hover:bg-accent/15 hover:text-accent-hover transition-colors"
                  aria-label="Dismiss task notification"
                >
                  <X size={14} />
                </button>
              </div>
            )}

            {/* Harness adapter environment chip */}
            {currentThread.kind === 'agent' && currentAdapterType && (
              <div className="flex items-center gap-2 border-b border-line bg-surface-2 px-4 py-1.5 text-[10px] text-text-secondary select-none animate-in fade-in duration-200">
                <span className="text-text-muted">Harness Context:</span>
                <HarnessBadge adapterType={currentAdapterType} />
                <span className="text-text-disabled">|</span>
                <span className="text-text-muted text-[9px] font-sans">
                  {currentScope
                    ? formatChatScopeDescriptor(currentScope, workspaceName)
                    : 'Direct thread'}
                </span>
              </div>
            )}

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
                autoSendInitialDraft={autoSendInitialDraft}
                composerPlaceholder={currentThread.kind === 'agent' ? formatChatScopePlaceholder(currentThread.name) : undefined}
                onConversationReset={(conversationId) => {
                  if (currentThread.kind !== 'agent') return;
                  setSelected({
                    kind: 'agent',
                    id: currentThread.id,
                    name: currentThread.name,
                    conversationId,
                    archivedAt: null,
                    adapterType: agentAdapterMap[currentThread.id] ?? null
                  });
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
              <div className="mb-3 text-heading text-text-primary">Select a scope</div>
              <p className="text-[13px] text-text-secondary">
                Choose the workspace orchestrator or a space manager from the left.
              </p>
            </div>
          </div>
        )}
      </section>

      {/* Canvas Panel: slides in from the right */}
      <div
        className={`flex shrink-0 flex-col border-l border-line bg-surface-2/50 transition-all duration-300 ease-out overflow-hidden ${
          activeCanvas ? 'w-[460px]' : 'w-0'
        }`}
      >
        {activeCanvas && (
          <ChatCanvasPreview
            workflowId={activeCanvas.workflowId}
            runId={activeCanvas.runId}
            onClose={() => {
              dismissedCanvasWorkflowIdsRef.current.add(activeCanvas.workflowId);
              setActiveCanvas(null);
            }}
          />
        )}
      </div>

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

      <ChatShortcutsModal open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
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
