/**
 * AgentSessionService â€” persistent, DB-backed agent identity at work.
 *
 * SMARTER-AGENTS-10X Â§VI (Layer 1: The Cognitive Foundation).
 *
 * A session is a row, not a running process. It holds the agent's working
 * memory (persona/task/plan/observations blocks) plus the append-only episodic
 * message log. Between LLM inference calls the session is just this row â€” the
 * engine reconstructs the context window from it before each step and persists
 * the result after, so an agent spends zero tokens while a tool runs.
 *
 * This service owns persistence only. The thinkingâ†’doing loop, tool execution,
 * and suspend/wake orchestration live in the WorkflowEngine.
 */

import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { ChatMessage } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../../logger.js';

export type SessionStatus = 'idle' | 'active' | 'suspended' | 'waiting' | 'completed' | 'failed';
export type MemoryBlock = 'persona' | 'task' | 'plan' | 'observations';

/** Fixed nodeId sentinel for an agent's cross-run resident session (runId NULL). Â§3.1 */
export const RESIDENT_NODE_ID = '__resident__';
export type SuspendReason = 'delegate' | 'await_event' | 'checkpoint' | 'sleep_until' | 'long_tool';

export interface AgentSession {
  id: string;
  agentId: string;
  workspaceId: string;
  runId: string | null;
  nodeId: string | null;
  status: SessionStatus;
  personaBlock: string;
  taskBlock: string;
  planBlock: string;
  observationsBlock: string;
  suspendReason: SuspendReason | null;
  suspendPayload: Record<string, unknown> | null;
  suspendedAt: string | null;
  wakeCondition: string | null;
  parentSessionId: string | null;
  delegationDepth: number;
  totalSteps: number;
  totalTokensIn: number;
  totalTokensOut: number;
  lastCompactionAt: string | null;
  output: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A persisted episodic message. Maps onto a ChatMessage when rebuilt. */
export interface SessionMessage {
  id: string;
  sessionId: string;
  stepNumber: number;
  role: ChatMessage['role'];
  content: string;
  toolCalls: ChatMessage['toolCalls'] | null;
  toolCallId: string | null;
  tokenCount: number | null;
  inContextWindow: boolean;
  createdAt: string;
}

/** A message to append (the engine produces these from a step). */
export interface AppendMessage {
  role: ChatMessage['role'];
  content: string;
  toolCalls?: ChatMessage['toolCalls'];
  toolCallId?: string;
  tokenCount?: number;
}

export interface CreateSessionArgs {
  agentId: string;
  workspaceId: string;
  runId?: string | null;
  nodeId?: string | null;
  personaBlock?: string;
  taskBlock?: string;
  planBlock?: string;
  parentSessionId?: string | null;
  delegationDepth?: number;
}

/** Rough token estimate â€” 4 chars/token is the standard heuristic. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const MEMORY_COLUMN: Record<MemoryBlock, 'personaBlock' | 'taskBlock' | 'planBlock' | 'observationsBlock'> = {
  persona: 'personaBlock',
  task: 'taskBlock',
  plan: 'planBlock',
  observations: 'observationsBlock',
};

export class AgentSessionService {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly logger: Logger,
  ) {}

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Lifecycle
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  create(args: CreateSessionArgs): AgentSession {
    const now = new Date().toISOString();
    const row = {
      id: randomUUID(),
      agentId: args.agentId,
      workspaceId: args.workspaceId,
      runId: args.runId ?? null,
      nodeId: args.nodeId ?? null,
      status: 'active' as const,
      personaBlock: args.personaBlock ?? '',
      taskBlock: args.taskBlock ?? '',
      planBlock: args.planBlock ?? '',
      observationsBlock: '',
      suspendReason: null,
      suspendPayload: null,
      suspendedAt: null,
      wakeCondition: null,
      parentSessionId: args.parentSessionId ?? null,
      delegationDepth: args.delegationDepth ?? 0,
      totalSteps: 0,
      totalTokensIn: 0,
      totalTokensOut: 0,
      lastCompactionAt: null,
      output: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(schema.agentSessions).values(row).run();
    return row as AgentSession;
  }

  /**
   * Resume the live session for a run/node if one exists, otherwise create it.
   * Sessions are keyed by (runId, nodeId) so a node that yields and is later
   * woken reuses the same persistent identity.
   */
  getOrCreate(args: CreateSessionArgs & { runId: string; nodeId: string }): AgentSession {
    const existing = this.db
      .select()
      .from(schema.agentSessions)
      .where(and(eq(schema.agentSessions.runId, args.runId), eq(schema.agentSessions.nodeId, args.nodeId)))
      .get();
    if (existing) return this.#hydrate(existing);
    return this.create(args);
  }

