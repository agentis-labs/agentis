import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import type {
  ChatExecutionEnvelope,
  ChatContextManifest,
  ChatPermissionMode,
  ConversationExecutionMode,
  ConversationTurnStatus,
  EffectiveConversationExecutionMode,
  ViewportContext,
  TurnEventV2,
} from '@agentis/core';
import { AgentisError } from '@agentis/core';
import { REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core/events';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../../logger.js';
import type { EventBus } from '../../event-bus.js';

export type ConversationTurnRow = typeof schema.conversationTurns.$inferSelect;
export type ConversationTurnEventRow = typeof schema.conversationTurnEvents.$inferSelect;

export interface DurableTurnInput {
  workspaceId: string;
  conversationId: string;
  agentId: string;
  userId: string;
  messageId: string;
  clientTurnId: string;
  prompt: string;
  requestedMode: ConversationExecutionMode;
  effectiveMode: EffectiveConversationExecutionMode;
  permissionMode: ChatPermissionMode;
  attachmentIds: string[];
  viewport?: ViewportContext | null;
  contextManifest: ChatContextManifest;
  executionEnvelope: ChatExecutionEnvelope;
  planId?: string | null;
}

export interface DurableTurnExecutionResult {
  status: Extract<ConversationTurnStatus, 'completed' | 'failed' | 'blocked' | 'awaiting_approval' | 'interrupted'>;
  error?: string | null;
}

interface ConversationTurnServiceDeps {
  db: AgentisSqliteDb;
  logger: Logger;
  bus?: EventBus;
  execute: (turn: ConversationTurnRow, sink: DurableTurnEventSink, signal: AbortSignal) => Promise<DurableTurnExecutionResult>;
  onCancel?: (turn: ConversationTurnRow) => Promise<void> | void;
}

export interface DurableTurnEventSink {
  writeSSE(args: { event?: string; data: string }): Promise<void>;
}

const TERMINAL_STATUSES: ConversationTurnStatus[] = ['completed', 'failed', 'cancelled'];
const CLAIMABLE_STATUSES: ConversationTurnStatus[] = ['queued', 'interrupted'];
const LEASE_MS = 30_000;
const NARRATION_HEARTBEAT_MS = 45_000;

export class ConversationTurnService {
  readonly #running = new Map<string, AbortController>();
  readonly #workerId = `chat-worker:${process.pid}:${randomUUID()}`;

  constructor(private readonly deps: ConversationTurnServiceDeps) {}

  enqueue(input: DurableTurnInput): ConversationTurnRow {
    const existing = this.deps.db.select().from(schema.conversationTurns).where(and(
      eq(schema.conversationTurns.workspaceId, input.workspaceId),
      eq(schema.conversationTurns.conversationId, input.conversationId),
      eq(schema.conversationTurns.clientTurnId, input.clientTurnId),
    )).get();
    if (existing) return existing;
    const now = new Date().toISOString();
    const row = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      agentId: input.agentId,
      userId: input.userId,
      messageId: input.messageId,
      planId: input.planId ?? null,
      clientTurnId: input.clientTurnId,
      prompt: input.prompt,
      requestedMode: input.requestedMode,
      effectiveMode: input.effectiveMode,
      permissionMode: input.permissionMode,
      status: 'queued',
      attachments: input.attachmentIds,
      viewport: input.viewport ?? null,
      executionEnvelope: input.executionEnvelope,
      contextManifest: input.contextManifest,
      lastEventSeq: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      error: null,
      startedAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.deps.db.insert(schema.conversationTurns).values(row).run();
    this.appendEvent(row.id, row.workspaceId, 'delta', {
      type: 'execution',
      envelope: input.executionEnvelope,
      context: input.contextManifest,
    });
    // Host narration is persisted synchronously with acceptance, so a queued
    // turn still acknowledges its next action within the two-second UX budget.
    this.appendEvent(row.id, row.workspaceId, 'delta', hostCommentary(
      row,
      'starting',
      `host-${row.clientTurnId}-starting`,
    ));
    queueMicrotask(() => void this.start(row.id));
    return row;
  }

  recover(): void {
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const rows = this.deps.db.select().from(schema.conversationTurns).where(inArray(
      schema.conversationTurns.status,
      [...CLAIMABLE_STATUSES, 'running'],
    )).orderBy(asc(schema.conversationTurns.createdAt)).all();
    for (const row of rows) {
      if (row.status === 'running') {
        const leaseExpiresAt = row.leaseExpiresAt ? Date.parse(row.leaseExpiresAt) : 0;
        if (leaseExpiresAt > nowMs) {
          const retry = setTimeout(() => this.recover(), Math.max(50, leaseExpiresAt - nowMs + 25));
          retry.unref?.();
          continue;
        }
        this.deps.db.update(schema.conversationTurns).set({
          status: 'queued',
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: now,
        }).where(eq(schema.conversationTurns.id, row.id)).run();
        this.appendEvent(row.id, row.workspaceId, 'delta', {
          type: 'activity',
          id: `activity-${row.clientTurnId}-recovered`,
          phase: 'waiting',
          status: 'running',
          label: 'Recovered after restart',
          detail: 'Agentis restored this durable turn and is continuing from persisted state.',
          clientTurnId: row.clientTurnId,
          agentId: row.agentId,
          startedAt: now,
        });
      }
      queueMicrotask(() => void this.start(row.id));
    }
  }

  async start(turnId: string): Promise<void> {
    if (this.#running.has(turnId)) return;
    const turn = this.getById(turnId);
    if (!turn || !CLAIMABLE_STATUSES.includes(turn.status as ConversationTurnStatus)) return;
    const otherRunning = this.deps.db.select({ id: schema.conversationTurns.id }).from(schema.conversationTurns).where(and(
      eq(schema.conversationTurns.workspaceId, turn.workspaceId),
      eq(schema.conversationTurns.conversationId, turn.conversationId),
      eq(schema.conversationTurns.status, 'running'),
      sql`${schema.conversationTurns.id} <> ${turnId}`,
    )).get();
    if (otherRunning) return;
    const now = new Date();
    const claimed = this.deps.db.update(schema.conversationTurns).set({
      status: 'running',
      leaseOwner: this.#workerId,
      leaseExpiresAt: new Date(now.getTime() + LEASE_MS).toISOString(),
      startedAt: turn.startedAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
    }).where(and(
      eq(schema.conversationTurns.id, turnId),
      inArray(schema.conversationTurns.status, CLAIMABLE_STATUSES),
    )).run();
    if (claimed.changes === 0) return;

    const controller = new AbortController();
    this.#running.set(turnId, controller);
    const heartbeat = setInterval(() => {
      const stamp = new Date();
      this.deps.db.update(schema.conversationTurns).set({
        leaseExpiresAt: new Date(stamp.getTime() + LEASE_MS).toISOString(),
        updatedAt: stamp.toISOString(),
      }).where(and(
        eq(schema.conversationTurns.id, turnId),
        eq(schema.conversationTurns.leaseOwner, this.#workerId),
        eq(schema.conversationTurns.status, 'running'),
      )).run();
    }, 10_000);
    heartbeat.unref?.();
    let lastNarrationAt = Date.now();
    const narrationHeartbeat = setInterval(() => {
      if (Date.now() - lastNarrationAt < NARRATION_HEARTBEAT_MS) return;
      lastNarrationAt = Date.now();
      const latest = this.getById(turnId);
      if (!latest || latest.status !== 'running') return;
      this.appendEvent(turnId, turn.workspaceId, 'delta', hostCommentary(
        latest,
        'working',
        `host-${turn.clientTurnId}-working-${Math.floor(lastNarrationAt / NARRATION_HEARTBEAT_MS)}`,
      ));
    }, 5_000);
    narrationHeartbeat.unref?.();

    const sink: DurableTurnEventSink = {
      writeSSE: async ({ event = 'message', data }) => {
        let parsed: unknown = data;
        try { parsed = JSON.parse(data); } catch { /* retain transport text */ }
        if (parsed && typeof parsed === 'object' && (parsed as { type?: unknown }).type === 'commentary') {
          lastNarrationAt = Date.now();
        }
        this.appendEvent(turnId, turn.workspaceId, event, parsed);
      },
    };

    try {
      const current = this.getById(turnId)!;
      const result = await this.deps.execute(current, sink, controller.signal);
      const latest = this.getById(turnId);
      if (!latest || latest.status === 'paused' || latest.status === 'cancelled') return;
      this.finish(turnId, result.status, result.error ?? null);
    } catch (error) {
      const latest = this.getById(turnId);
      if (latest?.status === 'paused' || latest?.status === 'cancelled') return;
      const message = (error as Error).message || 'Durable conversation turn failed.';
      this.appendEvent(turnId, turn.workspaceId, 'delta', hostCommentary(
        turn,
        'failed',
        `host-${turn.clientTurnId}-failed`,
      ));
      this.appendEvent(turnId, turn.workspaceId, 'error', { code: 'DURABLE_TURN_FAILED', message });
      this.finish(turnId, controller.signal.aborted
        ? 'interrupted'
        : isRecoverableRuntimeBlock(message) ? 'blocked' : 'failed', message);
      this.deps.logger.error('chat.turn_worker_failed', { turnId, conversationId: turn.conversationId, error: message });
    } finally {
      clearInterval(heartbeat);
      clearInterval(narrationHeartbeat);
      this.#running.delete(turnId);
    }
  }

  pause(workspaceId: string, turnId: string): ConversationTurnRow {
    const turn = this.require(workspaceId, turnId);
    if (TERMINAL_STATUSES.includes(turn.status as ConversationTurnStatus)) return turn;
    this.deps.db.update(schema.conversationTurns).set({
      status: 'paused',
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.conversationTurns.id, turnId)).run();
    this.#running.get(turnId)?.abort(new Error('operator_pause'));
    this.appendEvent(turnId, workspaceId, 'turn', { type: 'turn_status', status: 'paused' });
    return this.require(workspaceId, turnId);
  }

  resume(workspaceId: string, turnId: string): ConversationTurnRow {
    const turn = this.require(workspaceId, turnId);
    if (turn.status !== 'paused' && turn.status !== 'interrupted' && turn.status !== 'blocked') return turn;
    this.deps.db.update(schema.conversationTurns).set({
      status: 'queued',
      error: null,
      completedAt: null,
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.conversationTurns.id, turnId)).run();
    this.appendEvent(turnId, workspaceId, 'turn', { type: 'turn_status', status: 'queued' });
    queueMicrotask(() => void this.start(turnId));
    return this.require(workspaceId, turnId);
  }

  async cancel(workspaceId: string, turnId: string): Promise<ConversationTurnRow> {
    const turn = this.require(workspaceId, turnId);
    if (TERMINAL_STATUSES.includes(turn.status as ConversationTurnStatus)) return turn;
    this.deps.db.update(schema.conversationTurns).set({
      status: 'cancelled',
      leaseOwner: null,
      leaseExpiresAt: null,
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.conversationTurns.id, turnId)).run();
    this.#running.get(turnId)?.abort(new Error('operator_cancel'));
    await this.deps.onCancel?.(turn);
    this.appendEvent(turnId, workspaceId, 'done', { finishReason: 'interrupted', status: 'cancelled' });
    return this.require(workspaceId, turnId);
  }

  resolveAwaiting(
    workspaceId: string,
    conversationId: string,
    outcome: 'completed' | 'failed' | 'cancelled',
    error: string | null = null,
  ): ConversationTurnRow | null {
    const turn = this.deps.db.select().from(schema.conversationTurns).where(and(
      eq(schema.conversationTurns.workspaceId, workspaceId),
      eq(schema.conversationTurns.conversationId, conversationId),
      eq(schema.conversationTurns.status, 'awaiting_approval'),
    )).orderBy(asc(schema.conversationTurns.createdAt)).get();
    if (!turn) return null;
    const now = new Date().toISOString();
    this.deps.db.update(schema.conversationTurns).set({
      status: outcome,
      error,
      leaseOwner: null,
      leaseExpiresAt: null,
      completedAt: now,
      updatedAt: now,
    }).where(eq(schema.conversationTurns.id, turn.id)).run();
    this.appendEvent(turn.id, workspaceId, 'turn', { type: 'turn_status', status: outcome, error });
    const next = this.deps.db.select({ id: schema.conversationTurns.id }).from(schema.conversationTurns).where(and(
      eq(schema.conversationTurns.workspaceId, workspaceId),
      eq(schema.conversationTurns.conversationId, conversationId),
      eq(schema.conversationTurns.status, 'queued'),
    )).orderBy(asc(schema.conversationTurns.createdAt)).get();
    if (next) queueMicrotask(() => void this.start(next.id));
    return this.require(workspaceId, turn.id);
  }

  listActive(workspaceId: string, conversationId: string): ConversationTurnRow[] {
    return this.deps.db.select().from(schema.conversationTurns).where(and(
      eq(schema.conversationTurns.workspaceId, workspaceId),
      eq(schema.conversationTurns.conversationId, conversationId),
      inArray(schema.conversationTurns.status, ['queued', 'running', 'awaiting_approval', 'blocked', 'paused', 'interrupted']),
    )).orderBy(asc(schema.conversationTurns.createdAt)).all();
  }

  listRecent(workspaceId: string, conversationId: string, limit = 50): ConversationTurnRow[] {
    return this.deps.db.select().from(schema.conversationTurns).where(and(
      eq(schema.conversationTurns.workspaceId, workspaceId),
      eq(schema.conversationTurns.conversationId, conversationId),
    )).orderBy(desc(schema.conversationTurns.createdAt)).limit(Math.min(Math.max(limit, 1), 100)).all().reverse();
  }

  history(workspaceId: string, conversationId: string, limit = 50): Array<{
    turn: ConversationTurnRow;
    events: TurnEventV2[];
  }> {
    return this.listRecent(workspaceId, conversationId, limit).map((turn) => ({
      turn,
      events: this.events(workspaceId, turn.id, 0, 1_000).map((event) => projectTurnEvent(turn, event)),
    }));
  }

  events(workspaceId: string, turnId: string, after = 0, limit = 500): ConversationTurnEventRow[] {
    this.require(workspaceId, turnId);
    return this.deps.db.select().from(schema.conversationTurnEvents).where(and(
      eq(schema.conversationTurnEvents.workspaceId, workspaceId),
      eq(schema.conversationTurnEvents.turnId, turnId),
      gt(schema.conversationTurnEvents.seq, Math.max(0, after)),
    )).orderBy(asc(schema.conversationTurnEvents.seq)).limit(Math.min(Math.max(limit, 1), 1_000)).all();
  }

  require(workspaceId: string, turnId: string): ConversationTurnRow {
    const row = this.getById(turnId);
    if (!row || row.workspaceId !== workspaceId) throw new AgentisError('RESOURCE_NOT_FOUND', 'conversation turn not found');
    return row;
  }

  private getById(turnId: string): ConversationTurnRow | undefined {
    return this.deps.db.select().from(schema.conversationTurns).where(eq(schema.conversationTurns.id, turnId)).get();
  }

  private appendEvent(turnId: string, workspaceId: string, event: string, data: unknown): void {
    const eventId = randomUUID();
    const createdAt = new Date().toISOString();
    let insertedSeq: number | null = null;
    this.deps.db.transaction((tx) => {
      const turn = tx.select({ lastEventSeq: schema.conversationTurns.lastEventSeq }).from(schema.conversationTurns)
        .where(eq(schema.conversationTurns.id, turnId)).get();
      if (!turn) return;
      const seq = turn.lastEventSeq + 1;
      tx.insert(schema.conversationTurnEvents).values({ id: eventId, workspaceId, turnId, seq, event, data, createdAt }).run();
      tx.update(schema.conversationTurns).set({ lastEventSeq: seq, updatedAt: createdAt })
        .where(eq(schema.conversationTurns.id, turnId)).run();
      insertedSeq = seq;
    });
    if (insertedSeq == null || !this.deps.bus) return;
    const turn = this.getById(turnId);
    if (!turn) return;
    const projected = projectTurnEvent(turn, {
      id: eventId,
      workspaceId,
      turnId,
      seq: insertedSeq,
      event,
      data,
      createdAt,
    });
    this.deps.bus.publish(
      REALTIME_ROOMS.workspace(workspaceId),
      REALTIME_EVENTS.CONVERSATION_TURN_EVENT,
      projected,
      turn.clientTurnId,
    );
  }

  private finish(turnId: string, status: DurableTurnExecutionResult['status'], error: string | null): void {
    const current = this.getById(turnId);
    const now = new Date().toISOString();
    this.deps.db.update(schema.conversationTurns).set({
      status,
      error,
      leaseOwner: null,
      leaseExpiresAt: null,
      completedAt: status === 'awaiting_approval' || status === 'blocked' ? null : now,
      updatedAt: now,
    }).where(eq(schema.conversationTurns.id, turnId)).run();
    if (current) this.appendEvent(turnId, current.workspaceId, 'turn', { type: 'turn_status', status, error });
    if (current && status !== 'awaiting_approval') {
      const next = this.deps.db.select({ id: schema.conversationTurns.id }).from(schema.conversationTurns).where(and(
        eq(schema.conversationTurns.workspaceId, current.workspaceId),
        eq(schema.conversationTurns.conversationId, current.conversationId),
        eq(schema.conversationTurns.status, 'queued'),
      )).orderBy(asc(schema.conversationTurns.createdAt)).get();
      if (next) queueMicrotask(() => void this.start(next.id));
    }
  }
}

function isRecoverableRuntimeBlock(message: string): boolean {
  return /\b(?:capacity|overloaded|rate.?limit|quota|temporarily unavailable|try again|no healthy runtime)\b/i.test(message);
}

function hostCommentary(
  turn: Pick<ConversationTurnRow, 'clientTurnId' | 'prompt'>,
  phase: 'starting' | 'working' | 'failed',
  id: string,
) {
  const portuguese = /\b(?:vou|você|voce|preciso|faça|faca|implemente|corrija|crie|workflow|agente)\b/i.test(turn.prompt);
  const text = portuguese
    ? phase === 'starting'
      ? 'Vou revisar o contexto e confirmar o que precisa ser feito antes de alterar os recursos.'
      : phase === 'working'
        ? 'Continuo executando e verificando o trabalho; vou informar a próxima descoberta ou resultado concreto.'
        : 'A execução foi interrompida por uma falha; vou preservar o diagnóstico para que o trabalho possa ser retomado.'
    : phase === 'starting'
      ? 'I’ll review the context and confirm what must be done before changing any resources.'
      : phase === 'working'
        ? 'I’m still executing and verifying the work; I’ll report the next concrete finding or result.'
        : 'Execution stopped because of a failure; I’ll preserve the diagnosis so the work can be resumed.';
  return {
    type: 'commentary' as const,
    id,
    text,
    source: 'host' as const,
    createdAt: new Date().toISOString(),
  };
}

export function projectTurnEvent(turn: ConversationTurnRow, event: ConversationTurnEventRow): TurnEventV2 {
  const value = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {};
  const type = typeof value.type === 'string' ? value.type : event.event;
  const runId = typeof value.runId === 'string' ? value.runId : undefined;
  const category: TurnEventV2['category'] = type === 'commentary'
    ? 'narration'
    : type === 'activity' || type === 'tool_call' || type === 'tool_result'
      ? 'operation'
      : type === 'plan'
        ? 'verification'
        : 'status';
  const visibility: TurnEventV2['visibility'] = type === 'execution' || type === 'tool_call' || type === 'tool_result'
    ? 'technical'
    : 'both';
  const summary = safeEventSummary(type, value, event.event);
  return {
    version: 2,
    id: event.id,
    workspaceId: turn.workspaceId,
    conversationId: turn.conversationId,
    turnId: turn.id,
    agentId: turn.agentId,
    ...(runId ? { runId } : {}),
    seq: event.seq,
    transportEvent: event.event,
    category,
    visibility,
    summary,
    data: safeReplayData(type, value),
    createdAt: event.createdAt,
  };
}

function safeEventSummary(type: string, value: Record<string, unknown>, fallback: string): string {
  if (type === 'commentary' && typeof value.text === 'string') return sanitizeSafeText(value.text);
  if (type === 'activity' && typeof value.label === 'string') {
    const detail = typeof value.detail === 'string' && value.detail.trim() ? ` — ${value.detail.trim()}` : '';
    return sanitizeSafeText(`${value.label}${detail}`);
  }
  if (type === 'tool_call') return `Started ${typeof value.name === 'string' ? value.name : 'an operation'}`;
  if (type === 'tool_result') return `${value.error ? 'Failed' : 'Completed'} ${typeof value.name === 'string' ? value.name : 'an operation'}`;
  if (type === 'turn_status' && typeof value.status === 'string') return `Turn ${value.status}`;
  if (typeof value.message === 'string') return sanitizeSafeText(value.message);
  return fallback;
}

function safeReplayData(type: string, value: Record<string, unknown>): unknown {
  if (type === 'thinking') return { type: 'status', hidden: true };
  if (type === 'tool_call') return { type, id: value.id, name: value.name };
  if (type === 'tool_result') return { type, id: value.id, name: value.name, error: typeof value.error === 'string' ? sanitizeSafeText(value.error) : value.error };
  if (type === 'commentary') return { type, id: value.id, text: sanitizeSafeText(String(value.text ?? '')), source: value.source, createdAt: value.createdAt };
  if (type === 'activity') return {
    type,
    id: value.id,
    phase: value.phase,
    status: value.status,
    label: typeof value.label === 'string' ? sanitizeSafeText(value.label) : value.label,
    detail: typeof value.detail === 'string' ? sanitizeSafeText(value.detail) : value.detail,
    workflowId: value.workflowId,
    runId: value.runId,
    nodeId: value.nodeId,
    clientTurnId: value.clientTurnId,
    agentId: value.agentId,
    startedAt: value.startedAt,
  };
  if (type === 'error') return { type, code: value.code, message: typeof value.message === 'string' ? sanitizeSafeText(value.message) : undefined };
  return value;
}

function sanitizeSafeText(input: string): string {
  return input
    .replace(/\b(?:bearer\s+)?(?:sk|pk|rk|api)[-_][a-z0-9_-]{12,}\b/gi, '[redacted]')
    .replace(/\b(password|passwd|secret|api[_ -]?key|token)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, 1_200);
}

export function classifyConversationExecutionMode(
  requested: ConversationExecutionMode,
  input: { body: string; attachmentCount: number; permissionMode: ChatPermissionMode },
): { mode: EffectiveConversationExecutionMode; reason: string } {
  if (requested !== 'auto') return { mode: requested, reason: 'Selected explicitly by the operator.' };
  const text = input.body.trim();
  const lower = text.toLowerCase();
  const missionSignals = [
    /\b(?:build|implement|create|migrate|redesign|refactor|ship|deliver|deploy|audit and fix)\b/,
    /\b(?:from start to finish|end[- ]to[- ]end|production[- ]ready|do not stop|until (?:it|this) (?:is|works)|acceptance criteria)\b/,
    /\b(?:multi[- ]agent|delegate|specialist|parallel|entire|whole|complete)\b/,
  ];
  const deepSignals = [
    /\b(?:analy[sz]e|investigate|debug|review|compare|research|plan|explain)\b/,
    /\b(?:repository|codebase|architecture|database|api|workflow|document|spreadsheet|pdf)\b/,
  ];
  if (missionSignals.filter((signal) => signal.test(lower)).length >= 2 || text.length >= 4_000) {
    return { mode: 'mission', reason: 'The request contains multiple build/delivery signals or a substantial specification.' };
  }
  if (input.permissionMode === 'auto' && missionSignals.some((signal) => signal.test(lower))) {
    return { mode: 'mission', reason: 'A mutating build request in Auto mode requires durable mission execution.' };
  }
  if (input.attachmentCount > 0 || text.length >= 700 || deepSignals.some((signal) => signal.test(lower))) {
    return { mode: 'deep', reason: input.attachmentCount > 0 ? 'Attachments require deliberate ingestion and analysis.' : 'The request requires deliberate analysis or tools.' };
  }
  return { mode: 'quick', reason: 'A short conversational request can use the low-latency path.' };
}
