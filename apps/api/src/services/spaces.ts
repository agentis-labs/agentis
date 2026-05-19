/**
 * SpaceService — organizational grouping primitive (UIUX §23).
 *
 * Spaces are optional, organizational only (no permission boundaries in V1).
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { AgentisError } from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';

export interface SpaceDto {
  id: string;
  workspaceId: string;
  name: string;
  color: string | null;
  iconGlyph: string | null;
  teamId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SpaceScope {
  workspaceId: string;
  userId: string;
}

export class SpaceService {
  constructor(private readonly db: AgentisSqliteDb) {}

  list(workspaceId: string): SpaceDto[] {
    const rows = this.db
      .select()
      .from(schema.spaces)
      .where(eq(schema.spaces.workspaceId, workspaceId))
      .all();
    return rows
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((row) => ({
        id: row.id,
        workspaceId: row.workspaceId,
        name: row.name,
        color: row.color,
        iconGlyph: row.iconGlyph,
        teamId: row.teamId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }));
  }

  get(workspaceId: string, id: string): SpaceDto {
    const row = this.db
      .select()
      .from(schema.spaces)
      .where(and(eq(schema.spaces.workspaceId, workspaceId), eq(schema.spaces.id, id)))
      .get();
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', 'Space not found');
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      color: row.color,
      iconGlyph: row.iconGlyph,
      teamId: row.teamId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  create(scope: SpaceScope, params: { name: string; color?: string | null; iconGlyph?: string | null; teamId?: string | null }): SpaceDto {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .insert(schema.spaces)
      .values({
        id,
        workspaceId: scope.workspaceId,
        userId: scope.userId,
        name: params.name.trim(),
        color: params.color ?? null,
        iconGlyph: params.iconGlyph ?? null,
        teamId: params.teamId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return this.get(scope.workspaceId, id);
  }

  update(
    scope: SpaceScope,
    id: string,
    patch: { name?: string; color?: string | null; iconGlyph?: string | null; teamId?: string | null },
  ): SpaceDto {
    const existing = this.get(scope.workspaceId, id);
    const now = new Date().toISOString();
    this.db
      .update(schema.spaces)
      .set({
        name: patch.name?.trim() ?? existing.name,
        color: patch.color === undefined ? existing.color : patch.color,
        iconGlyph: patch.iconGlyph === undefined ? existing.iconGlyph : patch.iconGlyph,
        teamId: patch.teamId === undefined ? existing.teamId : patch.teamId,
        updatedAt: now,
      })
      .where(and(eq(schema.spaces.workspaceId, scope.workspaceId), eq(schema.spaces.id, id)))
      .run();
    return this.get(scope.workspaceId, id);
  }

  delete(scope: SpaceScope, id: string): void {
    const result = this.db
      .delete(schema.spaces)
      .where(and(eq(schema.spaces.workspaceId, scope.workspaceId), eq(schema.spaces.id, id)))
      .run();
    if (!result.changes) throw new AgentisError('RESOURCE_NOT_FOUND', 'Space not found');
  }
}
