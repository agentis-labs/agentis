import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Clock3, Copy, FileText, Loader2, Pencil, Plug, ShieldCheck, X } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { REALTIME_EVENTS, type ChatDelta, type ChatPermissionMode, type ChatTurnTrace, type ViewportContext, type WorkStepTrack } from '@agentis/core';
import { PermissionModePicker } from './PermissionModePicker';
import { readPlanStepTrack } from '../../lib/workSteps';
import { StepTrack } from '../shared/StepTrack';
import { api, apiErrorMessage, streamSse } from '../../lib/api';
import { useViewportAwareness } from '../../lib/viewportContext';
import { openRunModal } from '../../lib/runModal';
import { listInteractions, type InteractionEvent } from '../../lib/connections';
import { useToast } from '../shared/Toast';
import { Skeleton } from '../shared/Skeleton';
import { rtSubscribe, useRealtime } from '../../lib/realtime';
import { Composer } from './Composer';
import type { ToolCallData as ToolCallPillData } from './toolCalls';
import { ProactiveCard, type ProactiveCardData } from './ProactiveCard';
import { ChatMarkdown } from './ChatMarkdown';
import { useChatPanelStore } from './ChatPanelStore';
import { AgentTurnTrace } from './AgentTurnTrace';
import { dedupeMessages, mergeMessage, prependUnique, sortMessages, upsertMessage } from './messageModel';
import { useAutoScroll } from '../../hooks/useAutoScroll';
import { ChatPlanCanvas, extractAgentPlan } from './ChatPlanCanvas';
import { ChatArtifactAttachments, collectArtifactIds } from './ArtifactAttachments';

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

/** A message sent while a turn was already streaming — durably queued
 * server-side and auto-dispatched, oldest first, once the turn ends. */
type QueuedItem = {
  id: string;
  conversationId?: string;
  text: string;
  createdAt: string;
  position: number;
};

type AgentConversation = {
  id: string;
  executionMode?: 'chat' | 'plan';
};

type RoomMsg = {
  id: string;
  authorType: string;
  authorId?: string | null;
  contentType?: string;
  content: Record<string, unknown>;
  createdAt: string;
};

