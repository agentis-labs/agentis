/**
 * Assistant — persistent operator companion.
 *
 * Replaces the modal "Threads" dock with a Crunchbase-Scout-style
 * persistent surface: the assistant is always available, knows about
 * the current page, and can expand into a full conversation panel
 * without forcing a route change.
 *
 * Three states drive the UX:
 *   1. Collapsed orb — anchored bottom-right; shows unread count and
 *      pulses on pending approvals.
 *   2. Compact bar — focused input with page-aware placeholder.
 *   3. Expanded panel — left mini rail (threads), main thread, header
 *      shows the page context the assistant is "looking at".
 *
 * Pages publish their context with `usePageContext({...})` so the
 * placeholder, header, and quick prompts all change as the operator
 * navigates.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import clsx from 'clsx';
import { Link } from 'react-router-dom';
import {
  MessageCircle,
  Send,
  X,
  ChevronDown,
  Sparkles,
  ChevronUp,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { api, workspace as wsStore } from '../../lib/api';
import { rtSubscribe, useRealtime } from '../../lib/realtime';
import { StatusBadge } from '../shared/StatusBadge';

// ---------- Page context ------------------------------------------------

export interface AssistantPageContext {
  /** Short label for the assistant header, e.g. "Run · bdcf0b99" */
  label: string;
  /** Optional placeholder shown in the input when on this page */
  placeholder?: string;
  /** Optional quick-prompt suggestions surfaced above the input */
  prompts?: string[];
  /** Optional href to deep-link the operator to the entity */
  href?: string;
}

interface AssistantCtxValue {
  pageContext: AssistantPageContext | null;
  setPageContext: (ctx: AssistantPageContext | null) => void;
  open: () => void;
  close: () => void;
  toggle: () => void;
  isOpen: boolean;
}

const AssistantCtx = createContext<AssistantCtxValue | null>(null);

