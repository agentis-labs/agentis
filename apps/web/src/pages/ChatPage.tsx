/**
 * ChatPage — full-screen chat. ChatPanel is suppressed when this is active.
 *
 * Same room list + thread view layout, just full-width.
 */

import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Plus, Clock } from 'lucide-react';
import { RoomList } from '../components/chat/RoomList';
import { ThreadView } from '../components/chat/ThreadView';
import { RoomCreateDialog } from '../components/chat/RoomCreateDialog';

type Selected = { kind: 'room' | 'agent'; id: string; name: string };

export function ChatPage() {
  const { agentId } = useParams<{ agentId?: string }>();
  const nav = useNavigate();
  const [selected, setSelected] = useState<Selected | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    if (agentId) {
      // Pre-select the agent — name is unknown until thread loads, use placeholder
      setSelected({ kind: 'agent', id: agentId, name: 'Agent' });
    }
  }, [agentId]);

  return (
    <div className="flex h-full">
      <aside className="flex w-80 shrink-0 flex-col border-r border-line bg-surface">
        <header className="flex h-12 items-center justify-between border-b border-line px-3">
          <span className="text-subheading text-text-primary">Chat</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="History"
              title="History"
              className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
            >
              <Clock size={14} />
            </button>
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              aria-label="New room"
              title="New room"
              className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
            >
              <Plus size={14} />
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <RoomList onSelect={(t) => {
            setSelected(t);
            if (t.kind === 'agent') nav(`/chat/agent/${t.id}`, { replace: true });
            else nav('/chat', { replace: true });
          }} />
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <>
            <header className="flex h-12 items-center justify-between border-b border-line bg-surface px-4">
              <div>
                <div className="text-subheading text-text-primary">{selected.name}</div>
                <div className="text-[11px] text-text-muted">
                  {selected.kind === 'agent' ? 'Direct thread' : 'Room'}
                </div>
              </div>
            </header>
            <div className="min-h-0 flex-1">
              <ThreadView kind={selected.kind} id={selected.id} name={selected.name} />
            </div>
          </>
        ) : (
          <div className="flex h-full items-center justify-center">
            <div className="max-w-md px-8 text-center">
              <div className="mb-3 text-heading text-text-primary">Select a conversation</div>
              <p className="text-[13px] text-text-secondary">
                Pick a room or direct thread from the left, or create a new room to start.
              </p>
            </div>
          </div>
        )}
      </section>

      <RoomCreateDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(room) => {
          setCreateOpen(false);
          setSelected({ kind: 'room', id: room.id, name: room.name });
        }}
      />
    </div>
  );
}
