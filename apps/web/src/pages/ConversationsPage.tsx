/**
 * Conversations — list of operator-agent threads + thread view.
 */

import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, workspace } from '../lib/api';
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

interface Message {
  id: string;
  role: 'operator' | 'agent' | 'system';
  body: string;
  createdAt: string;
  metadata?: {
    source?: 'openclaw_exec' | 'workflow' | 'manual';
    runId?: string;
    workflowId?: string;
    approvalId?: string;
    approvalSummary?: string;
  };
}

export function ConversationsPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const nav = useNavigate();
  const [list, setList] = useState<ConversationRow[]>([]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const ws = workspace.get();
    if (ws) rtSubscribe('workspace', { workspaceId: ws });
    void api<{ conversations: ConversationRow[] }>('/v1/conversations').then((r) => setList(r.conversations));
  }, [tick]);

  useRealtime(
    ['conversation.message.received', 'conversation.message.sent', 'conversation.read'],
    () => setTick((t) => t + 1),
  );

  return (
    <div className="grid h-full grid-cols-12">
      <aside className="col-span-12 border-r border-line bg-surface md:col-span-4 lg:col-span-3">
        <div className="border-b border-line px-4 py-3 text-sm font-medium">Conversations</div>
        <div className="divide-y divide-line">
          {list.length === 0 && (
            <div className="px-4 py-6 text-xs text-text-muted">
              No threads yet. Pick an agent to start a conversation.
            </div>
          )}
          {list.map((c) => (
            <button
              key={c.id}
              onClick={() => nav(`/conversations/${c.agentId}`)}
              className={`flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-surface-2 ${
                c.agentId === agentId ? 'bg-surface-2' : ''
              }`}
            >
              <span
                className="mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: c.agentColor }}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm">{c.agentName}</span>
                  {c.unread > 0 && (
                    <span className="ml-auto rounded-full bg-accent px-1.5 text-xs font-medium text-canvas">
                      {c.unread}
                    </span>
                  )}
                </div>
                {c.lastMessagePreview && (
                  <div className="truncate text-xs text-text-muted">{c.lastMessagePreview}</div>
                )}
              </div>
            </button>
          ))}
        </div>
      </aside>
      <section className="col-span-12 min-h-0 md:col-span-8 lg:col-span-9">
        {agentId ? <Thread agentId={agentId} /> : <EmptyThread />}
      </section>
    </div>
  );
}

function EmptyThread() {
  return (
    <div className="flex h-full items-center justify-center text-text-muted">
      Select a conversation to view its thread.
    </div>
  );
}

