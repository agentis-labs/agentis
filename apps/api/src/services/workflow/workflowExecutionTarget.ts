import { and, eq } from 'drizzle-orm';
import { AgentisError, type WorkflowGraph } from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { WorkflowRevisionService } from './workflowRevisionService.js';

export type WorkflowExecutionMode = 'active' | 'candidate' | 'candidate_or_active' | 'revision';

export interface WorkflowExecutionTarget {
  workflow: typeof schema.workflows.$inferSelect;
  revision: typeof schema.workflowGraphRevisions.$inferSelect;
  mode: WorkflowExecutionMode;
  revisionId: string;
  semanticHash: string;
  graph: WorkflowGraph;
}

/**
 * Resolve the immutable graph bytes that every verifier and executor must use.
 * Callers must not read `workflows.graph` after this point: that column is only
 * the active-production compatibility mirror and intentionally excludes drafts.
 */
export function resolveWorkflowExecutionTarget(input: {
  db: AgentisSqliteDb;
  revisions: WorkflowRevisionService;
  workspaceId: string;
  workflowId: string;
  mode: WorkflowExecutionMode;
  revisionId?: string | null;
}): WorkflowExecutionTarget {
  const workflow = input.db.select().from(schema.workflows).where(and(
    eq(schema.workflows.id, input.workflowId),
    eq(schema.workflows.workspaceId, input.workspaceId),
  )).get();
  if (!workflow) throw new AgentisError('RESOURCE_NOT_FOUND', `workflow ${input.workflowId} not found`);

  const ensured = input.revisions.ensureWorkflow(input.workspaceId, input.workflowId);
  if (input.mode === 'revision' && !input.revisionId) {
    throw new AgentisError('VALIDATION_FAILED', 'Exact revision execution requires revisionId.');
  }
  const selected = input.revisionId
    ? input.revisions.revision(input.workspaceId, input.workflowId, input.revisionId)
    : input.mode === 'candidate'
      ? input.revisions.candidate(input.workspaceId, input.workflowId)?.revision
      : input.mode === 'candidate_or_active'
        ? input.revisions.candidate(input.workspaceId, input.workflowId)?.revision ?? ensured.active
      : ensured.active;
  if (!selected) {
    throw new AgentisError(
      'RESOURCE_NOT_FOUND',
      input.mode === 'candidate' ? 'No candidate revision is available to verify.' : 'Workflow revision not found',
    );
  }

  if (input.mode === 'active' && selected.id !== ensured.active.id) {
    throw new AgentisError(
      'AUTH_FORBIDDEN',
      'Production execution must target the active revision. Use candidate/debug mode to verify a draft.',
    );
  }
  if (input.mode === 'candidate' && selected.id === ensured.active.id) {
    throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'The requested debug revision is active, not a candidate.');
  }

  return {
    workflow,
    revision: selected,
    mode: input.mode,
    revisionId: selected.id,
    semanticHash: selected.semanticHash,
    graph: selected.graphJson as WorkflowGraph,
  };
}
