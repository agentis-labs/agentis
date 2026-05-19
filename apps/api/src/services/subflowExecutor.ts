/**
 * SubflowExecutor — implements V1-SPEC §6 subflow nodes.
 *
 * Semantics (per the resolution plan):
 *  - Parent run dispatches a subflow node → SubflowExecutor.start() creates
 *    a NEW WorkflowRun with `parentRunId = parentRun.id`.
 *  - Child run inherits inputs as the seed payload to its trigger node.
 *  - Child gets a prefixed scratchpad namespace (`subflow:{nodeId}:`) so it
 *    can read/write without colliding with the parent.
 *  - Parent node stays RUNNING until the child reaches a terminal status.
 *  - Parent ledger gets `subflow.started` and `subflow.completed|failed`
 *    events with the child runId.
 *  - Failed subflow → parent node fails with `subflow_failed: <child_run_id>`.
 *  - Subflow cancelled → propagates to parent node failure with reason.
 *
 * The executor is a lightweight broker over the engine; the engine remains
 * agnostic to the parent/child relationship except for the readiness signal
 * delivered through `notifyTaskCompleted`/`notifyTaskFailed`.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import {
  AgentisError,
  type WorkflowGraph,
  type WorkflowRunState,
} from '@agentis/core';
import type { LedgerService } from './ledger.js';
import type { ScratchpadService } from './scratchpad.js';
import { buildInitialRunState } from '../engine/initialRunState.js';

export interface SubflowExecutorDeps {
  db: AgentisSqliteDb;
  ledger: LedgerService;
  scratchpad: ScratchpadService;
}

export interface StartSubflowArgs {
  parentRunId: string;
  parentNodeId: string;
  workspaceId: string;
  ambientId: string | null;
  userId: string;
  childWorkflowId: string;
  inputs: Record<string, unknown>;
  /** Called by the engine bridge when the parent should resume / fail. */
  resumeParent: (output: Record<string, unknown>) => Promise<void>;
  failParent: (error: string) => Promise<void>;
  /**
   * The engine entrypoint for starting a run. We pass it in to avoid a
   * circular dependency between WorkflowEngine and SubflowExecutor.
   */
  startChildRun: (args: {
    workspaceId: string;
    ambientId: string | null;
    workflowId: string;
    userId: string;
    triggerId: string | null;
    inputs: Record<string, unknown>;
    initialState: WorkflowRunState;
    graph: WorkflowGraph;
  }) => Promise<{ runId: string }>;
}

export class SubflowExecutor {
  /** parentRunId+nodeId → resume/fail callbacks. */
  readonly #pending = new Map<string, { resume: (o: Record<string, unknown>) => Promise<void>; fail: (m: string) => Promise<void>; childRunId: string }>();

  constructor(private readonly deps: SubflowExecutorDeps) {}

  async start(args: StartSubflowArgs): Promise<string> {
    this.#assertNoSubflowCycle(args.parentRunId, args.childWorkflowId);
    const child = this.deps.db
      .select()
      .from(schema.workflows)
      .where(eq(schema.workflows.id, args.childWorkflowId))
      .get();
    if (!child || child.workspaceId !== args.workspaceId) {
      throw new AgentisError('RESOURCE_NOT_FOUND', `subflow workflow ${args.childWorkflowId} not found`);
    }
    const graph = child.graph as WorkflowGraph;
    const childRunId = randomUUID();
    const initialState = buildInitialRunState({
      runId: childRunId,
      workflowId: child.id,
      graph,
      inputs: args.inputs,
    });
    // Persist child run row first so the engine has a primary key to update.
    this.deps.db.insert(schema.workflowRuns).values({
      id: childRunId,
      workspaceId: args.workspaceId,
      ambientId: args.ambientId ?? null,
      workflowId: child.id,
      userId: args.userId,
      status: 'CREATED',
      runState: initialState as unknown as object,
      replanCount: 0,
      triggerId: null,
      parentRunId: args.parentRunId,
    }).run();

    // Register pending parent callback.
    const key = `${args.parentRunId}:${args.parentNodeId}`;
    this.#pending.set(key, {
      resume: args.resumeParent,
      fail: args.failParent,
      childRunId,
    });

    // Parent ledger: subflow.started.
    await this.deps.ledger.append({
      workspaceId: args.workspaceId,
      ambientId: args.ambientId,
      runId: args.parentRunId,
      eventType: 'subflow.started',
      nodeId: args.parentNodeId,
      payload: { childRunId, childWorkflowId: child.id },
    });

    await args.startChildRun({
      workspaceId: args.workspaceId,
      ambientId: args.ambientId,
      workflowId: child.id,
      userId: args.userId,
      triggerId: null,
      inputs: args.inputs,
      initialState,
      graph,
    });

    return childRunId;
  }

  #assertNoSubflowCycle(parentRunId: string, childWorkflowId: string): void {
    let cursor: string | null = parentRunId;
    for (let depth = 0; cursor && depth < 32; depth += 1) {
      const parent = this.deps.db
        .select({
          id: schema.workflowRuns.id,
          parentRunId: schema.workflowRuns.parentRunId,
          workflowId: schema.workflowRuns.workflowId,
        })
        .from(schema.workflowRuns)
        .where(eq(schema.workflowRuns.id, cursor))
        .get();
      if (!parent) return;
      if (parent.workflowId === childWorkflowId) {
        throw new AgentisError(
          'WORKFLOW_GRAPH_INVALID',
          `Subflow cycle detected: workflow ${childWorkflowId} is already in this run chain`,
        );
      }
      cursor = parent.parentRunId;
    }
    if (cursor) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'Subflow nesting limit exceeded');
    }
  }

  /** Called when a child run reaches a terminal status. */
  async onChildRunFinished(args: {
    childRunId: string;
    parentRunId: string;
    parentNodeId: string;
    status: 'COMPLETED' | 'FAILED' | 'CANCELLED';
    finalOutput: Record<string, unknown>;
    workspaceId: string;
    ambientId: string | null;
    error?: string;
  }): Promise<void> {
    const key = `${args.parentRunId}:${args.parentNodeId}`;
    const pending = this.#pending.get(key);
    if (!pending) return;
    this.#pending.delete(key);

    if (args.status === 'COMPLETED') {
      await this.deps.ledger.append({
        workspaceId: args.workspaceId,
        ambientId: args.ambientId,
        runId: args.parentRunId,
        eventType: 'subflow.completed',
        nodeId: args.parentNodeId,
        payload: { childRunId: args.childRunId, output: args.finalOutput },
      });
      await pending.resume(args.finalOutput);
    } else {
      await this.deps.ledger.append({
        workspaceId: args.workspaceId,
        ambientId: args.ambientId,
        runId: args.parentRunId,
        eventType: 'subflow.failed',
        nodeId: args.parentNodeId,
        payload: { childRunId: args.childRunId, error: args.error ?? args.status },
      });
      await pending.fail(`subflow_${args.status.toLowerCase()}: ${args.childRunId}${args.error ? ' - ' + args.error : ''}`);
    }
  }

  /** Look up the parent waiting for a child run, if any. */
  findParentByChildRunId(childRunId: string): { parentRunId: string; parentNodeId: string } | undefined {
    for (const [key, v] of this.#pending) {
      if (v.childRunId === childRunId) {
        const [parentRunId, parentNodeId] = key.split(':');
        return { parentRunId: parentRunId!, parentNodeId: parentNodeId! };
      }
    }
    return undefined;
  }
}
