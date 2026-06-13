/**
 * CORA Organizational Model — versioned artifacts + reproducible snapshots
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

export class CoraModelService {
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
    const existing = this.db.select().from(schema.coraModelArtifacts)
      .where(and(
        eq(schema.coraModelArtifacts.workspaceId, args.workspaceId),
        eq(schema.coraModelArtifacts.kind, args.kind),
        eq(schema.coraModelArtifacts.title, args.title),
        eq(schema.coraModelArtifacts.status, 'active'),
      ))
      .get();
    const now = new Date().toISOString();
    if (existing) {
      this.db.update(schema.coraModelArtifacts)
        .set({
          bodyJson: args.body,
          claimIdsJson: args.claimIds,
          version: (existing.version ?? 1) + 1,
          updatedAt: now,
        })
        .where(eq(schema.coraModelArtifacts.id, existing.id))
        .run();
      return this.getArtifact(args.workspaceId, existing.id)!;
    }
    const id = randomUUID();
    this.db.insert(schema.coraModelArtifacts).values({
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
    return this.db.select().from(schema.coraModelArtifacts)
      .where(and(eq(schema.coraModelArtifacts.workspaceId, workspaceId), eq(schema.coraModelArtifacts.id, artifactId)))
      .get() ?? null;
  }

  listArtifacts(workspaceId: string, options: { kind?: string; limit?: number } = {}) {
    const conditions = [
      eq(schema.coraModelArtifacts.workspaceId, workspaceId),
      eq(schema.coraModelArtifacts.status, 'active'),
    ];
    if (options.kind) conditions.push(eq(schema.coraModelArtifacts.kind, options.kind));
    return this.db.select().from(schema.coraModelArtifacts)
      .where(and(...conditions))
      .orderBy(desc(schema.coraModelArtifacts.updatedAt))
      .limit(Math.min(options.limit ?? 100, 300))
      .all();
  }

  // ── Snapshots (§13.4) ─────────────────────────────────────

  buildSnapshot(workspaceId: string): { id: string; claimSetHash: string; entityGraphHash: string } {
    const now = new Date().toISOString();
    const claimSetHash = this.deps.claims.activeClaimSetHash(workspaceId);
    const entities = this.db.select({ id: schema.coraEntities.id, updatedAt: schema.coraEntities.updatedAt })
      .from(schema.coraEntities)
      .where(and(eq(schema.coraEntities.workspaceId, workspaceId), eq(schema.coraEntities.status, 'active')))
      .orderBy(schema.coraEntities.id)
      .all();
    const entityGraphHash = createHash('sha256').update(JSON.stringify(entities)).digest('hex');

    const current = this.activeSnapshot(workspaceId);
    if (current && current.claimSetHash === claimSetHash && current.entityGraphHash === entityGraphHash) {
      // Nothing changed — no new snapshot, no churn.
      return { id: current.id, claimSetHash, entityGraphHash };
    }
    const connections = this.db.select().from(schema.coraSourceConnections)
      .where(eq(schema.coraSourceConnections.workspaceId, workspaceId))
      .all();
    const coverage: Record<string, number> = {};
    for (const c of connections) coverage[c.sourceType] = c.status === 'ready' ? 1 : 0;

    const id = randomUUID();
    this.db.insert(schema.coraModelSnapshots).values({
      id,
      workspaceId,
      predecessorId: current?.id ?? null,
      status: 'active',
      claimSetHash,
      entityGraphHash,
      reasoningVersion: 'cora-v1',
      sourceCoverageJson: coverage,
      builtAt: now,
      activatedAt: now,
    }).run();
    if (current) {
      this.db.update(schema.coraModelSnapshots)
        .set({ status: 'superseded' })
        .where(eq(schema.coraModelSnapshots.id, current.id))
        .run();
    }
    this.deps.logger.info('cora.model.snapshot', { workspaceId, snapshotId: id });
    return { id, claimSetHash, entityGraphHash };
  }

  activeSnapshot(workspaceId: string) {
    return this.db.select().from(schema.coraModelSnapshots)
      .where(and(eq(schema.coraModelSnapshots.workspaceId, workspaceId), eq(schema.coraModelSnapshots.status, 'active')))
      .orderBy(desc(schema.coraModelSnapshots.createdAt))
      .get() ?? null;
  }

  /** Rollback: reactivate the predecessor when a defect is discovered (§13.4). */
  rollbackSnapshot(workspaceId: string, snapshotId: string) {
    const snapshot = this.db.select().from(schema.coraModelSnapshots)
      .where(and(eq(schema.coraModelSnapshots.workspaceId, workspaceId), eq(schema.coraModelSnapshots.id, snapshotId)))
      .get();
    if (!snapshot?.predecessorId) return null;
    const now = new Date().toISOString();
    this.db.update(schema.coraModelSnapshots)
      .set({ status: 'rejected' })
      .where(eq(schema.coraModelSnapshots.id, snapshotId))
      .run();
    this.db.update(schema.coraModelSnapshots)
      .set({ status: 'active', activatedAt: now })
      .where(eq(schema.coraModelSnapshots.id, snapshot.predecessorId))
      .run();
    return this.db.select().from(schema.coraModelSnapshots).where(eq(schema.coraModelSnapshots.id, snapshot.predecessorId)).get();
  }
}
