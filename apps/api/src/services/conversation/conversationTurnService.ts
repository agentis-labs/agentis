import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import type {
  ChatExecutionEnvelope,
  ChatContextManifest,
  ChatPermissionMode,
  ConversationExecutionMode,
  ConversationTurnStatus,
  EffectiveConversationExecutionMode,
  ViewportContext,
} from '@agentis/core';
import { AgentisError } from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../../logger.js';

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
  status: Extract<ConversationTurnStatus, 'completed' | 'failed' | 'awaiting_approval' | 'interrupted'>;
  error?: string | null;
}

interface ConversationTurnServiceDeps {
  db: AgentisSqliteDb;
  logger: Logger;
  execute: (turn: ConversationTurnRow, sink: DurableTurnEventSink, signal: AbortSignal) => Promise<DurableTurnExecutionResult>;
  onCancel?: (turn: ConversationTurnRow) => Promise<void> | void;
}

export interface DurableTurnEventSink {
  writeSSE(args: { event?: string; data: string }): Promise<void>;
}

const TERMINAL_STATUSES: ConversationTurnStatus[] = ['completed', 'failed', 'cancelled'];
const CLAIMABLE_STATUSES: ConversationTurnStatus[] = ['queued', 'interrupted'];
const LEASE_MS = 30_000;

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

    const sink: DurableTurnEventSink = {
      writeSSE: async ({ event = 'message', data }) => {
        let parsed: unknown = data;
        try { parsed = JSON.parse(data); } catch { /* retain transport text */ }
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
      this.appendEvent(turnId, turn.workspaceId, 'error', { code: 'DURABLE_TURN_FAILED', message });
      this.finish(turnId, controller.signal.aborted ? 'interrupted' : 'failed', message);
      this.deps.logger.error('chat.turn_worker_failed', { turnId, conversationId: turn.conversationId, error: message });
    } finally {
      clearInterval(heartbeat);
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
    if (turn.status !== 'paused' && turn.status !== 'interrupted') return turn;
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
      inArray(schema.conversationTurns.status, ['queued', 'running', 'awaiting_approval', 'paused', 'interrupted']),
    )).orderBy(asc(schema.conversationTurns.createdAt)).all();
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
    this.deps.db.transaction((tx) => {
      const turn = tx.select({ lastEventSeq: schema.conversationTurns.lastEventSeq }).from(schema.conversationTurns)
        .where(eq(schema.conversationTurns.id, turnId)).get();
      if (!turn) return;
      const seq = turn.lastEventSeq + 1;
      tx.insert(schema.conversationTurnEvents).values({ id: randomUUID(), workspaceId, turnId, seq, event, data }).run();
      tx.update(schema.conversationTurns).set({ lastEventSeq: seq, updatedAt: new Date().toISOString() })
        .where(eq(schema.conversationTurns.id, turnId)).run();
    });
  }

  private finish(turnId: string, status: DurableTurnExecutionResult['status'], error: string | null): void {
    const current = this.getById(turnId);
    const now = new Date().toISOString();
    this.deps.db.update(schema.conversationTurns).set({
      status,
      error,
      leaseOwner: null,
      leaseExpiresAt: null,
      completedAt: status === 'awaiting_approval' ? null : now,
      updatedAt: now,
    }).where(eq(schema.conversationTurns.id, turnId)).run();
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
