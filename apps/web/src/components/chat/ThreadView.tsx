import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, Clock3, Copy, FileText, Loader2, Pencil, Plug, ShieldCheck, Trash2, X } from 'lucide-react';
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
import type { ToolCallPillData } from '../ChatPanel/ToolCallPill';
import { ProactiveCard, type ProactiveCardData } from '../ChatPanel/ProactiveCard';
import { AgentModelSelector } from './AgentModelSelector';
import { ChatMarkdown } from './ChatMarkdown';
import { useChatPanelStore } from './ChatPanelStore';
import { ThinkingBubble } from './ThinkingBubble';
import { ExecutionFeed } from './ExecutionFeed';
import { PlanList, derivePlanItems, extractPlan } from './PlanList';
import { StickyProgressBanner } from './StickyProgressBanner';

interface ThreadViewProps {
  kind: 'room' | 'agent';
  id: string;
  name: string;
  initialDraft?: string;
  initialViewportOverride?: ViewportContext | null;
  autoSendInitialDraft?: boolean;
  conversationId?: string | null;
  archivedAt?: string | null;
  composerPlaceholder?: string;
  emptyBody?: string;
  onInitialDraftUsed?: () => void;
  onConversationReset?: (conversationId: string) => void;
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
  impact?: {
    summary: string;
    details?: string[];
    riskLevel?: 'low' | 'medium' | 'high' | 'danger';
    reversible?: boolean;
    externalSideEffects?: boolean;
  };
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

interface AgentRuntimeInfo {
  adapterType?: string | null;
  runtimeModel?: string | null;
  adapterCapabilities?: {
    interactiveChat: boolean;
    toolCalling: boolean;
    toolForwarding?: string;
    limitations?: string[];
  } | null;
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

function taskLabel(message: string): string {
  const firstLine = message.trim().split('\n')[0] ?? '';
  const clean = firstLine.replace(/\s+/g, ' ').trim();
  if (!clean) return 'Working…';
  return clean.length > 48 ? `${clean.slice(0, 47)}…` : clean;
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

function dedupeMessages(messages: ChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const message of sortMessages(messages)) byId.set(message.id, message);
  return Array.from(byId.values());
}

function upsertMessage(messages: ChatMessage[], next: ChatMessage): ChatMessage[] {
  let found = false;
  const updated = messages.map((message) => {
    if (message.id !== next.id) return message;
    found = true;
    return next;
  });
  return dedupeMessages(found ? updated : [...updated, next]);
}

function prependUnique(messages: ChatMessage[], older: ChatMessage[]): ChatMessage[] {
  const seen = new Set(messages.map((message) => message.id));
  return sortMessages([...older.filter((message) => !seen.has(message.id)), ...messages]);
}

function mergeMessage(messages: ChatMessage[], incoming: ChatMessage): ChatMessage[] {
  if (messages.some((message) => message.id === incoming.id)) {
    return upsertMessage(messages, incoming);
  }
  if (incoming.authorKind === 'operator') {
    const optimisticIndex = messages.findIndex(
      (message) => message.id.startsWith('tmp-') && message.authorKind === 'operator' && message.text === incoming.text,
    );
    if (optimisticIndex >= 0) {
      return dedupeMessages(messages.map((message, index) => (index === optimisticIndex ? incoming : message)));
    }
  }
  if (incoming.authorKind === 'agent') {
    const streamingIndex = messages.findIndex((message) => {
      if (!message.id.startsWith('stream-') || message.authorKind !== 'agent') return false;
      const currentText = message.text.trim();
      return currentText.length === 0 || currentText === incoming.text;
    });
    if (streamingIndex >= 0) {
      const replaced = messages.map((message, index) => (index === streamingIndex ? incoming : message));
      return dedupeMessages(replaced);
    }
  }
  return dedupeMessages([...messages, incoming]);
}

function harnessLabel(adapterType?: string | null): string {
  if (adapterType === 'codex') return 'Codex';
  if (adapterType === 'claude_code') return 'Claude Code';
  if (adapterType === 'cursor') return 'Cursor';
  if (adapterType === 'hermes_agent') return 'Hermes Agent';
  if (adapterType === 'openclaw') return 'OpenClaw';
  if (adapterType === 'http') return 'HTTP';
  return 'Runtime';
}

function formatAssistantLabel(name: string, runtime: AgentRuntimeInfo | null): string {
  const runtimeModel = runtime?.runtimeModel?.trim()
    || defaultRuntimeModel(runtime?.adapterType)
    || harnessLabel(runtime?.adapterType);
  return `${name} - ${runtimeModel}`;
}

function runtimeCapabilityWarning(runtime: AgentRuntimeInfo | null): { title: string; body: string } | null {
  const capabilities = runtime?.adapterCapabilities;
  if (!capabilities) return null;
  const limitation = capabilities.limitations?.find((item) => item.trim())?.trim();
  if (!capabilities.interactiveChat) {
    return {
      title: 'Runtime is task-only',
      body: limitation ?? 'This agent can run workflow tasks, but it is not wired into the live chat loop yet.',
    };
  }
  if (!capabilities.toolCalling) {
    return {
      title: 'Chat tools unavailable',
      body: limitation ?? 'This runtime can chat, but it cannot execute Agentis tools from chat yet. Build and run requests may stay advisory.',
    };
  }
  return null;
}

function defaultRuntimeModel(adapterType?: string | null): string | null {
  if (adapterType === 'codex') return 'gpt-5.3-codex';
  if (adapterType === 'claude_code') return 'claude-sonnet-4-6';
  if (adapterType === 'cursor') return 'auto';
  if (adapterType === 'hermes_agent') return 'hermes-auto';
  if (adapterType === 'openclaw') return 'gateway-default';
  if (adapterType === 'http') return 'provider-default';
  return null;
}

export function ThreadView({
  kind,
  id,
  name,
  initialDraft,
  initialViewportOverride,
  autoSendInitialDraft,
  conversationId,
  archivedAt,
  composerPlaceholder,
  emptyBody,
  onInitialDraftUsed,
  onConversationReset,
}: ThreadViewProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [agentNoAdapter, setAgentNoAdapter] = useState(false);
  const [agentRuntime, setAgentRuntime] = useState<AgentRuntimeInfo | null>(null);
  const [agentTyping, setAgentTyping] = useState(false);
  const [composerInitialText, setComposerInitialText] = useState(initialDraft ?? '');
  const scrollRef = useRef<HTMLDivElement>(null);
  const preserveScrollRef = useRef(false);
  const typingTimer = useRef<number | null>(null);
  const autoSentDraftKeyRef = useRef<string | null>(null);
  const consumedLaunchKeyRef = useRef<string | null>(null);
  const pendingViewportOverrideRef = useRef<ViewportContext | null>(initialViewportOverride ?? null);
  const openedCanvasWorkflowIdsRef = useRef<Set<string>>(new Set());
  const setActiveTask = useChatPanelStore((store) => store.setActiveTask);
  const updateActiveTask = useChatPanelStore((store) => store.updateActiveTask);
  const toast = useToast();
  const confirm = useConfirm();
  const awareness = useViewportAwareness();
  const navigate = useNavigate();

  const endpoint = kind === 'agent' ? `/v1/conversations/${id}` : `/v1/rooms/${id}/messages`;
  const sendEndpoint = kind === 'agent' ? `/v1/conversations/${id}/send` : `/v1/rooms/${id}/messages`;
  const confirmEndpoint = kind === 'agent' ? `/v1/conversations/${id}/confirm` : null;
  const readOnly = kind === 'agent' && Boolean(archivedAt);

  useEffect(() => {
    if (kind !== 'agent') return;
    function onModelUpdated(event: Event) {
      const detail = (event as CustomEvent<{ agentId?: string; model?: string | null }>).detail;
      if (detail?.agentId !== id) return;
        setAgentRuntime((current) => ({
          adapterType: current?.adapterType ?? null,
          runtimeModel: detail.model ?? defaultRuntimeModel(current?.adapterType),
          adapterCapabilities: current?.adapterCapabilities ?? null,
        }));
    }
    window.addEventListener('agentis:agent-model-updated', onModelUpdated);
    return () => window.removeEventListener('agentis:agent-model-updated', onModelUpdated);
  }, [id, kind]);

  async function loadPage(before?: ChatMessage): Promise<ChatMessage[]> {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (kind === 'agent' && conversationId) query.set('conversationId', conversationId);
    if (before) {
      query.set('before', before.createdAt);
      query.set('beforeId', before.id);
    }
    const path = `${endpoint}?${query.toString()}`;
    if (kind === 'agent') {
      const [threadData, agentData] = await Promise.all([
        api<{ messages: AgentMsg[] }>(path),
        api<{ agent: { adapterType?: string | null; runtimeModel?: string | null; adapterCapabilities?: AgentRuntimeInfo['adapterCapabilities']; config?: Record<string, unknown> | null } }>(`/v1/agents/${id}`)
          .catch(() => ({ agent: { adapterType: null, runtimeModel: null, adapterCapabilities: null, config: null } })),
      ]);
      if (!before) {
        setAgentNoAdapter(!agentData.agent?.adapterType);
        const selectedModel = typeof agentData.agent?.config?.model === 'string'
          ? agentData.agent.config.model
          : agentData.agent?.runtimeModel ?? defaultRuntimeModel(agentData.agent?.adapterType);
        setAgentRuntime({
          adapterType: agentData.agent?.adapterType ?? null,
          runtimeModel: selectedModel ?? null,
          adapterCapabilities: agentData.agent?.adapterCapabilities ?? null,
        });
      }
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
      setMessages(dedupeMessages(page));
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
    let streamedBody = '';
    const streamId = 'stream-' + Date.now();

    // Set the original confirmation card status to 'approving'
    setMessages((current) => current.map((message) => (
      message.id === messageId
        ? {
            ...message,
            metadata: {
              ...(message.metadata ?? {}),
              confirmation: { ...confirmation, status: 'approving' },
            },
          }
        : message
    )));

    // Create and append the new decoupled streaming bubble
    const streamingMessage: ChatMessage = {
      id: streamId,
      authorId: id,
      authorKind: 'agent',
      text: '',
      createdAt: new Date().toISOString(),
      deliveryStatus: 'sending',
      metadata: { source: 'chat_loop' },
    };
    setMessages((current) => dedupeMessages([...current, streamingMessage]));
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
                message.id === streamId
                  ? {
                      ...message,
                      text: streamedBody,
                      deliveryStatus: 'sending',
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
              setMessages((current) => current.map((message) => {
                if (message.id === messageId) {
                  return {
                    ...message,
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
                  };
                }
                if (message.id === streamId) {
                  return {
                    ...message,
                    deliveryStatus: delta.finishReason === 'error' ? 'failed' : 'delivered',
                  };
                }
                return message;
              }));
            }
          } else if (event === 'message') {
            const persisted = normalizeAgentMessage(data as AgentMsg);
            setMessages((current) => current.map((message) => {
              if (message.id === messageId) return message;
              if (message.id === streamId) {
                return {
                  ...persisted,
                  metadata: {
                    ...persisted.metadata,
                    toolCalls: message.metadata?.toolCalls ?? persisted.metadata?.toolCalls,
                    thinking: message.metadata?.thinking ?? persisted.metadata?.thinking,
                  },
                };
              }
              return message;
            }));
          } else if (event === 'error') {
            const message = streamErrorMessage(data);
            setAgentTyping(false);
            setMessages((current) => current.map((msg) => {
              if (msg.id === messageId) {
                return {
                  ...msg,
                  metadata: {
                    ...(msg.metadata ?? {}),
                    confirmation: msg.metadata?.confirmation
                      ? { ...msg.metadata.confirmation, status: 'failed' }
                      : undefined,
                  },
                };
              }
              if (msg.id === streamId) {
                return {
                  ...msg,
                  deliveryStatus: 'failed',
                };
              }
              return msg;
            }));
            toast.error('Agent could not complete the action', message);
          }
        },
      });
    } catch (error) {
      setAgentTyping(false);
      setMessages((current) => current.map((msg) => {
        if (msg.id === messageId) {
          return {
            ...msg,
            metadata: {
              ...(msg.metadata ?? {}),
              confirmation: msg.metadata?.confirmation
                ? { ...msg.metadata.confirmation, status: 'failed' }
                : undefined,
            },
          };
        }
        if (msg.id === streamId) {
          return {
            ...msg,
            deliveryStatus: 'failed',
          };
        }
        return msg;
      }));
      toast.error('Failed to confirm action', apiErrorMessage(error));
    }
  }

  useEffect(() => {
    void loadInitial();
  }, [kind, id, conversationId]);

  // Drop any "agent working" progress card we own when leaving this thread
  // (switching agents, navigating to fullscreen /chat, or unmounting). The
  // server turn keeps running and its result still arrives via realtime, but
  // the card must never orphan into an undismissable stuck state.
  useEffect(() => () => {
    const store = useChatPanelStore.getState();
    if (store.activeTask?.agentId === id) store.setActiveTask(null);
  }, [id]);

  useEffect(() => {
    setComposerInitialText('');
    consumedLaunchKeyRef.current = null;
    pendingViewportOverrideRef.current = initialViewportOverride ?? null;
  }, [kind, id, conversationId]);

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
    if (readOnly) return;
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
        setMessages((prev) => mergeMessage(prev, normalizeAgentMessage(payload.message as AgentMsg)));
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

  useRealtime([REALTIME_EVENTS.CANVAS_BUILD_COMPLETE], (env) => {
    if (kind !== 'agent') return;
    const payload = env.payload as { agentId?: string | null; workflowId?: string; runId?: string } | undefined;
    const workflowId = payload?.workflowId;
    if (!workflowId) return;
    if (payload?.agentId && payload.agentId !== id) return;
    if (openedCanvasWorkflowIdsRef.current.has(workflowId)) return;
    openedCanvasWorkflowIdsRef.current.add(workflowId);
    window.dispatchEvent(new CustomEvent('agentis:open-canvas', { detail: { workflowId, runId: payload?.runId ?? null } }));
    navigate(`/workflows/${workflowId}`);
    toast.success('Workflow opened on canvas');
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
      args: delta.args,
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
      const previous = existing.find((entry) => entry.id === delta.id);
      const nextPill: ToolCallPillData = {
        id: delta.id,
        name: delta.name,
        status: delta.error ? 'error' : 'success',
        args: previous?.args,
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
      impact: delta.impact,
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
    if (readOnly) {
      toast.warn('Past conversation', 'Use the + button in the header to start a fresh conversation.');
      return;
    }
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

    setMessages((current) => dedupeMessages([...current, operatorMessage, streamingMessage]));
    setAgentTyping(true);
    setActiveTask({ agentId: id, agentName: name, label: taskLabel(value), done: 0, total: 0, startedAt: Date.now() });

    const toolStartedAt = new Map<string, number>();
    let toolTotal = 0;
    let toolDone = 0;

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
              toolTotal += 1;
              updateActiveTask({ total: toolTotal });
              applyToolCallDelta(streamId, delta);
            } else if (delta.type === 'tool_result') {
              toolDone += 1;
              updateActiveTask({ done: toolDone });
              applyToolResultDelta(streamId, delta, toolStartedAt);
            } else if (delta.type === 'confirmation_required') {
              applyConfirmationDelta(streamId, delta);
            } else if (delta.type === 'done') {
              setAgentTyping(false);
              setActiveTask(null);
              setMessages((current) => current.map((message) => (
                message.id === streamId
                  ? { ...message, deliveryStatus: delta.finishReason === 'error' ? 'failed' : 'delivered' }
                  : message
              )));
            }
          } else if (event === 'message') {
            const persisted = normalizeAgentMessage(data as AgentMsg);
            setMessages((current) => {
              const merged: ChatMessage[] = current.map((message): ChatMessage => {
                if (message.id === streamId) {
                  return {
                    ...persisted,
                    metadata: {
                      ...persisted.metadata,
                      toolCalls: message.metadata?.toolCalls ?? persisted.metadata?.toolCalls,
                      thinking: message.metadata?.thinking ?? persisted.metadata?.thinking,
                    },
                  };
                }
                if (message.id === operatorMessage.id) return { ...message, deliveryStatus: 'delivered' as const };
                return message;
              });
              return dedupeMessages(merged);
            });
          } else if (event === 'error') {
            const message = streamErrorMessage(data);
            setAgentTyping(false);
            setActiveTask(null);
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
      setActiveTask(null);
      setMessages((current) => current.map((message) => (
        message.id === streamId || message.id === operatorMessage.id
          ? { ...message, deliveryStatus: 'failed' }
          : message
      )));
      toast.error('Failed to send', apiErrorMessage(error));
    }
  }

  async function startNewConversation() {
    if (kind !== 'agent') return;
    try {
      const result = await api<{ conversationId: string }>(`/v1/conversations/${id}/new`, { method: 'POST' });
      setMessages([]);
      setHasMore(false);
      setLoading(false);
      setAgentTyping(false);
      onConversationReset?.(result.conversationId);
      window.dispatchEvent(new CustomEvent('agentis:chat-history-changed'));
      toast.success('New conversation ready');
    } catch (error) {
      toast.error('Could not start a new conversation', apiErrorMessage(error));
    }
  }

  useEffect(() => {
    function onNewConversation(event: Event) {
      const detail = (event as CustomEvent<{ kind?: string; id?: string }>).detail;
      if (detail?.kind !== kind || detail?.id !== id) return;
      void startNewConversation();
    }
    window.addEventListener('agentis:chat-new-conversation', onNewConversation);
    return () => window.removeEventListener('agentis:chat-new-conversation', onNewConversation);
  });

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

  async function handleCancelRun(runId: string) {
    try {
      await api(`/v1/runs/${runId}/cancel`, { method: 'POST' });
      toast.success('Run cancellation request sent');
      const store = useChatPanelStore.getState();
      if (store.activeTask?.agentId === id) store.setActiveTask(null);
    } catch (error) {
      toast.error('Failed to cancel run', apiErrorMessage(error));
    }
  }

  const awarenessActive = kind === 'agent'
    && awareness.context.surface !== 'chat'
    && awareness.context.surface !== 'unknown';
  const activeToolCalls = messages
    .filter((message) => message.deliveryStatus === 'sending' || message.metadata?.toolCalls?.some((call) => call.status === 'running'))
    .flatMap((message) => message.metadata?.toolCalls ?? []);
  const activeRunId = messages.find(
    (m) => (m.deliveryStatus === 'sending' || m.metadata?.toolCalls?.some((tc) => tc.status === 'running')) && m.metadata?.runId
  )?.metadata?.runId;
  const runtimeWarning = kind === 'agent' && !agentNoAdapter
    ? runtimeCapabilityWarning(agentRuntime)
    : null;
  // When an assistant bubble is mid-stream it shows its own in-bubble typing
  // indicator, so the standalone "is thinking…" footer would be a duplicate.
  const streamingAgentActive = messages.some(
    (message) => message.authorKind === 'agent' && message.deliveryStatus === 'sending',
  );

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3">
        <StickyProgressBanner
          toolCalls={activeToolCalls}
          activeRunId={activeRunId}
          onCancelRun={handleCancelRun}
          onJumpToLatest={() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })}
        />
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
                assistantLabel={kind === 'agent' ? formatAssistantLabel(name, agentRuntime) : undefined}
                onDelete={() => void handleDelete(message)}
                onCopy={() => void handleCopy(message)}
                isEditing={editingId === message.id}
                readOnly={readOnly}
                onStartEdit={() => setEditingId(message.id)}
                onSaveEdit={(text) => void handleEditSave(message, text)}
                onCancelEdit={() => setEditingId(null)}
                onConfirmAction={(confirmation, approved) => void handleConfirmationAction(message.id, confirmation, approved)}
                onCancelRun={handleCancelRun}
              />
            ))}
          </ul>
        )}
        {agentTyping && kind === 'agent' && !streamingAgentActive && (
          <div className="mt-2 flex items-center gap-2 px-1 text-[11px] italic text-text-muted">
            <TypingDots />
            <span>{name} is thinking…</span>
          </div>
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

      {runtimeWarning && (
        <div className="border-t border-warn/20 bg-[linear-gradient(135deg,rgba(245,158,11,0.10),rgba(20,184,166,0.06))] px-3 py-2.5">
          <div className="flex items-start gap-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warn" />
            <div className="min-w-0">
              <div className="text-[12px] font-medium text-text-primary">{runtimeWarning.title}</div>
              <div className="mt-0.5 text-[11px] leading-relaxed text-text-muted">{runtimeWarning.body}</div>
            </div>
          </div>
        </div>
      )}

      {readOnly ? (
        <div className="border-t border-line bg-surface-2 px-3 py-2 text-[12px] text-text-muted">
          This is a saved conversation. Use the + button in the header to start a fresh chat with {name}.
        </div>
      ) : (
        <Composer
          key={`${kind}:${id}:${composerInitialText}`}
          onSend={handleSend}
          awareness={{ label: awareness.label, active: awarenessActive }}
          initialText={composerInitialText}
          placeholder={composerPlaceholder}
          draftKey={`${kind}:${id}`}
          footer={
            kind === 'agent' ? (
              <AgentModelSelector agentId={id} compact />
            ) : undefined
          }
        />
      )}
    </div>
  );
}

