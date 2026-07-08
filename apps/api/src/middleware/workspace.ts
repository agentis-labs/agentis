/**
 * Hono middleware: workspace context resolver.
 *
 * Reads `x-agentis-workspace` header and attaches `WorkspaceContext` to the
 * request. Verifies the workspace belongs to the authenticated user — this
 * is the single point where multi-tenant isolation is enforced for the API.
 *
 * Optional `x-agentis-ambient` header narrows the scope to a specific
 * ambient inside the workspace; if omitted, the workspace's defaultAmbientId
 * is used.
 */

import type { Context, MiddlewareHandler } from 'hono';
import { and, eq } from 'drizzle-orm';
import { AgentisError, type WorkspaceContext } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { getUser } from './auth.js';

export function requireWorkspace(deps: { db: AgentisSqliteDb }): MiddlewareHandler {
  return async (c, next) => {
    const user = getUser(c);
    const workspaceId = c.req.header('x-agentis-workspace');
    if (!workspaceId) {
      throw new AgentisError(
        'VALIDATION_FAILED',
        'x-agentis-workspace header is required',
      );
    }
    const ws = deps.db
      .select()
      .from(schema.workspaces)
      .where(and(eq(schema.workspaces.id, workspaceId), eq(schema.workspaces.userId, user.id)))
      .get();
    if (!ws) throw new AgentisError('CROSS_WORKSPACE_ACCESS', 'Workspace not accessible');

    let ambientId = c.req.header('x-agentis-ambient') ?? ws.defaultAmbientId ?? null;
    if (ambientId) {
      const amb = deps.db
        .select()
        .from(schema.ambients)
        .where(and(eq(schema.ambients.id, ambientId), eq(schema.ambients.workspaceId, ws.id)))
        .get();
      if (!amb) throw new AgentisError('CROSS_WORKSPACE_ACCESS', 'Ambient not in workspace');
    }

    const ctx: WorkspaceContext = { workspaceId: ws.id, ambientId, user };
    c.set('workspace', ctx);
    await next();
  };
}

export function getWorkspace(c: Context): WorkspaceContext {
  const ws = c.get('workspace') as WorkspaceContext | undefined;
  if (!ws) throw new AgentisError('VALIDATION_FAILED', 'No workspace context on request');
  return ws;
}
