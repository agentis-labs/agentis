/**
 * ThreadView — single agent conversation inside the ChatPanel.
 *
 * Mirrors the data flow of the legacy ConversationsPage Thread component:
 * fetch /v1/conversations/:agentId, mark-as-read, send messages,
 * subscribe to CONVERSATION_MESSAGE_* events, render typing indicator.
 *
 * The composer adds the §4.2.7 power-user features:
 *   - `/` slash commands (`/run`, `/pause`, `/wake`, `/approve`, `/history`, `/status`, `/help`)
 *   - `@` agent mentions
 *   - `#` resource references (workflows, runs)
 *   - keyboard shortcuts: ↑ to edit last sent, Shift+Enter newline,
 *     Enter to send.
 */

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { REALTIME_EVENTS, type ChatDelta } from '@agentis/core';
import { api, streamSse } from '../../lib/api';
import { rtSubscribe, useRealtime } from '../../lib/realtime';
import { useViewportAwareness } from '../../lib/viewportContext';
import { Composer } from './Composer';
import { ProactiveCard, type ProactiveCardData } from './ProactiveCard';
import { CanvasEmbed } from './CanvasEmbed';
import { ArtifactPanel } from '../ArtifactPanel/ArtifactPanel';
import type { Artifact } from '../ArtifactPanel/types';
import type { ToolCallPillData } from './ToolCallPill';
import { ThinkingBubble } from '../chat/ThinkingBubble';
import { ExecutionFeed } from '../chat/ExecutionFeed';
import { PlanList, derivePlanItems, extractPlan } from '../chat/PlanList';
import { ThreadSkeleton, SkeletonGate } from '../shared/Skeleton';

type ContentType =
  | 'text'
  | 'canvas_embed'
  | 'code'
  | 'image'
  | 'document'
  | 'diff'
  | 'data_table'
  | 'broadcast';

interface Message {
  id: string;
  role: 'operator' | 'agent' | 'system';
  body: string;
  createdAt: string;
  metadata?: {
    source?: 'openclaw_exec' | 'openclaw_session' | 'workflow' | 'manual' | 'proactive' | 'chat_loop' | 'tool_call';
    runId?: string;
    workflowId?: string;
    approvalId?: string;
    approvalSummary?: string;
    card?: ProactiveCardData;
    sessionId?: string | null;
    /** AGENTIS-UX-V2 §6.5 + 8b: rich content extension. */
    contentType?: ContentType;
    canvasRunId?: string;
    canvasWorkflowId?: string;
    code?: { language?: string; source: string };
    imageUrl?: string;
    document?: { title?: string; markdown?: string };
    diff?: { before: string; after: string };
    dataTable?: { columns: string[]; rows: Array<Record<string, unknown>> };
    artifact?: Artifact;
    /** Multi-agent run participants for stacked-avatar cards. */
    participants?: Array<{ id: string; name: string; colorHex?: string | null; type?: 'agent' | 'team' }>;
    /** §5.4 streaming deltas — live tool calls + accumulated thinking text. */
    toolCalls?: ToolCallPillData[];
    thinking?: string;
  };
  deliveryStatus?: 'sending' | 'sent' | 'delivered' | 'failed' | 'mirrored';
  sessionMessageId?: string | null;
}

interface ConversationSession {
  id: string;
  label: string;
  source: 'agentis' | 'openclaw';
  active: boolean;
  stale?: boolean;
}

