/**
 * WorkspaceContextService — V1-SPEC §3.3 spec-named service.
 *
 * Resolves a workspace + ambient pair from raw header values, enforcing
 * the tenant-isolation invariant in one place. The Hono `requireWorkspace`
 * middleware (middleware/workspace.ts) is now a thin adapter that calls
 * this service; routes that need to resolve a workspace from a non-HTTP
 * source (background jobs, future MCP server) call this directly.
 */

import { and, eq } from 'drizzle-orm';
import { AgentisError, type WorkspaceContext, type AuthenticatedUser } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';

export interface WorkspaceResolveArgs {
  user: AuthenticatedUser;
  workspaceId: string | undefined;
  ambientId?: string | undefined;
}

export class WorkspaceContextService {
  constructor(private readonly db: AgentisSqliteDb) {}

  resolve(args: WorkspaceResolveArgs): WorkspaceContext {
    if (!args.workspaceId) {
      throw new AgentisError(
        'VALIDATION_FAILED',
        'x-agentis-workspace header is required',
      );
    }
    const ws = this.db
      .select()
      .from(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.id, args.workspaceId),
          eq(schema.workspaces.userId, args.user.id),
        ),
      )
      .get();
    if (!ws) throw new AgentisError('CROSS_WORKSPACE_ACCESS', 'Workspace not accessible');

    const ambientId = args.ambientId ?? ws.defaultAmbientId ?? null;
    if (ambientId) {
      const amb = this.db
        .select()
        .from(schema.ambients)
        .where(
          and(eq(schema.ambients.id, ambientId), eq(schema.ambients.workspaceId, ws.id)),
        )
        .get();
      if (!amb) throw new AgentisError('CROSS_WORKSPACE_ACCESS', 'Ambient not in workspace');
    }

    return { workspaceId: ws.id, ambientId, user: args.user };
  }
}