interface MessageMeta {
  source?: 'openclaw_exec' | 'openclaw_session' | 'workflow' | 'manual' | 'proactive' | 'chat_loop' | 'chat_confirmation' | 'tool_call';
  clientTurnId?: string;
  card?: ProactiveCardData;
  activity?: Array<Extract<ChatDelta, { type: 'activity' }>>;
  turn?: ChatTurnTrace;
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
  artifactIds?: string[];
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

function createClientTurnId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `turn-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Normalize an @handle the same way the backend broadcast dispatcher does. */
function normalizeAgentHandle(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Resolve @handles in `text` to known agent ids (mirrors the server's matcher). */
function resolveMentionedAgentIds(text: string, agentMap: Record<string, { name: string }>): string[] {
  const handles = new Set<string>();
  for (const match of text.matchAll(/@([a-z0-9._-]{2,40})/gi)) {
    const handle = normalizeAgentHandle(match[1] ?? '');
    if (handle) handles.add(handle);
  }
  if (handles.size === 0) return [];
  const ids: string[] = [];
  for (const [id, agent] of Object.entries(agentMap)) {
    if (handles.has(normalizeAgentHandle(agent.name))) ids.push(id);
  }
  return ids;
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
  const content = message.content ?? {};
  return {
    id: message.id,
    authorId: message.authorId ?? '',
    authorKind: message.authorType as ChatMessage['authorKind'],
    text:
      typeof content.text === 'string'
        ? content.text
        : typeof content.caption === 'string'
          ? content.caption
          : '',
    artifactIds: extractArtifactIdsFromRoomContent(message.contentType, content),
    createdAt: message.createdAt,
  };
}

function extractArtifactIdsFromRoomContent(contentType: string | undefined, content: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  collectArtifactIds(content, ids);
  if ((contentType === 'image' || contentType === 'document' || contentType === 'artifact_card') && typeof content.artifactId === 'string') {
    ids.add(content.artifactId);
  }
  return [...ids];
}

function normalizeInteractionMessage(event: InteractionEvent): ChatMessage {
  let text = event.summary;

  // Transform A2A messages into conversational slack-like text
  if (event.kind === 'message') {
    // "Actor → Target: Message" or similar
    // We just want it to look like it naturally flows.
    // If it has an arrow indicating a target, let's try to extract it.
    const parts = text.split('→');
    if (parts.length > 1) {
      const rightSide = parts[1]!.trim();
      const colonIdx = rightSide.indexOf(':');
      if (colonIdx > 0) {
        const target = rightSide.substring(0, colonIdx).trim();
        const content = rightSide.substring(colonIdx + 1).trim();
        // Remove quotes if present
        const unquoted = content.replace(/^"|"$/g, '');
        text = `**@${target}** ${unquoted}`;
      }
    }
  }

  return {
    id: `interaction-${event.id}`,
    authorId: event.actor.id ?? 'system',
    authorName: event.actor.id ?? 'System',
    authorKind: event.actor.type === 'agent' ? 'agent' : 'system',
    text,
    createdAt: event.at,
  };
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
  if (adapterType === 'codex') return 'gpt-5.5';
  if (adapterType === 'claude_code') return 'claude-sonnet-5';
  if (adapterType === 'cursor') return 'auto';
  if (adapterType === 'hermes_agent') return 'hermes-auto';
  if (adapterType === 'openclaw') return 'gateway-default';
  if (adapterType === 'http') return 'provider-default';
  return null;
}

/** Read a persisted permission mode from localStorage, validating the value. */
function readStoredPermissionMode(key: string): ChatPermissionMode | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === 'ask' || raw === 'plan' || raw === 'auto' ? raw : null;
  } catch {
    return null;
  }
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
  // Queue-then-auto-continue composer: messages sent while a turn was already
  // streaming. Persisted server-side (survives a reload) and rendered as
  // dimmed "queued" bubbles until they're auto-dispatched into a real turn.
  const [pendingQueue, setPendingQueue] = useState<QueuedItem[]>([]);
  const dispatchedQueueIdsRef = useRef<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [agentMap, setAgentMap] = useState<Record<string, { name: string; role?: string | null; colorHex?: string | null }>>({});

  useEffect(() => {
    api<{ agents: Array<{ id: string; name: string; role?: string | null; colorHex?: string | null }> }>('/v1/agents')
      .then((res) => {
        const map: Record<string, { name: string; role?: string | null; colorHex?: string | null }> = {};
        for (const a of res.agents) map[a.id] = { name: a.name, role: a.role, colorHex: a.colorHex };
        setAgentMap(map);
      })
      .catch(() => {});
  }, []);
  const [agentNoAdapter, setAgentNoAdapter] = useState(false);
  const [agentRuntime, setAgentRuntime] = useState<AgentRuntimeInfo | null>(null);
  const [loadedConversationId, setLoadedConversationId] = useState<string | null>(conversationId ?? null);
  const [agentTyping, setAgentTyping] = useState(false);
  // Global Chat loading state: which @mentioned agents we're still waiting on for
  // reply (posted after the mention) shows up. A safety timer caps the wait.
  const [pendingResponders, setPendingResponders] = useState<string[]>([]);
  const broadcastPostAtRef = useRef<string | null>(null);
  const broadcastPendingTimerRef = useRef<number | null>(null);
  const [composerInitialText, setComposerInitialText] = useState(initialDraft ?? '');
  // Per-conversation permission mode (ask | plan | auto). Sticky locally so the
  // server-side so channels and the next turn agree (default ask).
  const permissionModeKey = `agentis:permission-mode:${id}:${conversationId ?? 'active'}`;
  const [permissionMode, setPermissionModeState] = useState<ChatPermissionMode>('ask');
  useEffect(() => {
    if (kind !== 'agent') return;
    const stored = readStoredPermissionMode(permissionModeKey);
    setPermissionModeState(stored ?? 'ask');
  }, [permissionModeKey, kind]);
  async function setPermissionMode(mode: ChatPermissionMode) {
    setPermissionModeState(mode);
    try { window.localStorage.setItem(permissionModeKey, mode); } catch { /* ignore */ }
    if (conversationId) {
      try {
        await api(`/v1/conversations/session/${conversationId}/mode`, {
          method: 'POST',
          body: JSON.stringify({ mode }),
        });
      } catch (error) {
        toast.error('Could not change mode', apiErrorMessage(error));
      }
    }
  }
  const typingTimer = useRef<number | null>(null);
  const activeChatAbortRef = useRef<AbortController | null>(null);
  const autoSentDraftKeyRef = useRef<string | null>(null);
  const consumedLaunchKeyRef = useRef<string | null>(null);
  const pendingViewportOverrideRef = useRef<ViewportContext | null>(initialViewportOverride ?? null);
  const openedCanvasWorkflowIdsRef = useRef<Set<string>>(new Set());
  // The real workspace room id behind the virtual `__broadcast__` view, so live
  // room events (which carry the real id) can be scoped to Global Chat.
  const broadcastRoomIdRef = useRef<string | null>(null);
  const setActiveTask = useChatPanelStore((store) => store.setActiveTask);
  const updateActiveTask = useChatPanelStore((store) => store.updateActiveTask);
  const toast = useToast();
  const awareness = useViewportAwareness();
  const navigate = useNavigate();
  const {
    scrollRef,
    isAtBottom,
    scrollToBottom,
    suppressNextScroll,
  } = useAutoScroll(messages.length, agentTyping || pendingResponders.length > 0);

  const querySuffix = conversationId ? `?conversationId=${conversationId}` : '';
  const endpoint = kind === 'agent' ? `/v1/conversations/${id}` : `/v1/rooms/${id}/messages`;
  const sendEndpoint = kind === 'agent' ? `/v1/conversations/${id}/send${querySuffix}` : `/v1/rooms/${id}/messages`;
  const confirmEndpoint = kind === 'agent' ? `/v1/conversations/${id}/confirm${querySuffix}` : null;
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
        api<{ messages: AgentMsg[]; conversation?: AgentConversation }>(path),
        api<{ agent: { adapterType?: string | null; runtimeModel?: string | null; adapterCapabilities?: AgentRuntimeInfo['adapterCapabilities']; config?: Record<string, unknown> | null } }>(`/v1/agents/${id}`)
          .catch(() => ({ agent: { adapterType: null, runtimeModel: null, adapterCapabilities: null, config: null } })),
      ]);
      if (!before) {
        setLoadedConversationId(threadData.conversation?.id ?? conversationId ?? null);
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
    if (id === '__broadcast__') {
      const [data, interactions] = await Promise.all([
        api<{ messages: RoomMsg[] }>(path).catch(() => ({ messages: [] as RoomMsg[] })),
        listInteractions({ limit: PAGE_SIZE, before: before?.createdAt }).catch(() => ({ events: [] }))
      ]);
      const roomMessages = (data.messages ?? []).map(normalizeRoomMessage);
      // The interaction feed re-reports agent-authored room messages (same id) as
      // `kind:'message'` events. Drop those so a reply already shown as a room
      // message isn't rendered a SECOND time; keep interactions from other rooms.
      const roomMsgIds = new Set((data.messages ?? []).map((m) => m.id));
      const interactionMessages = (interactions.events ?? [])
        .filter((e) => e.kind === 'message' && !roomMsgIds.has(e.id))
        .map(normalizeInteractionMessage);
      return sortMessages([...roomMessages, ...interactionMessages]);
    }
    const data = await api<{ messages: RoomMsg[] }>(path);
    return (data.messages ?? []).map(normalizeRoomMessage);
  }

  async function loadInitial() {
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
    suppressNextScroll();
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
    const clientTurnId = createClientTurnId();
    const createdAt = new Date().toISOString();
    const streamId = `stream-${clientTurnId}`;

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
      createdAt,
      deliveryStatus: 'sending',
      metadata: {
        source: 'chat_loop',
        clientTurnId,
        turn: {
          clientTurnId,
          startedAt: createdAt,
          status: 'running',
        },
      },
    };
    setMessages((current) => dedupeMessages([...current, streamingMessage]));
    setAgentTyping(true);

    try {
      await streamSse(confirmEndpoint, {
        method: 'POST',
        body: JSON.stringify({ turnId: confirmation.turnId, confirmed, clientTurnId }),
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
            setMessages((current) => {
              const streamMessage = current.find((message) => message.id === streamId);
              return mergeMessage(current, {
                ...persisted,
                metadata: {
                  ...persisted.metadata,
                  clientTurnId: persisted.metadata?.clientTurnId ?? clientTurnId,
                  toolCalls: streamMessage?.metadata?.toolCalls ?? persisted.metadata?.toolCalls,
                  activity: persisted.metadata?.activity ?? streamMessage?.metadata?.activity,
                  turn: persisted.metadata?.turn ?? streamMessage?.metadata?.turn,
                },
              });
            });
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

  /** Refetch the still-pending queued messages for this conversation. */
  async function loadQueue() {
    if (kind !== 'agent') { setPendingQueue([]); return; }
    try {
      const res = await api<{ items: QueuedItem[] }>(`/v1/conversations/${id}/queue${querySuffix}`);
      setPendingQueue(res.items ?? []);
    } catch {
      setPendingQueue([]);
    }
  }

  /** Remove a queued item locally + start the real turn for it exactly once
   * (guards against the direct /queue/resume response and the realtime echo
   * of the same dispatch both trying to fire it). */
  function handleQueueDispatch(item: QueuedItem) {
    if (dispatchedQueueIdsRef.current.has(item.id)) return;
    dispatchedQueueIdsRef.current.add(item.id);
    setPendingQueue((prev) => prev.filter((q) => q.id !== item.id));
    void handleSend(item.text);
  }

  useEffect(() => {
    if (kind !== 'agent') { setPendingQueue([]); return; }
    let cancelled = false;
    void loadQueue();
    // Reload recovery: if the tab (re)loaded mid-queue with no turn actively
    // streaming, atomically claim the oldest still-pending message so it
    // keeps going as a fresh turn — a reload must never silently strand a
    // queued send. The backend only hands it back if no turn is in flight.
    (async () => {
      try {
        const res = await api<{ item: QueuedItem | null }>(`/v1/conversations/${id}/queue/resume${querySuffix}`, { method: 'POST' });
        if (!cancelled && res.item) handleQueueDispatch(res.item);
      } catch {  }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, id, conversationId]);

  // Resolve the backing room id for Global Chat so live agent replies (posted
  // under the real id) can be matched to this workspace-wide view.
  useEffect(() => {
    broadcastRoomIdRef.current = null;
    if (kind !== 'room' || id !== '__broadcast__') return;
    let cancelled = false;
    api<{ room: { id: string } }>('/v1/rooms/__broadcast__')
      .then((res) => { if (!cancelled) broadcastRoomIdRef.current = res.room.id; })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [kind, id]);

  useEffect(() => {
    setLoadedConversationId(conversationId ?? null);
  }, [kind, id, conversationId]);

  // Reset the Global Chat "responding…" indicator when switching threads, and
  // clear its safety timer on unmount.
  useEffect(() => {
    setPendingResponders([]);
    broadcastPostAtRef.current = null;
    if (broadcastPendingTimerRef.current) {
      window.clearTimeout(broadcastPendingTimerRef.current);
      broadcastPendingTimerRef.current = null;
    }
  }, [kind, id]);
  useEffect(() => () => {
    if (broadcastPendingTimerRef.current) window.clearTimeout(broadcastPendingTimerRef.current);
  }, []);

  // Drop any "agent working" progress card we own when leaving this thread
  // (switching agents or unmounting). The
  // server turn keeps running and its result still arrives via realtime, but
  // the card must never remain as an undismissable stuck state.
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
    return kind === 'room'
      ? rtSubscribe('room', { roomId: id })
      : rtSubscribe('conversation', { agentId: id });
  }, [kind, id]);

  // Live task-spine steps for this conversation — the same StepTrack the Live
  // Workspace shows, so progress is visible right in the chat. Task spine events
  // are published to the workspace room, so we subscribe to it explicitly.
  const [stepTrack, setStepTrack] = useState<WorkStepTrack | null>(null);
  useEffect(() => { setStepTrack(null); }, [kind, id, conversationId]);
  useEffect(() => rtSubscribe('workspace', {}), []);
  useRealtime([
    REALTIME_EVENTS.TASK_SPINE_ACCEPTED,
    REALTIME_EVENTS.TASK_SPINE_UPDATED,
    REALTIME_EVENTS.TASK_SPINE_COMPLETED,
    REALTIME_EVENTS.TASK_SPINE_VERIFIED,
    REALTIME_EVENTS.TASK_SPINE_BLOCKED,
    REALTIME_EVENTS.TASK_SPINE_FAILED,
  ], (env) => {
    const payload = env.payload as { conversationId?: string | null };
    const expected = loadedConversationId ?? conversationId ?? null;
    if (!payload.conversationId || !expected || payload.conversationId !== expected) return;
    const track = readPlanStepTrack(env.payload as Record<string, unknown>);
    if (track) setStepTrack(track);
  });

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
    const payload = env.payload as {
      id?: string;
      roomId?: string;
      agentId?: string;
      message?: AgentMsg | RoomMsg;
      conversationId?: string | null;
    };
    if (kind === 'agent') {
      if (payload.agentId !== id) return;
      const expectedConversationId = loadedConversationId ?? conversationId ?? null;
      if (!payload.conversationId || !expectedConversationId || payload.conversationId !== expectedConversationId) return;
      if (env.event === REALTIME_EVENTS.CONVERSATION_MESSAGE_DELETED) {
        setMessages((prev) => prev.filter((message) => message.id !== payload.id));
        return;
      }
      if (payload.message) {
        setMessages((prev) => mergeMessage(prev, normalizeAgentMessage(payload.message as AgentMsg)));
      }
      return;
    }
    // Global Chat is a virtual view over a real backing room; match live events
    // (incl. the agent replies the broadcast dispatcher posts) to that room id.
    const targetRoomId = id === '__broadcast__' ? broadcastRoomIdRef.current : id;
    if (!targetRoomId || payload.roomId !== targetRoomId) return;
    if (env.event === REALTIME_EVENTS.ROOM_MESSAGE_DELETED) {
      setMessages((prev) => prev.filter((message) => message.id !== payload.id));
      return;
    }
    if (payload.message) {
      setMessages((prev) => upsertMessage(prev, normalizeRoomMessage(payload.message as RoomMsg)));
    }
  });

  // Queue-then-auto-continue composer: a message was queued/discarded while a
  // turn streamed, or the oldest queued message was just popped and needs to
  // become a real turn now that the prior one ended.
  useRealtime([REALTIME_EVENTS.CONVERSATION_QUEUE_UPDATED], (env) => {
    if (kind !== 'agent' || readOnly) return;
    const payload = env.payload as {
      agentId?: string;
      conversationId?: string | null;
      item?: QueuedItem;
      action?: 'added' | 'dispatched' | 'discarded';
    };
    if (payload.agentId !== id || !payload.item) return;
    const expectedConversationId = loadedConversationId ?? conversationId ?? null;
    if (!payload.conversationId || !expectedConversationId || payload.conversationId !== expectedConversationId) return;
    if (payload.action === 'added') {
      setPendingQueue((prev) => (prev.some((q) => q.id === payload.item!.id) ? prev : [...prev, payload.item!]));
    } else if (payload.action === 'discarded') {
      setPendingQueue((prev) => prev.filter((q) => q.id !== payload.item!.id));
    } else if (payload.action === 'dispatched') {
      handleQueueDispatch(payload.item);
    }
  });

  // Global Chat (__broadcast__) is a virtual view over a real backing room, so a
  // posted agent reply only renders through the primary room-message handler if
  // the backing room id has resolved AND matches — a fragile, race-prone path that
  // left agent @mention replies invisible. These same room.message.* events DO
  // reach this workspace-scoped handler reliably, so here we authoritatively
  // REFETCH the room's own messages (the agent replies the broadcast dispatcher
  // posts) plus the latest interaction events, and merge. This guarantees a reply
  // appears without depending on live event-payload matching.
  useRealtime(['activity.created', REALTIME_EVENTS.ROOM_MESSAGE_SENT, REALTIME_EVENTS.ROOM_MESSAGE_RECEIVED], () => {
    if (id !== '__broadcast__') return;
    void Promise.all([
      api<{ messages: RoomMsg[] }>(`/v1/rooms/__broadcast__/messages?limit=${PAGE_SIZE}`)
        .then((res) => res.messages ?? [])
        .catch(() => [] as RoomMsg[]),
      listInteractions({ limit: 10 }).then((res) => res.events ?? []).catch(() => []),
    ]).then(([roomMessages, events]) => {
      const roomMsgIds = new Set(roomMessages.map((m) => m.id));
      // Clear the "responding…" indicator for any mentioned agent whose reply has
      const postAt = broadcastPostAtRef.current;
      if (postAt) {
        const replied = new Set(
          roomMessages
            .filter((m) => m.authorType === 'agent' && m.authorId && m.createdAt >= postAt)
            .map((m) => m.authorId as string),
        );
        if (replied.size > 0) setPendingResponders((prev) => prev.filter((agentId) => !replied.has(agentId)));
      }
      setMessages((current) => {
        let updated = [...current];
        for (const message of roomMessages) {
          updated = upsertMessage(updated, normalizeRoomMessage(message));
        }
        for (const event of events) {
          // Skip interaction 'message' events that ARE these room messages (same
          // id) — they'd render a duplicate bubble. Keep agent chatter elsewhere.
          if (event.kind === 'message' && !roomMsgIds.has(event.id)) {
            updated = mergeMessage(updated, normalizeInteractionMessage(event));
          }
        }
        return sortMessages(updated);
      });
    }).catch(() => {});
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

  // Open the canvas as soon as the FIRST node streams in, not only once the
  // build finishes — otherwise a bare chat thread never shows the node-by-node
  // build reveal (it only ever saw the graph after it was already complete).
  // CANVAS_NODE_PLACED only ever fires once the workflow row is persisted, so
  // the canvas mount below can always fetch it successfully.
  useRealtime([REALTIME_EVENTS.CANVAS_NODE_PLACED], (env) => {
    if (kind !== 'agent') return;
    const payload = env.payload as { agentId?: string | null; workflowId?: string; appId?: string | null; runId?: string } | undefined;
    const workflowId = payload?.workflowId;
    if (!workflowId) return;
    if (payload?.agentId && payload.agentId !== id) return;
    if (openedCanvasWorkflowIdsRef.current.has(workflowId)) return;
    openedCanvasWorkflowIdsRef.current.add(workflowId);
    const appId = payload?.appId ?? null;
    window.dispatchEvent(new CustomEvent('agentis:open-canvas', { detail: { workflowId, appId, runId: payload?.runId ?? null } }));
    navigate(appId ? `/apps/${appId}` : `/apps/workflows/${workflowId}`);
    toast.success(appId ? 'App opened' : 'Logic opened on canvas');
  });

  useRealtime([REALTIME_EVENTS.CANVAS_BUILD_COMPLETE], (env) => {
    if (kind !== 'agent') return;
    const payload = env.payload as { agentId?: string | null; workflowId?: string; appId?: string | null; runId?: string } | undefined;
    const workflowId = payload?.workflowId;
    if (!workflowId) return;
    if (payload?.agentId && payload.agentId !== id) return;
    if (openedCanvasWorkflowIdsRef.current.has(workflowId)) return;
    openedCanvasWorkflowIdsRef.current.add(workflowId);
    // Agentis ships Apps — open the owning App, not the bare workflow canvas.
    const appId = payload?.appId ?? null;
    window.dispatchEvent(new CustomEvent('agentis:open-canvas', { detail: { workflowId, appId, runId: payload?.runId ?? null } }));
    navigate(appId ? `/apps/${appId}` : `/apps/workflows/${workflowId}`);
    toast.success(appId ? 'App opened' : 'Logic opened on canvas');
  });

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
    setMessages((current) => current.map((message) => {
      if (message.id !== streamId) return message;
      const existing = message.metadata?.toolCalls ?? [];
      const updatedToolCalls = existing.map((tc) => {
        if (tc.id === delta.toolCall.id) {
          return { ...tc, status: 'paused' as any };
        }
        return tc;
      });
      return {
        ...message,
        metadata: {
          ...(message.metadata ?? {}),
          source: message.metadata?.source ?? 'chat_loop',
          confirmation: confirmationCard,
          toolCalls: updatedToolCalls,
        },
      };
    }));
  }

  /** Durably queue a message sent while this conversation's turn is already
   * streaming (§ChatComposerQueue). The backend re-checks the in-flight-turn
   * guard itself, so this is correct even if `streamingAgentActive` is a beat
   * stale. */
  async function enqueueMessage(text: string) {
    try {
      const res = await api<{ queued: boolean; item?: QueuedItem }>(sendEndpoint, {
        method: 'POST',
        body: JSON.stringify({ body: text, clientTurnId: createClientTurnId(), useViewportContext: true, permissionMode }),
      });
      if (res.queued && res.item) {
        const item = res.item;
        setPendingQueue((prev) => (prev.some((q) => q.id === item.id) ? prev : [...prev, item]));
      }
    } catch (error) {
      toast.error('Failed to queue message', apiErrorMessage(error));
      throw error;
    }
  }

  /** Cancel a still-pending queued message before it dispatches. */
  async function cancelQueuedMessage(itemId: string) {
    setPendingQueue((prev) => prev.filter((q) => q.id !== itemId));
    try {
      await api(`/v1/conversations/${id}/queue/${itemId}${querySuffix}`, { method: 'DELETE' });
    } catch (error) {
      toast.error('Failed to remove queued message', apiErrorMessage(error));
      void loadQueue();
    }
  }

  async function handleSend(text: string, options?: { useViewportContext?: boolean }) {
    if (readOnly) {
      toast.warn('Past conversation', 'Use the + button in the header to start a fresh conversation.');
      return;
    }
    const value = text.trim();
    if (!value) return;
    // ChatGPT/Gemini-style queue-then-auto-continue: a turn is already
    // streaming in this thread, so don't race a second live turn — queue this
    // send. `streamConversationTurnReply` auto-dispatches it, oldest first,
    // once the in-flight turn ends (see the CONVERSATION_QUEUE_UPDATED
    // realtime subscription above).
    if (kind === 'agent' && streamingAgentActive) {
      await enqueueMessage(value);
      return;
    }
    if (kind === 'room') {
      try {
        const res = await api<{ message?: RoomMsg }>(sendEndpoint, {
          method: 'POST',
          body: JSON.stringify({ contentType: 'text', content: { text: value } }),
        });
        const message = res.message;
        if (message) setMessages((prev) => upsertMessage(prev, normalizeRoomMessage(message)));
        // Global Chat: show a "responding…" indicator for each @mentioned agent
        // until its reply lands (the dispatch is async and can take a while).
        if (id === '__broadcast__') {
          const responders = resolveMentionedAgentIds(value, agentMap);
          if (responders.length > 0) {
            broadcastPostAtRef.current = new Date().toISOString();
            setPendingResponders(responders);
            if (broadcastPendingTimerRef.current) window.clearTimeout(broadcastPendingTimerRef.current);
            broadcastPendingTimerRef.current = window.setTimeout(() => setPendingResponders([]), 180_000);
          }
        }
      } catch (error) {
        toast.error('Failed to send', apiErrorMessage(error));
      }
      return;
    }

    const clientTurnId = createClientTurnId();
    const createdAt = new Date().toISOString();
    const operatorMessage: ChatMessage = {
      id: `tmp-${clientTurnId}`,
      authorId: 'operator',
      authorKind: 'operator',
      text: value,
      createdAt,
      deliveryStatus: 'sending',
      metadata: { clientTurnId },
    };
    const streamId = `stream-${clientTurnId}`;
    const streamingMessage: ChatMessage = {
      id: streamId,
      authorId: id,
      authorKind: 'agent',
      text: '',
      createdAt,
      deliveryStatus: 'sending',
      metadata: {
        source: 'chat_loop',
        clientTurnId,
        turn: { clientTurnId, startedAt: createdAt, status: 'running' },
        activity: [{
          type: 'activity',
          id: `activity-${clientTurnId}-local-start`,
          phase: 'runtime',
          status: 'running',
          label: `Starting ${name}`,
          startedAt: createdAt,
          agentId: id,
          clientTurnId,
        }],
      },
    };

    setMessages((current) => dedupeMessages([...current, operatorMessage, streamingMessage]));
    setAgentTyping(true);
    setActiveTask({ agentId: id, agentName: name, label: taskLabel(value), done: 0, total: 0, startedAt: Date.now() });

    const toolStartedAt = new Map<string, number>();
    let toolTotal = 0;
    let toolDone = 0;
    let streamedBody = '';

    try {
      const controller = new AbortController();
      activeChatAbortRef.current?.abort();
      activeChatAbortRef.current = controller;
      const viewportOverride = pendingViewportOverrideRef.current;
      await streamSse(sendEndpoint, {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({
          body: value,
          clientTurnId,
          useViewportContext: options?.useViewportContext !== false,
          viewportOverride,
          permissionMode,
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
            } else if (delta.type === 'activity') {
              updateActiveTask({ label: delta.label });
              setMessages((current) => current.map((message) => {
                if (message.id !== streamId) return message;
                const activity = message.metadata?.activity ?? [];
                return {
                  ...message,
                  metadata: {
                    ...(message.metadata ?? {}),
                    source: message.metadata?.source ?? 'chat_loop',
                    activity: [...activity.filter((entry) => entry.id !== delta.id), delta].slice(-80),
                  },
                };
              }));
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
              const streamMessage = current.find((message) => message.id === streamId);
              const incoming: ChatMessage = {
                ...persisted,
                metadata: {
                  ...persisted.metadata,
                  clientTurnId: persisted.metadata?.clientTurnId ?? clientTurnId,
                  toolCalls: streamMessage?.metadata?.toolCalls ?? persisted.metadata?.toolCalls,
                  activity: persisted.metadata?.activity ?? streamMessage?.metadata?.activity,
                  turn: persisted.metadata?.turn ?? streamMessage?.metadata?.turn,
                },
              };
              const delivered = current.map((message): ChatMessage => {
                if (message.id === operatorMessage.id) return { ...message, deliveryStatus: 'delivered' as const };
                return message;
              });
              return mergeMessage(delivered, incoming);
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
      const stopped = error instanceof DOMException && error.name === 'AbortError';
      const shouldKeepStoppedBubble = streamedBody.trim().length > 0 || toolTotal > 0;
      const completedAt = new Date().toISOString();
      setMessages((current) => current.flatMap((message) => {
        if (message.id === streamId) {
          if (stopped && !shouldKeepStoppedBubble) return [];
          return [{
            ...message,
            deliveryStatus: stopped ? 'delivered' as const : 'failed' as const,
            metadata: {
              ...(message.metadata ?? {}),
              toolCalls: (message.metadata?.toolCalls ?? []).map((tool) => (
                tool.status === 'running' || tool.status === 'paused'
                  ? { ...tool, status: stopped ? 'stopped' as const : 'error' as const }
                  : tool
              )),
              turn: {
                ...(message.metadata?.turn ?? { clientTurnId, startedAt: message.createdAt }),
                completedAt,
                status: stopped ? 'stopped' : 'failed',
              },
            },
          }];
        }
        if (message.id === operatorMessage.id) {
          return [{ ...message, deliveryStatus: stopped ? 'delivered' as const : 'failed' as const }];
        }
        return [message];
      }));
      if (!stopped) toast.error('Failed to send', apiErrorMessage(error));
    } finally {
      activeChatAbortRef.current = null;
    }
  }

  function stopActiveTurn() {
    activeChatAbortRef.current?.abort();
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

  async function handleCopy(message: ChatMessage) {
    try {
      await navigator.clipboard.writeText(message.text);
      toast.success('Copied to clipboard');
    } catch {
      // no-op
    }
  }

  async function rerunFromEditedMessage(message: ChatMessage, value: string) {
    const clientTurnId = createClientTurnId();
    const streamId = `stream-${clientTurnId}`;
    const createdAt = message.createdAt;
    const editedMessage: ChatMessage = {
      ...message,
      text: value,
      deliveryStatus: 'delivered',
      metadata: {
        ...(message.metadata ?? {}),
        clientTurnId,
      },
    };
    const streamingMessage: ChatMessage = {
      id: streamId,
      authorId: id,
      authorKind: 'agent',
      text: '',
      createdAt,
      deliveryStatus: 'sending',
      metadata: {
        source: 'chat_loop',
        clientTurnId,
        turn: { clientTurnId, startedAt: createdAt, status: 'running' },
        activity: [{
          type: 'activity',
          id: `activity-${clientTurnId}-local-rewrite`,
          phase: 'runtime',
          status: 'running',
          label: `Starting ${name}`,
          startedAt: new Date().toISOString(),
          agentId: id,
          clientTurnId,
        }],
      },
    };

    setEditingId(null);
    setMessages((current) => {
      const ordered = sortMessages(current);
      const anchorIndex = ordered.findIndex((item) => item.id === message.id);
      const kept = anchorIndex >= 0 ? ordered.slice(0, anchorIndex) : ordered.filter((item) => item.createdAt < message.createdAt);
      return dedupeMessages([...kept, editedMessage, streamingMessage]);
    });
    setAgentTyping(true);
    setActiveTask({ agentId: id, agentName: name, label: taskLabel(value), done: 0, total: 0, startedAt: Date.now() });

    const toolStartedAt = new Map<string, number>();
    let toolTotal = 0;
    let toolDone = 0;
    let streamedBody = '';

    try {
      const controller = new AbortController();
      activeChatAbortRef.current?.abort();
      activeChatAbortRef.current = controller;
      const viewportOverride = pendingViewportOverrideRef.current;
      await streamSse(`${endpoint}/${message.id}/rewrite${querySuffix}`, {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({
          text: value,
          clientTurnId,
          useViewportContext: true,
          viewportOverride,
        }),
      }, {
        onEvent(event, data) {
          if (event === 'delta') {
            const delta = data as ChatDelta;
            if (delta.type === 'text') {
              streamedBody += delta.delta;
              setMessages((current) => current.map((item) => (
                item.id === streamId
                  ? { ...item, text: streamedBody, deliveryStatus: 'sending' }
                  : item
              )));
            } else if (delta.type === 'activity') {
              updateActiveTask({ label: delta.label });
              setMessages((current) => current.map((item) => {
                if (item.id !== streamId) return item;
                const activity = item.metadata?.activity ?? [];
                return {
                  ...item,
                  metadata: {
                    ...(item.metadata ?? {}),
                    source: item.metadata?.source ?? 'chat_loop',
                    activity: [...activity.filter((entry) => entry.id !== delta.id), delta].slice(-80),
                  },
                };
              }));
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
              setMessages((current) => current.map((item) => (
                item.id === streamId
                  ? { ...item, deliveryStatus: delta.finishReason === 'error' ? 'failed' : 'delivered' }
                  : item
              )));
            }
          } else if (event === 'message') {
            const persisted = normalizeAgentMessage(data as AgentMsg);
            setMessages((current) => {
              const streamMessage = current.find((item) => item.id === streamId);
              return mergeMessage(current, {
                ...persisted,
                metadata: {
                  ...persisted.metadata,
                  clientTurnId: persisted.metadata?.clientTurnId ?? clientTurnId,
                  toolCalls: streamMessage?.metadata?.toolCalls ?? persisted.metadata?.toolCalls,
                  activity: persisted.metadata?.activity ?? streamMessage?.metadata?.activity,
                  turn: persisted.metadata?.turn ?? streamMessage?.metadata?.turn,
                },
              });
            });
          } else if (event === 'error') {
            const errorMessage = streamErrorMessage(data);
            setAgentTyping(false);
            setActiveTask(null);
            setMessages((current) => current.map((item) => (
              item.id === streamId
                ? { ...item, text: item.text || errorMessage, deliveryStatus: 'failed' }
                : item
            )));
            toast.error('Agent could not reply', errorMessage);
          }
        },
      });
      pendingViewportOverrideRef.current = null;
    } catch (error) {
      setAgentTyping(false);
      setActiveTask(null);
      const stopped = error instanceof DOMException && error.name === 'AbortError';
      const shouldKeepStoppedBubble = streamedBody.trim().length > 0 || toolTotal > 0;
      const completedAt = new Date().toISOString();
      setMessages((current) => current.flatMap((item) => {
        if (item.id !== streamId) return [item];
        if (stopped && !shouldKeepStoppedBubble) return [];
        return [{
          ...item,
          deliveryStatus: stopped ? 'delivered' as const : 'failed' as const,
          metadata: {
            ...(item.metadata ?? {}),
            toolCalls: (item.metadata?.toolCalls ?? []).map((tool) => (
              tool.status === 'running' || tool.status === 'paused'
                ? { ...tool, status: stopped ? 'stopped' as const : 'error' as const }
                : tool
            )),
            turn: {
              ...(item.metadata?.turn ?? { clientTurnId, startedAt: item.createdAt }),
              completedAt,
              status: stopped ? 'stopped' : 'failed',
            },
          },
        }];
      }));
      if (!stopped) toast.error('Failed to rerun from edited message', apiErrorMessage(error));
    } finally {
      activeChatAbortRef.current = null;
    }
  }

  async function handleEditSave(message: ChatMessage, text: string) {
    const value = text.trim();
    if (!value) return;
    if (kind === 'agent' && message.authorKind === 'operator') {
      await rerunFromEditedMessage(message, value);
      return;
    }
    try {
      const res = await api<{ message?: AgentMsg | RoomMsg }>(`${endpoint}/${message.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ text: value }),
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
        setMessages((prev) => prev.map((item) => (item.id === message.id ? { ...item, text: value } : item)));
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
  const runtimeWarning = kind === 'agent' && !agentNoAdapter
    ? runtimeCapabilityWarning(agentRuntime)
    : null;
  // When an assistant bubble is mid-stream it shows its own in-bubble typing
  // indicator, so the standalone "is thinking…" footer would be a duplicate.
  const streamingAgentActive = messages.some(
    (message) => message.authorKind === 'agent' && message.deliveryStatus === 'sending',
  );

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <div ref={scrollRef} className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-3 py-3">
        {id === '__broadcast__' && (
          <div className="mb-4 mt-2 flex items-center justify-center text-center">
            <span className="rounded-full bg-surface-2 px-3 py-1 text-[11px] text-text-muted border border-line shadow-sm">
              Observe agent-to-agent conversations, or use <strong className="text-text-secondary font-semibold">@</strong> to join in.
            </span>
          </div>
        )}
        {loading ? (
          <div className="space-y-2">
            <Skeleton height={36} />
            <Skeleton height={48} width="80%" />
            <Skeleton height={36} />
          </div>
        ) : messages.length === 0 && pendingQueue.length === 0 ? (
          <div className="px-2 py-8 text-center text-[13px] text-text-muted">
            {emptyBody ?? `Send a message to start a conversation with ${name}.`}
          </div>
        ) : (
          <ul className="flex min-w-0 flex-col gap-2.5">
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
            {messages.filter((msg) => {
              const cardTitle = msg.metadata?.card?.title;
              if (cardTitle === 'Run failed' || cardTitle === 'Approval needed') return false;
              return true;
            }).map((message) => (
              <MessageBubble
                key={message.id}
                msg={message}
                agentData={agentMap[message.authorId]}
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
            {kind === 'agent' && pendingQueue.map((item) => (
              <QueuedMessageBubble
                key={item.id}
                item={item}
                onCancel={readOnly ? undefined : () => void cancelQueuedMessage(item.id)}
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
        {kind === 'room' && pendingResponders.length > 0 && (
          <div className="mt-2 flex items-center gap-2 px-1 text-[11px] italic text-text-muted">
            <TypingDots />
            <span>
              {pendingResponders.map((agentId) => agentMap[agentId]?.name ?? 'agent').join(', ')}
              {pendingResponders.length > 1 ? ' are responding…' : ' is responding…'}
            </span>
          </div>
        )}
        {stepTrack && stepTrack.steps.length > 0 && (streamingAgentActive || agentTyping) && (
          <div className="mt-2 rounded-xl border border-line/60 bg-surface-2/40 px-3 py-2 shadow-sm transition-colors duration-150 hover:border-line">
            <StepTrack track={stepTrack} />
          </div>
        )}
        {!isAtBottom && (
          <button
            type="button"
            onClick={() => scrollToBottom('smooth')}
            className="sticky bottom-2 mx-auto mt-2 block rounded-full border border-line bg-surface px-3 py-1 text-[11px] text-text-secondary shadow-card hover:text-text-primary"
          >
            Jump to latest
          </button>
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
          key={`${kind}:${id}:${conversationId ?? 'active'}:${composerInitialText}`}
          onSend={handleSend}
          awareness={{ label: awareness.label, active: awarenessActive }}
          initialText={composerInitialText}
          placeholder={composerPlaceholder}
          draftKey={`${kind}:${id}:${conversationId ?? 'active'}`}
          agentId={kind === 'agent' ? id : undefined}
          isRunning={streamingAgentActive}
          onStop={stopActiveTurn}
          footer={kind === 'agent' ? (
            <PermissionModePicker value={permissionMode} onChange={(mode) => void setPermissionMode(mode)} />
          ) : undefined}
        />
      )}
    </div>
  );
}

/** Queue-then-auto-continue composer: a message sent while the turn was
 * already streaming, rendered like a real outbound bubble but dimmed with a
 * "Queued" label — and cancelable before it dispatches. */
function QueuedMessageBubble({ item, onCancel }: { item: QueuedItem; onCancel?: () => void }) {
  return (
    <li className="group flex min-w-0 max-w-full flex-col items-end gap-0.5">
      <div className="flex min-w-0 max-w-full items-start gap-1.5">
        <div className="min-w-0 max-w-[85%] overflow-hidden rounded-card border border-dashed border-line bg-accent-soft/40 px-3 py-2 text-[13px] leading-relaxed text-text-primary opacity-60">
          <div className="mb-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-text-muted">
            <Clock3 size={10} />
            <span>Queued</span>
          </div>
          <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{item.text}</div>
        </div>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel queued message"
            title="Remove from queue"
            className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-text-muted opacity-0 transition-opacity hover:bg-surface-2 hover:text-danger group-hover:opacity-100"
          >
            <X size={12} />
          </button>
        )}
      </div>
    </li>
  );
}

function MessageBubble({
  msg,
  agentData,
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
  onCopy: () => void;
  isEditing: boolean;
  readOnly: boolean;
  onStartEdit: () => void;
  onSaveEdit: (text: string) => void;
  onCancelEdit: () => void;
  onConfirmAction: (confirmation: ConfirmationCardData, approved: boolean) => void;
  onCancelRun?: (runId: string) => void;
  agentData?: { name: string; role?: string | null; colorHex?: string | null };
}) {
  const isOperator = msg.authorKind === 'operator';
  const [editDraft, setEditDraft] = useState(msg.text);
  const streaming = msg.deliveryStatus === 'sending';
  const parsedAgentPlan = !isOperator && !isEditing ? extractAgentPlan(msg.text) : null;
  const bodyBeforePlan = parsedAgentPlan ? parsedAgentPlan.before : msg.text;
  const bodyAfterPlan = parsedAgentPlan?.after ?? '';
  const toolCalls = msg.metadata?.toolCalls ?? [];
  const activities = msg.metadata?.activity ?? [];
  const artifactIds = useMemo(() => {
    const ids = new Set(msg.artifactIds ?? []);
    toolCalls.forEach((call) => collectArtifactIds(call.result, ids));
    return [...ids];
  }, [msg.artifactIds, toolCalls]);

  useEffect(() => {
    if (isEditing) setEditDraft(msg.text);
  }, [isEditing, msg.text]);

  return (
    <li className={clsx('group flex min-w-0 max-w-full flex-col gap-0.5', isOperator ? 'items-end' : 'items-start')}>
      {!isOperator && msg.authorKind !== 'system' && (
        <span
          className="px-1 text-[11px] font-medium"
          style={{ color: agentData?.colorHex || 'var(--text-muted)' }}
        >
          {agentData?.name || msg.authorName || msg.authorId}
          {agentData?.role ? ` - ${agentData.role}` : ''}
        </span>
      )}
      <div className={clsx('flex min-w-0 max-w-full items-start gap-1.5', !isOperator && 'w-full')}>
        {isOperator && !readOnly && (
          <MessageActions onCopy={onCopy} onEdit={onStartEdit} />
        )}
        <div
          className={clsx(
            'min-w-0 overflow-hidden rounded-card px-3 py-2 text-[13px] leading-relaxed',
                  isOperator
                    ? 'max-w-[85%]'
                    : streaming
                      ? 'w-full max-w-full'
                    : parsedAgentPlan
                        ? 'w-full max-w-full'
                        : 'max-w-[85%]',
            isOperator
              ? 'bg-accent-soft text-text-primary'
              : msg.authorKind === 'system'
                ? 'border border-dashed border-line bg-surface-2 text-text-muted'
                : 'bg-surface-2 text-text-primary shadow-[0_18px_35px_-30px_rgba(0,0,0,0.7)]',
          )}
        >
          {!isOperator && (streaming || activities.length > 0 || toolCalls.length > 0) && (
            <AgentTurnTrace
              activities={activities}
              toolCalls={toolCalls}
              turn={msg.metadata?.turn}
              streaming={streaming}
              failed={msg.deliveryStatus === 'failed'}
            />
          )}
          {!isEditing && bodyBeforePlan && (
            isOperator ? (
              <div className="mb-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{bodyBeforePlan}</div>
            ) : (
              <div className="mb-2 break-words [overflow-wrap:anywhere]">
                <ChatMarkdown text={bodyBeforePlan} />
                {streaming ? <StreamingCursor /> : null}
              </div>
            )
          )}
          <ChatArtifactAttachments artifactIds={artifactIds} />
          {msg.metadata?.confirmation && (
            <ConfirmationCard
              data={msg.metadata.confirmation}
              onApprove={() => onConfirmAction(msg.metadata!.confirmation!, true)}
              onCancel={() => onConfirmAction(msg.metadata!.confirmation!, false)}
            />
          )}
          {parsedAgentPlan && <ChatPlanCanvas planText={parsedAgentPlan.planText} architecture={parsedAgentPlan.architecture} />}
          {msg.metadata?.card && <ProactiveCard data={msg.metadata.card} />}
          {msg.metadata?.runId && (
            <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-line bg-canvas/60 px-2 py-1.5 text-[11px] text-text-secondary">
              <Plug size={12} className="text-text-muted" />
              <span className="font-medium text-text-primary">
                {msg.metadata.runTitle ?? (msg.metadata.isEphemeral ? 'Ephemeral run' : 'Workflow run')}
              </span>
              {msg.metadata.runStatus && <span className="uppercase tracking-wide text-text-muted">{msg.metadata.runStatus}</span>}
              <button
                type="button"
                onClick={() => openRunModal({
                  runId: msg.metadata!.runId!,
                  workflowId: msg.metadata!.workflowId,
                  source: 'chat-message',
                })}
                className="font-medium text-accent hover:underline"
              >
                Inspect run
              </button>
              {msg.metadata.workflowId && (
                <Link to={`/apps/workflows/${msg.metadata.workflowId}`} className="font-medium text-accent hover:underline">Logic</Link>
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
            <div className="mt-2 break-words [overflow-wrap:anywhere]">
              <ChatMarkdown text={bodyAfterPlan} />
            </div>
          ) : (msg.metadata?.card || msg.metadata?.confirmation || parsedAgentPlan || toolCalls.length > 0 || activities.length > 0 || bodyBeforePlan || artifactIds.length > 0) ? null : streaming && !isOperator ? (
            <TypingDots />
          ) : !isOperator ? null : (
            <div className="text-[12px] italic text-text-muted">No text content</div>
          )}
        </div>
        {!isOperator && <MessageActions onCopy={onCopy} />}
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
          <ul className="mt-2.5 space-y-1.5 rounded-lg border border-line/40 bg-surface/30 px-3 py-2 text-[11px] text-text-secondary">
            {details.slice(0, 4).map((detail) => (
              <li key={detail} className="flex items-start gap-1.5 leading-normal">
                <span className={clsx('mt-1.5 h-1 w-1 shrink-0 rounded-full', risk.dot)} />
                <span className="break-all font-sans">{detail}</span>
              </li>
            ))}
          </ul>
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
  onEdit,
}: {
  onCopy: () => void;
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
    </div>
  );
}