function MessageBubble({
  msg,
  assistantLabel,
  onDelete,
  onCopy,
  isEditing,
  readOnly,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onConfirmAction,
  onCancelRun,
}: {
  msg: ChatMessage;
  assistantLabel?: string;
  onDelete: () => void;
  onCopy: () => void;
  isEditing: boolean;
  readOnly: boolean;
  onStartEdit: () => void;
  onSaveEdit: (text: string) => void;
  onCancelEdit: () => void;
  onConfirmAction: (confirmation: ConfirmationCardData, approved: boolean) => void;
  onCancelRun?: (runId: string) => void;
}) {
  const isOperator = msg.authorKind === 'operator';
  const [editDraft, setEditDraft] = useState(msg.text);
  const statusLabel = isOperator && msg.deliveryStatus === 'sending'
    ? 'sending'
    : msg.deliveryStatus === 'failed'
      ? 'failed'
      : null;
  const streaming = msg.deliveryStatus === 'sending';
  const parsedPlan = !isOperator && !isEditing ? extractPlan(msg.text) : null;
  const bodyBeforePlan = parsedPlan ? parsedPlan.before : msg.text;
  const bodyAfterPlan = parsedPlan?.after ?? '';
  const toolCalls = msg.metadata?.toolCalls ?? [];

  useEffect(() => {
    if (isEditing) setEditDraft(msg.text);
  }, [isEditing, msg.text]);

  return (
    <li className={clsx('group flex flex-col gap-0.5', isOperator ? 'items-end' : 'items-start')}>
      {!isOperator && msg.authorName && (
        <span className="px-1 text-[11px] text-text-muted">{msg.authorName}</span>
      )}
      <div className="flex items-start gap-1.5">
        {isOperator && !readOnly && (
          <MessageActions onCopy={onCopy} onDelete={onDelete} onEdit={onStartEdit} />
        )}
        <div
          className={clsx(
            'max-w-[85%] rounded-card px-3 py-2 text-[13px] leading-relaxed',
            isOperator
              ? 'bg-accent-soft text-text-primary'
              : msg.authorKind === 'system'
                ? 'border border-dashed border-line bg-surface-2 text-text-muted'
                : 'bg-surface-2 text-text-primary shadow-[0_18px_35px_-30px_rgba(0,0,0,0.7)]',
          )}
        >
          {!isOperator && msg.metadata?.thinking && (
            <ThinkingBubble text={msg.metadata.thinking} streaming={streaming && !msg.text.trim()} />
          )}
          {!isEditing && bodyBeforePlan && (
            isOperator ? (
              <div className="mb-2 whitespace-pre-wrap break-words">{bodyBeforePlan}</div>
            ) : (
              <div className="mb-2 break-words">
                <ChatMarkdown text={bodyBeforePlan} />
                {streaming && !bodyAfterPlan ? <StreamingCursor /> : null}
              </div>
            )
          )}
          {!isOperator && parsedPlan && (
            <PlanList items={derivePlanItems(parsedPlan.items, toolCalls, streaming)} />
          )}
          {!isOperator && toolCalls.length > 0 && (
            <ExecutionFeed toolCalls={toolCalls} streaming={streaming} />
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
              {onCancelRun && msg.metadata.runId && (!msg.metadata.runStatus || ['running', 'pending'].includes(msg.metadata.runStatus)) && (
                <button
                  type="button"
                  onClick={() => onCancelRun(msg.metadata!.runId!)}
                  className="font-medium text-danger hover:underline ml-auto"
                >
                  Stop run
                </button>
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
          ) : bodyAfterPlan ? (
            isOperator ? (
              <div className="whitespace-pre-wrap break-words">{bodyAfterPlan}</div>
            ) : (
              <div className="break-words">
                <ChatMarkdown text={bodyAfterPlan} />
                {streaming ? <StreamingCursor /> : null}
              </div>
            )
          ) : (msg.metadata?.card || msg.metadata?.confirmation || toolCalls.length > 0 || bodyBeforePlan || (!isOperator && msg.metadata?.thinking)) ? null : streaming && !isOperator ? (
            <TypingDots />
          ) : !isOperator ? null : (
            <div className="text-[12px] italic text-text-muted">No text content</div>
          )}
          <div className="mt-1.5 border-t border-line/30 pt-1 flex flex-wrap items-center gap-1.5 text-[10px] font-mono tracking-wider text-text-muted">
            <span>{new Date(msg.createdAt).toLocaleTimeString()}</span>
            {!isOperator && msg.authorKind === 'agent' && assistantLabel && (
              <span className="rounded bg-canvas px-1">{assistantLabel}</span>
            )}
            {statusLabel && <span className={clsx('uppercase font-bold', statusLabel === 'sending' ? 'text-accent' : 'text-danger')}>{statusLabel}</span>}
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
  const [now, setNow] = useState(Date.now());
  const [detailsOpen, setDetailsOpen] = useState(false);
  const expiresAtMs = Date.parse(data.expiresAt);
  const hasExpiry = Number.isFinite(expiresAtMs);
  const expired = data.status === 'pending' && hasExpiry && expiresAtMs <= now;
  const disabled = data.status !== 'pending' || expired;
  const impact = data.impact ?? inferConfirmationImpact(data);
  const riskLevel = impact.riskLevel ?? 'medium';
  const risk = confirmationRiskStyle(riskLevel);
  const details = impact.details?.filter(Boolean) ?? [];
  const auditPreview = formatConfirmationJson(data.toolCall.args);

  useEffect(() => {
    if (data.status !== 'pending' || !hasExpiry) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [data.status, hasExpiry]);

  return (
    <div className={clsx(
      'mb-2 overflow-hidden rounded-2xl border bg-canvas/80 text-[12px] text-text-primary shadow-[0_24px_55px_-42px_rgba(0,0,0,0.85)]',
      risk.container,
    )} data-testid="chat-confirmation-card">
      <div className="relative p-3">
        <div className={clsx('pointer-events-none absolute inset-x-0 top-0 h-1', risk.bar)} />
        <div className="flex items-start gap-2.5">
          <div className={clsx('mt-0.5 rounded-xl border p-2', risk.icon)}>
            {riskLevel === 'danger' || riskLevel === 'high'
              ? <AlertTriangle size={15} />
              : <ShieldCheck size={15} />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <div className="font-semibold">{data.title}</div>
              <span className={clsx('rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em]', risk.badge)}>
                {riskLevel} risk
              </span>
            </div>
            <div className="mt-1 text-[12px] leading-relaxed text-text-secondary">{impact.summary}</div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] text-text-muted">
              <span className="font-mono">{data.toolCall.name}</span>
              <span className="inline-flex items-center gap-1">
                <Clock3 size={11} />
                {expired ? 'Expired' : hasExpiry ? `${formatRemainingTime(expiresAtMs - now)} left` : data.status}
              </span>
              {impact.reversible !== undefined && (
                <span>{impact.reversible ? 'Reversible' : 'Not automatically reversible'}</span>
              )}
              {impact.externalSideEffects && <span>May trigger external side effects</span>}
            </div>
          </div>
          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-text-muted">
            {expired ? 'expired' : data.status}
          </span>
        </div>

        {details.length > 0 && (
          <div className="mt-3 grid gap-1.5">
            {details.slice(0, 4).map((detail) => (
              <div key={detail} className="flex gap-2 rounded-xl border border-line/60 bg-surface/60 px-2.5 py-1.5 text-[11px] text-text-secondary">
                <span className={clsx('mt-1 h-1.5 w-1.5 shrink-0 rounded-full', risk.dot)} />
                <span>{detail}</span>
              </div>
            ))}
          </div>
        )}

        <button
          type="button"
          onClick={() => setDetailsOpen((value) => !value)}
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-line/60 bg-surface/70 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted transition hover:bg-surface-2 hover:text-text-primary"
          aria-expanded={detailsOpen}
        >
          <FileText size={11} />
          {detailsOpen ? 'Hide audit payload' : 'Show audit payload'}
        </button>
        {detailsOpen && (
          <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-line/70 bg-canvas/80 p-2 font-mono text-[10px] leading-relaxed text-text-secondary">
            {auditPreview}
          </pre>
        )}

        <div className="mt-3 flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={onApprove}
          disabled={disabled}
          className="inline-flex h-8 items-center gap-1.5 rounded-btn bg-accent px-3 text-[11px] font-semibold text-canvas transition hover:bg-accent-hover active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {data.status === 'approving' ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          {data.confirmLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={disabled}
          className="inline-flex h-8 items-center gap-1.5 rounded-btn border border-line bg-surface px-3 text-[11px] font-semibold text-text-secondary transition hover:bg-surface-2 hover:text-text-primary active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <X size={12} />
          {data.cancelLabel}
        </button>
        {disabled && expired && (
          <span className="inline-flex h-8 items-center text-[11px] text-text-muted">Send the request again to refresh approval.</span>
        )}
        </div>
      </div>
    </div>
  );
}

function inferConfirmationImpact(data: ConfirmationCardData): NonNullable<ConfirmationCardData['impact']> {
  return {
    summary: data.body.split('\n').find((line) => line.trim()) ?? 'This action changes platform state.',
    details: [],
    riskLevel: 'medium',
    reversible: false,
    externalSideEffects: false,
  };
}

function confirmationRiskStyle(level: NonNullable<NonNullable<ConfirmationCardData['impact']>['riskLevel']>) {
  const styles = {
    low: {
      container: 'border-accent/25',
      bar: 'bg-accent/70',
      badge: 'bg-accent/10 text-accent',
      icon: 'border-accent/25 bg-accent/10 text-accent',
      dot: 'bg-accent',
    },
    medium: {
      container: 'border-warn/35',
      bar: 'bg-warn/80',
      badge: 'bg-warn-soft text-warn',
      icon: 'border-warn/35 bg-warn-soft text-warn',
      dot: 'bg-warn',
    },
    high: {
      container: 'border-warn/50',
      bar: 'bg-warn',
      badge: 'bg-warn-soft text-warn',
      icon: 'border-warn/50 bg-warn-soft text-warn',
      dot: 'bg-warn',
    },
    danger: {
      container: 'border-danger/45',
      bar: 'bg-danger',
      badge: 'bg-danger/10 text-danger',
      icon: 'border-danger/40 bg-danger/10 text-danger',
      dot: 'bg-danger',
    },
  };
  return styles[level];
}

function formatRemainingTime(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes <= 0) return `${rest}s`;
  return `${minutes}m ${rest.toString().padStart(2, '0')}s`;
}

function formatConfirmationJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
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

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-1" role="status" aria-label="Assistant is responding">
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-muted/80 [animation-delay:-0.3s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-muted/80 [animation-delay:-0.15s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-muted/80" />
    </span>
  );
}

function StreamingCursor() {
  return (
    <span
      className="ml-0.5 inline-block h-3.5 w-[2px] translate-y-[2px] animate-pulse rounded-sm bg-accent align-middle"
      aria-hidden
    />
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
