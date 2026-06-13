/**
 * CORA Graph Projection — the organizational overlay for the Workspace Brain
 * Map (RFC §14.1, §14.4).
 *
 * Returns a BrainGraph fragment the existing map merges with the classic atom
 * graph: source anchors, organizational entities, and judged claims, with
 * provenance edges (claim —derived_from→ source, claim —supports→ entity).
 * The client requests only this bounded overview — never the full evidence
 * graph (§14.4 "no download-everything-and-hide-it-with-CSS").
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import type { BrainGraph, BrainGraphLink, BrainGraphNode } from '@agentis/core';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { schema } from '@agentis/db/sqlite';

const MAX_CLAIMS = 60;
const MAX_ENTITIES = 40;

export function buildOrganizationalOverlay(db: AgentisSqliteDb, workspaceId: string): BrainGraph {
  const nodes: BrainGraphNode[] = [];
  const links: BrainGraphLink[] = [];
  const now = new Date().toISOString();

  // Source anchors — recognizable systems with health (§14.2).
  const connections = db.select().from(schema.coraSourceConnections)
    .where(eq(schema.coraSourceConnections.workspaceId, workspaceId))
    .all()
    .filter((c) => c.status !== 'revoked');
  for (const connection of connections) {
    nodes.push({
      id: `cora:source:${connection.id}`,
      atomId: connection.id,
      atomKind: 'cora_source',
      label: connection.displayName,
      summary: connection.lastSyncAt
        ? `Synced ${connection.lastSyncAt.slice(0, 16).replace('T', ' ')}`
        : 'Never synced',
      confidence: connection.status === 'ready' ? 0.9 : 0.4,
      reinforceCount: 1,
      isStale: connection.status === 'needs_attention',
      metadata: { cora: 'source', sourceType: connection.sourceType, status: connection.status },
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
    } as BrainGraphNode);
  }

  // Entities — people, agents, processes, systems (§6.4).
  const entities = db.select().from(schema.coraEntities)
    .where(and(eq(schema.coraEntities.workspaceId, workspaceId), eq(schema.coraEntities.status, 'active')))
    .orderBy(desc(schema.coraEntities.updatedAt))
    .limit(MAX_ENTITIES)
    .all();
  const entityIds = new Set(entities.map((e) => e.id));
  for (const entity of entities) {
    nodes.push({
      id: `cora:entity:${entity.id}`,
      atomId: entity.id,
      atomKind: 'cora_entity',
      label: entity.name,
      summary: entity.kind,
      confidence: 0.8,
      reinforceCount: 1,
      metadata: { cora: 'entity', kind: entity.kind, tags: [entity.kind] },
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    } as BrainGraphNode);
  }

  // Claims — judged organizational truth, disputed ones flagged (§14.3).
  const claims = db.select().from(schema.coraClaims)
    .where(and(
      eq(schema.coraClaims.workspaceId, workspaceId),
      inArray(schema.coraClaims.status, ['active', 'disputed']),
    ))
    .orderBy(desc(schema.coraClaims.confidence))
    .limit(MAX_CLAIMS)
    .all();
  const claimIds = claims.map((c) => c.id);
  for (const claim of claims) {
    const object = typeof claim.objectJson === 'string' ? claim.objectJson : JSON.stringify(claim.objectJson);
    nodes.push({
      id: `cora:claim:${claim.id}`,
      atomId: claim.id,
      atomKind: 'cora_claim',
      label: claim.predicate.replace(/_/g, ' '),
      summary: object.slice(0, 140),
      confidence: claim.confidence,
      reinforceCount: 1,
      isDisputed: claim.status === 'disputed',
      metadata: { cora: 'claim', claimType: claim.claimType, protectedDomain: claim.protectedDomain, status: claim.status },
      createdAt: claim.createdAt,
      updatedAt: claim.updatedAt,
    } as BrainGraphNode);
    if (claim.subjectEntityId && entityIds.has(claim.subjectEntityId)) {
      links.push(link(workspaceId, `cora:claim:${claim.id}`, claim.id, 'cora_claim', `cora:entity:${claim.subjectEntityId}`, claim.subjectEntityId, 'cora_entity', 'supports', claim.confidence));
    }
  }

  // Provenance: claim → source connection, via evidence → source object.
  if (claimIds.length > 0) {
    const evidenceRows = db.select({
      claimId: schema.coraClaimEvidence.claimId,
      evidenceVersionId: schema.coraClaimEvidence.evidenceVersionId,
    }).from(schema.coraClaimEvidence)
      .where(and(
        eq(schema.coraClaimEvidence.workspaceId, workspaceId),
        inArray(schema.coraClaimEvidence.claimId, claimIds),
      ))
      .all();
    const versionIds = [...new Set(evidenceRows.map((r) => r.evidenceVersionId))];
    const versions = versionIds.length > 0
      ? db.select({
          id: schema.coraEvidenceVersions.id,
          sourceObjectId: schema.coraEvidenceVersions.sourceObjectId,
        }).from(schema.coraEvidenceVersions)
          .where(inArray(schema.coraEvidenceVersions.id, versionIds))
          .all()
      : [];
    const objectIds = [...new Set(versions.map((v) => v.sourceObjectId))];
    const objects = objectIds.length > 0
      ? db.select({
          id: schema.coraSourceObjects.id,
          connectionId: schema.coraSourceObjects.connectionId,
        }).from(schema.coraSourceObjects)
          .where(inArray(schema.coraSourceObjects.id, objectIds))
          .all()
      : [];
    const versionToConnection = new Map<string, string>();
    const objectToConnection = new Map(objects.map((o) => [o.id, o.connectionId]));
    for (const version of versions) {
      const connectionId = objectToConnection.get(version.sourceObjectId);
      if (connectionId) versionToConnection.set(version.id, connectionId);
    }
    const seen = new Set<string>();
    for (const row of evidenceRows) {
      const connectionId = versionToConnection.get(row.evidenceVersionId);
      if (!connectionId) continue;
      const key = `${row.claimId}->${connectionId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push(link(workspaceId, `cora:claim:${row.claimId}`, row.claimId, 'cora_claim', `cora:source:${connectionId}`, connectionId, 'cora_source', 'derived_from', 0.7));
    }
  }

  return {
    nodes,
    links,
    meta: {
      workspaceId,
      scope: 'workspace',
      atomCount: nodes.length,
      linkCount: links.length,
      lastActivityAt: now,
      adapterTypes: [],
    },
  };
}

function link(
  workspaceId: string,
  source: string,
  sourceAtomId: string,
  sourceKind: BrainGraphLink['sourceKind'],
  target: string,
  targetAtomId: string,
  targetKind: BrainGraphLink['targetKind'],
  relation: BrainGraphLink['relation'],
  confidence: number,
): BrainGraphLink {
  return {
    id: `coral:${sourceAtomId}:${targetAtomId}:${relation}`,
    source,
    target,
    sourceAtomId,
    sourceKind,
    targetAtomId,
    targetKind,
    relation,
    confidence,
    reinforceCount: 1,
  } as BrainGraphLink;
}
