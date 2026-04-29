/**
 * GatewayDirectoryService — V1-SPEC §3.3 spec-named service.
 *
 * Read-side helpers for OpenClaw Gateway lookups. The CRUD lifecycle
 * (pair / sync / disconnect) lives in routes/gatewayMutations.ts; this
 * service owns the ergonomic queries the engine + adapters need:
 *  - by id (with workspace scope check)
 *  - by workspace
 *  - by ambient inside a workspace
 *
 * Returns the raw `openclawGateways` row shape; the device-token credential
 * id is included so callers can decrypt via `CredentialVault` when they
 * need to dispatch.
 */

import { and, eq } from 'drizzle-orm';
import { AgentisError } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';

export class GatewayDirectoryService {
  constructor(private readonly db: AgentisSqliteDb) {}

  byId(workspaceId: string, gatewayId: string) {
    const row = this.db
      .select()
      .from(schema.openclawGateways)
      .where(
        and(
          eq(schema.openclawGateways.id, gatewayId),
          eq(schema.openclawGateways.workspaceId, workspaceId),
        ),
      )
      .get();
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `gateway ${gatewayId} not found`);
    return row;
  }

  listByWorkspace(workspaceId: string) {
    return this.db
      .select()
      .from(schema.openclawGateways)
      .where(eq(schema.openclawGateways.workspaceId, workspaceId))
      .all();
  }

  listByAmbient(workspaceId: string, ambientId: string | null) {
    return this.listByWorkspace(workspaceId).filter((g) => g.ambientId === ambientId);
  }
}
