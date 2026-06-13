/**
 * runPublishedWorkflow — shared "run a workflow and await its output" helper.
 *
 * The single mechanism behind every *synchronous* external invocation of a
 * workflow: MCP `tools/call` and A2A `message:send` both create a run, drive the
 * engine, poll to terminal (or timeout), and return the declared output. Keeping
 * it here means the two protocol surfaces cannot drift apart.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { WorkflowGraph, WorkflowRunState } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { WorkflowEngine } from './WorkflowEngine.js';
import { buildInitialRunState } from './initialRunState.js';
import { validateWorkflowGraph } from './validateGraph.js';

export interface RunPublishedWorkflowArgs {
  db: AgentisSqliteDb;
  engine: WorkflowEngine;
  workspaceId: string;
  ambientId: string | null;
  userId: string;
  workflowId: string;
  graph: WorkflowGraph;
  inputs: Record<string, unknown>;
  /** Poll budget before returning the last-seen (possibly non-terminal) state. */
  timeoutMs?: number;
}

export interface RunPublishedWorkflowResult {
  runId: string;
  status: string;
  /** Declared output (return_output / isOutput nodes), or last completed node. */
  output: unknown;
  terminal: boolean;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export async function runPublishedWorkflow(args: RunPublishedWorkflowArgs): Promise<RunPublishedWorkflowResult> {
  validateWorkflowGraph(args.graph, { currentWorkflowId: args.workflowId });
  const runId = randomUUID();
  const inputs = args.inputs ?? {};
  const initialState = buildInitialRunState({ runId, workflowId: args.workflowId, graph: args.graph, inputs });
  args.db.insert(schema.workflowRuns).values({
    id: runId,
    workspaceId: args.workspaceId,
    ambientId: args.ambientId,
    workflowId: args.workflowId,
    userId: args.userId,
    status: 'CREATED',
    runState: initialState,
  }).run();
  await args.engine.startRun({
    workspaceId: args.workspaceId,
    ambientId: args.ambientId,
    workflowId: args.workflowId,
    userId: args.userId,
    triggerId: null,
    inputs,
    initialState,
    graph: args.graph,
  });

  const final = await awaitRun(args.db, runId, args.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const terminal = isTerminal(final.status);
  const succeeded = final.status === 'COMPLETED' || final.status === 'COMPLETED_WITH_CONTRACT_VIOLATION';
  return {
    runId,
    status: final.status,
    output: succeeded ? finalOutput(args.graph, final.runState as WorkflowRunState) : null,
    terminal,
  };
}

/** Poll a run to a terminal state (or timeout → returns last seen). */
async function awaitRun(db: AgentisSqliteDb, runId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let row = db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
  while (Date.now() < deadline && !isTerminal(row.status)) {
    await sleep(250);
    row = db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get()!;
  }
  return row;
}

function isTerminal(status: string): boolean {
  return ['COMPLETED', 'COMPLETED_WITH_CONTRACT_VIOLATION', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED'].includes(status);
}

/** Final output: declared output nodes (return_output / isOutput), else last completed node. */
export function finalOutput(graph: WorkflowGraph, state: WorkflowRunState): unknown {
  const declared = (graph.nodes ?? []).filter((n) => {
    const c = n.config as { kind?: string; isOutput?: boolean };
    return c.kind === 'return_output' || c.isOutput === true;
  });
  const pick = (id: string, kind?: string) => {
    const o = state.nodeStates?.[id]?.outputData ?? null;
    if (kind === 'return_output' && o && typeof o === 'object' && 'value' in o) return (o as { value: unknown }).value;
    return o;
  };
  if (declared.length > 0) {
    const out: Record<string, unknown> = {};
    for (const n of declared) {
      const o = pick(n.id, (n.config as { kind?: string }).kind);
      if (o !== null && o !== undefined) out[n.id] = o;
    }
    return out;
  }
  const last = state.completedNodeIds?.at(-1);
  return last ? pick(last) : null;
}

/** Build a minimal JSON schema from the workflow's inputContract (if any). */
export function inputSchemaFor(graph: WorkflowGraph): Record<string, unknown> {
  const fields = (graph as { inputContract?: { fields?: Array<{ key: string; type: string; required?: boolean }> } }).inputContract?.fields ?? [];
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const f of fields) {
    properties[f.key] = { type: f.type === 'any' ? 'string' : f.type };
    if (f.required) required.push(f.key);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });
}
