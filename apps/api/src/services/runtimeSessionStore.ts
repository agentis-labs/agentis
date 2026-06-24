import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { RuntimeSessionInfo } from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';

export interface RuntimeSessionRecord extends RuntimeSessionInfo {
  workspaceId: string;
  agentId: string;
  conversationId: string | null;
  executionMode: string;
  runtimeProfileId: string | null;
}

export class RuntimeSessionStore {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void },
  ) {}

  /**
   * Coerce a candidate `conversationId` to a value the FK can accept. The CLI
   * adapters pass their `sessionKey` here, which is a real conversation id during
   * chat but a SYNTHETIC key (e.g. 'default') for self-heal / structured
   * completions. Writing a synthetic key into the `conversation_id` FK column
   * raised `SQLITE_CONSTRAINT_FOREIGNKEY`, and because the upsert ran inside an
   * adapter stdout handler the throw was uncaught — it killed the whole API
   * process mid-run. Only persist the FK when it points at a real conversation;
   * otherwise store null (the `session_key` column already carries the key).
   */
  #safeConversationId(conversationId: string | null | undefined): string | null {
    if (!conversationId) return null;
    try {
      const row = this.db
        .select({ id: schema.conversations.id })
        .from(schema.conversations)
        .where(eq(schema.conversations.id, conversationId))
        .get();
      return row ? conversationId : null;
    } catch {
      return null;
    }
  }

  get(
    workspaceId: string,
    agentId: string,
    sessionKey: string,
    executionMode = 'chat',
  ): RuntimeSessionRecord | null {
    const row = this.db
      .select()
      .from(schema.runtimeSessions)
      .where(and(
        eq(schema.runtimeSessions.workspaceId, workspaceId),
        eq(schema.runtimeSessions.agentId, agentId),
        eq(schema.runtimeSessions.sessionKey, sessionKey),
        eq(schema.runtimeSessions.executionMode, executionMode),
      ))
      .get();
    return row ? present(row) : null;
  }

  upsert(input: {
    workspaceId: string;
    agentId: string;
    conversationId?: string | null;
    sessionKey: string;
    executionMode?: string;
    runtimeProfileId?: string | null;
    runtimeSessionId: string;
    processGeneration?: number;
    selectedModel?: string | null;
    status?: RuntimeSessionInfo['status'];
  }): RuntimeSessionRecord {
    const now = new Date().toISOString();
    const executionMode = input.executionMode ?? 'chat';
    const conversationId = this.#safeConversationId(input.conversationId);
    // Persisting a runtime session is a best-effort optimisation for resumption.
    // It must NEVER throw into the caller — these upserts run inside adapter
    // stdout stream handlers, where an uncaught DB error would crash the whole
    // process and tear down every live run/stream. On failure we log and return
    // a best-effort record synthesised from the inputs.
    try {
      this.db
        .insert(schema.runtimeSessions)
        .values({
          id: randomUUID(),
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          conversationId,
          sessionKey: input.sessionKey,
          executionMode,
          runtimeProfileId: input.runtimeProfileId ?? null,
          runtimeSessionId: input.runtimeSessionId,
          processGeneration: input.processGeneration ?? 1,
          selectedModel: input.selectedModel ?? null,
          status: input.status ?? 'idle',
          lastUsedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            schema.runtimeSessions.workspaceId,
            schema.runtimeSessions.agentId,
            schema.runtimeSessions.sessionKey,
            schema.runtimeSessions.executionMode,
          ],
          set: {
            conversationId,
            runtimeProfileId: input.runtimeProfileId ?? null,
            runtimeSessionId: input.runtimeSessionId,
            processGeneration: input.processGeneration ?? 1,
            selectedModel: input.selectedModel ?? null,
            status: input.status ?? 'idle',
            lastUsedAt: now,
            updatedAt: now,
          },
        })
        .run();
      return this.get(input.workspaceId, input.agentId, input.sessionKey, executionMode)
        ?? this.#synthesize(input, conversationId, executionMode, now);
    } catch (err) {
      this.logger?.warn('runtime_session.upsert_failed', {
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        sessionKey: input.sessionKey,
        error: (err as Error).message,
      });
      return this.#synthesize(input, conversationId, executionMode, now);
    }
  }

  #synthesize(
    input: { workspaceId: string; agentId: string; conversationId?: string | null; sessionKey: string; runtimeProfileId?: string | null; runtimeSessionId: string; processGeneration?: number; selectedModel?: string | null; status?: RuntimeSessionInfo['status'] },
    conversationId: string | null,
    executionMode: string,
    now: string,
  ): RuntimeSessionRecord {
    return {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      conversationId,
      sessionKey: input.sessionKey,
      executionMode,
      runtimeProfileId: input.runtimeProfileId ?? null,
      runtimeSessionId: input.runtimeSessionId,
      status: normalizeStatus(input.status ?? 'idle'),
      selectedModel: input.selectedModel ?? null,
      processGeneration: input.processGeneration ?? 1,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
    };
  }

  markStatus(
    workspaceId: string,
    agentId: string,
    sessionKey: string,
    status: RuntimeSessionInfo['status'],
    executionMode = 'chat',
  ): void {
    const now = new Date().toISOString();
    this.db
      .update(schema.runtimeSessions)
      .set({ status, lastUsedAt: now, updatedAt: now })
      .where(and(
        eq(schema.runtimeSessions.workspaceId, workspaceId),
        eq(schema.runtimeSessions.agentId, agentId),
        eq(schema.runtimeSessions.sessionKey, sessionKey),
        eq(schema.runtimeSessions.executionMode, executionMode),
      ))
      .run();
  }

  remove(
    workspaceId: string,
    agentId: string,
    sessionKey: string,
    executionMode = 'chat',
  ): void {
    this.db
      .delete(schema.runtimeSessions)
      .where(and(
        eq(schema.runtimeSessions.workspaceId, workspaceId),
        eq(schema.runtimeSessions.agentId, agentId),
        eq(schema.runtimeSessions.sessionKey, sessionKey),
        eq(schema.runtimeSessions.executionMode, executionMode),
      ))
      .run();
  }

  list(workspaceId: string, agentId: string): RuntimeSessionRecord[] {
    return this.db
      .select()
      .from(schema.runtimeSessions)
      .where(and(
        eq(schema.runtimeSessions.workspaceId, workspaceId),
        eq(schema.runtimeSessions.agentId, agentId),
      ))
      .orderBy(desc(schema.runtimeSessions.lastUsedAt))
      .all()
      .map(present);
  }
}

function present(row: typeof schema.runtimeSessions.$inferSelect): RuntimeSessionRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    agentId: row.agentId,
    conversationId: row.conversationId,
    sessionKey: row.sessionKey,
    executionMode: row.executionMode,
    runtimeProfileId: row.runtimeProfileId,
    runtimeSessionId: row.runtimeSessionId,
    status: normalizeStatus(row.status),
    selectedModel: row.selectedModel,
    processGeneration: row.processGeneration,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastUsedAt: row.lastUsedAt,
  };
}

function normalizeStatus(value: string): RuntimeSessionInfo['status'] {
  if (value === 'active' || value === 'stale' || value === 'closed' || value === 'error') return value;
  return 'idle';
}
