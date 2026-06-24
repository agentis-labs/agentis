/**
 * Grounding Organizational Model — versioned artifacts + reproducible snapshots
 * (RFC §6.4, §13.4).
 *
 * Artifacts (process maps, ownership maps, decisions, narratives, gaps) are
 * projections over claims: the claims and their evidence remain independently
 * inspectable. Snapshots hash the active claim set + entity graph so model
 * changes are diffable and a bad import or reasoning defect can be rolled
 * back by reactivating the predecessor.
 */

import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { schema } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import type { ClaimService } from './claimService.js';

export interface ModelServiceDeps {
  db: AgentisSqliteDb;
  logger: Logger;
  claims: ClaimService;
}

export class GroundingModelService {
  constructor(private readonly deps: ModelServiceDeps) {}

  private get db() { return this.deps.db; }

  // ── Artifacts ─────────────────────────────────────────────

  upsertArtifact(args: {
    workspaceId: string;
    kind: 'process' | 'ownership' | 'decision' | 'system' | 'dependency' | 'narrative' | 'gap';
    title: string;
    body: Record<string, unknown>;
    claimIds: string[];
  }) {
    const existing = this.db.select().from(schema.groundingModelArtifacts)
      .where(and(
        eq(schema.groundingModelArtifacts.workspaceId, args.workspaceId),
        eq(schema.groundingModelArtifacts.kind, args.kind),
        eq(schema.groundingModelArtifacts.title, args.title),
        eq(schema.groundingModelArtifacts.status, 'active'),
      ))
      .get();
    const now = new Date().toISOString();
    if (existing) {
      this.db.update(schema.groundingModelArtifacts)
        .set({
          bodyJson: args.body,
          claimIdsJson: args.claimIds,
          version: (existing.version ?? 1) + 1,
          updatedAt: now,
        })
        .where(eq(schema.groundingModelArtifacts.id, existing.id))
        .run();
      return this.getArtifact(args.workspaceId, existing.id)!;
    }
    const id = randomUUID();
    this.db.insert(schema.groundingModelArtifacts).values({
      id,
      workspaceId: args.workspaceId,
      kind: args.kind,
      title: args.title,
      bodyJson: args.body,
      claimIdsJson: args.claimIds,
    }).run();
    return this.getArtifact(args.workspaceId, id)!;
  }

  getArtifact(workspaceId: string, artifactId: string) {
    return this.db.select().from(schema.groundingModelArtifacts)
      .where(and(eq(schema.groundingModelArtifacts.workspaceId, workspaceId), eq(schema.groundingModelArtifacts.id, artifactId)))
      .get() ?? null;
  }

  listArtifacts(workspaceId: string, options: { kind?: string; limit?: number } = {}) {
    const conditions = [
      eq(schema.groundingModelArtifacts.workspaceId, workspaceId),
      eq(schema.groundingModelArtifacts.status, 'active'),
    ];
    if (options.kind) conditions.push(eq(schema.groundingModelArtifacts.kind, options.kind));
    return this.db.select().from(schema.groundingModelArtifacts)
      .where(and(...conditions))
      .orderBy(desc(schema.groundingModelArtifacts.updatedAt))
      .limit(Math.min(options.limit ?? 100, 300))
      .all();
  }

  // ── Snapshots (§13.4) ─────────────────────────────────────

  buildSnapshot(workspaceId: string): { id: string; claimSetHash: string; entityGraphHash: string } {
    const now = new Date().toISOString();
    const claimSetHash = this.deps.claims.activeClaimSetHash(workspaceId);
    const entities = this.db.select({ id: schema.groundingEntities.id, updatedAt: schema.groundingEntities.updatedAt })
      .from(schema.groundingEntities)
      .where(and(eq(schema.groundingEntities.workspaceId, workspaceId), eq(schema.groundingEntities.status, 'active')))
      .orderBy(schema.groundingEntities.id)
      .all();
    const entityGraphHash = createHash('sha256').update(JSON.stringify(entities)).digest('hex');

    const current = this.activeSnapshot(workspaceId);
    if (current && current.claimSetHash === claimSetHash && current.entityGraphHash === entityGraphHash) {
      // Nothing changed — no new snapshot, no churn.
      return { id: current.id, claimSetHash, entityGraphHash };
    }
    const connections = this.db.select().from(schema.groundingSourceConnections)
      .where(eq(schema.groundingSourceConnections.workspaceId, workspaceId))
      .all();
    const coverage: Record<string, number> = {};
    for (const c of connections) coverage[c.sourceType] = c.status === 'ready' ? 1 : 0;

    const id = randomUUID();
    this.db.insert(schema.groundingModelSnapshots).values({
      id,
      workspaceId,
      predecessorId: current?.id ?? null,
      status: 'active',
      claimSetHash,
      entityGraphHash,
      reasoningVersion: 'grounding-v1',
      sourceCoverageJson: coverage,
      builtAt: now,
      activatedAt: now,
    }).run();
    if (current) {
      this.db.update(schema.groundingModelSnapshots)
        .set({ status: 'superseded' })
        .where(eq(schema.groundingModelSnapshots.id, current.id))
        .run();
    }
    this.deps.logger.info('grounding.model.snapshot', { workspaceId, snapshotId: id });
    return { id, claimSetHash, entityGraphHash };
  }

  activeSnapshot(workspaceId: string) {
    return this.db.select().from(schema.groundingModelSnapshots)
      .where(and(eq(schema.groundingModelSnapshots.workspaceId, workspaceId), eq(schema.groundingModelSnapshots.status, 'active')))
      .orderBy(desc(schema.groundingModelSnapshots.createdAt))
      .get() ?? null;
  }

  /** Rollback: reactivate the predecessor when a defect is discovered (§13.4). */
  rollbackSnapshot(workspaceId: string, snapshotId: string) {
    const snapshot = this.db.select().from(schema.groundingModelSnapshots)
      .where(and(eq(schema.groundingModelSnapshots.workspaceId, workspaceId), eq(schema.groundingModelSnapshots.id, snapshotId)))
      .get();
    if (!snapshot?.predecessorId) return null;
    const now = new Date().toISOString();
    this.db.update(schema.groundingModelSnapshots)
      .set({ status: 'rejected' })
      .where(eq(schema.groundingModelSnapshots.id, snapshotId))
      .run();
    this.db.update(schema.groundingModelSnapshots)
      .set({ status: 'active', activatedAt: now })
      .where(eq(schema.groundingModelSnapshots.id, snapshot.predecessorId))
      .run();
    return this.db.select().from(schema.groundingModelSnapshots).where(eq(schema.groundingModelSnapshots.id, snapshot.predecessorId)).get();
  }
}
