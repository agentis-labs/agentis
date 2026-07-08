import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import {
  AgentisError,
  appEnvironmentSchema,
  appManifestSchema,
  type AppEnvironment,
  type AppManifest,
  type PromoteAppEnvironmentInput,
  type UpsertAppEnvironmentInput,
} from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { AppLifecycle, type AppUpgradeResult } from './appLifecycle.js';
import { AppPackager } from './appPackager.js';
import { AppStore } from './appStore.js';

type EnvironmentRow = typeof schema.appEnvironments.$inferSelect;

export interface AppEnvironmentPromotionResult {
  environment: AppEnvironment;
  runtimeUpgrade?: AppUpgradeResult;
}

/**
 * Named AppManifest snapshots for dev/staging/production promotion.
 *
 * Environments are intentionally definitions, not alternate runtime tables:
 * production promotion goes through AppLifecycle so migrations, snapshots, and
 * rollback retain the same invariants as a package upgrade.
 */
export class AppEnvironmentStore {
  constructor(private readonly db: AgentisSqliteDb) {}

  list(workspaceId: string, appId: string): AppEnvironment[] {
    this.requireApp(workspaceId, appId);
    return this.db
      .select()
      .from(schema.appEnvironments)
      .where(and(eq(schema.appEnvironments.workspaceId, workspaceId), eq(schema.appEnvironments.appId, appId)))
      .orderBy(asc(schema.appEnvironments.kind), asc(schema.appEnvironments.name))
      .all()
      .map((row) => this.toEnvironment(row));
  }

  get(workspaceId: string, appId: string, name: string): AppEnvironment {
    this.requireApp(workspaceId, appId);
    const row = this.db
      .select()
      .from(schema.appEnvironments)
      .where(and(
        eq(schema.appEnvironments.workspaceId, workspaceId),
        eq(schema.appEnvironments.appId, appId),
        eq(schema.appEnvironments.name, name),
      ))
      .get();
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `app environment not found: ${name}`);
    return this.toEnvironment(row);
  }

  snapshotRuntime(workspaceId: string, userId: string, appId: string, name: string, kind: UpsertAppEnvironmentInput['kind'] = 'dev'): AppEnvironment {
    const manifest = new AppPackager(this.db).toManifest(workspaceId, appId);
    return this.upsert(workspaceId, userId, appId, name, { kind, manifest });
  }

  upsert(workspaceId: string, userId: string, appId: string, name: string, input: UpsertAppEnvironmentInput): AppEnvironment {
    this.requireApp(workspaceId, appId);
    const manifest = appManifestSchema.parse(input.manifest);
    const now = new Date().toISOString();
    const existing = this.find(workspaceId, appId, name);
    if (existing) {
      this.db
        .update(schema.appEnvironments)
        .set({
          kind: input.kind,
          manifestJson: manifest,
          sourceEnvironmentId: null,
          promotedAt: null,
          updatedAt: now,
        })
        .where(eq(schema.appEnvironments.id, existing.id))
        .run();
      return this.get(workspaceId, appId, name);
    }
    this.db
      .insert(schema.appEnvironments)
      .values({
        id: randomUUID(),
        workspaceId,
        appId,
        name,
        kind: input.kind,
        manifestJson: manifest,
        sourceEnvironmentId: null,
        promotedAt: null,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return this.get(workspaceId, appId, name);
  }

  promote(
    workspaceId: string,
    userId: string,
    appId: string,
    sourceName: string,
    input: PromoteAppEnvironmentInput,
  ): AppEnvironmentPromotionResult {
    const source = this.get(workspaceId, appId, sourceName);
    if (input.applyToRuntime && input.targetKind !== 'production') {
      throw new AgentisError('VALIDATION_FAILED', 'Only a production environment can be applied to the live runtime');
    }

    const now = new Date().toISOString();
    const target = this.find(workspaceId, appId, input.targetName);
    if (target) {
      this.db
        .update(schema.appEnvironments)
        .set({
          kind: input.targetKind,
          manifestJson: source.manifest,
          sourceEnvironmentId: source.id,
          promotedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.appEnvironments.id, target.id))
        .run();
    } else {
      this.db
        .insert(schema.appEnvironments)
        .values({
          id: randomUUID(),
          workspaceId,
          appId,
          name: input.targetName,
          kind: input.targetKind,
          manifestJson: source.manifest,
          sourceEnvironmentId: source.id,
          promotedAt: now,
          createdBy: userId,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    const environment = this.get(workspaceId, appId, input.targetName);
    if (!input.applyToRuntime) return { environment };

    const checksum = new AppPackager(this.db).serialize(source.manifest).checksum;
    const runtimeUpgrade = new AppLifecycle(this.db).upgrade(workspaceId, userId, appId, source.manifest, { installedChecksum: checksum });
    return { environment, runtimeUpgrade };
  }

  private find(workspaceId: string, appId: string, name: string): EnvironmentRow | undefined {
    return this.db
      .select()
      .from(schema.appEnvironments)
      .where(and(
        eq(schema.appEnvironments.workspaceId, workspaceId),
        eq(schema.appEnvironments.appId, appId),
        eq(schema.appEnvironments.name, name),
      ))
      .get();
  }

  private requireApp(workspaceId: string, appId: string): void {
    new AppStore(this.db).get(workspaceId, appId);
  }

  private toEnvironment(row: EnvironmentRow): AppEnvironment {
    return appEnvironmentSchema.parse({
      id: row.id,
      workspaceId: row.workspaceId,
      appId: row.appId,
      name: row.name,
      kind: row.kind,
      manifest: row.manifestJson,
      sourceEnvironmentId: row.sourceEnvironmentId ?? null,
      promotedAt: row.promotedAt ?? null,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }
}



