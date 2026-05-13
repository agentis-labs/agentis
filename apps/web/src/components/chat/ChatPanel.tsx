/**
 * ChatPanel — persistent right-side chat dock.
 *
 * States: hidden (0), floating (360px, overlay), docked (480px, compresses main).
 * Resets on workspace change. Lists rooms + direct threads. Selecting one
 * opens an inline thread view with composer.
 */

import { useEffect, useState } from 'react';
import { Pin, X, Plus, Clock, ChevronLeft } from 'lucide-react';
import clsx from 'clsx';
import { useLocation } from 'react-router-dom';
import { useChatPanelStore } from './ChatPanelStore';
import { RoomList } from './RoomList';
import { ThreadView } from './ThreadView';
import { RoomCreateDialog } from './RoomCreateDialog';
import { workspace as wsStore } from '../../lib/api';
import { rtSubscribe } from '../../lib/realtime';

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
  const { state, setState, selectedThread, selectThread, resetForWorkspace } = useChatPanelStore();
  const [createOpen, setCreateOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const { pathname } = useLocation();
  const pageCtx = pathToContext(pathname);

  // Reset chat panel on workspace change
  useEffect(() => {
    let cleanup = wsStore.get() ? rtSubscribe('workspace', { workspaceId: wsStore.get()! }) : undefined;
    function onWorkspaceChanged() {
      const cur = wsStore.get();
      cleanup?.();
      cleanup = cur ? rtSubscribe('workspace', { workspaceId: cur }) : undefined;
      resetForWorkspace();
    }
    window.addEventListener('agentis:workspace-changed', onWorkspaceChanged);
    return () => {
      cleanup?.();
      window.removeEventListener('agentis:workspace-changed', onWorkspaceChanged);
    };
  }, [resetForWorkspace]);

  if (state === 'hidden') return null;

  return (
    <>
      <aside
        className={clsx(
          'animate-slide-in-right z-30 flex shrink-0 flex-col border-l border-line bg-surface',
          state === 'floating' ? 'fixed right-0 top-12 h-[calc(100vh-3rem)] w-[360px] shadow-modal' : 'w-[480px]',
        )}
        role="complementary"
        aria-label="Chat panel"
      >
        <header className="flex h-12 items-center gap-2 border-b border-line px-3">
          {selectedThread ? (
            <>
              <button
                type="button"
                onClick={() => selectThread(null)}
                aria-label="Back to threads"
                className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="truncate text-subheading text-text-primary">{selectedThread.name}</span>
            </>
          ) : (
            <>
              <div className="flex flex-col">
                <span className="text-subheading text-text-primary">Chat</span>
                {pageCtx && <span className="text-[10px] text-text-muted">{pageCtx}</span>}
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
              onClick={() => setState(state === 'docked' ? 'floating' : 'docked')}
              aria-label={state === 'docked' ? 'Float panel' : 'Dock panel'}
              title={state === 'docked' ? 'Float panel' : 'Dock panel'}
              className={clsx(
                '-m-1 rounded-md p-1 transition-colors hover:bg-surface-2',
                state === 'docked' ? 'text-accent' : 'text-text-muted hover:text-text-primary',
              )}
            >
              <Pin size={14} />
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
        </header>

        {!selectedThread && (
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <span className="text-[11px] font-medium uppercase tracking-wider text-text-muted">
              Rooms & threads
            </span>
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="inline-flex h-7 items-center gap-1 rounded-btn bg-surface-2 px-2 text-[11px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary"
            >
              <Plus size={11} /> New room
            </button>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {selectedThread ? (
            <ThreadView
              kind={selectedThread.kind}
              id={selectedThread.id}
              name={selectedThread.name}
            />
          ) : (
            <RoomList onSelect={selectThread} />
          )}
        </div>
      </aside>

      <RoomCreateDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(room) => {
          setCreateOpen(false);
          selectThread({ kind: 'room', id: room.id, name: room.name });
        }}
      />
    </>
  );
}
