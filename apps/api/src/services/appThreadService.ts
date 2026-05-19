/**
 * AppThreadService — APP-OUTPUT-REPLAN.md §5.3.
 *
 * Persistent operator-directed conversation surface scoped to one app.
 * Replaces the issues kanban; lives in the App Output surface.
 *
 * Append-only message log. The Conversation panel reads `kind in
 * ('message', 'progress', 'result', 'checkpoint', 'error')`.
 *
 * Realtime: every append publishes APP_THREAD_MESSAGE_APPENDED on the
 * `workflow(entryWorkflowId)` room (see §5.4 — there is no `app` room in
 * REALTIME_ROOMS, so we route through the workflow room which the AppThread
 * component subscribes to on mount).
 */

import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, lt } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import type { EventBus } from '../event-bus.js';

export type AppThreadRole = 'operator' | 'app' | 'system';
export type AppThreadKind = 'message' | 'progress' | 'result' | 'checkpoint' | 'error';

export interface AppThreadMessage {
  id: string;
  appId: string;
  workspaceId: string;
  role: AppThreadRole;
  kind: AppThreadKind;
  content: unknown;
  runId: string | null;
  approvalId: string | null;
  operatorId: string | null;
  createdAt: string;
}

export interface AppendArgs {
  appId: string;
  workspaceId: string;
  /** Required to fan out APP_THREAD_MESSAGE_APPENDED to the right room. */
  entryWorkflowId: string | null;
  role: AppThreadRole;
  kind: AppThreadKind;
  content: unknown;
  runId?: string | null;
  approvalId?: string | null;
  operatorId?: string | null;
}

export class AppThreadService {
  constructor(
    private readonly deps: {
      db: AgentisSqliteDb;
      bus: EventBus;
    },
  ) {}

  append(args: AppendArgs): AppThreadMessage {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const message: AppThreadMessage = {
      id,
      appId: args.appId,
      workspaceId: args.workspaceId,
      role: args.role,
      kind: args.kind,
      content: args.content,
      runId: args.runId ?? null,
      approvalId: args.approvalId ?? null,
      operatorId: args.operatorId ?? null,
      createdAt,
    };

    this.deps.db
      .insert(schema.appThreadMessages)
      .values({
        id,
        appId: args.appId,
        workspaceId: args.workspaceId,
        role: args.role,
        kind: args.kind,
        content: args.content as never,
        runId: message.runId,
        approvalId: message.approvalId,
        operatorId: message.operatorId,
        createdAt,
      })
      .run();

    if (args.entryWorkflowId) {
      this.deps.bus.publish(
        REALTIME_ROOMS.workflow(args.entryWorkflowId),
        REALTIME_EVENTS.APP_THREAD_MESSAGE_APPENDED,
        { ...message },
      );
    }
    // Always publish on the workspace room as well — supports a future
    // workspace-orchestrator dashboard listening for cross-app activity.
    this.deps.bus.publish(
      REALTIME_ROOMS.workspace(args.workspaceId),
      REALTIME_EVENTS.APP_THREAD_MESSAGE_APPENDED,
      { ...message },
    );

    return message;
  }

  list(args: { workspaceId: string; appId: string; limit?: number; before?: string }): AppThreadMessage[] {
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);
    const conditions = [
      eq(schema.appThreadMessages.workspaceId, args.workspaceId),
      eq(schema.appThreadMessages.appId, args.appId),
    ];
    if (args.before) conditions.push(lt(schema.appThreadMessages.createdAt, args.before));
    const rows = this.deps.db
      .select()
      .from(schema.appThreadMessages)
      .where(and(...conditions))
      .orderBy(desc(schema.appThreadMessages.createdAt))
      .limit(limit)
      .all();
    return rows.map(rowToMessage).reverse();
  }

  /** Recent N messages in chronological order (used to seed chat history). */
  recent(workspaceId: string, appId: string, limit = 20): AppThreadMessage[] {
    const rows = this.deps.db
      .select()
      .from(schema.appThreadMessages)
      .where(and(eq(schema.appThreadMessages.workspaceId, workspaceId), eq(schema.appThreadMessages.appId, appId)))
      .orderBy(asc(schema.appThreadMessages.createdAt))
      .limit(limit)
      .all();
    return rows.map(rowToMessage);
  }
}

function rowToMessage(row: typeof schema.appThreadMessages.$inferSelect): AppThreadMessage {
  return {
    id: row.id,
    appId: row.appId,
    workspaceId: row.workspaceId,
    role: row.role as AppThreadRole,
    kind: row.kind as AppThreadKind,
    content: row.content,
    runId: row.runId,
    approvalId: row.approvalId,
    operatorId: row.operatorId,
    createdAt: row.createdAt,
  };
}
