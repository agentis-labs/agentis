import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  AgentisError,
  appManifestSchema,
  collectionSchemaSchema,
  upsertSurfaceSchema,
  type AppManifest,
  type CollectionField,
  type CollectionMigration,
  type CollectionSchema,
  type ManifestCollection,
  type WorkflowGraph,
} from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { z } from 'zod';
import { AppDatastore } from './appDatastore.js';
import { AppPackager } from './appPackager.js';
import { AppStore } from './appStore.js';
import { AppSurfaceStore } from './appSurfaceStore.js';

export interface AppUpgradeIssue {
  code: 'collection_removed' | 'field_removed' | 'field_retyped' | 'required_field_added' | 'record_invalid';
  collection: string;
  field?: string;
  message: string;
}

export interface AppUpgradePlan {
  appId: string;
  fromVersion: string;
  toVersion: string;
  safe: boolean;
  requiresMigration: boolean;
  migrations: string[];
  blockers: AppUpgradeIssue[];
  changes: string[];
}

export interface AppUpgradeResult {
  appId: string;
  snapshotId: string;
  plan: AppUpgradePlan;
}

export interface AppRollbackResult {
  appId: string;
  snapshotId: string;
  restoredVersion: string;
}

interface SnapshotRecord {
  id: string;
  collection: string;
  data: Record<string, unknown>;
  version: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SnapshotCollection {
  name: string;
  records: SnapshotRecord[];
}

type SnapshotRow = typeof schema.appLifecycleSnapshots.$inferSelect;

export class AppLifecycle {
  constructor(private readonly db: AgentisSqliteDb) {}

  planUpgrade(workspaceId: string, appId: string, nextManifest: AppManifest): AppUpgradePlan {
    const current = new AppPackager(this.db).toManifest(workspaceId, appId);
    const next = appManifestSchema.parse(nextManifest);
    const blockers: AppUpgradeIssue[] = [];
    const changes: string[] = [];
    const currentCollections = byName(current.collections);
    const nextCollections = byName(next.collections);
    const migrations = next.migrations;
    let requiresMigration = false;

    for (const [name, currentCollection] of currentCollections) {
      const nextCollection = nextCollections.get(name);
      const rowCount = this.recordCount(appId, name);
      if (!nextCollection) {
        changes.push(`collection removed: ${name}`);
        if (rowCount > 0) {
          blockers.push({
            code: 'collection_removed',
            collection: name,
            message: `collection '${name}' has ${rowCount} live records and cannot be removed automatically`,
          });
        }
        continue;
      }

      const currentFields = fieldsByKey(currentCollection.schema);
      const nextFields = fieldsByKey(nextCollection.schema);

      for (const [fieldKey, currentField] of currentFields) {
        const nextField = nextFields.get(fieldKey);
        if (!nextField) {
          changes.push(`field removed: ${name}.${fieldKey}`);
          requiresMigration = true;
          if (!hasMigration(migrations, name, ['drop_field', 'rename_field', 'transform'], (migration) => migrationTouchesField(migration, fieldKey))) {
            blockers.push({
              code: 'field_removed',
              collection: name,
              field: fieldKey,
              message: `field '${name}.${fieldKey}' is removed without a declared migration`,
            });
          }
          continue;
        }
        if (currentField.type !== nextField.type) {
          changes.push(`field retyped: ${name}.${fieldKey} ${currentField.type} -> ${nextField.type}`);
          requiresMigration = true;
          if (!hasMigration(migrations, name, ['retype_field', 'transform'], (migration) => migrationTouchesField(migration, fieldKey))) {
            blockers.push({
              code: 'field_retyped',
              collection: name,
              field: fieldKey,
              message: `field '${name}.${fieldKey}' changes type without a declared migration`,
            });
          }
        }
      }

      for (const [fieldKey, nextField] of nextFields) {
        if (currentFields.has(fieldKey)) continue;
        changes.push(`field added: ${name}.${fieldKey}`);
        if (nextField.required && rowCount > 0) {
          requiresMigration = true;
          if (!hasMigration(migrations, name, ['add_field', 'transform'], (migration) => migrationTouchesField(migration, fieldKey))) {
            blockers.push({
              code: 'required_field_added',
              collection: name,
              field: fieldKey,
              message: `required field '${name}.${fieldKey}' is added without a declared default/transform migration`,
            });
          }
        }
      }
    }

    for (const [name] of nextCollections) {
      if (!currentCollections.has(name)) changes.push(`collection added: ${name}`);
    }

    return {
      appId,
      fromVersion: current.identity.version,
      toVersion: next.identity.version,
      safe: blockers.length === 0,
      requiresMigration,
      migrations: migrations.map((migration) => migration.id),
      blockers,
      changes,
    };
  }

