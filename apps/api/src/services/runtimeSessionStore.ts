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
  constructor(private readonly db: AgentisSqliteDb) {}

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
    this.db
      .insert(schema.runtimeSessions)
      .values({
        id: randomUUID(),
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        conversationId: input.conversationId ?? null,
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
          conversationId: input.conversationId ?? null,
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
    return this.get(input.workspaceId, input.agentId, input.sessionKey, executionMode)!;
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