export function ThreadView({ agentId, agentColor, agentName }: { agentId: string; agentColor?: string; agentName?: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [sessions, setSessions] = useState<ConversationSession[]>([]);
  const [agentTyping, setAgentTyping] = useState(false);
  const [sessionStale, setSessionStale] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const typingTimer = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const awareness = useViewportAwareness();

  useEffect(() => {
    setHydrated(false);
    rtSubscribe('conversation', { agentId });
    void api<{ messages: Message[] }>(`/v1/conversations/${agentId}`)
      .then((r) => setMessages(r.messages.map(normalizeMessage)))
      .catch(() => undefined)
      .finally(() => setHydrated(true));
    void api<{ sessions: ConversationSession[] }>(`/v1/conversations/${agentId}/sessions`)
      .then((r) => setSessions(r.sessions))
      .catch(() => setSessions([]));
    void api(`/v1/conversations/${agentId}/read`, { method: 'POST' }).catch(() => {});
  }, [agentId]);

  useRealtime(
    [
      REALTIME_EVENTS.CONVERSATION_MESSAGE_RECEIVED,
      REALTIME_EVENTS.CONVERSATION_MESSAGE_SENT,
      REALTIME_EVENTS.CONVERSATION_SESSION_DISCOVERED,
      REALTIME_EVENTS.CONVERSATION_SESSION_SYNCED,
      REALTIME_EVENTS.CONVERSATION_SESSION_STALE,
    ],
    (env) => {
      const payload = env.payload as { agentId?: string; message?: Message; sessionId?: string };
      if (payload.agentId !== agentId) return;
      if (env.event === REALTIME_EVENTS.CONVERSATION_SESSION_STALE) {
        setSessionStale(true);
        return;
      }
      if (
        env.event === REALTIME_EVENTS.CONVERSATION_SESSION_DISCOVERED ||
        env.event === REALTIME_EVENTS.CONVERSATION_SESSION_SYNCED
      ) {
        setSessionStale(false);
        void api<{ sessions: ConversationSession[] }>(`/v1/conversations/${agentId}/sessions`)
          .then((r) => setSessions(r.sessions))
          .catch(() => {});
      }
      if (payload.message) {
        setMessages((m) => mergeMessage(m, normalizeMessage(payload.message!)));
        setAgentTyping(false);
      }
    },
  );

  useRealtime([REALTIME_EVENTS.CONVERSATION_AGENT_TYPING], (env) => {
    const payload = env.payload as { agentId?: string };
    if (payload.agentId !== agentId) return;
    setAgentTyping(true);
    if (typingTimer.current) window.clearTimeout(typingTimer.current);
    typingTimer.current = window.setTimeout(() => setAgentTyping(false), 4000);
  });

  useRealtime([REALTIME_EVENTS.AGENT_PROACTIVE_PUSH], (env) => {
    const payload = env.payload as { id?: string; agentId?: string | null; card?: ProactiveCardData };
    if (payload.agentId && payload.agentId !== agentId) return;
    if (!payload.card) return;
    const message: Message = {
      id: payload.id ?? `proactive-${env.emittedAt}`,
      role: 'agent',
      body: '',
      createdAt: env.emittedAt,
      metadata: { source: 'proactive', card: payload.card },
      deliveryStatus: 'delivered',
    };
    setMessages((current) => mergeMessage(current, message));
  });

  // §6.3 / §25 — When the orchestrator emits CANVAS_NODE_PLACED for this
  // conversation, surface (or upsert) a single mini-canvas-embed message
  // tied to that runId so subsequent edge / build_complete events render
  // into the same embed.
  useRealtime(
    [
      REALTIME_EVENTS.CANVAS_NODE_PLACED,
      REALTIME_EVENTS.CANVAS_BUILD_COMPLETE,
    ],
    (env) => {
      const payload = env.payload as
        | { agentId?: string; runId?: string; workflowId?: string }
        | undefined;
      if (!payload?.runId) return;
      // Filter: only if this orchestrator/agent is the active thread, OR
      // the event payload explicitly references this thread's agentId.
      if (payload.agentId && payload.agentId !== agentId) return;
      const embedId = `canvas-embed-${payload.runId}`;
      setMessages((current) => {
        if (current.some((m) => m.id === embedId)) return current;
        const embed: Message = {
          id: embedId,
          role: 'agent',
          body: '',
          createdAt: new Date().toISOString(),
          metadata: {
            source: 'workflow',
            contentType: 'canvas_embed',
            canvasRunId: payload.runId,
            canvasWorkflowId: payload.workflowId,
          },
        };
        return [...current, embed];
      });
    },
  );

  useEffect(
    () => () => {
      if (typingTimer.current) window.clearTimeout(typingTimer.current);
    },
    [],
  );

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages.length, agentTyping]);

  async function send(text: string, options?: { useViewportContext?: boolean }) {
    if (!text.trim()) return;
    const streamId = `stream-${Date.now()}`;
    const optimistic: Message = {
      id: `tmp-${Date.now()}`,
      role: 'operator',
      body: text,
      createdAt: new Date().toISOString(),
      deliveryStatus: 'sending',
    };
    const streaming: Message = {
      id: streamId,
      role: 'agent',
      body: '',
      createdAt: new Date().toISOString(),
      deliveryStatus: 'sending',
      metadata: { source: 'chat_loop' },
    };
    setMessages((m) => [...m, optimistic, streaming]);
    if (typingTimer.current) window.clearTimeout(typingTimer.current);
    typingTimer.current = window.setTimeout(() => setAgentTyping(true), 250);
    // Track tool-call start timestamps so tool_result can compute duration.
    const toolStartedAt = new Map<string, number>();
    try {
      let streamedBody = '';
      let streamedThinking = '';
      await streamSse(`/v1/conversations/${agentId}/send`, {
        method: 'POST',
        body: JSON.stringify({ body: text, useViewportContext: options?.useViewportContext !== false }),
      }, {
        onEvent(event, data) {
          if (event === 'delta') {
            const delta = data as ChatDelta;
            if (delta.type === 'text') {
              streamedBody += delta.delta;
              setMessages((m) => m.map((x) => (x.id === streamId ? { ...x, body: streamedBody, deliveryStatus: 'sending' } : x)));
            } else if (delta.type === 'thinking') {
              setAgentTyping(true);
              const piece = (delta as { delta?: string }).delta;
              if (typeof piece === 'string' && piece.length > 0) {
                streamedThinking += piece;
                setMessages((m) => m.map((x) => (
                  x.id === streamId
                    ? { ...x, metadata: { ...(x.metadata ?? {}), thinking: streamedThinking, source: x.metadata?.source ?? 'chat_loop' } }
                    : x
                )));
              }
            } else if (delta.type === 'tool_call') {
              toolStartedAt.set(delta.id, performance.now());
              const pill: ToolCallPillData = {
                id: delta.id,
                name: delta.name,
                status: 'running',
                args: delta.args,
              };
              setMessages((m) => m.map((x) => {
                if (x.id !== streamId) return x;
                const existing = x.metadata?.toolCalls ?? [];
                const idx = existing.findIndex((p) => p.id === delta.id);
                const next = idx >= 0
                  ? existing.map((p, i) => (i === idx ? { ...p, ...pill } : p))
                  : [...existing, pill];
                return { ...x, metadata: { ...(x.metadata ?? {}), toolCalls: next, source: x.metadata?.source ?? 'chat_loop' } };
              }));
            } else if (delta.type === 'tool_result') {
              const startedAt = toolStartedAt.get(delta.id);
              const durationMs = startedAt !== undefined ? Math.max(0, performance.now() - startedAt) : null;
              setMessages((m) => m.map((x) => {
                if (x.id !== streamId) return x;
                const existing = x.metadata?.toolCalls ?? [];
                const previous = existing.find((p) => p.id === delta.id);
                const next = existing.map((p) =>
                  p.id === delta.id
                    ? {
                        ...p,
                        status: (delta.error ? 'error' : 'success') as ToolCallPillData['status'],
                        args: previous?.args,
                        result: delta.result,
                        error: delta.error,
                        durationMs,
                      }
                    : p,
                );
                // If the tool call wasn't seen earlier (rare), append a synthetic entry.
                const finalCalls = next.some((p) => p.id === delta.id)
                  ? next
                  : [...next, {
                      id: delta.id,
                      name: delta.name,
                      status: (delta.error ? 'error' : 'success') as ToolCallPillData['status'],
                      args: previous?.args,
                      result: delta.result,
                      error: delta.error,
                      durationMs,
                    }];
                return { ...x, metadata: { ...(x.metadata ?? {}), toolCalls: finalCalls, source: x.metadata?.source ?? 'chat_loop' } };
              }));
            } else if (delta.type === 'done') {
              setAgentTyping(false);
              setMessages((m) => m.map((x) => (x.id === streamId ? { ...x, deliveryStatus: delta.finishReason === 'error' ? 'failed' : 'delivered' } : x)));
            }
          } else if (event === 'message') {
            const persisted = normalizeMessage(data as Message);
            setMessages((m) => m.map((x) => {
              if (x.id !== streamId) return x;
              // Preserve the live tool calls and thinking we accumulated so the
              // pills don't disappear when the persisted record lands.
              return {
                ...persisted,
                metadata: {
                  ...persisted.metadata,
                  toolCalls: x.metadata?.toolCalls ?? persisted.metadata?.toolCalls,
                  thinking: x.metadata?.thinking ?? persisted.metadata?.thinking,
                },
              };
            }));
          } else if (event === 'error') {
            setMessages((m) => m.map((x) => (x.id === streamId ? { ...x, deliveryStatus: 'failed' } : x)));
          }
        },
      });
    } catch {
      setMessages((m) => m.map((x) => (
        x.id === optimistic.id || x.id === streamId ? { ...x, deliveryStatus: 'failed' } : x
      )));
    } finally {
      setAgentTyping(false);
    }
  }

  async function switchSession(session: ConversationSession) {
    if (session.active || session.id === 'agentis-local') return;
    await api(`/v1/conversations/${agentId}/continue/${encodeURIComponent(session.id)}`, { method: 'POST' });
    setSessions((current) => current.map((item) => ({ ...item, active: item.id === session.id })));
    setSessionStale(false);
  }

  return (
    <div
      className="flex h-full flex-col"
      style={
        agentColor
          ? ({ ['--agent-color' as string]: agentColor } as React.CSSProperties)
          : undefined
      }
    >
      {(sessions.length > 0 || sessionStale) && (
        <div className="border-b border-line bg-canvas/60 px-3 py-2">
          {sessionStale && (
            <div className="mb-2 rounded-md border border-warn/40 bg-warn/10 px-2 py-1 text-[11px] text-warn">
              Gateway session is stale. Reconnect the gateway before sending more context-sensitive commands.
            </div>
          )}
          <div className="flex flex-wrap gap-1">
            {sessions.map((session) => (
              <button
                key={session.id}
                type="button"
                onClick={() => void switchSession(session)}
                className={`rounded-full border px-2 py-0.5 text-[10px] ${
                  session.active
                    ? 'border-accent/40 bg-accent/10 text-accent'
                    : 'border-line text-text-muted hover:text-text-primary'
                }`}
              >
                {session.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
        <SkeletonGate loading={!hydrated && messages.length === 0}>
          <ThreadSkeleton />
        </SkeletonGate>
        {hydrated && messages.length === 0 && (
          <div className="px-2 py-6 text-center text-xs text-text-muted">
            {agentName ? `Send a message to start a conversation with ${agentName}.` : 'Send a message to start this conversation.'}
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} m={m} />
        ))}
        {!agentTyping && messages.length > 0 && messages[messages.length - 1]?.role === 'operator' && (
          <div className="px-1 text-[11px] italic text-text-muted/60">
            {agentName ? `${agentName} hasn't responded yet.` : 'Waiting for a response…'}
          </div>
        )}
        {agentTyping && (
          <div className="text-xs italic text-text-muted">agent is thinking…</div>
        )}
      </div>
      <Composer
        onSend={send}
        awareness={{ label: awareness.label, active: awareness.context.surface !== 'chat' && awareness.context.surface !== 'unknown' }}
      />
    </div>
  );
}

function normalizeMessage(message: Message): Message {
  return {
    ...message,
    role: message.role ?? 'system',
    createdAt: message.createdAt ?? new Date().toISOString(),
  };
}

function mergeMessage(messages: Message[], incoming: Message): Message[] {
  if (messages.some((message) => message.id === incoming.id)) return messages;
  if (incoming.role === 'operator') {
    const optimisticIndex = messages.findIndex(
      (message) => message.id.startsWith('tmp-') && message.role === 'operator' && message.body === incoming.body,
    );
    if (optimisticIndex >= 0) {
      return messages.map((message, index) => (index === optimisticIndex ? incoming : message));
    }
  }
  return [...messages, incoming];
}

// Note: §5.4 — tool_call / tool_result deltas are now rendered as live
// pills attached to the streaming agent message, not as separate system
// messages. See `ToolCallPill` and `Message.metadata.toolCalls`.

function MessageBubble({ m }: { m: Message }) {
  const mine = m.role === 'operator';
  const [openArtifact, setOpenArtifact] = useState<Artifact | null>(null);
  const ct = m.metadata?.contentType ?? 'text';
  const parsedPlan = !mine ? extractPlan(m.body) : null;
  const bodyBeforePlan = parsedPlan ? parsedPlan.before : m.body;
  const bodyAfterPlan = parsedPlan?.after ?? '';
  const toolCalls = m.metadata?.toolCalls ?? [];
  const streaming = m.deliveryStatus === 'sending';
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
          mine
            ? 'bg-accent/15 text-text-primary'
            : m.role === 'system'
              ? 'border border-dashed border-line bg-surface-2 text-text-muted'
              : 'bg-surface-2 text-text-primary'
        }`}
      >
        {m.metadata?.participants && m.metadata.participants.length > 0 && (
          <ParticipantStack participants={m.metadata.participants} />
        )}
        {/* §5.4 streaming thinking — italic muted indented */}
        {m.metadata?.thinking && (
          <ThinkingBubble text={m.metadata.thinking} streaming={streaming && !m.body.trim()} />
        )}
        {/* §5.4 tool calls — vertical stack of pills, parallel-friendly */}
        {bodyBeforePlan && <div className="mb-2 whitespace-pre-wrap break-words">{bodyBeforePlan}</div>}
        {parsedPlan && (
          <PlanList items={derivePlanItems(parsedPlan.items, toolCalls, streaming)} />
        )}
        {toolCalls.length > 0 && (
          <ExecutionFeed toolCalls={toolCalls} streaming={streaming} />
        )}
        {bodyAfterPlan && <div className="whitespace-pre-wrap break-words">{bodyAfterPlan}</div>}
        {ct === 'canvas_embed' && m.metadata?.canvasRunId && (
          <CanvasEmbed runId={m.metadata.canvasRunId} workflowId={m.metadata.canvasWorkflowId} />
        )}
        {ct === 'code' && m.metadata?.code && (
          <pre className="mt-2 overflow-auto rounded-md border border-line bg-canvas p-2 font-mono text-[11px] leading-relaxed text-text">
            {m.metadata.code.language && (
              <div className="mb-1 text-[9px] uppercase tracking-wider text-text-muted">
                {m.metadata.code.language}
              </div>
            )}
            <code>{m.metadata.code.source}</code>
          </pre>
        )}
        {ct === 'image' && m.metadata?.imageUrl && (
          <img
            src={m.metadata.imageUrl}
            alt="attachment"
            className="mt-2 max-h-[260px] rounded-md border border-line object-contain"
          />
        )}
        {ct === 'document' && m.metadata?.document && (
          <div className="mt-2 rounded-md border border-line bg-canvas p-3">
            {m.metadata.document.title && (
              <div className="mb-1 text-[11px] font-medium text-text">
                {m.metadata.document.title}
              </div>
            )}
            <div className="whitespace-pre-wrap text-[11px] leading-relaxed text-text-muted">
              {m.metadata.document.markdown}
            </div>
          </div>
        )}
        {ct === 'diff' && m.metadata?.diff && (
          <div className="mt-2 grid grid-cols-2 gap-1 overflow-hidden rounded-md border border-line text-[10px]">
            <pre className="bg-status-error/10 p-2 font-mono text-text">{m.metadata.diff.before}</pre>
            <pre className="bg-accent/10 p-2 font-mono text-text">{m.metadata.diff.after}</pre>
          </div>
        )}
        {ct === 'data_table' && m.metadata?.dataTable && (
          <div className="mt-2 overflow-auto rounded-md border border-line">
            <table className="w-full border-collapse text-[11px]">
              <thead className="bg-surface-2">
                <tr>
                  {m.metadata.dataTable.columns.map((col) => (
                    <th key={col} className="px-2 py-1 text-left font-medium text-text">{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {m.metadata.dataTable.rows.slice(0, 50).map((row, i) => (
                  <tr key={i} className="border-t border-line/40">
                    {m.metadata!.dataTable!.columns.map((col) => (
                      <td key={col} className="px-2 py-1 text-text-muted">
                        {formatDataCell(row[col])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {m.metadata?.card && <ProactiveCard data={m.metadata.card} />}
        {m.metadata?.artifact && (
          <button
            type="button"
            onClick={() => setOpenArtifact(m.metadata!.artifact!)}
            className="mt-2 flex w-full items-center justify-between rounded-md border border-line bg-canvas px-3 py-2 text-left hover:border-accent/40"
          >
            <div>
              <div className="text-[11px] font-medium text-text">{m.metadata.artifact.title}</div>
              <div className="text-[10px] uppercase tracking-wider text-text-muted">
                {m.metadata.artifact.type} · artifact
              </div>
            </div>
            <span className="text-[10px] text-accent">Open →</span>
          </button>
        )}
        {openArtifact && (
          <ArtifactPanel artifact={openArtifact} state="docked" onClose={() => setOpenArtifact(null)} />
        )}
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-text-muted">
          <span>{new Date(m.createdAt).toLocaleTimeString()}</span>
          {m.metadata?.source && m.metadata.source !== 'manual' && (
            <span className="rounded bg-canvas px-1">
              {m.metadata.source === 'openclaw_exec' || m.metadata.source === 'openclaw_session'
                ? 'via OpenClaw'
                : m.metadata.source === 'workflow'
                  ? 'via Workflow'
                  : m.metadata.source === 'proactive'
                    ? 'Proactive'
                    : m.metadata.source === 'chat_loop'
                      ? 'Agentis loop'
                      : m.metadata.source === 'tool_call'
                        ? 'Tool'
                    : m.metadata.source}
            </span>
          )}
          {m.deliveryStatus && m.deliveryStatus !== 'sent' && <span>{m.deliveryStatus}</span>}
        </div>
        {m.metadata?.runId && (
          <div className="mt-1 text-[10px] text-text-muted">
            <Link to={`/runs/${m.metadata.runId}`} className="hover:text-accent">
              Run {m.metadata.runId.slice(0, 8)} →
            </Link>
          </div>
        )}
        {m.metadata?.workflowId && (
          <div className="mt-1 text-[10px] text-text-muted">
            <Link to={`/workflows/${m.metadata.workflowId}`} className="hover:text-accent">
              Workflow →
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

function ParticipantStack({ participants }: { participants: Array<{ id: string; name: string; colorHex?: string | null; type?: 'agent' | 'team' }> }) {
  const visible = participants.slice(0, 4);
  const extra = participants.length - visible.length;
  return (
    <div className="mb-1 flex items-center gap-1">
      <div className="flex -space-x-1">
        {visible.map((p) => (
          <span
            key={p.id}
            title={p.name}
            className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-canvas text-[8px] font-semibold text-canvas"
            style={{ background: p.colorHex ?? '#9cffb0' }}
          >
            {p.name.slice(0, 1).toUpperCase()}
          </span>
        ))}
      </div>
      {extra > 0 && (
        <span className="text-[9px] text-text-muted">+{extra}</span>
      )}
    </div>
  );
}

function formatDataCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
