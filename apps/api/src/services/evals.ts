import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { and, desc, eq } from 'drizzle-orm';
import { AgentisError, type WorkflowGraph } from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { WorkflowEngine } from '../engine/WorkflowEngine.js';
import { buildInitialRunState } from '../engine/initialRunState.js';
import { validateWorkflowGraph } from '../engine/validateGraph.js';

export interface CreateEvalSuiteArgs {
  workspaceId: string;
  userId: string;
  appInstanceId?: string | null;
  workflowId?: string | null;
  name: string;
  description?: string | null;
  datasetKey?: string | null;
  rubric?: unknown;
  config?: Record<string, unknown>;
  cases?: Array<{ name?: string; input?: unknown; expected?: unknown; metadata?: unknown }>;
}

export interface RunEvalSuiteArgs {
  workspaceId: string;
  userId: string;
  suiteId: string;
  syncTimeoutMs?: number;
}

export class EvalService {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly engine: WorkflowEngine,
  ) {}

  listSuites(workspaceId: string) {
    return this.db
      .select()
      .from(schema.evalSuites)
      .where(eq(schema.evalSuites.workspaceId, workspaceId))
      .orderBy(desc(schema.evalSuites.updatedAt))
      .all();
  }

  getSuite(workspaceId: string, suiteId: string) {
    const suite = this.db
      .select()
      .from(schema.evalSuites)
      .where(and(eq(schema.evalSuites.workspaceId, workspaceId), eq(schema.evalSuites.id, suiteId)))
      .get();
    if (!suite) throw new AgentisError('RESOURCE_NOT_FOUND', 'Eval suite not found');
    const cases = this.listCases(workspaceId, suiteId);
    const results = this.listResults(workspaceId, suiteId, 20);
    return { suite, cases, results };
  }

  createSuite(args: CreateEvalSuiteArgs) {
    if (args.workflowId) this.assertWorkflow(args.workspaceId, args.workflowId);
    if (args.appInstanceId) this.assertApp(args.workspaceId, args.appInstanceId);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.insert(schema.evalSuites).values({
      id,
      workspaceId: args.workspaceId,
      userId: args.userId,
      appInstanceId: args.appInstanceId ?? null,
      workflowId: args.workflowId ?? null,
      name: args.name,
      description: args.description ?? null,
      datasetKey: args.datasetKey ?? null,
      rubric: args.rubric ?? {},
      config: args.config ?? {},
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }).run();
    for (const [index, item] of (args.cases ?? []).entries()) {
      this.addCase(args.workspaceId, id, {
        name: item.name ?? `Case ${index + 1}`,
        input: item.input ?? {},
        expected: item.expected ?? {},
        metadata: item.metadata ?? {},
      });
    }
    return this.getSuite(args.workspaceId, id);
  }

  listCases(workspaceId: string, suiteId: string) {
    return this.db
      .select()
      .from(schema.evalCases)
      .where(and(eq(schema.evalCases.workspaceId, workspaceId), eq(schema.evalCases.suiteId, suiteId)))
      .all()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  addCase(workspaceId: string, suiteId: string, item: { name: string; input: unknown; expected: unknown; metadata?: unknown }) {
    this.assertSuite(workspaceId, suiteId);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.insert(schema.evalCases).values({
      id,
      suiteId,
      workspaceId,
      name: item.name,
      input: asRecord(item.input),
      expected: asRecord(item.expected),
      metadata: asRecord(item.metadata),
      createdAt: now,
    }).run();
    return this.db.select().from(schema.evalCases).where(eq(schema.evalCases.id, id)).get();
  }

  listResults(workspaceId: string, suiteId: string, limit = 50) {
    return this.db
      .select()
      .from(schema.evalResults)
      .where(and(eq(schema.evalResults.workspaceId, workspaceId), eq(schema.evalResults.suiteId, suiteId)))
      .orderBy(desc(schema.evalResults.createdAt))
      .limit(Math.min(Math.max(limit, 1), 100))
      .all();
  }

  async runSuite(args: RunEvalSuiteArgs) {
    const suite = this.assertSuite(args.workspaceId, args.suiteId);
    const cases = this.listCases(args.workspaceId, args.suiteId);
    if (cases.length === 0) throw new AgentisError('VALIDATION_FAILED', 'Eval suite has no cases');
    const now = new Date().toISOString();
    const resultId = randomUUID();
    this.db.insert(schema.evalResults).values({
      id: resultId,
      suiteId: suite.id,
      workspaceId: args.workspaceId,
      userId: args.userId,
      appInstanceId: suite.appInstanceId,
      workflowId: suite.workflowId,
      runId: null,
      status: 'running',
      score: 0,
      passed: false,
      totalCases: cases.length,
      passedCases: 0,
      failedCases: 0,
      summary: null,
      metrics: { cases: [] },
      startedAt: now,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    }).run();

    const perCase: Array<Record<string, unknown>> = [];
    let passedCases = 0;
    let firstRunId: string | null = null;
    for (const item of cases) {
      const actual = suite.workflowId
        ? await this.runWorkflowCase(args.workspaceId, args.userId, suite.workflowId, asRecord(item.input), args.syncTimeoutMs)
        : asRecord(item.input);
      if (!firstRunId && isRecord(actual) && typeof actual.runId === 'string') firstRunId = actual.runId;
      const normalizedActual = isRecord(actual) && 'response' in actual ? actual.response : actual;
      const score = scoreExpected(asRecord(item.expected), normalizedActual);
      const passed = score >= thresholdOf(suite.config);
      if (passed) passedCases += 1;
      perCase.push({
        caseId: item.id,
        name: item.name,
        passed,
        score,
        expected: item.expected,
        actual: normalizedActual,
      });
    }
    const completedAt = new Date().toISOString();
    const totalScore = perCase.reduce((sum, item) => sum + Number(item.score ?? 0), 0) / cases.length;
    const failedCases = cases.length - passedCases;
    const passed = failedCases === 0;
    this.db.update(schema.evalResults).set({
      runId: firstRunId,
      status: passed ? 'passed' : 'failed',
      score: totalScore,
      passed,
      totalCases: cases.length,
      passedCases,
      failedCases,
      summary: `${passedCases}/${cases.length} cases passed`,
      metrics: { cases: perCase, threshold: thresholdOf(suite.config) },
      completedAt,
      updatedAt: completedAt,
    }).where(eq(schema.evalResults.id, resultId)).run();
    return this.db.select().from(schema.evalResults).where(eq(schema.evalResults.id, resultId)).get();
  }

  private assertSuite(workspaceId: string, suiteId: string) {
    const suite = this.db
      .select()
      .from(schema.evalSuites)
      .where(and(eq(schema.evalSuites.workspaceId, workspaceId), eq(schema.evalSuites.id, suiteId)))
      .get();
    if (!suite) throw new AgentisError('RESOURCE_NOT_FOUND', 'Eval suite not found');
    return suite;
  }

  private assertWorkflow(workspaceId: string, workflowId: string) {
    const wf = this.db
      .select()
      .from(schema.workflows)
      .where(and(eq(schema.workflows.workspaceId, workspaceId), eq(schema.workflows.id, workflowId)))
      .get();
    if (!wf) throw new AgentisError('RESOURCE_NOT_FOUND', 'Workflow not found');
    return wf;
  }

  private assertApp(workspaceId: string, appInstanceId: string) {
    const app = this.db
      .select()
      .from(schema.appInstances)
      .where(and(eq(schema.appInstances.workspaceId, workspaceId), eq(schema.appInstances.id, appInstanceId)))
      .get();
    if (!app) throw new AgentisError('RESOURCE_NOT_FOUND', 'App not found');
    return app;
  }

  private async runWorkflowCase(workspaceId: string, userId: string, workflowId: string, input: Record<string, unknown>, timeoutMs = 2500) {
    const wf = this.assertWorkflow(workspaceId, workflowId);
    const graph = wf.graph as WorkflowGraph;
    validateWorkflowGraph(graph);
    const runId = randomUUID();
    const state = buildInitialRunState({ runId, workflowId, graph, inputs: input });
    this.db.insert(schema.workflowRuns).values({
      id: runId,
      workspaceId,
      ambientId: wf.ambientId,
      workflowId,
      userId,
      status: 'CREATED',
      runState: { ...state, eval: { mode: true } },
      triggerId: null,
    }).run();
    await this.engine.startRun({
      workspaceId,
      ambientId: wf.ambientId,
      workflowId,
      userId,
      triggerId: null,
      inputs: input,
      initialState: state,
      graph,
    });
    const deadline = Date.now() + Math.max(0, Math.min(timeoutMs, 10_000));
    let run = this.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get();
    while (run && Date.now() < deadline && !['COMPLETED', 'FAILED', 'CANCELLED', 'WAITING'].includes(run.status)) {
      await delay(25);
      run = this.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get();
    }
    return { runId, status: run?.status ?? 'CREATED', response: finalResponseFromRunState(run?.runState) };
  }
}

function finalResponseFromRunState(runState: unknown): unknown {
  const state = runState as {
    response?: { body?: unknown } | unknown;
    completedNodeIds?: string[];
    nodeStates?: Record<string, { outputData?: unknown }>;
  } | undefined;
  if (!state) return null;
  if (state.response !== undefined) return isRecord(state.response) && 'body' in state.response ? state.response.body : state.response;
  const finalNodeId = state.completedNodeIds?.at(-1);
  return finalNodeId ? state.nodeStates?.[finalNodeId]?.outputData ?? {} : {};
}

function thresholdOf(config: unknown): number {
  const threshold = asRecord(config).threshold;
  return typeof threshold === 'number' ? Math.min(Math.max(threshold, 0), 1) : 1;
}

function scoreExpected(expected: Record<string, unknown>, actual: unknown): number {
  const keys = Object.keys(expected);
  if (keys.length === 0) return 1;
  const actualRecord = asRecord(actual);
  let hits = 0;
  for (const key of keys) {
    if (deepEqual(expected[key], actualRecord[key])) hits += 1;
  }
  return hits / keys.length;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}