  upgrade(workspaceId: string, userId: string, appId: string, nextManifest: AppManifest, options: { installedChecksum?: string | null } = {}): AppUpgradeResult {
    const parsed = appManifestSchema.parse(nextManifest);
    const plan = this.planUpgrade(workspaceId, appId, parsed);
    if (!plan.safe) throw new AgentisError('VALIDATION_FAILED', `upgrade blocked: ${plan.blockers.map((b) => b.message).join('; ')}`);

    return this.db.transaction((tx) => {
      const db = tx as AgentisSqliteDb;
      const lifecycle = new AppLifecycle(db);
      const snapshotId = lifecycle.createSnapshot(workspaceId, appId, 'upgrade');
      lifecycle.applyMigrations(workspaceId, appId, parsed);
      lifecycle.validateRowsAgainstManifest(workspaceId, appId, parsed);
      lifecycle.applyManifestToExisting(workspaceId, userId, appId, parsed, { preserveRecords: true, installedChecksum: options.installedChecksum ?? null });
      return { appId, snapshotId, plan };
    });
  }

  rollback(workspaceId: string, userId: string, appId: string, snapshotId: string): AppRollbackResult {
    return this.db.transaction((tx) => {
      const db = tx as AgentisSqliteDb;
      const lifecycle = new AppLifecycle(db);
      const snapshot = lifecycle.requireSnapshot(workspaceId, appId, snapshotId);
      const manifest = appManifestSchema.parse(snapshot.manifestJson);
      const collections = snapshotCollectionsSchema.parse(snapshot.collectionsJson);
      const installedChecksum = snapshot.installedChecksum ?? new AppPackager(db).serialize(manifest).checksum;
      lifecycle.applyManifestToExisting(workspaceId, userId, appId, manifest, { preserveRecords: false, installedChecksum });
      lifecycle.restoreSnapshotRecords(workspaceId, appId, collections);
      return { appId, snapshotId, restoredVersion: manifest.identity.version };
    });
  }

  private createSnapshot(workspaceId: string, appId: string, reason: string): string {
    const manifest = new AppPackager(this.db).toManifest(workspaceId, appId);
    const installedChecksum = new AppStore(this.db).get(workspaceId, appId).installedChecksum;
    const collections = this.snapshotCollections(workspaceId, appId);
    const id = randomUUID();
    this.db
      .insert(schema.appLifecycleSnapshots)
      .values({
        id,
        workspaceId,
        appId,
        version: manifest.identity.version,
        manifestJson: manifest,
        installedChecksum,
        collectionsJson: collections,
        reason,
        createdAt: new Date().toISOString(),
      })
      .run();
    return id;
  }

  private requireSnapshot(workspaceId: string, appId: string, snapshotId: string): SnapshotRow {
    const row = this.db
      .select()
      .from(schema.appLifecycleSnapshots)
      .where(and(eq(schema.appLifecycleSnapshots.workspaceId, workspaceId), eq(schema.appLifecycleSnapshots.appId, appId), eq(schema.appLifecycleSnapshots.id, snapshotId)))
      .get();
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `snapshot not found: ${snapshotId}`);
    return row;
  }

  private snapshotCollections(workspaceId: string, appId: string): SnapshotCollection[] {
    const collections = new AppDatastore(this.db).listCollections(workspaceId, appId);
    return collections.map((collection) => {
      const rows = this.db
        .select()
        .from(schema.appRecords)
        .where(and(eq(schema.appRecords.workspaceId, workspaceId), eq(schema.appRecords.appId, appId), eq(schema.appRecords.collectionId, collection.id)))
        .all();
      return {
        name: collection.name,
        records: rows.map((row) => ({
          id: row.id,
          collection: collection.name,
          data: (row.dataJson ?? {}) as Record<string, unknown>,
          version: row.version,
          createdBy: row.createdBy,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })),
      };
    });
  }

  private applyMigrations(workspaceId: string, appId: string, manifest: AppManifest): void {
    for (const migration of manifest.migrations) {
      const records = this.recordsForCollection(workspaceId, appId, migration.collection);
      for (const record of records) {
        const next = applyCollectionMigration(record.data, migration);
        this.db
          .update(schema.appRecords)
          .set({ dataJson: next, version: record.version + 1, updatedAt: new Date().toISOString() })
          .where(eq(schema.appRecords.id, record.id))
          .run();
      }
    }
  }

  private validateRowsAgainstManifest(workspaceId: string, appId: string, manifest: AppManifest): void {
    for (const collection of manifest.collections) {
      const validator = recordValidator(collection.schema);
      for (const record of this.recordsForCollection(workspaceId, appId, collection.name)) {
        const parsed = validator.safeParse(record.data);
        if (!parsed.success) {
          throw new AgentisError('VALIDATION_FAILED', `record ${record.id} does not satisfy next schema for '${collection.name}'`);
        }
      }
    }
  }