export function AssistantProvider({ children }: { children: React.ReactNode }) {
  const [pageContext, setPageContext] = useState<AssistantPageContext | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  const value = useMemo<AssistantCtxValue>(
    () => ({
      pageContext,
      setPageContext,
      open: () => setIsOpen(true),
      close: () => setIsOpen(false),
      toggle: () => setIsOpen((v) => !v),
      isOpen,
    }),
    [pageContext, isOpen],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && (e.key === 'j' || e.key === 'J')) {
        e.preventDefault();
        setIsOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return <AssistantCtx.Provider value={value}>{children}</AssistantCtx.Provider>;
}

export function useAssistant() {
  const ctx = useContext(AssistantCtx);
  return (
    ctx ?? {
      pageContext: null,
      setPageContext: () => {},
      open: () => {},
      close: () => {},
      toggle: () => {},
      isOpen: false,
    }
  );
}

/**
 * Pages call this to publish their context to the assistant. The
 * registration is automatically cleared on unmount.
 *
 * Falls back to a silent no-op when rendered without an
 * `AssistantProvider` in scope (page-level unit tests).
 */
export function usePageContext(ctx: AssistantPageContext | null, deps: unknown[] = []) {
  const provider = useContext(AssistantCtx);
  useEffect(() => {
    if (!provider) return;
    provider.setPageContext(ctx);
    return () => provider.setPageContext(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

// ---------- Data types --------------------------------------------------

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
  authorType?: 'operator' | 'agent' | 'system';
  role?: 'operator' | 'agent' | 'system';
  body: string;
  createdAt: string;
}

function authorOf(m: Message): 'operator' | 'agent' | 'system' {
  return m.authorType ?? m.role ?? 'agent';
}

// ---------- Persistent surface -----------------------------------------

export function Assistant() {
  const { pageContext, isOpen, open, close } = useAssistant();
  const [rows, setRows] = useState<ConversationRow[]>([]);
  const [activeAgent, setActiveAgent] = useState<string | null>(null);
  const [typingByAgent, setTypingByAgent] = useState<Record<string, number>>({});
  const [expanded, setExpanded] = useState(false);

  async function refresh() {
    try {
      const r = await api<{ conversations: ConversationRow[] }>('/v1/conversations');
      setRows(r.conversations);
      if (!activeAgent && r.conversations[0]) setActiveAgent(r.conversations[0].agentId);
    } catch {
      /* best effort */
    }
  }

  useEffect(() => {
    const ws = wsStore.get();
    if (ws) rtSubscribe('workspace', { workspaceId: ws });
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useRealtime(
    ['conversation.message.received', 'conversation.message.sent', 'conversation.read'],
    () => void refresh(),
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
  const anyTyping = Object.keys(typingByAgent).length > 0;

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={open}
        title="Assistant (⌘J)"
        className={clsx(
          'group fixed bottom-12 right-4 z-30 flex h-12 items-center gap-2 rounded-full border border-line bg-surface px-3 pr-4 text-xs text-text-primary shadow-card transition hover:border-accent/50',
          unreadTotal > 0 && 'border-accent/60',
        )}
      >
        <span
          className={clsx(
            'relative flex h-8 w-8 items-center justify-center rounded-full bg-accent/15 text-accent',
            anyTyping && 'animate-pulse',
          )}
        >
          <Sparkles size={14} />
          {unreadTotal > 0 && (
            <span className="absolute -right-1 -top-1 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-medium text-canvas">
              {unreadTotal}
            </span>
          )}
        </span>
        <span className="hidden text-text-muted group-hover:text-text-primary md:inline">
          {pageContext?.placeholder ?? 'Ask Agentis…'}
        </span>
        <span className="ml-2 hidden rounded border border-line px-1.5 py-0.5 text-[10px] text-text-muted md:inline">
          ⌘J
        </span>
      </button>
    );
  }

  return (
    <aside
      className={clsx(
        'fixed bottom-12 right-4 z-30 flex flex-col rounded-2xl border border-line bg-surface shadow-card',
        expanded ? 'h-[80vh] w-[44rem] max-w-[calc(100vw-2rem)]' : 'h-[36rem] w-[26rem] max-w-[calc(100vw-2rem)]',
      )}
    >
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent/15 text-accent">
          <Sparkles size={13} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] font-medium uppercase tracking-wide text-text-muted">
            Assistant
          </div>
          <div className="truncate text-xs text-text-primary">
            {pageContext?.label ?? 'No context'}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? 'Compact view' : 'Expand'}
          className="rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
        >
          {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
        <button
          type="button"
          onClick={close}
          aria-label="Close assistant"
          className="rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
        >
          <X size={14} />
        </button>
      </header>
      <div className="flex min-h-0 flex-1">
        {expanded && (
          <ThreadList
            rows={rows}
            activeAgent={activeAgent}
            onSelect={setActiveAgent}
            typingByAgent={typingByAgent}
          />
        )}
        <div className="flex min-h-0 flex-1 flex-col">
          {activeAgent ? (
            <ThreadView agentId={activeAgent} pageContext={pageContext} rows={rows} />
          ) : (
            <EmptyAssistant />
          )}
        </div>
      </div>
    </aside>
  );
}

// ---------- Subcomponents ----------------------------------------------

function EmptyAssistant() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-xs text-text-muted">
      <Sparkles size={20} />
      <div>No conversations yet.</div>
      <div className="text-[11px]">
        Register an agent to start a thread, then come back here to ask anything.
      </div>
      <Link
        to="/agents"
        className="mt-1 rounded-md border border-line px-2 py-1 text-[11px] hover:text-accent"
      >
        Go to Agents
      </Link>
    </div>
  );
}

function ThreadList({
  rows,
  activeAgent,
  onSelect,
  typingByAgent,
}: {
  rows: ConversationRow[];
  activeAgent: string | null;
  onSelect: (agentId: string) => void;
  typingByAgent: Record<string, number>;
}) {
  return (
    <aside className="flex w-44 shrink-0 flex-col border-r border-line">
      <div className="flex items-center justify-between px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-text-muted">
        <span>Threads</span>
        <Link to="/conversations" className="text-text-muted hover:text-accent" title="Inbox">
          ↗
        </Link>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {rows.length === 0 && (
          <div className="px-3 py-6 text-[11px] text-text-muted">No threads yet.</div>
        )}
        {rows.map((r) => {
          const typing = !!typingByAgent[r.agentId];
          const active = r.agentId === activeAgent;
          return (
            <button
              key={r.id}
              type="button"
              onClick={() => onSelect(r.agentId)}
              className={clsx(
                'flex w-full items-start gap-2 px-3 py-2 text-left transition',
                active ? 'bg-surface-2' : 'hover:bg-surface-2/60',
              )}
            >
              <span
                className="mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: r.agentColor }}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1">
                  <span className="truncate text-xs">{r.agentName}</span>
                  {r.unread > 0 && (
                    <span className="ml-auto rounded-full bg-accent px-1.5 text-[9px] font-medium text-canvas">
                      {r.unread}
                    </span>
                  )}
                </div>
                {typing ? (
                  <div className="text-[10px] italic text-accent">typing…</div>
                ) : (
                  r.lastMessagePreview && (
                    <div className="truncate text-[10px] text-text-muted">
                      {r.lastMessagePreview}
                    </div>
                  )
                )}
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function ThreadView({
  agentId,
  pageContext,
  rows,
}: {
  agentId: string;
  pageContext: AssistantPageContext | null;
  rows: ConversationRow[];
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [showPrompts, setShowPrompts] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const agent = rows.find((r) => r.agentId === agentId);

  async function load() {
    try {
      const r = await api<{ messages: Message[] }>(`/v1/conversations/${agentId}`);
      setMessages(r.messages);
      void api(`/v1/conversations/${agentId}/read`, { method: 'POST' }).catch(() => {});
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  useRealtime(['conversation.message.received', 'conversation.message.sent'], (env) => {
    const payload = env.payload as { agentId?: string; message?: Message };
    if (payload.agentId === agentId && payload.message) {
      setMessages((m) => [...m, payload.message!]);
    }
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const send = useCallback(async () => {
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    try {
      await api(`/v1/conversations/${agentId}/send`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      });
      setDraft('');
    } finally {
      setSending(false);
    }
  }, [draft, agentId]);

  const prompts = pageContext?.prompts ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {pageContext && (
        <div className="flex items-center gap-2 border-b border-line bg-surface-2/60 px-3 py-1.5 text-[11px] text-text-muted">
          <StatusBadge tone="neutral" label="Context" dot={false} />
          <span className="truncate">{pageContext.label}</span>
          {pageContext.href && (
            <Link to={pageContext.href} className="ml-auto text-text-muted hover:text-accent">
              open ↗
            </Link>
          )}
        </div>
      )}
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-auto p-3">
        {messages.length === 0 && agent && (
          <div className="text-[11px] text-text-muted">
            Start a conversation with <span className="text-text-primary">{agent.agentName}</span>.
          </div>
        )}
        {messages.map((m) => {
          const author = authorOf(m);
          const mine = author === 'operator';
          return (
            <div
              key={m.id}
              className={clsx('flex flex-col', mine ? 'items-end' : 'items-start')}
            >
              <div
                className={clsx(
                  'max-w-[85%] whitespace-pre-wrap rounded-xl border px-2.5 py-1.5 text-xs',
                  mine
                    ? 'border-accent/40 bg-accent/10 text-text-primary'
                    : author === 'system'
                      ? 'border-line bg-surface-2 text-text-muted'
                      : 'border-line bg-surface-2 text-text-primary',
                )}
              >
                {m.body}
              </div>
              <div className="mt-0.5 text-[9px] text-text-muted">
                {author} · {new Date(m.createdAt).toLocaleTimeString()}
              </div>
            </div>
          );
        })}
      </div>
      {prompts.length > 0 && showPrompts && (
        <div className="border-t border-line px-2 pt-2">
          <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wide text-text-muted">
            <span>Suggested</span>
            <button
              type="button"
              onClick={() => setShowPrompts(false)}
              className="hover:text-text-primary"
              aria-label="Hide suggestions"
            >
              <ChevronDown size={11} />
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5 pb-1">
            {prompts.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setDraft(p)}
                className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[11px] text-text-muted hover:border-accent/40 hover:text-text-primary"
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      )}
      {prompts.length > 0 && !showPrompts && (
        <button
          type="button"
          onClick={() => setShowPrompts(true)}
          className="border-t border-line px-3 py-1 text-left text-[10px] text-text-muted hover:text-text-primary"
        >
          <ChevronUp size={10} className="mr-1 inline" />
          Show suggestions
        </button>
      )}
      <div className="flex items-center gap-2 border-t border-line bg-surface p-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={pageContext?.placeholder ?? 'Ask anything…'}
          className="flex-1 rounded-md border border-line bg-canvas px-2.5 py-1.5 text-xs text-text-primary outline-none focus:border-accent"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={sending || !draft.trim()}
          aria-label="Send"
          className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-canvas disabled:opacity-40"
        >
          {sending ? <span className="text-[10px]">…</span> : <Send size={12} />}
        </button>
      </div>
    </div>
  );
}

// ---------- Header trigger (kept for header parity) --------------------

export function AssistantHeaderButton() {
  const { toggle, isOpen } = useAssistant();
  return (
    <button
      type="button"
      onClick={toggle}
      title="Assistant (⌘J)"
      className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2 py-1 text-xs text-text-muted hover:text-text-primary"
    >
      <MessageCircle size={12} />
      {isOpen ? 'Hide assistant' : 'Assistant'}
      <span className="rounded border border-line px-1 py-0.5 text-[9px]">⌘J</span>
    </button>
  );
}
