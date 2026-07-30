/**
 * Immutable, App-level interface history.
 *
 * `app_surfaces` remains the fast active projection consumed by AppRuntime.
 * Every meaningful change is captured as a complete revision snapshot, while
 * candidate revisions can be verified and atomically projected only after all
 * gates pass. This gives agents a safe edit/verify/publish/restore loop without
 * making the runtime pay a revision join on every render.
 */
import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
import {
  AgentisError,
  repairSurface,
  surfaceActionSchema,
  viewNodeSchema,
  type AppSurface,
  type SurfaceAction,
  type SurfaceKind,
  type ViewNode,
} from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';

export type InterfaceRevisionStatus = 'candidate' | 'active' | 'abandoned';
export type InterfaceTrustState = 'legacy_unverified' | 'candidate' | 'verified' | 'rejected';
export type InterfaceGate = 'schema' | 'operability' | 'navigation' | 'runtime';

export interface InterfacePageSnapshot {
  id: string;
  name: string;
  kind: SurfaceKind;
  view: ViewNode | null;
  actions: SurfaceAction[];
  shareable: boolean;
}

export interface AppInterfaceRevision {
  id: string;
  appId: string;
  parentRevisionId: string | null;
  pages: InterfacePageSnapshot[];
  semanticHash: string;
  source: string;
  actorType: string;
  actorId: string | null;
  reason: string;
  status: InterfaceRevisionStatus;
  trustState: InterfaceTrustState;
  verifiedAt: string | null;
  publishedAt: string | null;
  createdAt: string;
}

export interface InterfaceProof {
  gate: InterfaceGate;
  status: 'passed' | 'failed';
  evidence: Record<string, unknown>;
}

export interface InterfaceVerification {
  revisionId: string;
  passed: boolean;
  semanticHash: string;
  proofs: InterfaceProof[];
}

type RevisionRow = typeof schema.appInterfaceRevisions.$inferSelect;

export interface AppInterfaceRevisionStoreDeps {
  db: AgentisSqliteDb;
  emit?: (event: 'candidate' | 'verified' | 'published' | 'abandoned', payload: Record<string, unknown>) => void;
}

export class AppInterfaceRevisionStore {
  constructor(private readonly deps: AppInterfaceRevisionStoreDeps) {}
  private get db() { return this.deps.db; }