  private applyManifestToExisting(workspaceId: string, userId: string, appId: string, manifest: AppManifest, options: { preserveRecords: boolean; installedChecksum?: string | null }): void {
    const apps = new AppStore(this.db);
    apps.get(workspaceId, appId);
    apps.update(workspaceId, appId, {
      name: manifest.identity.name,
      version: manifest.identity.version,
      icon: manifest.identity.icon ?? null,
      entrySurfaceId: manifest.surfaces[0]?.name ?? null,
      policy: manifest.policy,
      manifest: manifest.identity,
      source: manifest.source ?? null,
      ...(options.installedChecksum !== undefined ? { installedChecksum: options.installedChecksum } : {}),
    });

    this.db.delete(schema.workflows).where(and(eq(schema.workflows.workspaceId, workspaceId), eq(schema.workflows.appId, appId))).run();
    for (const workflow of manifest.workflows) {
      const now = new Date().toISOString();
      this.db
        .insert(schema.workflows)
        .values({
          id: randomUUID(),
          workspaceId,
          userId,
          appId,
          title: workflow.title,
          description: workflow.description ?? null,
          graph: workflow.graph as WorkflowGraph,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    const datastore = new AppDatastore(this.db);
    const existingCollections = datastore.listCollections(workspaceId, appId);
    const nextNames = new Set(manifest.collections.map((collection) => collection.name));
    if (!options.preserveRecords) {
      this.db.delete(schema.appRecords).where(and(eq(schema.appRecords.workspaceId, workspaceId), eq(schema.appRecords.appId, appId))).run();
      this.db.delete(schema.appCollections).where(and(eq(schema.appCollections.workspaceId, workspaceId), eq(schema.appCollections.appId, appId))).run();
    } else {
      for (const existing of existingCollections) {
        if (!nextNames.has(existing.name)) {
          this.db.delete(schema.appCollections).where(eq(schema.appCollections.id, existing.id)).run();
        }
      }
    }
    for (const collection of manifest.collections) {
      datastore.defineCollection(workspaceId, appId, { name: collection.name, schema: collectionSchemaSchema.parse(collection.schema) });
    }

    this.db.delete(schema.appSurfaces).where(and(eq(schema.appSurfaces.workspaceId, workspaceId), eq(schema.appSurfaces.appId, appId))).run();
    const surfaces = new AppSurfaceStore({ db: this.db });
    for (const surface of manifest.surfaces) {
      surfaces.upsert(workspaceId, appId, upsertSurfaceSchema.parse({ name: surface.name, kind: surface.kind, view: surface.view, actions: surface.actions, shareable: surface.shareable }));
    }
  }

  private restoreSnapshotRecords(workspaceId: string, appId: string, collections: SnapshotCollection[]): void {
    const datastore = new AppDatastore(this.db);
    const collectionIds = new Map(datastore.listCollections(workspaceId, appId).map((collection) => [collection.name, collection.id]));
    for (const collection of collections) {
      const collectionId = collectionIds.get(collection.name);
      if (!collectionId) continue;
      for (const record of collection.records) {
        this.db
          .insert(schema.appRecords)
          .values({
            id: record.id,
            collectionId,
            appId,
            workspaceId,
            dataJson: record.data,
            version: record.version,
            createdBy: record.createdBy,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
          })
          .run();
      }
    }
  }

  private recordCount(appId: string, collection: string): number {
    const row = this.db
      .select({ id: schema.appCollections.id })
      .from(schema.appCollections)
      .where(and(eq(schema.appCollections.appId, appId), eq(schema.appCollections.name, collection)))
      .get();
    if (!row) return 0;
    return this.db.select({ id: schema.appRecords.id }).from(schema.appRecords).where(eq(schema.appRecords.collectionId, row.id)).all().length;
  }

  private recordsForCollection(workspaceId: string, appId: string, collection: string): SnapshotRecord[] {
    const row = this.db
      .select({ id: schema.appCollections.id })
      .from(schema.appCollections)
      .where(and(eq(schema.appCollections.workspaceId, workspaceId), eq(schema.appCollections.appId, appId), eq(schema.appCollections.name, collection)))
      .get();
    if (!row) return [];
    return this.db
      .select()
      .from(schema.appRecords)
      .where(and(eq(schema.appRecords.workspaceId, workspaceId), eq(schema.appRecords.appId, appId), eq(schema.appRecords.collectionId, row.id)))
      .all()
      .map((record) => ({
        id: record.id,
        collection,
        data: (record.dataJson ?? {}) as Record<string, unknown>,
        version: record.version,
        createdBy: record.createdBy,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      }));
  }
}

const snapshotCollectionsSchema: z.ZodType<SnapshotCollection[]> = z.array(
  z.object({
    name: z.string(),
    records: z.array(
      z.object({
        id: z.string(),
        collection: z.string(),
        data: z.record(z.unknown()),
        version: z.number(),
        createdBy: z.string().nullable(),
        createdAt: z.string(),
        updatedAt: z.string(),
      }),
    ),
  }),
);

function byName(collections: ManifestCollection[]): Map<string, ManifestCollection> {
  return new Map(collections.map((collection) => [collection.name, collection]));
}

function fieldsByKey(collectionSchema: CollectionSchema): Map<string, CollectionField> {
  return new Map(collectionSchema.fields.map((field) => [field.key, field]));
}

function hasMigration(
  migrations: CollectionMigration[],
  collection: string,
  ops: CollectionMigration['op'][],
  predicate: (migration: CollectionMigration) => boolean,
): boolean {
  return migrations.some((migration) => migration.collection === collection && ops.includes(migration.op) && predicate(migration));
}

function migrationTouchesField(migration: CollectionMigration, field: string): boolean {
  const spec = migration.spec;
  const keys = [spec.field, spec.key, spec.from, spec.to];
  const nestedField = typeof spec.field === 'object' && spec.field !== null ? (spec.field as Record<string, unknown>).key : undefined;
  return [...keys, nestedField].some((value) => value === field);
}

function applyCollectionMigration(record: Record<string, unknown>, migration: CollectionMigration): Record<string, unknown> {
  const spec = migration.spec;
  const next = { ...record };
  switch (migration.op) {
    case 'add_field': {
      const field = fieldKey(spec);
      if (!field) throw new AgentisError('VALIDATION_FAILED', `migration ${migration.id} missing field`);
      if (!(field in next)) next[field] = Object.prototype.hasOwnProperty.call(spec, 'default') ? spec.default : null;
      return next;
    }
    case 'drop_field': {
      const field = fieldKey(spec);
      if (!field) throw new AgentisError('VALIDATION_FAILED', `migration ${migration.id} missing field`);
      delete next[field];
      return next;
    }
    case 'rename_field': {
      const from = typeof spec.from === 'string' ? spec.from : undefined;
      const to = typeof spec.to === 'string' ? spec.to : undefined;
      if (!from || !to) throw new AgentisError('VALIDATION_FAILED', `migration ${migration.id} requires from/to`);
      if (from in next) {
        next[to] = next[from];
        delete next[from];
      }
      return next;
    }
    case 'retype_field': {
      const field = fieldKey(spec);
      const to = typeof spec.to === 'string' ? spec.to : spec.type;
      if (!field || typeof to !== 'string') throw new AgentisError('VALIDATION_FAILED', `migration ${migration.id} requires field/to`);
      next[field] = coerceValue(next[field], to);
      return next;
    }
    case 'transform': {
      const set = spec.set && typeof spec.set === 'object' && !Array.isArray(spec.set) ? spec.set as Record<string, unknown> : {};
      for (const [key, value] of Object.entries(set)) next[key] = value;
      const unset = Array.isArray(spec.unset) ? spec.unset.filter((value): value is string => typeof value === 'string') : [];
      for (const key of unset) delete next[key];
      return next;
    }
    default:
      return next;
  }
}

function fieldKey(spec: Record<string, unknown>): string | undefined {
  if (typeof spec.field === 'string') return spec.field;
  if (typeof spec.key === 'string') return spec.key;
  if (spec.field && typeof spec.field === 'object' && !Array.isArray(spec.field)) {
    const key = (spec.field as Record<string, unknown>).key;
    return typeof key === 'string' ? key : undefined;
  }
  return undefined;
}

function coerceValue(value: unknown, type: string): unknown {
  if (value == null) return value;
  if (type === 'string' || type === 'date') return String(value);
  if (type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new AgentisError('VALIDATION_FAILED', `cannot coerce '${String(value)}' to number`);
    return n;
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    return ['true', '1', 'yes'].includes(String(value).toLowerCase());
  }
  return value;
}

function recordValidator(collectionSchema: CollectionSchema): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of collectionSchema.fields) {
    let base: z.ZodTypeAny;
    switch (field.type) {
      case 'string':
      case 'date':
        base = z.string();
        break;
      case 'number':
        base = z.number();
        break;
      case 'boolean':
        base = z.boolean();
        break;
      default:
        base = z.unknown();
    }
    shape[field.key] = field.required ? base : base.optional();
  }
  return z.object(shape).passthrough() as unknown as z.ZodType<Record<string, unknown>>;
}



