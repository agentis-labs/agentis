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
import { and, eq, inArray } from 'drizzle-orm';
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
  type ManifestAgent,
  type BundleFidelity,
  type ViewNode,
  type WorkflowGraph,
} from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { AppStore } from './appStore.js';
import { AppDatastore } from './appDatastore.js';
import { AppSurfaceStore } from './appSurfaceStore.js';
import type { BrainReader, BrainWriter } from './brainPort.js';

/** Options controlling how much learned intelligence an App export carries. */
export interface AppExportOptions {
  /** `full` carries brains + collection rows; `shareable` (default) carries neither. */
  fidelity?: BundleFidelity;
  /** Brain reader (api-supplied). Absent ⇒ no brains travel regardless of fidelity. */
  brain?: BrainReader;
  includeAppBrain?: boolean;
  includeAgentBrains?: boolean;
  includeCollectionData?: boolean;
  /** Per-collection row cap. */
  collectionRowCap?: number;
  /** Collected non-fatal notes (e.g. truncated collections) appended here. */
  warnings?: string[];
}

/** Options controlling how an App install rehydrates intelligence + team. */
export interface AppImportOptions {
  brain?: BrainWriter;
  includeAppBrain?: boolean;
  includeAgentBrains?: boolean;
  includeCollectionData?: boolean;
  /** Existing workspace agents by name → id, so app agents relink instead of duplicating. */
  agentNameToId?: Map<string, string>;
  warnings?: string[];
}

// Hash the manifest AS GIVEN (raw object), never a schema-parsed projection.
// canonicalizeManifest is a pure deep key-sort, so it is well-defined on the
// raw manifest — and hashing raw is what makes the checksum survive schema
// evolution (see deserialize).
function checksum(manifest: unknown): string {
  return createHash('sha256').update(canonicalizeManifest(manifest as AppManifest)).digest('hex');
}

/**
 * The transported envelope with the manifest kept RAW (unknown). Import paths
 * must not schema-parse the manifest before verifying the checksum — parsing
 * strips/defaults fields and changes the canonical form, so an authentic but
 * older export would fail verification. Callers pass this shape (or a fully
 * typed AppManifestEnvelope, which is assignable) into deserialize.
 */
