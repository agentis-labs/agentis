import { useEffect, useRef, useState } from 'react';
import { Send, Pencil, Trash2, Copy, Plug } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { REALTIME_EVENTS } from '@agentis/core';
import { api } from '../../lib/api';
import { useToast } from '../shared/Toast';
import { useConfirm } from '../shared/ConfirmDialog';
import { Skeleton } from '../shared/Skeleton';
import { rtSubscribe, useRealtime } from '../../lib/realtime';

export interface ChatMessage {
  id: string;
  authorId: string;
  authorName?: string;
  authorKind: 'operator' | 'agent' | 'system';
  text: string;
  createdAt: string;
  source?: string;
}

interface ThreadViewProps {
  kind: 'room' | 'agent';
  id: string;
  name: string;
}

const PAGE_SIZE = 50;

type AgentMsg = {
  id: string;
  role?: string;
  authorType?: string;
  authorId?: string | null;
  body: string;
  createdAt: string;
};

type RoomMsg = {
  id: string;
  authorType: string;
  authorId?: string | null;
  content: Record<string, unknown>;
  createdAt: string;
};

function normalizeAgentMessage(message: AgentMsg): ChatMessage {
  return {
    id: message.id,
    authorId: message.authorId ?? '',
    authorKind: (message.role ?? message.authorType ?? 'agent') as ChatMessage['authorKind'],
    text: message.body,
    createdAt: message.createdAt,
  };
}

function normalizeRoomMessage(message: RoomMsg): ChatMessage {
  return {
    id: message.id,
    authorId: message.authorId ?? '',
    authorKind: message.authorType as ChatMessage['authorKind'],
    text: typeof message.content?.text === 'string' ? message.content.text : '',
    createdAt: message.createdAt,
  };
}