  /**
   * The agent's cross-run RESIDENT session (Agent-Native Platform Plan Â§3.1).
   *
   * Every other session dies with its run â€” an `AgentSession` is keyed
   * `(runId, nodeId)`. A *persistent* agent needs a session that OUTLIVES any run:
   * keyed by `agentId` alone, with `runId` NULL (the column already allows it) and
   * a fixed `nodeId` sentinel. This is the working-memory home a scheduled wake
   * reuses tick after tick â€” so a resident agent continues where it left off
   * (`planBlock`/`observationsBlock`) instead of waking amnesiac every time.
   */
  getOrCreateResident(args: { workspaceId: string; agentId: string; personaBlock?: string }): AgentSession {
    const existing = this.db
      .select()
      .from(schema.agentSessions)
      .where(and(
        eq(schema.agentSessions.agentId, args.agentId),
        isNull(schema.agentSessions.runId),
        eq(schema.agentSessions.nodeId, RESIDENT_NODE_ID),
      ))
      .get();
    if (existing) return this.#hydrate(existing);
    return this.create({ workspaceId: args.workspaceId, agentId: args.agentId, nodeId: RESIDENT_NODE_ID, personaBlock: args.personaBlock });
  }

  /** Read a resident agent's carried working state (plan + observations blocks). */
  residentState(workspaceId: string, agentId: string): { plan: string; observations: string } {
    const s = this.getOrCreateResident({ workspaceId, agentId });
    return { plan: s.planBlock ?? '', observations: s.observationsBlock ?? '' };
  }

  /** Persist a resident agent's working state across wakes (what it's doing / where it left off). */
  rememberResident(workspaceId: string, agentId: string, patch: { plan?: string; observations?: string }): void {
    const s = this.getOrCreateResident({ workspaceId, agentId });
    if (patch.plan !== undefined) this.updateMemoryBlock(s.id, 'plan', patch.plan);
    if (patch.observations !== undefined) this.updateMemoryBlock(s.id, 'observations', patch.observations);
  }

  get(sessionId: string): AgentSession | null {
    const row = this.db.select().from(schema.agentSessions).where(eq(schema.agentSessions.id, sessionId)).get();
    return row ? this.#hydrate(row) : null;
  }

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Messages (episodic log)
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  appendMessages(sessionId: string, messages: AppendMessage[], stepNumber: number): void {
    if (messages.length === 0) return;
    const now = new Date().toISOString();
    const rows = messages.map((m) => ({
      id: randomUUID(),
      sessionId,
      stepNumber,
      role: m.role,
      content: m.content,
      toolCalls: m.toolCalls ?? null,
      toolCallId: m.toolCallId ?? null,
      tokenCount: m.tokenCount ?? estimateTokens(m.content),
      inContextWindow: true,
      createdAt: now,
    }));
    this.db.insert(schema.agentSessionMessages).values(rows).run();
    this.#touch(sessionId);
  }