function Thread({ agentId }: { agentId: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [agentTyping, setAgentTyping] = useState(false);
  const typingTimer = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api<{ messages: Message[] }>(`/v1/conversations/${agentId}`).then((r) => setMessages(r.messages));
    void api(`/v1/conversations/${agentId}/read`, { method: 'POST' }).catch(() => {});
  }, [agentId]);

  useRealtime(
    ['conversation.message.received', 'conversation.message.sent'],
    (env) => {
      const payload = env.payload as { agentId?: string; message?: Message };
      if (payload.agentId === agentId && payload.message) {
        setMessages((m) => [...m, payload.message!]);
        setAgentTyping(false);
      }
    },
  );

  // V1-SPEC §13.12 typing indicator: surfaces "agent is thinking" between
  // a tool-call dispatch and the next message arriving on the thread.
  useRealtime(['conversation.agent.typing'], (env) => {
    const payload = env.payload as { agentId?: string };
    if (payload.agentId !== agentId) return;
    setAgentTyping(true);
    if (typingTimer.current) window.clearTimeout(typingTimer.current);
    typingTimer.current = window.setTimeout(() => setAgentTyping(false), 4000);
  });

  useEffect(
    () => () => {
      if (typingTimer.current) window.clearTimeout(typingTimer.current);
    },
    [],
  );

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  async function send() {
    if (!draft.trim()) return;
    setSending(true);
    try {
      await api(`/v1/conversations/${agentId}/send`, {
        method: 'POST',
        body: JSON.stringify({ body: draft }),
      });
      setDraft('');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-line bg-surface px-4 py-2">
        <div className="text-sm">
          Thread <Link to={`/agents/${agentId}`} className="font-mono text-text-muted hover:text-accent">→ agent</Link>
        </div>
      </header>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto p-4 space-y-3">
        {messages.length === 0 && <div className="text-xs text-text-muted">No messages yet.</div>}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${
              m.role === 'operator'
                ? 'ml-auto bg-accent-soft text-text-primary'
                : m.role === 'system'
                  ? 'mx-auto bg-surface-2 text-xs text-text-muted'
                  : 'bg-surface text-text-primary'
            }`}
          >
            <pre className="whitespace-pre-wrap font-sans">{m.body}</pre>
            {m.metadata?.approvalId && (
              <InlineApprovalCard
                approvalId={m.metadata.approvalId}
                summary={m.metadata.approvalSummary ?? 'Approval requested'}
              />
            )}
            <div className="mt-1 flex items-center gap-2 text-[10px] text-text-muted">
              <span>{new Date(m.createdAt).toLocaleTimeString()}</span>
              {m.metadata?.source && (
                <span className="rounded bg-surface-2 px-1 uppercase tracking-wider">{m.metadata.source}</span>
              )}
              {m.metadata?.runId && (
                <Link
                  to={`/runs/${m.metadata.runId}`}
                  className="font-mono text-accent hover:underline"
                >
                  → run {m.metadata.runId.slice(0, 8)}
                </Link>
              )}
              {m.metadata?.workflowId && !m.metadata.runId && (
                <Link
                  to={`/workflows/${m.metadata.workflowId}`}
                  className="font-mono text-accent hover:underline"
                >
                  → canvas
                </Link>
              )}
            </div>
          </div>
        ))}
        {agentTyping && (
          <div className="flex items-center gap-1 px-1 text-[11px] text-text-muted">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent [animation-delay:120ms]" />
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent [animation-delay:240ms]" />
            <span className="ml-1">agent is thinking…</span>
          </div>
        )}
      </div>
      <div className="border-t border-line bg-surface p-3">
        <div className="flex gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Reply…"
            rows={2}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void send();
              }
            }}
            className="flex-1 resize-none rounded-md border border-line bg-canvas px-3 py-2 text-sm outline-none focus:border-accent"
          />
          <button
            disabled={sending || !draft.trim()}
            onClick={send}
            className="self-end rounded-md bg-accent px-3 py-2 text-xs font-medium text-canvas disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Inline approval card — V1-SPEC §13.12.
 *
 * When a conversation message carries `metadata.approvalId`, the operator
 * can resolve the approval directly from the thread without leaving for the
 * Approvals page. This is the OpenClaw-mirrored agent's primary surface for
 * permission gates ("Can I curl this URL?").
 */
function InlineApprovalCard({ approvalId, summary }: { approvalId: string; summary: string }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<'approved' | 'rejected' | null>(null);
  async function resolve(decision: 'approve' | 'reject') {
    setBusy(true);
    try {
      await api(`/v1/approvals/${approvalId}/${decision}`, { method: 'POST' });
      setDone(decision === 'approve' ? 'approved' : 'rejected');
    } finally {
      setBusy(false);
    }
  }
  if (done) {
    return (
      <div className="mt-2 rounded-md border border-line bg-surface-2 px-2 py-1 text-[11px] text-text-muted">
        Approval {done}.
      </div>
    );
  }
  return (
    <div className="mt-2 rounded-md border border-amber-400/40 bg-amber-400/10 p-2 text-[11px]">
      <div className="mb-2 text-amber-100">{summary}</div>
      <div className="flex gap-2">
        <button
          disabled={busy}
          onClick={() => resolve('approve')}
          className="rounded bg-accent px-2 py-0.5 text-[11px] font-medium text-canvas disabled:opacity-50"
        >
          Approve
        </button>
        <button
          disabled={busy}
          onClick={() => resolve('reject')}
          className="rounded border border-line px-2 py-0.5 text-[11px] hover:text-danger disabled:opacity-50"
        >
          Reject
        </button>
      </div>
    </div>
  );
}