export interface RawAppEnvelope {
  format?: unknown;
  formatVersion?: unknown;
  manifest: unknown;
  checksum?: unknown;
  exportedAt?: unknown;
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
  if (manifest.surfaces.some((surface) => surface.shareable || surface.kind === 'public')) {
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

  /** rows → canonical AppManifest IR. `opts.fidelity==='full'` carries brains + rows. */
  toManifest(workspaceId: string, appId: string, opts: AppExportOptions = {}): AppManifest {
    const app = this.apps.get(workspaceId, appId);
    const full = opts.fidelity === 'full';
    const withData = full && (opts.includeCollectionData ?? true);
    const withAppBrain = full && (opts.includeAppBrain ?? true) && !!opts.brain;
    const withAgentBrains = full && (opts.includeAgentBrains ?? true) && !!opts.brain;
    const cap = opts.collectionRowCap ?? 5000;

    const surfaces = this.surfaces.list(workspaceId, appId).map((s) => ({
      name: s.name,
      kind: s.kind,
      view: s.view,
      actions: s.actions.map((a) => surfaceActionSchema.parse(a)),
      shareable: s.shareable,
    }));
    const collections = this.data.listCollections(workspaceId, appId).map((col) => {
      let seed: Record<string, unknown>[] = [];
      if (withData) {
        const dump = this.data.exportRows(workspaceId, appId, col.name, cap);
        seed = dump.rows;
        if (dump.truncated) opts.warnings?.push(`Collection "${col.name}" exceeded ${cap} rows; only the first ${cap} were exported.`);
      }
      return { name: col.name, schema: col.schema, seed };
    });
    const workflows = this.db
      .select({ title: schema.workflows.title, description: schema.workflows.description, graph: schema.workflows.graph })
      .from(schema.workflows)
      .where(and(eq(schema.workflows.workspaceId, workspaceId), eq(schema.workflows.appId, appId)))
      .all()
      .map((w) => ({ title: w.title, description: w.description ?? null, graph: w.graph }));

    // Team (Team facet): the owning agent + seated members travel WITH the App so
    // it installs self-contained. Definitions always travel; brains only in `full`.
    const agents = this.#exportAgents(workspaceId, appId, app.ownerAgentId, withAgentBrains ? opts.brain : undefined);

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
      agents,
      ...(withAppBrain ? { brain: { atoms: opts.brain!.exportScope(workspaceId, appId) } } : {}),
      source: app.source,
    });
  }

  /** The App's cast (owner + members) as portable manifest agents, name-sorted. */
  #exportAgents(workspaceId: string, appId: string, ownerAgentId: string | null, brain: BrainReader | undefined): ManifestAgent[] {
    const members = this.apps.listMembers(workspaceId, appId);
    const roleByAgent = new Map(members.map((m) => [m.agentId, m.role]));
    const ids = new Set<string>(members.map((m) => m.agentId));
    if (ownerAgentId) ids.add(ownerAgentId);
    if (ids.size === 0) return [];
    const rows = this.db
      .select()
      .from(schema.agents)
      .where(and(eq(schema.agents.workspaceId, workspaceId), inArray(schema.agents.id, [...ids])))
      .all();
    return rows
      .map((a) => {
        const memberRole = roleByAgent.get(a.id);
        const agent: ManifestAgent = {
          name: a.name,
          role: memberRole === 'operator' ? 'operator' : 'worker',
          adapterType: a.adapterType,
          instructions: a.instructions ?? null,
          capabilityTags: stringArray(a.capabilityTags),
          owner: a.id === ownerAgentId,
          ...(memberRole ? { memberRole } : {}),
          config: objectRecord(a.config),
          avatarGlyph: a.avatarGlyph ?? null,
          runtimeModel: a.runtimeModel ?? null,
          ...(brain ? { brain: { atoms: brain.exportScope(workspaceId, a.id) } } : {}),
        };
        return agent;
      })
      .sort((x, y) => x.name.localeCompare(y.name));
  }

  /** canonical AppManifest IR → rows (creates a fresh App). Collections come back EMPTY. */
  preview(envelope: RawAppEnvelope): AppInstallPreview {
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

  fromManifest(workspaceId: string, userId: string, manifest: AppManifest, opts: AppImportOptions = {}): { appId: string } {
    const parsed = appManifestSchema.parse(manifest);
    return this.db.transaction((tx) => this.createFromManifestRows(tx as AgentisSqliteDb, workspaceId, userId, parsed, opts));
  }

  private createFromManifestRows(db: AgentisSqliteDb, workspaceId: string, userId: string, parsed: AppManifest, opts: AppImportOptions): { appId: string } {
    const apps = new AppStore(db);
    const data = new AppDatastore(db);
    const surfaces = new AppSurfaceStore({ db });
    const withData = opts.includeCollectionData ?? true;
    const withAgentBrains = (opts.includeAgentBrains ?? true) && !!opts.brain;
    const withAppBrain = (opts.includeAppBrain ?? true) && !!opts.brain;
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
      if (withData && col.seed && col.seed.length > 0) {
        const res = data.insertMany(workspaceId, app.id, col.name, col.seed, userId);
        if (res.failed.length > 0) {
          opts.warnings?.push(`Collection "${col.name}": ${res.failed.length} of ${col.seed.length} row(s) failed to import.`);
        }
      }
    }
    for (const s of parsed.surfaces) {
      surfaces.upsert(workspaceId, app.id, upsertSurfaceSchema.parse({ name: s.name, kind: s.kind, view: s.view, actions: s.actions, shareable: s.shareable }));
    }
    if (parsed.surfaces[0]) {
      apps.update(workspaceId, app.id, { entrySurfaceId: parsed.surfaces[0].name });
    }

    // Team (Team facet): seat the App's cast and relink its owner. Resolve each
    // agent by name against already-installed workspace agents (nameMap) so a
    // whole-workspace bundle does not duplicate them; create a minimal agent only
    // for a standalone App import. Owner relink touches ONLY apps.ownerAgentId —
    // it must never clear the agent's reportsTo/spaceId (that org-chart detach is
    // the staffApp side effect, which install never runs).
    for (const magent of parsed.agents) {
      let agentId = opts.agentNameToId?.get(magent.name) ?? this.#findAgentByName(db, workspaceId, magent.name);
      if (!agentId) {
        agentId = this.#createAgent(db, workspaceId, userId, magent);
        opts.agentNameToId?.set(magent.name, agentId);
      }
      apps.addMember(workspaceId, app.id, agentId, magent.memberRole ?? (magent.owner ? 'operator' : 'worker'));
      if (magent.owner) apps.update(workspaceId, app.id, { ownerAgentId: agentId });
      if (withAgentBrains && magent.brain && magent.brain.atoms.length > 0) {
        opts.brain!.importScope(workspaceId, agentId, magent.brain.atoms, 'agent');
      }
    }

    // App-scoped Brain memory (scope_id = appId).
    if (withAppBrain && parsed.brain && parsed.brain.atoms.length > 0) {
      opts.brain!.importScope(workspaceId, app.id, parsed.brain.atoms, 'app');
    }

    return { appId: app.id };
  }

  #findAgentByName(db: AgentisSqliteDb, workspaceId: string, name: string): string | null {
    const row = db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(and(eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.name, name)))
      .get();
    return row?.id ?? null;
  }

  /** Create a minimal agent row for a standalone App import (no org-chart wiring). */
  #createAgent(db: AgentisSqliteDb, workspaceId: string, userId: string, magent: ManifestAgent): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    db
      .insert(schema.agents)
      .values({
        id,
        workspaceId,
        userId,
        name: magent.name,
        adapterType: magent.adapterType ?? 'http',
        capabilityTags: magent.capabilityTags,
        config: magent.config,
        instructions: magent.instructions ?? null,
        avatarGlyph: magent.avatarGlyph ?? null,
        runtimeModel: magent.runtimeModel ?? null,
        role: magent.memberRole ?? magent.role,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return id;
  }

  // ── Serialization envelope (.agentisapp) ────────────────────

  serialize(manifest: AppManifest): AppManifestEnvelope {
    const parsed = appManifestSchema.parse(manifest);
    return { format: '.agentisapp', formatVersion: 1, manifest: parsed, checksum: checksum(parsed), exportedAt: new Date().toISOString() };
  }

  deserialize(envelope: RawAppEnvelope): AppManifest {
    if (envelope.format !== '.agentisapp') throw new AgentisError('VALIDATION_FAILED', 'not an .agentisapp envelope');
    // Verify the checksum against the RAW transported manifest — the same bytes
    // `serialize` hashed. Parsing first and hashing the parsed projection makes
    // the checksum brittle to schema evolution: when a later build drops or
    // defaults a manifest field (e.g. policy.audience/shareable), re-parsing an
    // OLD but authentic export changes its canonical form and the checksum
    // "mismatches" even though nothing was tampered with. Hash raw, then parse.
    if (checksum(envelope.manifest) !== envelope.checksum) {
      throw new AgentisError('VALIDATION_FAILED', 'checksum mismatch — package is corrupt or tampered');
    }
    return appManifestSchema.parse(envelope.manifest);
  }

  // ── Route-facing wrappers ───────────────────────────────────

  export(workspaceId: string, appId: string, opts: AppExportOptions = {}): AppManifestEnvelope {
    return this.serialize(this.toManifest(workspaceId, appId, opts));
  }

  import(workspaceId: string, userId: string, envelope: RawAppEnvelope, opts: AppImportOptions = {}): { appId: string } {
    return this.fromManifest(workspaceId, userId, this.deserialize(envelope), opts);
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}