function sortMessages(messages: ChatMessage[]): ChatMessage[] {
  return [...messages].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

function upsertMessage(messages: ChatMessage[], next: ChatMessage): ChatMessage[] {
  let found = false;
  const updated = messages.map((message) => {
    if (message.id !== next.id) return message;
    found = true;
    return next;
  });
  return sortMessages(found ? updated : [...updated, next]);
}

function prependUnique(messages: ChatMessage[], older: ChatMessage[]): ChatMessage[] {
  const seen = new Set(messages.map((message) => message.id));
  return sortMessages([...older.filter((message) => !seen.has(message.id)), ...messages]);
}

export function ThreadView({ kind, id, name }: ThreadViewProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [agentNoAdapter, setAgentNoAdapter] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const preserveScrollRef = useRef(false);
  const toast = useToast();
  const confirm = useConfirm();
  const nav = useNavigate();

  const endpoint = kind === 'agent' ? `/v1/conversations/${id}` : `/v1/rooms/${id}/messages`;
  const sendEndpoint = kind === 'agent' ? `/v1/conversations/${id}/send` : `/v1/rooms/${id}/messages`;

  async function loadPage(before?: string): Promise<ChatMessage[]> {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (before) query.set('before', before);
    const path = `${endpoint}?${query.toString()}`;
    if (kind === 'agent') {
      const data = await api<{ messages: AgentMsg[]; agentHasAdapter?: boolean }>(path);
      if (!before) setAgentNoAdapter(data.agentHasAdapter === false);
      return (data.messages ?? []).map(normalizeAgentMessage);
    }
    const data = await api<{ messages: RoomMsg[] }>(path);
    return (data.messages ?? []).map(normalizeRoomMessage);
  }

  async function loadInitial() {
    if (id === '__broadcast__') { setMessages([]); setHasMore(false); setLoading(false); return; }
    setLoading(true);
    try {
      const page = await loadPage();
      setMessages(page);
      setHasMore(page.length === PAGE_SIZE);
    } catch {
      setMessages([]);
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }

  async function loadOlder() {
    if (loadingOlder || !hasMore || messages.length === 0) return;
    preserveScrollRef.current = true;
    setLoadingOlder(true);
    try {
      const page = await loadPage(messages[0]!.createdAt);
      setMessages((prev) => prependUnique(prev, page));
      setHasMore(page.length === PAGE_SIZE);
    } catch (e) {
      toast.error('Failed to load older messages', String(e));
    } finally {
      setLoadingOlder(false);
    }
  }

  useEffect(() => { void loadInitial(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [kind, id]);

  useEffect(() => {
    if (id === '__broadcast__') return undefined;
    return kind === 'room'
      ? rtSubscribe('room', { roomId: id })
      : rtSubscribe('conversation', { agentId: id });
  }, [kind, id]);

  useRealtime([
    REALTIME_EVENTS.CONVERSATION_MESSAGE_RECEIVED,
    REALTIME_EVENTS.CONVERSATION_MESSAGE_SENT,
    REALTIME_EVENTS.CONVERSATION_MESSAGE_UPDATED,
    REALTIME_EVENTS.CONVERSATION_MESSAGE_DELETED,
    REALTIME_EVENTS.ROOM_MESSAGE_RECEIVED,
    REALTIME_EVENTS.ROOM_MESSAGE_SENT,
    REALTIME_EVENTS.ROOM_MESSAGE_UPDATED,
    REALTIME_EVENTS.ROOM_MESSAGE_DELETED,
  ], (env) => {
    if (id === '__broadcast__') return;
    const payload = env.payload as {
      id?: string;
      roomId?: string;
      agentId?: string;
      message?: AgentMsg | RoomMsg;
    };
    if (kind === 'agent') {
      if (payload.agentId !== id) return;
      if (env.event === REALTIME_EVENTS.CONVERSATION_MESSAGE_DELETED) {
        setMessages((prev) => prev.filter((message) => message.id !== payload.id));
        return;
      }
      if (payload.message) {
        setMessages((prev) => upsertMessage(prev, normalizeAgentMessage(payload.message as AgentMsg)));
      }
      return;
    }
    if (payload.roomId !== id) return;
    if (env.event === REALTIME_EVENTS.ROOM_MESSAGE_DELETED) {
      setMessages((prev) => prev.filter((message) => message.id !== payload.id));
      return;
    }
    if (payload.message) {
      setMessages((prev) => upsertMessage(prev, normalizeRoomMessage(payload.message as RoomMsg)));
    }
  });

  useEffect(() => {
    if (preserveScrollRef.current) {
      preserveScrollRef.current = false;
      return;
    }
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length]);

  function autosize(el: HTMLTextAreaElement) {
    el.style.height = 'auto';
    el.style.height = Math.min(120, el.scrollHeight) + 'px';
  }

  async function handleSend() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const reqBody = kind === 'agent'
        ? JSON.stringify({ body: text })
        : JSON.stringify({ contentType: 'text', content: { text } });
      const res = await api<{ message?: AgentMsg | RoomMsg }>(sendEndpoint, { method: 'POST', body: reqBody });
      setDraft('');
      if (taRef.current) { taRef.current.style.height = 'auto'; }
      if (res.message) {
        setMessages((prev) => upsertMessage(
          prev,
          kind === 'agent'
            ? normalizeAgentMessage(res.message as AgentMsg)
            : normalizeRoomMessage(res.message as RoomMsg),
        ));
      }
    } catch (e) {
      toast.error('Failed to send', String(e));
    } finally {
      setSending(false);
    }
  }

  async function handleDelete(m: ChatMessage) {
    const ok = await confirm({
      title: 'Delete this message?',
      body: 'This message will be removed from the conversation.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api(`${endpoint}/${m.id}`, { method: 'DELETE' });
      toast.success('Message deleted');
      setMessages((prev) => prev.filter((message) => message.id !== m.id));
    } catch (e) {
      toast.error('Failed to delete', String(e));
    }
  }

  async function handleCopy(m: ChatMessage) {
    try {
      await navigator.clipboard.writeText(m.text);
      toast.success('Copied to clipboard');
    } catch { /* ignore */ }
  }

  async function handleEditSave(m: ChatMessage, text: string) {
    if (!text.trim()) return;
    try {
      const res = await api<{ message?: AgentMsg | RoomMsg }>(`${endpoint}/${m.id}`, { method: 'PATCH', body: JSON.stringify({ text: text.trim() }) });
      setEditingId(null);
      if (res.message) {
        setMessages((prev) => upsertMessage(
          prev,
          kind === 'agent'
            ? normalizeAgentMessage(res.message as AgentMsg)
            : normalizeRoomMessage(res.message as RoomMsg),
        ));
      } else {
        setMessages((prev) => prev.map((message) => (message.id === m.id ? { ...message, text: text.trim() } : message)));
      }
    } catch (e) {
      toast.error('Failed to edit message', String(e));
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3">
        {loading ? (
          <div className="space-y-2">
            <Skeleton height={36} />
            <Skeleton height={48} width="80%" />
            <Skeleton height={36} />
          </div>
        ) : messages.length === 0 ? (
          <div className="px-2 py-8 text-center text-[13px] text-text-muted">
            Send a message to start a conversation with {name}.
          </div>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {hasMore && (
              <li className="flex justify-center">
                <button
                  type="button"
                  onClick={() => void loadOlder()}
                  disabled={loadingOlder}
                  className="rounded-btn border border-line bg-surface-2 px-2.5 py-1 text-[11px] text-text-muted transition-colors hover:bg-surface-3 hover:text-text-primary disabled:opacity-60"
                >
                  {loadingOlder ? 'Loading...' : 'Load earlier'}
                </button>
              </li>
            )}
            {messages.map((m) => (
              <MessageBubble
                key={m.id}
                msg={m}
                onDelete={() => void handleDelete(m)}
                onCopy={() => void handleCopy(m)}
                isEditing={editingId === m.id}
                onStartEdit={() => setEditingId(m.id)}
                onSaveEdit={(text) => void handleEditSave(m, text)}
                onCancelEdit={() => setEditingId(null)}
              />
            ))}
          </ul>
        )}
      </div>

      {agentNoAdapter && kind === 'agent' && (
        <div className="border-t border-warn/30 bg-warn-soft px-3 py-2.5">
          <div className="flex items-center gap-2">
            <Plug size={14} className="text-warn" />
            <span className="flex-1 text-[12px] text-text-primary">
              {name} has no connection. Connect one to start chatting.
            </span>
            <button
              type="button"
              onClick={() => nav(`/agents/${id}?tab=connections`)}
              className="inline-flex h-7 items-center gap-1 rounded-btn bg-warn px-2.5 text-[11px] font-semibold text-canvas hover:opacity-90"
            >
              Connect
            </button>
          </div>
        </div>
      )}

      <form
        onSubmit={(e) => { e.preventDefault(); void handleSend(); }}
        className="border-t border-line p-2"
      >
        <div className="flex items-end gap-2 rounded-card border border-line bg-surface-2 px-2.5 py-2 focus-within:border-line-strong">
          <textarea
            ref={taRef}
            value={draft}
            onChange={(e) => { setDraft(e.target.value); autosize(e.target); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
            placeholder="Message…  / for commands  @ for agents"
            rows={1}
            disabled={agentNoAdapter}
            className={clsx(
              'min-h-[20px] flex-1 resize-none bg-transparent text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none',
              agentNoAdapter && 'opacity-50',
            )}
            style={{ maxHeight: 120 }}
          />
          <button
            type="submit"
            disabled={!draft.trim() || sending || agentNoAdapter}
            aria-label="Send message"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-btn bg-accent text-canvas transition-all hover:bg-accent-hover disabled:bg-accent/40 disabled:cursor-not-allowed"
          >
            <Send size={12} />
          </button>
        </div>
        <div className="mt-1.5 px-2 text-[10px] text-text-muted">
          Enter to send · Shift+Enter for newline
        </div>
      </form>
    </div>
  );
}

function MessageBubble({
  msg, onDelete, onCopy, isEditing, onStartEdit, onSaveEdit, onCancelEdit,
}: {
  msg: ChatMessage;
  onDelete: () => void;
  onCopy: () => void;
  isEditing: boolean;
  onStartEdit: () => void;
  onSaveEdit: (text: string) => void;
  onCancelEdit: () => void;
}) {
  const isOperator = msg.authorKind === 'operator';
  const [editDraft, setEditDraft] = useState(msg.text);

  useEffect(() => {
    if (isEditing) setEditDraft(msg.text);
  }, [isEditing, msg.text]);

  return (
    <li className={clsx('group flex flex-col gap-0.5', isOperator ? 'items-end' : 'items-start')}>
      {!isOperator && (
        <span className="px-1 text-[11px] text-text-muted">{msg.authorName ?? 'Agent'}</span>
      )}
      <div className="flex items-start gap-1.5">
        {isOperator && (
          <MessageActions onCopy={onCopy} onDelete={onDelete} onEdit={onStartEdit} />
        )}
        <div
          className={clsx(
            'max-w-[85%] rounded-card px-3 py-2 text-[13px] leading-relaxed',
            isOperator ? 'bg-accent-soft text-text-primary' : 'bg-surface-2 text-text-primary',
          )}
        >
          {isEditing ? (
            <div className="flex flex-col gap-1.5">
              <textarea
                value={editDraft}
                onChange={(e) => setEditDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSaveEdit(editDraft); }
                  if (e.key === 'Escape') onCancelEdit();
                }}
                autoFocus
                rows={2}
                className="min-h-[40px] w-full resize-none rounded border border-line bg-surface px-2 py-1 text-[13px] text-text-primary focus:border-accent focus:outline-none"
                style={{ maxHeight: 120 }}
              />
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => onSaveEdit(editDraft)}
                  disabled={!editDraft.trim()}
                  className="inline-flex h-6 items-center rounded-btn bg-accent px-2 text-[11px] font-semibold text-canvas hover:bg-accent-hover disabled:opacity-50"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={onCancelEdit}
                  className="inline-flex h-6 items-center rounded-btn border border-line px-2 text-[11px] text-text-secondary hover:bg-surface-2"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="whitespace-pre-wrap break-words">{msg.text}</div>
          )}
        </div>
        {!isOperator && <MessageActions onCopy={onCopy} onDelete={onDelete} />}
      </div>
      {msg.source && (
        <span className="px-1 text-[10px] text-text-muted">via {msg.source}</span>
      )}
    </li>
  );
}

function MessageActions({
  onCopy,
  onDelete,
  onEdit,
}: {
  onCopy: () => void;
  onDelete: () => void;
  onEdit?: () => void;
}) {
  return (
    <div className="flex shrink-0 flex-col gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          aria-label="Edit"
          className="rounded p-0.5 text-text-muted hover:bg-surface-2 hover:text-text-primary"
        >
          <Pencil size={10} />
        </button>
      )}
      <button
        type="button"
        onClick={onCopy}
        aria-label="Copy"
        className="rounded p-0.5 text-text-muted hover:bg-surface-2 hover:text-text-primary"
      >
        <Copy size={10} />
      </button>
      <button
        type="button"
        onClick={onDelete}
        aria-label="Delete"
        className="rounded p-0.5 text-text-muted hover:bg-surface-2 hover:text-danger"
      >
        <Trash2 size={10} />
      </button>
    </div>
  );
}
