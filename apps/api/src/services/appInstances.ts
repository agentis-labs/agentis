import { and, eq } from 'drizzle-orm';
import {
  AgentisError,
  agentisPackageContentsSchema,
  type AgentisPackageContents,
} from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';

export type AppInstanceRow = typeof schema.appInstances.$inferSelect;

export interface AppScope {
  workspaceId: string;
  userId: string;
}

export type AppStatus = 'setup' | 'active' | 'paused' | 'error';

export class AppInstanceService {
  constructor(private readonly db: AgentisSqliteDb) {}

  list(scope: Pick<AppScope, 'workspaceId'>) {
    return this.db
      .select()
      .from(schema.appInstances)
      .where(eq(schema.appInstances.workspaceId, scope.workspaceId))
      .all()
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((row) => appDto(row));
  }

  getBySlug(workspaceId: string, slug: string) {
    const row = this.db
      .select()
      .from(schema.appInstances)
      .where(and(eq(schema.appInstances.workspaceId, workspaceId), eq(schema.appInstances.slug, slug)))
      .get();
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', 'App not found');
    return row;
  }

  getDtoBySlug(workspaceId: string, slug: string) {
    return appDto(this.getBySlug(workspaceId, slug));
  }

  setStatus(scope: AppScope, slug: string, status: AppStatus) {
    const app = this.getBySlug(scope.workspaceId, slug);
    const now = new Date().toISOString();
    this.db
      .update(schema.appInstances)
      .set({
        status,
        pausedAt: status === 'paused' ? now : null,
        updatedAt: now,
      })
      .where(and(eq(schema.appInstances.id, app.id), eq(schema.appInstances.userId, scope.userId)))
      .run();
    return this.getDtoBySlug(scope.workspaceId, slug);
  }

  /** Move an app into a Space (or out of it when spaceId === null). */
  setSpace(scope: AppScope, slug: string, spaceId: string | null) {
    const app = this.getBySlug(scope.workspaceId, slug);
    this.db
      .update(schema.appInstances)
      .set({ spaceId, updatedAt: new Date().toISOString() })
      .where(and(eq(schema.appInstances.id, app.id), eq(schema.appInstances.userId, scope.userId)))
      .run();
    return this.getDtoBySlug(scope.workspaceId, slug);
  }

  listBySpace(workspaceId: string, spaceId: string | null) {
    return this.list({ workspaceId }).filter((app) => (app.spaceId ?? null) === spaceId);
  }
}

export function parseAgentisContents(value: unknown): AgentisPackageContents {
  return agentisPackageContentsSchema.parse(value);
}

export function appDto(row: AppInstanceRow) {
  const contents = parseAgentisContents(row.packageContents);
  const datasetStatuses = arrayRecord(row.datasetStatuses);
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    ambientId: row.ambientId,
    userId: row.userId,
    packageId: row.packageId,
    spaceId: row.spaceId,
    slug: row.slug,
    name: row.name,
    version: row.version,
    status: row.status as AppStatus,
    entryWorkflowId: row.entryWorkflowId,
    credentialBindings: objectRecord(row.credentialBindings),
    datasetStatuses,
    knowledgeBaseIds: objectRecord(row.knowledgeBaseIds),
    activatedAt: row.activatedAt,
    pausedAt: row.pausedAt,
    lastRunAt: row.lastRunAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    contents,
    counts: {
      agents: contents.agents.length,
      workflows: contents.workflows.length,
      skills: contents.skills.length,
      integrations: contents.integrations.length,
      datasets: contents.datasetSpecs.length,
      credentials: contents.credentialSlots.length,
      importedDatasets: datasetStatuses.filter((item) => item.status === 'imported').length,
    },
    summary: {
      category: contents.category ?? null,
      replaces: contents.replaces ?? null,
      costSavedPerMonth: contents.costSavedPerMonth ?? null,
      readme: contents.readme ?? null,
      screenshotUrls: contents.screenshotUrls,
      crossAppDependencies: contents.crossAppDependencies,
    },
  };
}

export function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function arrayRecord(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
}