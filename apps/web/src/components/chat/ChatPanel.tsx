/**
 * ChatPanel — persistent right-side orchestrator chat dock.
 *
 * The primary surface is the workspace orchestrator thread. Space managers
 * appear as scope tabs. Rooms and direct threads remain available through
 * session history, but they are no longer the default landing view.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Clock, ChevronLeft } from 'lucide-react';
import clsx from 'clsx';
import { useLocation, useNavigate } from 'react-router-dom';
import type { ViewportContext } from '@agentis/core';
import { useChatPanelStore } from './ChatPanelStore';
import { ThreadView } from './ThreadView';
import { SessionHistoryPanel } from './SessionHistoryPanel';
import {
  ChatScopeBadge,
  formatChatScopeDescriptor,
  formatChatScopeName,
  formatChatScopePlaceholder,
} from './scopeIdentity';
import { workspace as wsStore } from '../../lib/api';
import { rtSubscribe } from '../../lib/realtime';
import { usePrimaryChatScopes } from './usePrimaryChatScopes';

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
    resetForWorkspace,
  } = useChatPanelStore();
  const [historyOpen, setHistoryOpen] = useState(false);
  const nav = useNavigate();
  const { pathname } = useLocation();
  const pageCtx = pathToContext(pathname);
  const resizePointerIdRef = useRef<number | null>(null);
  const { loading, orchestrator, scopes, workspaceName, missingOrchestrator } = usePrimaryChatScopes();

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
    function onOpen(event: Event) {
      const detail = (event as CustomEvent<{
        agentId?: string;
        roomId?: string;
        initialDraft?: string;
        initialViewportOverride?: ViewportContext | null;
        viewportOverride?: ViewportContext | null;
        autoSendInitialDraft?: boolean;
        buildSession?: { appId?: string; slug?: string; name?: string };
      }>).detail;
      setState('docked');
      setHistoryOpen(false);
      setLaunchContext(detail?.initialDraft || detail?.viewportOverride || detail?.initialViewportOverride || detail?.buildSession
        ? {
            initialDraft: detail.initialDraft,
            initialViewportOverride: detail.initialViewportOverride ?? detail.viewportOverride ?? null,
            autoSendInitialDraft: detail.autoSendInitialDraft,
            buildSession: detail.buildSession,
          }
        : null);
      if (detail?.agentId) {
        selectThread({ kind: 'agent', id: detail.agentId, name: 'Conversation' });
      } else if (detail?.roomId) {
        selectThread({ kind: 'room', id: detail.roomId, name: 'Room' });
      } else {
        selectThread(null);
      }
    }
    window.addEventListener('agentis:chat-panel-open', onOpen);
    return () => window.removeEventListener('agentis:chat-panel-open', onOpen);
  }, [selectThread, setLaunchContext, setState]);

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
            </>
          ) : (
            <>
              <div className="flex flex-col">
                <span className="text-subheading text-text-primary">{currentThread?.name ?? 'Chat'}</span>
                <span className="text-[10px] text-text-muted">
                  {currentScope
                    ? formatChatScopeDescriptor(currentScope, workspaceName)
                    : pageCtx || 'Chat'}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setHistoryOpen(true)}
                aria-label="Session history"
                title="Session history"
                className="ml-auto -m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
              >
                <Clock size={14} />
              </button>
            </>
          )}
          <div className={clsx('flex items-center gap-1', selectedThread && 'ml-auto')}>
            <button
              type="button"
              onClick={() => setState('hidden')}
              aria-label="Close chat panel"
              className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
            >
              <X size={14} />
            </button>
          </div>
        </header>

        {!historyOpen && scopes.length > 0 && (
          <div className="border-b border-line px-3 py-2">
            <div className="mb-1 flex items-center justify-between text-[10px] font-medium uppercase tracking-wider text-text-muted">
              <span>Workspace scopes</span>
              <button
                type="button"
                onClick={() => setHistoryOpen(true)}
                className="rounded-btn bg-surface-2 px-2 py-1 text-[10px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary"
              >
                Browse history
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {scopes.map((scope) => {
                const active = currentThread?.kind === 'agent' && currentThread.id === scope.id;
                return (
                  <button
                    key={scope.id}
                    type="button"
                    onClick={() => {
                      setHistoryOpen(false);
                      if (scope.role === 'orchestrator') selectThread(null);
                      else selectThread({ kind: 'agent', id: scope.id, name: scope.name });
                    }}
                    className={clsx(
                      'inline-flex items-center gap-2 rounded-full border px-2.5 py-1.5 text-left transition',
                      active
                        ? 'border-accent/40 bg-accent/10 text-accent'
                        : 'border-line bg-surface text-text-secondary hover:text-text-primary',
                    )}
                  >
                    <ChatScopeBadge role={scope.role} active={active} size={11} className="h-6 w-6 rounded-[8px]" />
                    <span className="min-w-0 flex flex-col">
                      <span className="max-w-32 truncate text-[11px] font-medium">
                        {formatChatScopeName(scope)}
                      </span>
                      <span className={active ? 'max-w-32 truncate text-[10px] text-accent/80' : 'max-w-32 truncate text-[10px] text-text-muted'}>
                        {formatChatScopeDescriptor(scope, workspaceName)}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {historyOpen ? (
            <SessionHistoryPanel
              onBack={() => setHistoryOpen(false)}
              onOpenAgent={(id, name) => {
                setHistoryOpen(false);
                selectThread({ kind: 'agent', id, name });
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
              kind={currentThread.kind}
              id={currentThread.id}
              name={currentThread.name}
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
