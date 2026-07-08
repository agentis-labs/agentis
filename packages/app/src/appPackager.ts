/**
 * AppManifestService / AppPackager — the projection between the three isomorphic
 * representations of an Agentic App (AGENTIC-SYSTEMS-ARCHITECTURE §2, §17):
 *
 *   DB rows  ──toManifest──►  AppManifest (IR)  ──serialize──►  .agentisapp
 *   DB rows  ◄─fromManifest─  AppManifest (IR)  ◄─deserialize─  .agentisapp
 *
 * `toManifest`/`fromManifest` are the canonical projection (DoD gate 1). They
 * must round-trip: `rows → manifest → rows → manifest` is identity modulo
 * server-assigned ids/slug. `serialize`/`deserialize` add the integrity envelope
 * (sha256 over the canonical manifest); deserialize rejects tampering.
 *
 * Collections project SCHEMA only; rows never travel (empty-with-schema install,
 * §14.4). `export`/`import` are thin wrappers kept for the existing routes.
 */

import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  AgentisError,
  appManifestSchema,
  appIdentitySchema,
  appInstallPreviewSchema,
  canonicalizeManifest,
  collectionSchemaSchema,
  upsertSurfaceSchema,
  surfaceActionSchema,
  type AppManifest,
  type AppManifestEnvelope,
  type AppInstallPreview,
  type ViewNode,
  type WorkflowGraph,
} from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { AppStore } from './appStore.js';
import { AppDatastore } from './appDatastore.js';
import { AppSurfaceStore } from './appSurfaceStore.js';

function checksum(manifest: AppManifest): string {
  return createHash('sha256').update(canonicalizeManifest(manifest)).digest('hex');
}

function permissionSummary(manifest: AppManifest): string[] {
  const permissions = new Set<string>();
  for (const collection of manifest.collections) permissions.add(`data:${collection.name}`);
  for (const plugin of new Set([...manifest.requiredPlugins, ...manifest.identity.requiredPlugins])) {
    permissions.add(`plugin:${plugin}`);
  }
  if (manifest.policy.customCode === 'allowed' || manifest.surfaces.some((surface) => hasCustomView(surface.view ?? null))) {
    permissions.add('custom-code');
  }
  if (manifest.policy.shareable || manifest.policy.audience.includes('public') || manifest.surfaces.some((surface) => surface.shareable || surface.kind === 'public')) {
    permissions.add('public-share');
  }
  for (const grant of manifest.policy.grants) {
    const scopes = grant.scopes.length > 0 ? `:${grant.scopes.join(',')}` : '';
    permissions.add(`grant:${grant.source ?? 'native'}:${grant.capability}${scopes}`);
  }
  for (const capability of manifest.capabilities) {
    permissions.add(`declares-capability:${capability.name}:${capability.target}`);
  }
  for (const surface of manifest.surfaces) {
    for (const action of surface.actions) {
      if (action.kind === 'data') permissions.add(`data-action:${action.target}`);
      if (action.kind === 'workflow') permissions.add(`workflow:${action.target}`);
      if (action.kind === 'tool') permissions.add(`tool:${action.target}`);
      if (action.kind === 'capability') permissions.add(`capability:${action.target}`);
    }
  }
  // Provenance gate (masterplan 0.4): an imported bundle whose workflows carry
  // executable payloads runs that code on the INSTALLER's host on first run. The
  // through install, so this only gates third-party bundles.
  for (const permission of executablePayloadPermissions(manifest)) permissions.add(permission);
  return [...permissions].sort((a, b) => a.localeCompare(b));
}

/** Permissions for workflow nodes that execute code / drive a browser on the host. */
function executablePayloadPermissions(manifest: AppManifest): string[] {
  const out = new Set<string>();
  for (const workflow of manifest.workflows) {
    const graph = workflow.graph as { nodes?: unknown } | null | undefined;
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    for (const node of nodes) {
      const config = (node as { config?: { kind?: string; language?: string } } | null)?.config;
      if (!config) continue;
      if (config.kind === 'code') out.add(`executes-code:${config.language ?? 'javascript'}`);
      else if (config.kind === 'browser') out.add('controls-browser');
    }
  }
  return [...out];
}

function hasCustomView(node: ViewNode | null): boolean {
  if (!node) return false;
  if (node.type === 'CustomView') return true;
  if ('children' in node) return node.children.some(hasCustomView);
  if (node.type === 'List') return hasCustomView(node.item);
  return false;
}

export class AppPackager {
  private readonly apps: AppStore;
  private readonly data: AppDatastore;
  private readonly surfaces: AppSurfaceStore;
  constructor(private readonly db: AgentisSqliteDb) {
    this.apps = new AppStore(db);
    this.data = new AppDatastore(db);
    this.surfaces = new AppSurfaceStore({ db });
  }

  /** rows → canonical AppManifest IR. */
  toManifest(workspaceId: string, appId: string): AppManifest {
    const app = this.apps.get(workspaceId, appId);
    const surfaces = this.surfaces.list(workspaceId, appId).map((s) => ({
      name: s.name,
      kind: s.kind,
      view: s.view,
      actions: s.actions.map((a) => surfaceActionSchema.parse(a)),
      shareable: s.shareable,
    }));
    const collections = this.data
      .listCollections(workspaceId, appId)
      .map((col) => ({ name: col.name, schema: col.schema, seed: [] as Record<string, unknown>[] }));
    const workflows = this.db
      .select({ title: schema.workflows.title, description: schema.workflows.description, graph: schema.workflows.graph })
      .from(schema.workflows)
      .where(and(eq(schema.workflows.workspaceId, workspaceId), eq(schema.workflows.appId, appId)))
      .all()
      .map((w) => ({ title: w.title, description: w.description ?? null, graph: w.graph }));

    return appManifestSchema.parse({
      manifestVersion: 1,
      identity: appIdentitySchema.parse({
        ...app.manifest,
        slug: app.slug,
        name: app.name,
        version: app.version,
        icon: app.icon,
        entrySurfaceId: app.entrySurfaceId,
      }),
      policy: app.policy,
      workflows,
      surfaces,
      collections,
      source: app.source,
    });
  }

