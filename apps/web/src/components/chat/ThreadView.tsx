import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Loader2, Pencil, Plug, Trash2, X } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { REALTIME_EVENTS, type ChatDelta, type ViewportContext } from '@agentis/core';
import { api, apiErrorMessage, streamSse } from '../../lib/api';
import { useViewportAwareness } from '../../lib/viewportContext';
import { useToast } from '../shared/Toast';
import { useConfirm } from '../shared/ConfirmDialog';
import { Skeleton } from '../shared/Skeleton';
import { rtSubscribe, useRealtime } from '../../lib/realtime';
import { Composer } from '../ChatPanel/Composer';
import { ToolCallPill, type ToolCallPillData } from '../ChatPanel/ToolCallPill';
import { ProactiveCard, type ProactiveCardData } from '../ChatPanel/ProactiveCard';

interface ThreadViewProps {
  kind: 'room' | 'agent';
  id: string;
  name: string;
  initialDraft?: string;
  initialViewportOverride?: ViewportContext | null;
  autoSendInitialDraft?: boolean;
  composerPlaceholder?: string;
  emptyBody?: string;
  onInitialDraftUsed?: () => void;
}

type AgentMsg = {
  id: string;
  role?: string;
  authorType?: string;
  authorId?: string | null;
  body: string;
  createdAt: string;
  metadata?: MessageMeta;
  deliveryStatus?: 'sending' | 'sent' | 'delivered' | 'failed' | 'mirrored';
};

type RoomMsg = {
  id: string;
  authorType: string;
  authorId?: string | null;
  content: Record<string, unknown>;
  createdAt: string;
};

interface MessageMeta {
  source?: 'openclaw_exec' | 'openclaw_session' | 'workflow' | 'manual' | 'proactive' | 'chat_loop' | 'chat_confirmation' | 'tool_call';
  card?: ProactiveCardData;
  thinking?: string;
  toolCalls?: ToolCallPillData[];
  confirmation?: ConfirmationCardData;
  runId?: string;
  workflowId?: string | null;
  runStatus?: string;
  runTitle?: string | null;
  isEphemeral?: boolean;
}

type ConfirmationStatus = 'pending' | 'approving' | 'approved' | 'cancelled' | 'failed';

interface ConfirmationCardData {
  turnId: string;
  toolCall: {
    id: string;
    name: string;
    args: unknown;
  };
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  expiresAt: string;
  status: ConfirmationStatus;
}

interface AppThreadHandoff {
  handoff: 'app_thread.open';
  slug: string;
  targetUrl?: string;
  carriedMessage?: string | null;
  reason?: string | null;
}

interface ChatMessage {
  id: string;
  authorId: string;
  authorName?: string;
  authorKind: 'operator' | 'agent' | 'system';
  text: string;
  createdAt: string;
  source?: string;
  metadata?: MessageMeta;
  deliveryStatus?: 'sending' | 'sent' | 'delivered' | 'failed' | 'mirrored';
}

const PAGE_SIZE = 50;