  /** Messages currently in the context window, oldest first. */
  contextMessages(sessionId: string): SessionMessage[] {
    const rows = this.db
      .select()
      .from(schema.agentSessionMessages)
      .where(
        and(eq(schema.agentSessionMessages.sessionId, sessionId), eq(schema.agentSessionMessages.inContextWindow, true)),
      )
      .orderBy(asc(schema.agentSessionMessages.stepNumber), asc(schema.agentSessionMessages.createdAt))
      .all();
    return rows.map((r) => this.#hydrateMessage(r));
  }

  /** The most recent N messages (any window state), oldest first. */
  getRecentMessages(sessionId: string, limit: number): SessionMessage[] {
    const rows = this.db
      .select()
      .from(schema.agentSessionMessages)
      .where(eq(schema.agentSessionMessages.sessionId, sessionId))
      .orderBy(desc(schema.agentSessionMessages.stepNumber), desc(schema.agentSessionMessages.createdAt))
      .limit(limit)
      .all();
    return rows.reverse().map((r) => this.#hydrateMessage(r));
  }

  /** Fulltext-ish search over a session's archival message log. */
  searchMessages(sessionId: string, query: string, limit = 8): SessionMessage[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const terms = needle.split(/\s+/).filter(Boolean);
    const rows = this.db
      .select()
      .from(schema.agentSessionMessages)
      .where(eq(schema.agentSessionMessages.sessionId, sessionId))
      .orderBy(asc(schema.agentSessionMessages.stepNumber))
      .all();
    const scored = rows
      .map((r) => {
        const text = r.content.toLowerCase();
        const score = terms.reduce((acc, t) => acc + (text.includes(t) ? 1 : 0), 0);
        return { row: r, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return scored.map((s) => this.#hydrateMessage(s.row));
  }

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Memory blocks (working memory)
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  updateMemoryBlock(sessionId: string, block: MemoryBlock, content: string): void {
    this.db
      .update(schema.agentSessions)
      .set({ [MEMORY_COLUMN[block]]: content, updatedAt: new Date().toISOString() })
      .where(eq(schema.agentSessions.id, sessionId))
      .run();
  }

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Suspension / wake
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  suspend(
    sessionId: string,
    reason: SuspendReason,
    wakeCondition: string,
    payload: Record<string, unknown> | null = null,
  ): void {
    this.db
      .update(schema.agentSessions)
      .set({
        status: 'waiting',
        suspendReason: reason,
        wakeCondition,
        suspendPayload: payload,
        suspendedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.agentSessions.id, sessionId))
      .run();
  }

  /** Clear suspension and mark active. The caller injects the wake payload as a message. */
  wake(sessionId: string): AgentSession | null {
    this.db
      .update(schema.agentSessions)
      .set({
        status: 'active',
        suspendReason: null,
        wakeCondition: null,
        suspendPayload: null,
        suspendedAt: null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.agentSessions.id, sessionId))
      .run();
    return this.get(sessionId);
  }

  /** Every session currently parked WAITING (restart-recovery rehydration). */
  listWaiting(): AgentSession[] {
    return this.db
      .select()
      .from(schema.agentSessions)
      .where(eq(schema.agentSessions.status, 'waiting'))
      .all()
      .map((r) => this.#hydrate(r));
  }

  /** All sessions currently waiting on an exact wake condition. */
  listWaitingFor(wakeCondition: string): AgentSession[] {
    const rows = this.db
      .select()
      .from(schema.agentSessions)
      .where(and(eq(schema.agentSessions.status, 'waiting'), eq(schema.agentSessions.wakeCondition, wakeCondition)))
      .all();
    return rows.map((r) => this.#hydrate(r));
  }

  /** All sessions waiting on a time-based wake whose ISO deadline has passed. */
  listDueTimers(nowIso: string): AgentSession[] {
    const rows = this.db
      .select()
      .from(schema.agentSessions)
      .where(and(eq(schema.agentSessions.status, 'waiting'), eq(schema.agentSessions.suspendReason, 'sleep_until')))
      .all();
    return rows
      .map((r) => this.#hydrate(r))
      .filter((s) => {
        const at = s.wakeCondition?.startsWith('time:') ? s.wakeCondition.slice('time:'.length) : null;
        return at !== null && at <= nowIso;
      });
  }

  complete(sessionId: string, output: Record<string, unknown>): void {
    this.db
      .update(schema.agentSessions)
      .set({ status: 'completed', output, updatedAt: new Date().toISOString() })
      .where(eq(schema.agentSessions.id, sessionId))
      .run();
  }

  fail(sessionId: string, error: string): void {
    this.db
      .update(schema.agentSessions)
      .set({ status: 'failed', error, updatedAt: new Date().toISOString() })
      .where(eq(schema.agentSessions.id, sessionId))
      .run();
  }

  incrementStats(sessionId: string, delta: { steps?: number; tokensIn?: number; tokensOut?: number }): void {
    this.db
      .update(schema.agentSessions)
      .set({
        totalSteps: sql`${schema.agentSessions.totalSteps} + ${delta.steps ?? 0}`,
        totalTokensIn: sql`${schema.agentSessions.totalTokensIn} + ${delta.tokensIn ?? 0}`,
        totalTokensOut: sql`${schema.agentSessions.totalTokensOut} + ${delta.tokensOut ?? 0}`,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.agentSessions.id, sessionId))
      .run();
  }

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Context reconstruction (the critical rebuild)
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * Rebuild the full context window from session state: a single system message
   * carrying persona + memory blocks (+ optional engine-supplied run context),
   * followed by every in-context episodic message. This is what makes the agent
   * "a DB record between steps" â€” the live conversation is reconstructed, never
   * held in memory.
   *
   * `opts.inContext` lets a caller that already fetched `contextMessages()` this
   * turn (e.g. for a compaction check) pass it through instead of paying for a
   * second identical query.
   */
  reconstructContext(session: AgentSession, opts: { runContext?: string; inContext?: SessionMessage[] } = {}): ChatMessage[] {
    const blocks: string[] = [];
    if (session.personaBlock) blocks.push(session.personaBlock);
    const memory: string[] = [];
    if (session.taskBlock) memory.push(`# Task\n${session.taskBlock}`);
    if (session.planBlock) memory.push(`# Plan\n${session.planBlock}`);
    if (session.observationsBlock) memory.push(`# Observations\n${session.observationsBlock}`);
    if (memory.length > 0) blocks.push(`<working_memory>\n${memory.join('\n\n')}\n</working_memory>`);
    if (opts.runContext) blocks.push(opts.runContext);

    const messages: ChatMessage[] = [];
    if (blocks.length > 0) messages.push({ role: 'system', content: blocks.join('\n\n') });

    for (const m of opts.inContext ?? this.contextMessages(session.id)) {
      const msg: ChatMessage = { role: m.role, content: m.content };
      if (m.toolCalls) msg.toolCalls = m.toolCalls;
      if (m.toolCallId) msg.toolCallId = m.toolCallId;
      messages.push(msg);
    }
    return messages;
  }

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Compaction (evict the oldest in-context messages)
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * Evict the oldest `fraction` of in-context messages and return them so the
   * caller can summarize them into the observations block. Tool/assistant pairs
   * are evicted by age; the summary preserves their content.
   */
  evictOldest(sessionId: string, fraction: number): SessionMessage[] {
    const inContext = this.contextMessages(sessionId);
    if (inContext.length < 4) return [];
    const count = Math.max(1, Math.floor(inContext.length * fraction));
    const victims = inContext.slice(0, count);
    const ids = victims.map((v) => v.id);
    for (const id of ids) {
      this.db
        .update(schema.agentSessionMessages)
        .set({ inContextWindow: false })
        .where(eq(schema.agentSessionMessages.id, id))
        .run();
    }
    this.db
      .update(schema.agentSessions)
      .set({ lastCompactionAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
      .where(eq(schema.agentSessions.id, sessionId))
      .run();
    return victims;
  }

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  #touch(sessionId: string): void {
    this.db
      .update(schema.agentSessions)
      .set({ updatedAt: new Date().toISOString() })
      .where(eq(schema.agentSessions.id, sessionId))
      .run();
  }

  #hydrate(row: typeof schema.agentSessions.$inferSelect): AgentSession {
    return {
      id: row.id,
      agentId: row.agentId,
      workspaceId: row.workspaceId,
      runId: row.runId,
      nodeId: row.nodeId,
      status: row.status as SessionStatus,
      personaBlock: row.personaBlock,
      taskBlock: row.taskBlock,
      planBlock: row.planBlock,
      observationsBlock: row.observationsBlock,
      suspendReason: (row.suspendReason as SuspendReason | null) ?? null,
      suspendPayload: (row.suspendPayload as Record<string, unknown> | null) ?? null,
      suspendedAt: row.suspendedAt,
      wakeCondition: row.wakeCondition,
      parentSessionId: row.parentSessionId,
      delegationDepth: row.delegationDepth,
      totalSteps: row.totalSteps,
      totalTokensIn: row.totalTokensIn,
      totalTokensOut: row.totalTokensOut,
      lastCompactionAt: row.lastCompactionAt,
      output: (row.output as Record<string, unknown> | null) ?? null,
      error: row.error,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  #hydrateMessage(row: typeof schema.agentSessionMessages.$inferSelect): SessionMessage {
    return {
      id: row.id,
      sessionId: row.sessionId,
      stepNumber: row.stepNumber,
      role: row.role as ChatMessage['role'],
      content: row.content,
      toolCalls: (row.toolCalls as ChatMessage['toolCalls']) ?? null,
      toolCallId: row.toolCallId,
      tokenCount: row.tokenCount,
      inContextWindow: row.inContextWindow,
      createdAt: row.createdAt,
    };
  }
}

