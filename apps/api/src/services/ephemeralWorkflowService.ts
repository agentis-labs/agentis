import { randomUUID } from 'node:crypto';
import { AgentisError, REALTIME_EVENTS, REALTIME_ROOMS, type WorkflowGraph } from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import { and, eq } from 'drizzle-orm';
import type { WorkflowEngine } from '../engine/WorkflowEngine.js';
import type { EventBus } from '../event-bus.js';
import { buildInitialRunState } from '../engine/initialRunState.js';
import { validateWorkflowGraph } from '../engine/validateGraph.js';

export interface EphemeralWorkflowDeps {
  db: AgentisSqliteDb;
  engine: WorkflowEngine;
  bus: EventBus;
}

export interface EphemeralRunInput {
  workspaceId: string;
  ambientId: string | null;
  conversationId?: string | null;
  userId: string;
  title?: string | null;
  graph: WorkflowGraph;
  inputs?: Record<string, unknown>;
  maxDurationMs?: number | null;
}

export interface EphemeralRunResult {
  runId: string;
  workflowId: null;
  syntheticWorkflowId: string;
  title: string;
  isEphemeral: true;
  streamUrl: string;
}

export function normalizeEphemeralGraph(graph: WorkflowGraph): WorkflowGraph {
  const triggerIds = new Set(
    graph.nodes
      .filter((node) => node.type === 'trigger' || node.config?.kind === 'trigger')
      .map((node) => node.id),
  );
  const nodes = graph.nodes.filter((node) => !triggerIds.has(node.id));
  const edges = graph.edges.filter((edge) => !triggerIds.has(edge.source) && !triggerIds.has(edge.target));
  return { ...graph, nodes, edges };
}

export async function startEphemeralWorkflow(
  deps: EphemeralWorkflowDeps,
  input: EphemeralRunInput,
): Promise<EphemeralRunResult> {
  const graph = normalizeEphemeralGraph(input.graph);
  if (graph.nodes.length === 0) {
    throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'ephemeral workflow graph must contain at least one non-trigger node');
  }
  validateWorkflowGraph(graph);

  const runId = randomUUID();
  const syntheticWorkflowId = `ephemeral:${runId}`;
  const title = input.title?.trim() || 'Ephemeral workflow';
  const maxDurationMs = Math.min(Math.max(input.maxDurationMs ?? 120_000, 1_000), 300_000);
  const initialState = buildInitialRunState({
    runId,
    workflowId: syntheticWorkflowId,
    graph,
    inputs: input.inputs ?? {},
  });

  deps.db.insert(schema.workflowRuns).values({
    id: runId,
    workspaceId: input.workspaceId,
    ambientId: input.ambientId,
    workflowId: null,
    conversationId: input.conversationId ?? null,
    userId: input.userId,
    status: 'CREATED',
    runState: { ...initialState, ephemeral: { title, maxDurationMs } } as unknown as typeof initialState,
    isEphemeral: true,
    ephemeralTitle: title,
    graphSnapshot: graph,
    triggerId: null,
  }).run();

  deps.bus.publish(REALTIME_ROOMS.workspace(input.workspaceId), REALTIME_EVENTS.RUN_CREATED, {
    runId,
    workflowId: null,
    ambientId: input.ambientId,
    isEphemeral: true,
    title,
  });

  await deps.engine.startRun({
    workspaceId: input.workspaceId,
    ambientId: input.ambientId,
    conversationId: input.conversationId ?? null,
    workflowId: syntheticWorkflowId,
    userId: input.userId,
    triggerId: null,
    inputs: input.inputs ?? {},
    initialState,
    graph,
  });

  const timeout = setTimeout(() => {
    void deps.engine.cancelRun(runId);
  }, maxDurationMs);
  timeout.unref?.();

  return {
    runId,
    workflowId: null,
    syntheticWorkflowId,
    title,
    isEphemeral: true,
    streamUrl: `/v1/runs/${runId}`,
  };
}

export function promoteEphemeralWorkflow(deps: { db: AgentisSqliteDb }, input: {
  workspaceId: string;
  ambientId: string | null;
  userId: string;
  runId: string;
  title?: string | null;
  summary?: string | null;
}) {
  const run = deps.db
    .select()
    .from(schema.workflowRuns)
    .where(and(eq(schema.workflowRuns.workspaceId, input.workspaceId), eq(schema.workflowRuns.id, input.runId)))
    .get();
  if (!run) throw new AgentisError('WORKFLOW_RUN_NOT_FOUND', 'ephemeral run not found');
  if (!run.isEphemeral) throw new AgentisError('WORKFLOW_RUN_INVALID_STATE', 'run is not ephemeral');
  const graph = run.graphSnapshot as WorkflowGraph | null;
  if (!graph) throw new AgentisError('WORKFLOW_RUN_INVALID_STATE', 'ephemeral run has no graph snapshot to promote');
  validateWorkflowGraph(graph);

  const workflowId = randomUUID();
  const now = new Date().toISOString();
  const workflow = {
    id: workflowId,
    workspaceId: input.workspaceId,
    ambientId: input.ambientId,
    userId: input.userId,
    title: input.title?.trim() || run.ephemeralTitle || 'Promoted ephemeral workflow',
    summary: input.summary ?? null,
    intendedBehavior: input.summary?.trim() || null,
    graph,
    settings: { promotedFromRunId: run.id, promotedAt: now },
  };
  deps.db.insert(schema.workflows).values(workflow).run();
  return { workflow };
}