function streamErrorMessage(data: unknown): string {
  if (data && typeof data === 'object') {
    const message = (data as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  if (typeof data === 'string' && data.trim()) return data.trim();
  return 'The agent runtime reported an error. Check the runtime settings and try again.';
}

function normalizeAgentMessage(message: AgentMsg): ChatMessage {
  return {
    id: message.id,
    authorId: message.authorId ?? '',
    authorKind: (message.role ?? message.authorType ?? 'agent') as ChatMessage['authorKind'],
    text: message.body,
    createdAt: message.createdAt,
    source: message.metadata?.source,
    metadata: message.metadata,
    deliveryStatus: message.deliveryStatus,
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

function mergeMessage(messages: ChatMessage[], incoming: ChatMessage): ChatMessage[] {
  if (messages.some((message) => message.id === incoming.id)) return messages;
  if (incoming.authorKind === 'operator') {
    const optimisticIndex = messages.findIndex(
      (message) => message.id.startsWith('tmp-') && message.authorKind === 'operator' && message.text === incoming.text,
    );
    if (optimisticIndex >= 0) {
      return messages.map((message, index) => (index === optimisticIndex ? incoming : message));
    }
  }
  return sortMessages([...messages, incoming]);
}

export function ThreadView({ kind, id, name, initialDraft, initialViewportOverride, autoSendInitialDraft, composerPlaceholder, emptyBody, onInitialDraftUsed }: ThreadViewProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [agentNoAdapter, setAgentNoAdapter] = useState(false);
  const [agentTyping, setAgentTyping] = useState(false);
  const [composerInitialText, setComposerInitialText] = useState(initialDraft ?? '');
  const scrollRef = useRef<HTMLDivElement>(null);
  const preserveScrollRef = useRef(false);
  const typingTimer = useRef<number | null>(null);
  const autoSentDraftKeyRef = useRef<string | null>(null);
  const consumedLaunchKeyRef = useRef<string | null>(null);
  const pendingViewportOverrideRef = useRef<ViewportContext | null>(initialViewportOverride ?? null);
  const toast = useToast();
  const confirm = useConfirm();
  const awareness = useViewportAwareness();
  const navigate = useNavigate();

  const endpoint = kind === 'agent' ? `/v1/conversations/${id}` : `/v1/rooms/${id}/messages`;
  const sendEndpoint = kind === 'agent' ? `/v1/conversations/${id}/send` : `/v1/rooms/${id}/messages`;
  const confirmEndpoint = kind === 'agent' ? `/v1/conversations/${id}/confirm` : null;

  async function loadPage(before?: ChatMessage): Promise<ChatMessage[]> {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (before) {
      query.set('before', before.createdAt);
      query.set('beforeId', before.id);
    }
    const path = `${endpoint}?${query.toString()}`;
    if (kind === 'agent') {
      const [threadData, agentData] = await Promise.all([
        api<{ messages: AgentMsg[] }>(path),
        api<{ agent: { adapterType?: string | null } }>(`/v1/agents/${id}`).catch(() => ({ agent: { adapterType: null } })),
      ]);
      if (!before) setAgentNoAdapter(!agentData.agent?.adapterType);
      return (threadData.messages ?? []).map(normalizeAgentMessage);
    }
    const data = await api<{ messages: RoomMsg[] }>(path);
    return (data.messages ?? []).map(normalizeRoomMessage);
  }

  async function loadInitial() {
    if (id === '__broadcast__') {
      setMessages([]);
      setHasMore(false);
      setLoading(false);
      return;
    }
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
      const page = await loadPage(messages[0]!);
      setMessages((prev) => prependUnique(prev, page));
      setHasMore(page.length === PAGE_SIZE);
    } catch (error) {
      toast.error('Failed to load older messages', String(error));
    } finally {
      setLoadingOlder(false);
    }
  }

  async function handleConfirmationAction(messageId: string, confirmation: ConfirmationCardData, confirmed: boolean) {
    if (!confirmEndpoint) return;
    const toolStartedAt = new Map<string, number>();
    const baseText = messages.find((message) => message.id === messageId)?.text.trim() ?? '';
    let streamedBody = '';

    setMessages((current) => current.map((message) => (
      message.id === messageId
        ? {
            ...message,
            deliveryStatus: 'sending',
            metadata: {
              ...(message.metadata ?? {}),
              confirmation: { ...confirmation, status: 'approving' },
            },
          }
        : message
    )));
    setAgentTyping(true);

    try {
      await streamSse(confirmEndpoint, {
        method: 'POST',
        body: JSON.stringify({ turnId: confirmation.turnId, confirmed }),
      }, {
        onEvent(event, data) {
          if (event === 'delta') {
            const delta = data as ChatDelta;
            if (delta.type === 'text') {
              streamedBody += delta.delta;
              setMessages((current) => current.map((message) => (
                message.id === messageId
                  ? {
                      ...message,
                      text: [baseText, streamedBody.trim()].filter(Boolean).join('\n\n'),
                      deliveryStatus: 'sending',
                    }
                  : message
              )));
            } else if (delta.type === 'tool_call') {
              toolStartedAt.set(delta.id, performance.now());
              applyToolCallDelta(messageId, delta);
            } else if (delta.type === 'tool_result') {
              applyToolResultDelta(messageId, delta, toolStartedAt);
            } else if (delta.type === 'confirmation_required') {
              applyConfirmationDelta(messageId, delta);
            } else if (delta.type === 'done') {
              setAgentTyping(false);
              setMessages((current) => current.map((message) => (
                message.id === messageId
                  ? {
                      ...message,
                      deliveryStatus: delta.finishReason === 'error' ? 'failed' : 'delivered',
                      metadata: {
                        ...(message.metadata ?? {}),
                        confirmation: message.metadata?.confirmation
                          ? {
                              ...message.metadata.confirmation,
                              status: delta.finishReason === 'error'
                                ? 'failed'
                                : confirmed
                                  ? 'approved'
                                  : 'cancelled',
                            }
                          : undefined,
                      },
                    }
                  : message
              )));
            }
          } else if (event === 'message') {
            const persisted = normalizeAgentMessage(data as AgentMsg);
            setMessages((current) => current.map((message) => {
              if (message.id !== messageId) return message;
              return {
                ...persisted,
                metadata: {
                  ...persisted.metadata,
                  toolCalls: message.metadata?.toolCalls ?? persisted.metadata?.toolCalls,
                  thinking: message.metadata?.thinking ?? persisted.metadata?.thinking,
                  confirmation: message.metadata?.confirmation,
                },
              };
            }));
          } else if (event === 'error') {
            const message = streamErrorMessage(data);
            setAgentTyping(false);
            setMessages((current) => current.map((message) => (
              message.id === messageId
                ? {
                    ...message,
                    deliveryStatus: 'failed',
                    metadata: {
                      ...(message.metadata ?? {}),
                      confirmation: message.metadata?.confirmation
                        ? { ...message.metadata.confirmation, status: 'failed' }
                        : undefined,
                    },
                  }
                : message
            )));
            toast.error('Agent could not complete the action', message);
          }
        },
      });
    } catch (error) {
      setAgentTyping(false);
      setMessages((current) => current.map((message) => (
        message.id === messageId
          ? {
              ...message,
              deliveryStatus: 'failed',
              metadata: {
                ...(message.metadata ?? {}),
                confirmation: message.metadata?.confirmation
                  ? { ...message.metadata.confirmation, status: 'failed' }
                  : undefined,
              },
            }
          : message
      )));
      toast.error('Failed to confirm action', apiErrorMessage(error));
    }
  }

  useEffect(() => {
    void loadInitial();
  }, [kind, id]);

  useEffect(() => {
    setComposerInitialText('');
    consumedLaunchKeyRef.current = null;
    pendingViewportOverrideRef.current = initialViewportOverride ?? null;
  }, [kind, id]);

  useEffect(() => {
    if (initialDraft === undefined && !initialViewportOverride) return;
    const key = `${kind}:${id}:${initialDraft ?? ''}:${initialViewportOverride ? JSON.stringify(initialViewportOverride) : ''}:${autoSendInitialDraft ? 'auto' : 'manual'}`;
    if (consumedLaunchKeyRef.current === key) return;
    consumedLaunchKeyRef.current = key;
    if (initialDraft !== undefined) setComposerInitialText(initialDraft);
    pendingViewportOverrideRef.current = initialViewportOverride ?? null;
    if (!autoSendInitialDraft) queueMicrotask(() => onInitialDraftUsed?.());
  }, [autoSendInitialDraft, id, initialDraft, initialViewportOverride, kind, onInitialDraftUsed]);

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

  useRealtime([REALTIME_EVENTS.CONVERSATION_AGENT_TYPING], (env) => {
    if (kind !== 'agent') return;
    const payload = env.payload as { agentId?: string };
    if (payload.agentId !== id) return;
    setAgentTyping(true);
    if (typingTimer.current) window.clearTimeout(typingTimer.current);
    typingTimer.current = window.setTimeout(() => setAgentTyping(false), 4000);
  });

  useRealtime([REALTIME_EVENTS.AGENT_PROACTIVE_PUSH], (env) => {
    if (kind !== 'agent') return;
    const payload = env.payload as { id?: string; agentId?: string | null; card?: ProactiveCardData };
    if (payload.agentId && payload.agentId !== id) return;
    if (!payload.card) return;
    const message: ChatMessage = {
      id: payload.id ?? `proactive-${env.emittedAt}`,
      authorId: payload.agentId ?? id,
      authorKind: 'agent',
      text: '',
      createdAt: env.emittedAt,
      metadata: { source: 'proactive', card: payload.card },
      deliveryStatus: 'delivered',
    };
    setMessages((current) => mergeMessage(current, message));
  });

  useEffect(() => {
    if (preserveScrollRef.current) {
      preserveScrollRef.current = false;
      return;
    }
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, agentTyping]);

  useEffect(() => () => {
    if (typingTimer.current) window.clearTimeout(typingTimer.current);
  }, []);

  function navigateToHandoff(result: unknown) {
    const handoff = asAppThreadHandoff(result);
    if (!handoff) return;
    const base = handoff.targetUrl ?? `/apps/${handoff.slug}`;
    const query = new URLSearchParams();
    if (handoff.carriedMessage) query.set('message', handoff.carriedMessage);
    if (handoff.reason) query.set('handoffReason', handoff.reason);
    const suffix = query.toString();
    navigate(suffix ? `${base}${base.includes('?') ? '&' : '?'}${suffix}` : base);
  }

  function applyToolCallDelta(streamId: string, delta: Extract<ChatDelta, { type: 'tool_call' }>) {
    const pill: ToolCallPillData = {
      id: delta.id,
      name: delta.name,
      status: 'running',
    };
    setMessages((current) => current.map((message) => {
      if (message.id !== streamId) return message;
      const existing = message.metadata?.toolCalls ?? [];
      return {
        ...message,
        metadata: {
          ...(message.metadata ?? {}),
          source: message.metadata?.source ?? 'chat_loop',
          toolCalls: [...existing.filter((entry) => entry.id !== pill.id), pill],
        },
      };
    }));
  }

  function applyToolResultDelta(
    streamId: string,
    delta: Extract<ChatDelta, { type: 'tool_result' }>,
    toolStartedAt: Map<string, number>,
  ) {
    const startedAt = toolStartedAt.get(delta.id);
    const durationMs = startedAt !== undefined ? Math.max(0, performance.now() - startedAt) : null;
    setMessages((current) => current.map((message) => {
      if (message.id !== streamId) return message;
      const existing = message.metadata?.toolCalls ?? [];
      const nextPill: ToolCallPillData = {
        id: delta.id,
        name: delta.name,
        status: delta.error ? 'error' : 'success',
        result: delta.result,
        error: delta.error,
        durationMs,
      };
      return {
        ...message,
        metadata: {
          ...(message.metadata ?? {}),
          source: message.metadata?.source ?? 'chat_loop',
          toolCalls: [...existing.filter((entry) => entry.id !== delta.id), nextPill],
        },
      };
    }));
    if (!delta.error) navigateToHandoff(delta.result);
  }

  function applyConfirmationDelta(streamId: string, delta: Extract<ChatDelta, { type: 'confirmation_required' }>) {
    const confirmationCard: ConfirmationCardData = {
      turnId: delta.turnId,
      toolCall: delta.toolCall,
      title: delta.title,
      body: delta.body,
      confirmLabel: delta.confirmLabel,
      cancelLabel: delta.cancelLabel,
      expiresAt: delta.expiresAt,
      status: 'pending',
    };
    setMessages((current) => current.map((message) => (
      message.id === streamId
        ? {
            ...message,
            metadata: {
              ...(message.metadata ?? {}),
              source: message.metadata?.source ?? 'chat_loop',
              confirmation: confirmationCard,
            },
          }
        : message
    )));
  }

  async function handleSend(text: string, options?: { useViewportContext?: boolean }) {
    const value = text.trim();
    if (!value) return;

    if (kind === 'room') {
      try {
        const res = await api<{ message?: RoomMsg }>(sendEndpoint, {
          method: 'POST',
          body: JSON.stringify({ contentType: 'text', content: { text: value } }),
        });
        const message = res.message;
        if (message) setMessages((prev) => upsertMessage(prev, normalizeRoomMessage(message)));
      } catch (error) {
        toast.error('Failed to send', apiErrorMessage(error));
      }
      return;
    }

    const operatorMessage: ChatMessage = {
      id: `tmp-${Date.now()}`,
      authorId: 'operator',
      authorKind: 'operator',
      text: value,
      createdAt: new Date().toISOString(),
      deliveryStatus: 'sending',
    };
    const streamId = `stream-${Date.now()}`;
    const streamingMessage: ChatMessage = {
      id: streamId,
      authorId: id,
      authorKind: 'agent',
      text: '',
      createdAt: new Date().toISOString(),
      deliveryStatus: 'sending',
      metadata: { source: 'chat_loop' },
    };

    setMessages((current) => [...current, operatorMessage, streamingMessage]);
    setAgentTyping(true);

    const toolStartedAt = new Map<string, number>();

    try {
      let streamedBody = '';
      let streamedThinking = '';
      const viewportOverride = pendingViewportOverrideRef.current;
      await streamSse(sendEndpoint, {
        method: 'POST',
        body: JSON.stringify({
          body: value,
          useViewportContext: options?.useViewportContext !== false,
          viewportOverride,
        }),
      }, {
        onEvent(event, data) {
          if (event === 'delta') {
            const delta = data as ChatDelta;
            if (delta.type === 'text') {
              streamedBody += delta.delta;
              setMessages((current) => current.map((message) => (
                message.id === streamId
                  ? { ...message, text: streamedBody, deliveryStatus: 'sending' }
                  : message
              )));
            } else if (delta.type === 'thinking') {
              streamedThinking += delta.delta;
              setMessages((current) => current.map((message) => (
                message.id === streamId
                  ? {
                      ...message,
                      metadata: {
                        ...(message.metadata ?? {}),
                        source: message.metadata?.source ?? 'chat_loop',
                        thinking: streamedThinking,
                      },
                    }
                  : message
              )));
            } else if (delta.type === 'tool_call') {
              toolStartedAt.set(delta.id, performance.now());
              applyToolCallDelta(streamId, delta);
            } else if (delta.type === 'tool_result') {
              applyToolResultDelta(streamId, delta, toolStartedAt);
            } else if (delta.type === 'confirmation_required') {
              applyConfirmationDelta(streamId, delta);
            } else if (delta.type === 'done') {
              setAgentTyping(false);
              setMessages((current) => current.map((message) => (
                message.id === streamId
                  ? { ...message, deliveryStatus: delta.finishReason === 'error' ? 'failed' : 'delivered' }
                  : message
              )));
            }
          } else if (event === 'message') {
            const persisted = normalizeAgentMessage(data as AgentMsg);
            setMessages((current) => current.map((message) => {
              if (message.id !== streamId) return message;
              return {
                ...persisted,
                metadata: {
                  ...persisted.metadata,
                  toolCalls: message.metadata?.toolCalls ?? persisted.metadata?.toolCalls,
                  thinking: message.metadata?.thinking ?? persisted.metadata?.thinking,
                },
              };
            }));
            setMessages((current) => current.map((message) => (
              message.id === operatorMessage.id
                ? { ...message, deliveryStatus: 'delivered' }
                : message
            )));
          } else if (event === 'error') {
            const message = streamErrorMessage(data);
            setAgentTyping(false);
            setMessages((current) => current.map((message) => (
              message.id === streamId
                ? { ...message, text: message.text || streamErrorMessage(data), deliveryStatus: 'failed' }
                : message.id === operatorMessage.id
                  ? { ...message, deliveryStatus: 'delivered' }
                  : message
            )));
            toast.error('Agent could not reply', message);
          }
        },
      });
      pendingViewportOverrideRef.current = null;
    } catch (error) {
      setAgentTyping(false);
      setMessages((current) => current.map((message) => (
        message.id === streamId || message.id === operatorMessage.id
          ? { ...message, deliveryStatus: 'failed' }
          : message
      )));
      toast.error('Failed to send', apiErrorMessage(error));
    }
  }

  useEffect(() => {
    const nextKey = autoSendInitialDraft && initialDraft?.trim()
      ? `${kind}:${id}:${initialDraft}`
      : null;
    if (!nextKey || autoSentDraftKeyRef.current === nextKey) return;
    autoSentDraftKeyRef.current = nextKey;
    setComposerInitialText('');
    void handleSend(initialDraft!);
    onInitialDraftUsed?.();
  }, [autoSendInitialDraft, handleSend, id, initialDraft, kind, onInitialDraftUsed]);

  async function handleDelete(message: ChatMessage) {
    const ok = await confirm({
      title: 'Delete this message?',
      body: 'This message will be removed from the conversation.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api(`${endpoint}/${message.id}`, { method: 'DELETE' });
      toast.success('Message deleted');
      setMessages((prev) => prev.filter((item) => item.id !== message.id));
    } catch (error) {
      toast.error('Failed to delete', String(error));
    }
  }

  async function handleCopy(message: ChatMessage) {
    try {
      await navigator.clipboard.writeText(message.text);
      toast.success('Copied to clipboard');
    } catch {
      // no-op
    }
  }

  async function handleEditSave(message: ChatMessage, text: string) {
    if (!text.trim()) return;
    try {
      const res = await api<{ message?: AgentMsg | RoomMsg }>(`${endpoint}/${message.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ text: text.trim() }),
      });
      setEditingId(null);
      if (res.message) {
        setMessages((prev) => upsertMessage(
          prev,
          kind === 'agent'
            ? normalizeAgentMessage(res.message as AgentMsg)
            : normalizeRoomMessage(res.message as RoomMsg),
        ));
      } else {
        setMessages((prev) => prev.map((item) => (item.id === message.id ? { ...item, text: text.trim() } : item)));
      }
    } catch (error) {
      toast.error('Failed to edit message', String(error));
    }
  }

  const awarenessActive = kind === 'agent'
    && awareness.context.surface !== 'chat'
    && awareness.context.surface !== 'unknown';

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
            {emptyBody ?? `Send a message to start a conversation with ${name}.`}
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
            {messages.map((message) => (
              <MessageBubble
                key={message.id}
                msg={message}
                onDelete={() => void handleDelete(message)}
                onCopy={() => void handleCopy(message)}
                isEditing={editingId === message.id}
                onStartEdit={() => setEditingId(message.id)}
                onSaveEdit={(text) => void handleEditSave(message, text)}
                onCancelEdit={() => setEditingId(null)}
                onConfirmAction={(confirmation, approved) => void handleConfirmationAction(message.id, confirmation, approved)}
              />
            ))}
          </ul>
        )}
        {agentTyping && kind === 'agent' && (
          <div className="mt-2 px-1 text-[11px] italic text-text-muted">{name} is thinking...</div>
        )}
      </div>

      {agentNoAdapter && kind === 'agent' && (
        <div className="border-t border-warn/30 bg-warn-soft px-3 py-2.5">
          <div className="flex items-center gap-2">
            <Plug size={14} className="text-warn" />
            <span className="flex-1 text-[12px] text-text-primary">
              {name} has no configured runtime yet. Configure one to start chatting.
            </span>
          </div>
        </div>
      )}

      <Composer
        key={`${kind}:${id}:${composerInitialText}`}
        onSend={handleSend}
        awareness={{ label: awareness.label, active: awarenessActive }}
        initialText={composerInitialText}
        placeholder={composerPlaceholder}
      />
    </div>
  );
}

function MessageBubble({
  msg,
  onDelete,
  onCopy,
  isEditing,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onConfirmAction,
}: {
  msg: ChatMessage;
  onDelete: () => void;
  onCopy: () => void;
  isEditing: boolean;
  onStartEdit: () => void;
  onSaveEdit: (text: string) => void;
  onCancelEdit: () => void;
  onConfirmAction: (confirmation: ConfirmationCardData, approved: boolean) => void;
}) {
  const isOperator = msg.authorKind === 'operator';
  const [editDraft, setEditDraft] = useState(msg.text);

  useEffect(() => {
    if (isEditing) setEditDraft(msg.text);
  }, [isEditing, msg.text]);

  return (
    <li className={clsx('group flex flex-col gap-0.5', isOperator ? 'items-end' : 'items-start')}>
      {!isOperator && msg.authorName && (
        <span className="px-1 text-[11px] text-text-muted">{msg.authorName}</span>
      )}
      <div className="flex items-start gap-1.5">
        {isOperator && (
          <MessageActions onCopy={onCopy} onDelete={onDelete} onEdit={onStartEdit} />
        )}
        <div
          className={clsx(
            'max-w-[85%] rounded-card px-3 py-2 text-[13px] leading-relaxed',
            isOperator
              ? 'bg-accent-soft text-text-primary'
              : msg.authorKind === 'system'
                ? 'border border-dashed border-line bg-surface-2 text-text-muted'
                : 'bg-surface-2 text-text-primary',
          )}
        >
          {msg.metadata?.thinking && (
            <div className="mb-2 border-l-2 border-line/60 pl-2 text-[11px] italic text-text-muted">
              {msg.metadata.thinking}
            </div>
          )}
          {msg.metadata?.toolCalls && msg.metadata.toolCalls.length > 0 && (
            <div className="mb-2 space-y-1">
              {msg.metadata.toolCalls.map((toolCall) => (
                <ToolCallPill key={toolCall.id} data={toolCall} />
              ))}
            </div>
          )}
          {msg.metadata?.confirmation && (
            <ConfirmationCard
              data={msg.metadata.confirmation}
              onApprove={() => onConfirmAction(msg.metadata!.confirmation!, true)}
              onCancel={() => onConfirmAction(msg.metadata!.confirmation!, false)}
            />
          )}
          {msg.metadata?.card && <ProactiveCard data={msg.metadata.card} />}
          {msg.metadata?.runId && (
            <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-line bg-canvas/60 px-2 py-1.5 text-[11px] text-text-secondary">
              <Plug size={12} className="text-text-muted" />
              <span className="font-medium text-text-primary">
                {msg.metadata.runTitle ?? (msg.metadata.isEphemeral ? 'Ephemeral run' : 'Workflow run')}
              </span>
              {msg.metadata.runStatus && <span className="uppercase tracking-wide text-text-muted">{msg.metadata.runStatus}</span>}
              <Link to={`/runs/${msg.metadata.runId}`} className="font-medium text-accent hover:underline">Open run</Link>
              {msg.metadata.workflowId && (
                <Link to={`/workflows/${msg.metadata.workflowId}`} className="font-medium text-accent hover:underline">Workflow</Link>
              )}
            </div>
          )}
          {isEditing ? (
            <div className="flex flex-col gap-1.5">
              <textarea
                value={editDraft}
                onChange={(event) => setEditDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    onSaveEdit(editDraft);
                  }
                  if (event.key === 'Escape') onCancelEdit();
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
          ) : msg.text ? (
            <div className="whitespace-pre-wrap break-words">{msg.text}</div>
          ) : msg.metadata?.card || msg.metadata?.confirmation || (msg.metadata?.toolCalls && msg.metadata.toolCalls.length > 0) ? null : (
            <div className="text-[12px] italic text-text-muted">No text content</div>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-text-muted">
            <span>{new Date(msg.createdAt).toLocaleTimeString()}</span>
            {msg.source && <span className="rounded bg-canvas px-1">via {msg.source}</span>}
            {msg.deliveryStatus && msg.deliveryStatus !== 'sent' && <span>{msg.deliveryStatus}</span>}
          </div>
        </div>
        {!isOperator && <MessageActions onCopy={onCopy} onDelete={onDelete} />}
      </div>
    </li>
  );
}

function ConfirmationCard({
  data,
  onApprove,
  onCancel,
}: {
  data: ConfirmationCardData;
  onApprove: () => void;
  onCancel: () => void;
}) {
  const expired = data.status === 'pending' && Number.isFinite(Date.parse(data.expiresAt)) && Date.parse(data.expiresAt) <= Date.now();
  const disabled = data.status !== 'pending' || expired;
  return (
    <div className="mb-2 rounded-md border border-warn/40 bg-warn-soft p-2 text-[12px] text-text-primary" data-testid="chat-confirmation-card">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-semibold">{data.title}</div>
          <div className="mt-0.5 font-mono text-[10px] text-text-muted">{data.toolCall.name}</div>
        </div>
        <span className="rounded bg-canvas px-1.5 py-0.5 text-[10px] text-text-muted">
          {expired ? 'expired' : data.status}
        </span>
      </div>
      <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-canvas/70 p-2 font-mono text-[10px] text-text-secondary">
        {data.body}
      </pre>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={onApprove}
          disabled={disabled}
          className="inline-flex h-7 items-center gap-1.5 rounded-btn bg-accent px-2.5 text-[11px] font-semibold text-canvas transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {data.status === 'approving' ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          {data.confirmLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={disabled}
          className="inline-flex h-7 items-center gap-1.5 rounded-btn border border-line bg-surface px-2.5 text-[11px] font-semibold text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          <X size={12} />
          {data.cancelLabel}
        </button>
      </div>
    </div>
  );
}

function asAppThreadHandoff(value: unknown): AppThreadHandoff | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.handoff !== 'app_thread.open' || typeof record.slug !== 'string') return null;
  return {
    handoff: 'app_thread.open',
    slug: record.slug,
    targetUrl: typeof record.targetUrl === 'string' ? record.targetUrl : undefined,
    carriedMessage: typeof record.carriedMessage === 'string' ? record.carriedMessage : null,
    reason: typeof record.reason === 'string' ? record.reason : null,
  };
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
