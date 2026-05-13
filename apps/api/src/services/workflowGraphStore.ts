import { createHash, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { WorkflowGraph } from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';

export function syncNormalizedWorkflowGraph(
  db: AgentisSqliteDb,
  workflowId: string,
  graph: WorkflowGraph,
): void {
  db.transaction(() => {
    db.delete(schema.workflowSubflows).where(eq(schema.workflowSubflows.workflowId, workflowId)).run();
    db.delete(schema.workflowEdges).where(eq(schema.workflowEdges.workflowId, workflowId)).run();
    db.delete(schema.workflowNodes).where(eq(schema.workflowNodes.workflowId, workflowId)).run();

    if (graph.nodes.length > 0) {
      db.insert(schema.workflowNodes)
        .values(
          graph.nodes.map((node) => ({
            id: randomUUID(),
            workflowId,
            nodeId: node.id,
            type: node.type,
            title: node.title,
            position: node.position,
            config: node.config,
            enabled: true,
          })),
        )
        .run();
    }

    if (graph.edges.length > 0) {
      db.insert(schema.workflowEdges)
        .values(
          graph.edges.map((edge) => ({
            id: randomUUID(),
            workflowId,
            edgeId: edge.id,
            sourceNodeId: edge.source,
            targetNodeId: edge.target,
            sourceHandle: edge.sourceHandle ?? null,
            targetHandle: edge.targetHandle ?? null,
            condition: edge.condition ?? null,
          })),
        )
        .run();
    }

    const subflows = graph.nodes.filter((node) => node.type === 'loop' || node.type === 'parallel');
    if (subflows.length > 0) {
      db.insert(schema.workflowSubflows)
        .values(
          subflows.map((node) => ({
            id: randomUUID(),
            workflowId,
            subflowId: node.id,
            type: node.type,
            nodeIds: Array.isArray((node.config as { nodeIds?: unknown }).nodeIds)
              ? (node.config as { nodeIds: string[] }).nodeIds
              : [],
            config: node.config,
          })),
        )
        .run();
    }
  });
}

// ────────────────────────────────────────────────────────────
// Graph revisions + replaceGraph
// ────────────────────────────────────────────────────────────

export type GraphRevisionReason =
  | 'initial'
  | 'user_edit'
  | 'auto_repair';

export interface ReplaceGraphOptions {
  reason: GraphRevisionReason;
  message?: string | null;
  actorUserId?: string | null;
}

export interface ReplaceGraphResult {
  revisionId: string;
  revisionNumber: number;
}

/**
 * Atomically replace a workflow's graph and append a row to
 * `workflow_graph_revisions`. Returns the new revision id + monotonic
 * revision number. Used by canvas-editor saves that need versioned history.
 *
 * NOTE: callers running inside a replay should avoid mutating production
 * workflow definitions.
 */
export function replaceGraph(
  db: AgentisSqliteDb,
  workflowId: string,
  graph: WorkflowGraph,
  options: ReplaceGraphOptions,
): ReplaceGraphResult {
  const revisionId = randomUUID();
  let revisionNumber = 0;
  let existingRevisionId: string | null = null;
  db.transaction(() => {
    const wf = db
      .select({ workspaceId: schema.workflows.workspaceId })
      .from(schema.workflows)
      .where(eq(schema.workflows.id, workflowId))
      .get();
    if (!wf) throw new Error(`replaceGraph: workflow ${workflowId} not found`);

    const revisions = db
      .select()
      .from(schema.workflowGraphRevisions)
      .where(eq(schema.workflowGraphRevisions.workflowId, workflowId))
      .all()
      .sort((a, b) => b.revisionNumber - a.revisionNumber);
    const last = revisions[0];
    if (last && graphHash(last.graph) === graphHash(graph)) {
      existingRevisionId = last.id;
      revisionNumber = last.revisionNumber;
      db.update(schema.workflows)
        .set({ graph, updatedAt: new Date().toISOString() })
        .where(eq(schema.workflows.id, workflowId))
        .run();
      return;
    }

    revisionNumber = (last?.revisionNumber ?? 0) + 1;

    db.insert(schema.workflowGraphRevisions)
      .values({
        id: revisionId,
        workflowId,
        workspaceId: wf.workspaceId,
        revisionNumber,
        graph,
        reason: options.reason,
        message: options.message ?? null,
        actorUserId: options.actorUserId ?? null,
      })
      .run();

    db.update(schema.workflows)
      .set({ graph, updatedAt: new Date().toISOString() })
      .where(eq(schema.workflows.id, workflowId))
      .run();
  });

  // Outside the transaction so the normalized denormalization is best-effort
  // and never blocks revision recording. Mirrors syncNormalizedWorkflowGraph
  // semantics elsewhere (canvas-editor save path).
  syncNormalizedWorkflowGraph(db, workflowId, graph);

  return { revisionId: existingRevisionId ?? revisionId, revisionNumber };
}

/** Returns revisions newest-first for the canvas diff view. */
export function listGraphRevisions(
  db: AgentisSqliteDb,
  workspaceId: string,
  workflowId: string,
  limit = 50,
) {
  return db
    .select()
    .from(schema.workflowGraphRevisions)
    .where(
      sql`${schema.workflowGraphRevisions.workflowId} = ${workflowId} AND ${schema.workflowGraphRevisions.workspaceId} = ${workspaceId}`,
    )
    .all()
    .sort((a, b) => b.revisionNumber - a.revisionNumber)
    .slice(0, limit);
}

function graphHash(graph: unknown): string {
  return createHash('sha256').update(JSON.stringify(graph)).digest('hex');
}