  /** canonical AppManifest IR → rows (creates a fresh App). Collections come back EMPTY. */
  preview(envelope: AppManifestEnvelope): AppInstallPreview {
    const manifest = this.deserialize(envelope);
    const warnings: string[] = [];
    const seedRows = manifest.collections.reduce((count, collection) => count + (collection.seed?.length ?? 0), 0);
    if (seedRows > 0) warnings.push('Seed rows are not installed; only collection schemas travel in V1.');
    if (manifest.migrations.length > 0) warnings.push('Migrations are declared but fresh installs do not apply upgrade migrations.');
    if (manifest.policy.customCode === 'allowed') warnings.push('This app enables CustomView code; review before installing into shared workspaces.');
    if (manifest.requiredPlugins.length > 0) warnings.push('Required plugins must already be available in this Agentis instance.');

    return appInstallPreviewSchema.parse({
      format: envelope.format,
      formatVersion: envelope.formatVersion,
      checksum: envelope.checksum,
      exportedAt: envelope.exportedAt,
      identity: manifest.identity,
      source: manifest.source ?? null,
      counts: {
        workflows: manifest.workflows.length,
        surfaces: manifest.surfaces.length,
        collections: manifest.collections.length,
        agents: manifest.agents.length,
        capabilities: manifest.capabilities.length,
        dependencies: manifest.dependencies.length,
        migrations: manifest.migrations.length,
      },
      facets: {
        workflows: manifest.workflows.map((workflow) => workflow.title),
        surfaces: manifest.surfaces.map((surface) => surface.name),
        collections: manifest.collections.map((collection) => collection.name),
      },
      requiredPlugins: manifest.requiredPlugins,
      permissions: permissionSummary(manifest),
      scanWarnings: [],
      warnings,
    });
  }

  fromManifest(workspaceId: string, userId: string, manifest: AppManifest): { appId: string } {
    const parsed = appManifestSchema.parse(manifest);
    return this.db.transaction((tx) => this.createFromManifestRows(tx as AgentisSqliteDb, workspaceId, userId, parsed));
  }

  private createFromManifestRows(db: AgentisSqliteDb, workspaceId: string, userId: string, parsed: AppManifest): { appId: string } {
    const apps = new AppStore(db);
    const data = new AppDatastore(db);
    const surfaces = new AppSurfaceStore({ db });
    const app = apps.create(workspaceId, userId, {
      name: parsed.identity.name,
      description: '',
      ...(parsed.identity.icon ? { icon: parsed.identity.icon } : {}),
    });
    // Carry version + policy onto the new app.
    apps.update(workspaceId, app.id, {
      version: parsed.identity.version,
      policy: parsed.policy,
      source: parsed.source ?? null,
      installedChecksum: checksum(parsed),
    });

    for (const wf of parsed.workflows) {
      const id = randomUUID();
      const now = new Date().toISOString();
      db
        .insert(schema.workflows)
        .values({ id, workspaceId, userId, appId: app.id, title: wf.title, description: wf.description ?? null, graph: wf.graph as WorkflowGraph, createdAt: now, updatedAt: now })
        .run();
    }
    for (const col of parsed.collections) {
      data.defineCollection(workspaceId, app.id, { name: col.name, schema: collectionSchemaSchema.parse(col.schema) });
    }
    for (const s of parsed.surfaces) {
      surfaces.upsert(workspaceId, app.id, upsertSurfaceSchema.parse({ name: s.name, kind: s.kind, view: s.view, actions: s.actions, shareable: s.shareable }));
    }
    if (parsed.surfaces[0]) {
      apps.update(workspaceId, app.id, { entrySurfaceId: parsed.surfaces[0].name });
    }
    return { appId: app.id };
  }

  // ── Serialization envelope (.agentisapp) ────────────────────

  serialize(manifest: AppManifest): AppManifestEnvelope {
    const parsed = appManifestSchema.parse(manifest);
    return { format: '.agentisapp', formatVersion: 1, manifest: parsed, checksum: checksum(parsed), exportedAt: new Date().toISOString() };
  }

  deserialize(envelope: AppManifestEnvelope): AppManifest {
    if (envelope.format !== '.agentisapp') throw new AgentisError('VALIDATION_FAILED', 'not an .agentisapp envelope');
    const manifest = appManifestSchema.parse(envelope.manifest);
    if (checksum(manifest) !== envelope.checksum) {
      throw new AgentisError('VALIDATION_FAILED', 'checksum mismatch — package is corrupt or tampered');
    }
    return manifest;
  }

  // ── Route-facing wrappers ───────────────────────────────────

  export(workspaceId: string, appId: string): AppManifestEnvelope {
    return this.serialize(this.toManifest(workspaceId, appId));
  }

  import(workspaceId: string, userId: string, envelope: AppManifestEnvelope): { appId: string } {
    return this.fromManifest(workspaceId, userId, this.deserialize(envelope));
  }
}