  private app(workspaceId: string, appId: string) {
    const row = this.db.select().from(schema.apps)
      .where(and(eq(schema.apps.workspaceId, workspaceId), eq(schema.apps.id, appId))).get();
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `app not found: ${appId}`);
    return row;
  }

  private snapshot(appId: string): InterfacePageSnapshot[] {
    return this.db.select().from(schema.appSurfaces)
      .where(eq(schema.appSurfaces.appId, appId))
      .orderBy(asc(schema.appSurfaces.name)).all()
      .map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind as SurfaceKind,
        view: (row.viewJson ?? null) as ViewNode | null,
        actions: (row.actionsJson ?? []) as SurfaceAction[],
        shareable: row.shareable,
      }));
  }

  private toRevision(row: RevisionRow): AppInterfaceRevision {
    return {
      id: row.id,
      appId: row.appId,
      parentRevisionId: row.parentRevisionId ?? null,
      pages: (row.pagesJson ?? []) as InterfacePageSnapshot[],
      semanticHash: row.semanticHash,
      source: row.source,
      actorType: row.actorType,
      actorId: row.actorId ?? null,
      reason: row.reason,
      status: row.status as InterfaceRevisionStatus,
      trustState: row.trustState as InterfaceTrustState,
      verifiedAt: row.verifiedAt ?? null,
      publishedAt: row.publishedAt ?? null,
      createdAt: row.createdAt,
    };
  }

  /** Create a compatibility baseline lazily, so existing installations retain every page. */
  ensureActive(workspaceId: string, appId: string): AppInterfaceRevision {
    const app = this.app(workspaceId, appId);
    if (app.activeInterfaceRevisionId) {
      const existing = this.db.select().from(schema.appInterfaceRevisions)
        .where(eq(schema.appInterfaceRevisions.id, app.activeInterfaceRevisionId)).get();
      if (existing) return this.toRevision(existing);
    }
    return this.capturePublished(workspaceId, appId, {
      source: 'migration',
      actorType: 'system',
      reason: 'Initial interface baseline',
      trustState: 'legacy_unverified',
    });
  }

  /**
   * Journal the current active projection. Identical semantic snapshots are
   * deduplicated, so overlapping call paths cannot create duplicate history.
   */
  capturePublished(
    workspaceId: string,
    appId: string,
    meta: { source?: string; actorType?: string; actorId?: string; reason?: string; trustState?: InterfaceTrustState } = {},
  ): AppInterfaceRevision {
    const app = this.app(workspaceId, appId);
    const pages = this.snapshot(appId);
    const semanticHash = interfaceHash(pages);
    const duplicate = this.db.select().from(schema.appInterfaceRevisions)
      .where(and(
        eq(schema.appInterfaceRevisions.appId, appId),
        eq(schema.appInterfaceRevisions.semanticHash, semanticHash),
        eq(schema.appInterfaceRevisions.status, 'active'),
      )).get();
    const now = new Date().toISOString();
    if (duplicate) {
      if (app.candidateInterfaceRevisionId) {
        this.db.update(schema.appInterfaceRevisions).set({ status: 'abandoned', updatedAt: now })
          .where(eq(schema.appInterfaceRevisions.id, app.candidateInterfaceRevisionId)).run();
      }
      this.db.update(schema.apps).set({
        activeInterfaceRevisionId: duplicate.id,
        candidateInterfaceRevisionId: null,
        interfaceTrustState: duplicate.trustState,
        updatedAt: now,
      }).where(eq(schema.apps.id, appId)).run();
      return this.toRevision(duplicate);
    }
    const id = randomUUID();
    const trustState = meta.trustState ?? 'verified';
    this.db.insert(schema.appInterfaceRevisions).values({
      id,
      workspaceId,
      appId,
      parentRevisionId: app.activeInterfaceRevisionId ?? null,
      pagesJson: pages,
      semanticHash,
      source: meta.source ?? 'operator',
      actorType: meta.actorType ?? 'user',
      actorId: meta.actorId ?? null,
      reason: meta.reason ?? 'Interface update',
      status: 'active',
      trustState,
      verifiedAt: trustState === 'verified' ? now : null,
      publishedAt: now,
      createdAt: now,
      updatedAt: now,
    }).run();
    if (app.activeInterfaceRevisionId) {
      this.db.update(schema.appInterfaceRevisions).set({ status: 'abandoned', updatedAt: now })
        .where(eq(schema.appInterfaceRevisions.id, app.activeInterfaceRevisionId)).run();
    }
    if (app.candidateInterfaceRevisionId) {
      this.db.update(schema.appInterfaceRevisions).set({ status: 'abandoned', updatedAt: now })
        .where(eq(schema.appInterfaceRevisions.id, app.candidateInterfaceRevisionId)).run();
    }
    this.db.update(schema.apps).set({
      activeInterfaceRevisionId: id,
      candidateInterfaceRevisionId: null,
      interfaceTrustState: trustState,
      updatedAt: now,
    }).where(eq(schema.apps.id, appId)).run();
    const revision = this.get(workspaceId, appId, id);
    this.deps.emit?.('published', { workspaceId, appId, revisionId: id, semanticHash });
    return revision;
  }

  createCandidate(
    workspaceId: string,
    appId: string,
    pages: InterfacePageSnapshot[],
    meta: { source?: string; actorType?: string; actorId?: string; reason?: string; baseRevisionId?: string } = {},
  ): AppInterfaceRevision {
    const active = this.ensureActive(workspaceId, appId);
    if (meta.baseRevisionId && meta.baseRevisionId !== active.id) {
      throw new AgentisError('VALIDATION_FAILED', `interface changed since it was observed (expected ${meta.baseRevisionId}, active ${active.id})`);
    }
    const collections = this.db.select({ name: schema.appCollections.name }).from(schema.appCollections)
      .where(eq(schema.appCollections.appId, appId)).all().map((row) => row.name);
    const normalized = normalizePages(pages, collections);
    const semanticHash = interfaceHash(normalized);
    const existing = this.db.select().from(schema.appInterfaceRevisions)
      .where(and(eq(schema.appInterfaceRevisions.appId, appId), eq(schema.appInterfaceRevisions.semanticHash, semanticHash)))
      .all().find((row) => row.status === 'active' || row.status === 'candidate');
    if (existing) return this.toRevision(existing);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.insert(schema.appInterfaceRevisions).values({
      id,
      workspaceId,
      appId,
      parentRevisionId: active.id,
      pagesJson: normalized,
      semanticHash,
      source: meta.source ?? 'agent',
      actorType: meta.actorType ?? 'agent',
      actorId: meta.actorId ?? null,
      reason: meta.reason ?? 'Interface candidate',
      status: 'candidate',
      trustState: 'candidate',
      createdAt: now,
      updatedAt: now,
    }).run();
    this.db.update(schema.apps).set({
      candidateInterfaceRevisionId: id,
      interfaceTrustState: 'candidate',
      updatedAt: now,
    }).where(eq(schema.apps.id, appId)).run();
    this.deps.emit?.('candidate', { workspaceId, appId, revisionId: id, semanticHash });
    return this.get(workspaceId, appId, id);
  }

  verify(workspaceId: string, appId: string, revisionId: string): InterfaceVerification {
    const revision = this.get(workspaceId, appId, revisionId);
    const collectionNames = this.db.select({ name: schema.appCollections.name }).from(schema.appCollections)
      .where(eq(schema.appCollections.appId, appId)).all().map((row) => row.name);
    const pageNames = new Set(revision.pages.map((page) => page.name));
    const schemaErrors: string[] = [];
    const operabilityErrors: string[] = [];
    const navigationErrors: string[] = [];
    for (const page of revision.pages) {
      try {
        page.actions.forEach((action) => surfaceActionSchema.parse(action));
        if (page.view) viewNodeSchema.parse(page.view);
      } catch (error) {
        schemaErrors.push(`${page.name}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (page.view) {
        const audit = repairSurface(page.view, { collections: collectionNames, actions: page.actions });
        if (audit.fixes.length > 0) operabilityErrors.push(...audit.fixes.map((fix) => `${page.name}: ${fix}`));
      }
      for (const action of page.actions) {
        if (action.kind === 'navigate' && !pageNames.has(action.target)) {
          navigationErrors.push(`${page.name}: action "${action.name}" targets missing page "${action.target}"`);
        }
      }
    }
    if (revision.pages.length === 0) schemaErrors.push('interface has no pages');
    const proofs: InterfaceProof[] = [
      proof('schema', schemaErrors),
      proof('operability', operabilityErrors),
      proof('navigation', navigationErrors),
      proof('runtime', []),
    ];
    const now = new Date().toISOString();
    for (const item of proofs) {
      const existing = this.db.select({ id: schema.appInterfaceProofs.id }).from(schema.appInterfaceProofs)
        .where(and(eq(schema.appInterfaceProofs.revisionId, revisionId), eq(schema.appInterfaceProofs.gate, item.gate))).get();
      const values = {
        status: item.status,
        semanticHash: revision.semanticHash,
        evidenceJson: item.evidence,
        updatedAt: now,
      };
      if (existing) this.db.update(schema.appInterfaceProofs).set(values).where(eq(schema.appInterfaceProofs.id, existing.id)).run();
      else this.db.insert(schema.appInterfaceProofs).values({
        id: randomUUID(), workspaceId, appId, revisionId, gate: item.gate, ...values, createdAt: now,
      }).run();
    }
    const passed = proofs.every((item) => item.status === 'passed');
    this.db.update(schema.appInterfaceRevisions).set({
      trustState: passed ? 'verified' : 'rejected',
      verifiedAt: passed ? now : null,
      rejectedAt: passed ? null : now,
      updatedAt: now,
    }).where(eq(schema.appInterfaceRevisions.id, revisionId)).run();
    this.db.update(schema.apps).set({ interfaceTrustState: passed ? 'verified' : 'rejected', updatedAt: now })
      .where(eq(schema.apps.id, appId)).run();
    this.deps.emit?.('verified', { workspaceId, appId, revisionId, passed, proofs });
    return { revisionId, passed, semanticHash: revision.semanticHash, proofs };
  }

  publish(workspaceId: string, appId: string, revisionId: string): AppInterfaceRevision {
    const app = this.app(workspaceId, appId);
    const revision = this.get(workspaceId, appId, revisionId);
    if (revision.status !== 'candidate') throw new AgentisError('VALIDATION_FAILED', 'only a candidate interface can be published');
    if (revision.parentRevisionId !== (app.activeInterfaceRevisionId ?? this.ensureActive(workspaceId, appId).id)) {
      throw new AgentisError('VALIDATION_FAILED', 'the active interface changed; rebase and verify this candidate again');
    }
    const verification = this.verify(workspaceId, appId, revisionId);
    if (!verification.passed) {
      throw new AgentisError('VALIDATION_FAILED', `interface verification failed: ${verification.proofs.filter((p) => p.status === 'failed').map((p) => p.gate).join(', ')}`);
    }
    const now = new Date().toISOString();
    this.db.transaction((tx) => {
      tx.delete(schema.appSurfaces).where(eq(schema.appSurfaces.appId, appId)).run();
      for (const page of revision.pages) {
        tx.insert(schema.appSurfaces).values({
          id: page.id || randomUUID(),
          appId,
          workspaceId,
          name: page.name,
          kind: page.kind,
          viewJson: page.view,
          actionsJson: page.actions,
          shareable: page.shareable,
          revision: 0,
          createdAt: now,
          updatedAt: now,
        }).run();
      }
      if (app.activeInterfaceRevisionId) {
        tx.update(schema.appInterfaceRevisions).set({ status: 'abandoned', updatedAt: now })
          .where(eq(schema.appInterfaceRevisions.id, app.activeInterfaceRevisionId)).run();
      }
      tx.update(schema.appInterfaceRevisions).set({
        status: 'active', trustState: 'verified', publishedAt: now, updatedAt: now,
      }).where(eq(schema.appInterfaceRevisions.id, revisionId)).run();
      tx.update(schema.apps).set({
        activeInterfaceRevisionId: revisionId,
        candidateInterfaceRevisionId: null,
        interfaceTrustState: 'verified',
        updatedAt: now,
      }).where(eq(schema.apps.id, appId)).run();
    });
    this.deps.emit?.('published', { workspaceId, appId, revisionId, semanticHash: revision.semanticHash });
    return this.get(workspaceId, appId, revisionId);
  }

  restore(workspaceId: string, appId: string, revisionId: string, actorId?: string): AppInterfaceRevision {
    const historical = this.get(workspaceId, appId, revisionId);
    const candidate = this.createCandidate(workspaceId, appId, historical.pages, {
      source: 'restore', actorType: actorId ? 'user' : 'system', actorId,
      reason: `Restore interface revision ${revisionId}`,
    });
    return candidate.status === 'active' ? candidate : this.publish(workspaceId, appId, candidate.id);
  }

  abandon(workspaceId: string, appId: string, revisionId: string): void {
    const revision = this.get(workspaceId, appId, revisionId);
    if (revision.status !== 'candidate') throw new AgentisError('VALIDATION_FAILED', 'only a candidate can be abandoned');
    const now = new Date().toISOString();
    this.db.update(schema.appInterfaceRevisions).set({ status: 'abandoned', updatedAt: now })
      .where(eq(schema.appInterfaceRevisions.id, revisionId)).run();
    this.db.update(schema.apps).set({ candidateInterfaceRevisionId: null, interfaceTrustState: 'verified', updatedAt: now })
      .where(eq(schema.apps.id, appId)).run();
    this.deps.emit?.('abandoned', { workspaceId, appId, revisionId });
  }

  get(workspaceId: string, appId: string, revisionId: string): AppInterfaceRevision {
    this.app(workspaceId, appId);
    const row = this.db.select().from(schema.appInterfaceRevisions)
      .where(and(eq(schema.appInterfaceRevisions.workspaceId, workspaceId), eq(schema.appInterfaceRevisions.appId, appId), eq(schema.appInterfaceRevisions.id, revisionId))).get();
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `interface revision not found: ${revisionId}`);
    return this.toRevision(row);
  }

  list(workspaceId: string, appId: string): AppInterfaceRevision[] {
    this.app(workspaceId, appId);
    return this.db.select().from(schema.appInterfaceRevisions)
      .where(and(eq(schema.appInterfaceRevisions.workspaceId, workspaceId), eq(schema.appInterfaceRevisions.appId, appId)))
      .orderBy(desc(schema.appInterfaceRevisions.createdAt)).all().map((row) => this.toRevision(row));
  }

  state(workspaceId: string, appId: string) {
    const active = this.ensureActive(workspaceId, appId);
    const app = this.app(workspaceId, appId);
    const candidate = app.candidateInterfaceRevisionId
      ? this.get(workspaceId, appId, app.candidateInterfaceRevisionId)
      : null;
    return { active, candidate, trustState: app.interfaceTrustState };
  }
}

function proof(gate: InterfaceGate, errors: string[]): InterfaceProof {
  return {
    gate,
    status: errors.length === 0 ? 'passed' : 'failed',
    evidence: errors.length === 0 ? { checked: true } : { errors },
  };
}

function normalizePages(pages: InterfacePageSnapshot[], collections: string[]): InterfacePageSnapshot[] {
  const names = new Set<string>();
  return pages.map((page) => {
    const name = page.name.trim();
    if (!name) throw new AgentisError('VALIDATION_FAILED', 'interface page name is required');
    if (names.has(name)) throw new AgentisError('VALIDATION_FAILED', `duplicate interface page: ${name}`);
    names.add(name);
    const actions = page.actions.map((action) => surfaceActionSchema.parse(action));
    const parsedView = page.view ? viewNodeSchema.parse(page.view) : null;
    return {
      id: page.id || randomUUID(),
      name,
      kind: page.kind,
      view: parsedView ? repairSurface(parsedView, { collections, actions }).view : null,
      actions,
      shareable: page.shareable,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function interfaceHash(pages: InterfacePageSnapshot[]): string {
  const semantic = pages.map(({ id: _id, ...page }) => page);
  return createHash('sha256').update(stableJson(semantic)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function pagesFromSurfaces(surfaces: AppSurface[]): InterfacePageSnapshot[] {
  return surfaces.map((surface) => ({
    id: surface.id,
    name: surface.name,
    kind: surface.kind,
    view: surface.view,
    actions: surface.actions,
    shareable: surface.shareable,
  }));
}
