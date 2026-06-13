/**
 * ChatPanel — persistent right-side orchestrator chat dock.
 *
 * The primary surface is the workspace orchestrator thread. Space managers
 * appear as scope tabs. Rooms and direct threads remain available through
 * session history, but they are no longer the default landing view.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Clock, ChevronLeft, Maximize2, Plus, ChevronDown, Check, Globe } from 'lucide-react';
import clsx from 'clsx';
import { useLocation, useNavigate } from 'react-router-dom';
import { useChatPanelStore } from './ChatPanelStore';
import { ThreadView } from './ThreadView';
import { SessionHistoryPanel } from './SessionHistoryPanel';
import {
  formatChatScopeDescriptor,
  formatChatScopePlaceholder,
  ChatScopeGlyph,
} from './scopeIdentity';
import { workspace as wsStore } from '../../lib/api';
import { rtSubscribe } from '../../lib/realtime';
import { usePrimaryChatScopes } from './usePrimaryChatScopes';
import { clearDraft } from './Composer';
import { RoomCreateDialog } from './RoomCreateDialog';

const MIN_DOCKED_WIDTH = 360;
const MAX_DOCKED_WIDTH = 720;

function pathToContext(path: string): string {
  if (path === '/' || path === '/home') return 'Home';
  if (path.startsWith('/agents/')) return 'Agent Details';
  if (path === '/agents') return 'Agents';
  if (path.startsWith('/workflows/')) return 'Workflow Canvas';
  if (path === '/workflows') return 'Workflows';
  if (path === '/apps') return 'Apps';
  if (path === '/packages') return 'Packages';
  if (path === '/settings') return 'Settings';
  if (path === '/history') return 'History';
  return '';
}

export function ChatPanel() {
  const {
    state,
    setState,
    dockedWidth,
    setDockedWidth,
    selectedThread,
    selectThread,
    launchContext,
    setLaunchContext,
    openRequestId,
    resetForWorkspace,
  } = useChatPanelStore();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [roomCreateOpen, setRoomCreateOpen] = useState(false);
  const agentMenuRef = useRef<HTMLDivElement>(null);
  const nav = useNavigate();
  const { pathname } = useLocation();
  const pageCtx = pathToContext(pathname);
  const resizePointerIdRef = useRef<number | null>(null);
  const { loading, orchestrator, scopes, workspaceName, missingOrchestrator } = usePrimaryChatScopes();

  useEffect(() => {
    if (!agentMenuOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (agentMenuRef.current?.contains(e.target as Node)) return;
      setAgentMenuOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [agentMenuOpen]);

  const primaryScopeIds = useMemo(() => new Set(scopes.map((scope) => scope.id)), [scopes]);
  const currentThread = selectedThread ?? (orchestrator ? { kind: 'agent' as const, id: orchestrator.id, name: orchestrator.name } : null);
  const currentScope = currentThread && currentThread.kind === 'agent'
    ? scopes.find((scope) => scope.id === currentThread.id) ?? null
    : null;
  const showingSecondaryThread = Boolean(selectedThread && !primaryScopeIds.has(selectedThread.id));

  // Reset chat panel on workspace change
  useEffect(() => {
    let cleanup = wsStore.get() ? rtSubscribe('workspace', { workspaceId: wsStore.get()! }) : undefined;
    function onWorkspaceChanged() {
      const cur = wsStore.get();
      cleanup?.();
      cleanup = cur ? rtSubscribe('workspace', { workspaceId: cur }) : undefined;
      setHistoryOpen(false);
      resetForWorkspace();
    }
    window.addEventListener('agentis:workspace-changed', onWorkspaceChanged);
    return () => {
      cleanup?.();
      window.removeEventListener('agentis:workspace-changed', onWorkspaceChanged);
    };
  }, [resetForWorkspace]);

  useEffect(() => {
    if (openRequestId > 0) setHistoryOpen(false);
  }, [openRequestId]);

  useEffect(() => {
    function onConversationDeleted() {
      selectThread(null);
    }
    window.addEventListener('agentis:active-conversation-deleted', onConversationDeleted);
    return () => {
      window.removeEventListener('agentis:active-conversation-deleted', onConversationDeleted);
    };
  }, [selectThread]);

  if (state === 'hidden') return null;

  function handleResizeStart(event: React.PointerEvent<HTMLDivElement>) {
    resizePointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    updateDockedWidth(event.clientX);
  }

  function handleResizeMove(event: React.PointerEvent<HTMLDivElement>) {
    if (resizePointerIdRef.current !== event.pointerId) return;
    updateDockedWidth(event.clientX);
  }

  function handleResizeEnd(event: React.PointerEvent<HTMLDivElement>) {
    if (resizePointerIdRef.current !== event.pointerId) return;
    resizePointerIdRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function updateDockedWidth(pointerX: number) {
    const width = window.innerWidth - pointerX;
    setDockedWidth(Math.min(MAX_DOCKED_WIDTH, Math.max(MIN_DOCKED_WIDTH, width)));
  }

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

  return (
    <>
      <aside
        className={clsx('animate-slide-in-right relative z-30 flex shrink-0 flex-col border-l border-line bg-surface')}
        style={{ width: `${dockedWidth}px` }}
        role="complementary"
        aria-label="Chat panel"
      >
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize chat panel"
          className="absolute inset-y-0 left-0 z-10 w-1.5 -translate-x-1/2 cursor-col-resize bg-transparent before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-line hover:before:bg-accent"
          onPointerDown={handleResizeStart}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeEnd}
          onPointerCancel={handleResizeEnd}
        />
        <header className="flex h-12 items-center gap-2 border-b border-line px-3">
          {historyOpen || showingSecondaryThread || currentThread?.kind === 'room' ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setHistoryOpen(false);
                  selectThread(null);
                }}
                aria-label={`Back to ${orchestrator?.name ?? 'orchestrator'}`}
                className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="truncate text-subheading text-text-primary">
                {historyOpen ? 'Conversation history' : currentThread?.name ?? 'Chat'}
              </span>
              <div className="ml-auto flex items-center gap-1">
                {!historyOpen && currentThread && (
                  <button
                    type="button"
                    onClick={requestNewChat}
                    aria-label={currentThread.kind === 'room' ? 'Create room' : 'New conversation'}
                    title={currentThread.kind === 'room' ? 'Create room' : 'New conversation'}
                    className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
                  >
                    <Plus size={14} />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setState('hidden')}
                  aria-label="Close chat panel"
                  className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
                >
                  <X size={14} />
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="relative" ref={agentMenuRef}>
                <button
                  type="button"
                  onClick={() => setAgentMenuOpen((o) => !o)}
                  aria-label="Switch agent"
                  className="-ml-1 flex items-center gap-1 rounded-md px-1 py-0.5 hover:bg-surface-2"
                >
                  <div className="flex flex-col items-start">
                    <span className="text-subheading text-text-primary">{currentThread?.name ?? 'Chat'}</span>
                    <span className="text-[10px] text-text-muted">
                      {currentScope
                        ? formatChatScopeDescriptor(currentScope, workspaceName)
                        : pageCtx || 'Chat'}
                    </span>
                  </div>
                  <ChevronDown size={12} className={clsx('shrink-0 text-text-muted transition-transform', agentMenuOpen && 'rotate-180')} />
                </button>
                {agentMenuOpen && scopes.length > 0 && (
                  <div className="absolute left-0 top-full z-50 mt-1 w-60 overflow-hidden rounded-card border border-line bg-surface shadow-dropdown">
                    {scopes.map((scope) => (
                      <button
                        key={scope.id}
                        type="button"
                        onClick={() => {
                          selectThread({ kind: 'agent', id: scope.id, name: scope.name });
                          setAgentMenuOpen(false);
                        }}
                        className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-surface-2"
                      >
                        <span className={clsx(
                          'grid h-6 w-6 shrink-0 place-items-center rounded border',
                          scope.id === currentThread?.id
                            ? 'border-accent/40 bg-accent/10 text-accent'
                            : 'border-line bg-surface-2 text-text-muted',
                        )}>
                          <ChatScopeGlyph role={scope.role} size={11} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12px] text-text-primary">{scope.name}</span>
                          <span className="block text-[10px] text-text-muted">
                            {scope.role === 'orchestrator' ? 'Orchestrator' : scope.spaceName ?? 'Manager'}
                          </span>
                        </span>
                        {scope.id === currentThread?.id && <Check size={12} className="shrink-0 text-accent" />}
                      </button>
                    ))}
                    <div className="mx-2 my-1 h-px bg-line/60" />
                    <button
                      type="button"
                      onClick={() => {
                        selectThread({ kind: 'room', id: '__broadcast__', name: 'Global Chat' });
                        setAgentMenuOpen(false);
                      }}
                      className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-surface-2"
                    >
                      <span className={clsx(
                        'grid h-5 w-5 shrink-0 place-items-center rounded border',
                        currentThread?.id === '__broadcast__'
                          ? 'border-accent/40 bg-accent/10 text-accent'
                          : 'border-line bg-surface-2 text-text-muted',
                      )}>
                        <Globe size={10} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[11px] font-medium text-text-secondary">Global Chat</span>
                        <span className="block text-[9px] text-text-muted">Workspace-wide interactions</span>
                      </span>
                      {currentThread?.id === '__broadcast__' && <Check size={12} className="shrink-0 text-accent" />}
                    </button>
                  </div>
                )}
              </div>
              <div className="ml-auto flex items-center gap-1">
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
                  onClick={() => setHistoryOpen(true)}
                  aria-label="Session history"
                  title="Session history"
                  className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
                >
                  <Clock size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (currentThread?.kind === 'agent') nav(`/chat/agent/${currentThread.id}`);
                    else nav('/chat');
                    setState('hidden');
                  }}
                  aria-label="Open full page chat"
                  title="Open full page chat"
                  className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
                >
                  <Maximize2 size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => setState('hidden')}
                  aria-label="Close chat panel"
                  className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
                >
                  <X size={14} />
                </button>
              </div>
            </>
          )}
        </header>

        <div className="min-h-0 flex-1 flex flex-col">
          {historyOpen ? (
            <SessionHistoryPanel
              activeConversationId={currentThread?.kind === 'agent' && 'conversationId' in currentThread ? currentThread.conversationId : null}
              onBack={() => setHistoryOpen(false)}
              onOpenAgent={(id, name, options) => {
                setHistoryOpen(false);
                selectThread({ kind: 'agent', id, name, conversationId: options?.conversationId ?? null, archivedAt: options?.archivedAt ?? null });
              }}
              onOpenRoom={(id, name) => {
                setHistoryOpen(false);
                selectThread({ kind: 'room', id, name });
              }}
              onOpenBroadcast={() => {
                setHistoryOpen(false);
                selectThread({ kind: 'room', id: '__broadcast__', name: 'Fleet broadcast' });
              }}
            />
          ) : currentThread ? (
            <ThreadView
              key={`${currentThread.kind}:${currentThread.id}:${currentThread.conversationId ?? 'active'}`}
              kind={currentThread.kind}
              id={currentThread.id}
              name={currentThread.name}
              conversationId={currentThread.kind === 'agent' ? currentThread.conversationId ?? null : null}
              archivedAt={currentThread.kind === 'agent' ? currentThread.archivedAt ?? null : null}
              initialDraft={launchContext?.initialDraft}
              initialViewportOverride={launchContext?.initialViewportOverride ?? null}
              autoSendInitialDraft={launchContext?.autoSendInitialDraft}
              composerPlaceholder={
                launchContext?.buildSession
                  ? 'Describe what this app should do...'
                  : currentThread.kind === 'agent'
                    ? formatChatScopePlaceholder(currentThread.name)
                    : undefined
              }
              emptyBody={launchContext?.buildSession ? 'The orchestrator is ready to design this app, create its workflows, assign agents, and update the canvas.' : undefined}
              onInitialDraftUsed={() => setLaunchContext(null)}
              onConversationReset={(conversationId) => {
                if (currentThread.kind !== 'agent') return;
                selectThread({ kind: 'agent', id: currentThread.id, name: currentThread.name, conversationId, archivedAt: null });
              }}
            />
          ) : loading ? (
            <div className="space-y-2 px-3 py-4">
              <div className="h-8 rounded bg-surface-2" />
              <div className="h-20 rounded bg-surface-2" />
            </div>
          ) : missingOrchestrator ? (
            <EmptyOrchestratorState onOpenAgents={() => nav('/agents')} />
          ) : (
            <div className="px-4 py-8 text-center text-[12px] text-text-muted">No chat scope available.</div>
          )}
        </div>
      </aside>
      <RoomCreateDialog
        open={roomCreateOpen}
        onClose={() => setRoomCreateOpen(false)}
        onCreated={(room) => {
          setRoomCreateOpen(false);
          setHistoryOpen(false);
          selectThread({ kind: 'room', id: room.id, name: room.name });
        }}
      />
    </>
  );
}

function EmptyOrchestratorState({ onOpenAgents }: { onOpenAgents: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="mb-2 text-sm font-medium text-text-primary">Commission your orchestrator</div>
      <p className="mb-4 text-[12px] text-text-muted">
        This workspace does not have an orchestrator yet. Create one to use chat as the platform command surface.
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
