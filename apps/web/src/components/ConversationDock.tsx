/**
 * ConversationDock — V1-SPEC §13.12 right-side dock.
 *
 * Lives in the global Shell so the operator can pop conversations open
 * over any surface (canvas, fleet overview, run history) without
 * navigating away. The dock surfaces:
 *   - the agent thread list with unread counts,
 *   - a typing indicator subscribed to CONVERSATION_AGENT_TYPING,
 *   - a "→ open full view" link into ConversationsPage.
 *
 * The toggle pill renders an unread total badge that bumps when any
 * agent receives a message, even if the dock is closed.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, workspace as wsStore } from '../lib/api';
import { rtSubscribe, useRealtime } from '../lib/realtime';

interface ConversationRow {
  id: string;
  agentId: string;
  agentName: string;
  agentColor: string;
  unread: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
}

export function ConversationDock() {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<ConversationRow[]>([]);
  const [typingByAgent, setTypingByAgent] = useState<Record<string, number>>({});

  async function refresh() {
    try {
      const r = await api<{ conversations: ConversationRow[] }>('/v1/conversations');
      setRows(r.conversations);
    } catch {
      // dock is best-effort; failures must not break the shell.
    }
  }

  useEffect(() => {
    const ws = wsStore.get();
    if (ws) rtSubscribe('workspace', { workspaceId: ws });
    void refresh();
  }, []);

  useRealtime(
    ['conversation.message.received', 'conversation.message.sent', 'conversation.read'],
    () => {
      void refresh();
    },
  );

  useRealtime(['conversation.agent.typing'], (env) => {
    const payload = env.payload as { agentId?: string };
    if (!payload.agentId) return;
    const id = payload.agentId;
    setTypingByAgent((t) => ({ ...t, [id]: Date.now() }));
    window.setTimeout(() => {
      setTypingByAgent((t) => {
        const last = t[id];
        if (!last || Date.now() - last < 3500) return t;
        const next = { ...t };
        delete next[id];
        return next;
      });
    }, 4000);
  });

  const unreadTotal = rows.reduce((acc, r) => acc + (r.unread ?? 0), 0);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Conversations"
        className="relative rounded-md border border-line bg-surface-2 px-2 py-1 text-xs text-text-muted hover:text-text-primary"
      >
        ✉ {open ? 'Hide' : 'Threads'}
        {unreadTotal > 0 && (
          <span className="absolute -right-1 -top-1 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-medium text-canvas">
            {unreadTotal}
          </span>
        )}
      </button>
      {open && (
        <aside className="fixed right-0 top-12 z-30 flex h-[calc(100vh-3rem-2.25rem)] w-[22rem] flex-col border-l border-line bg-surface shadow-card">
          <header className="flex items-center justify-between border-b border-line px-3 py-2 text-sm">
            <span>Conversations</span>
            <div className="flex items-center gap-2">
              <Link
                to="/conversations"
                onClick={() => setOpen(false)}
                className="text-xs text-text-muted hover:text-accent"
              >
                full view →
              </Link>
              <button
                onClick={() => setOpen(false)}
                className="text-text-muted hover:text-text-primary"
                title="Close"
              >
                ×
              </button>
            </div>
          </header>
          <div className="min-h-0 flex-1 overflow-auto divide-y divide-line">
            {rows.length === 0 && (
              <div className="px-3 py-6 text-xs text-text-muted">
                No threads yet. Connect a gateway and dispatch an agent to start one.
              </div>
            )}
            {rows.map((r) => {
              const typing = !!typingByAgent[r.agentId];
              return (
                <Link
                  key={r.id}
                  to={`/conversations/${r.agentId}`}
                  onClick={() => setOpen(false)}
                  className="flex items-start gap-2 px-3 py-2 text-left hover:bg-surface-2"
                >
                  <span
                    className="mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ background: r.agentColor }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm">{r.agentName}</span>
                      {r.unread > 0 && (
                        <span className="ml-auto rounded-full bg-accent px-1.5 text-[10px] font-medium text-canvas">
                          {r.unread}
                        </span>
                      )}
                    </div>
                    {typing ? (
                      <div className="text-xs italic text-accent">typing…</div>
                    ) : (
                      r.lastMessagePreview && (
                        <div className="truncate text-xs text-text-muted">
                          {r.lastMessagePreview}
                        </div>
                      )
                    )}
                  </div>
                </Link>
              );
            })}
          </div>
        </aside>
      )}
    </>
  );
}
