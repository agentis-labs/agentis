/**
 * /v1/workflows — route unit tests (V1-SPEC §3.3).
 *
 * Engine.startRun is stubbed via vi.fn() since these tests cover the route
 * surface, not engine semantics. Engine internals are exercised by the
 * dedicated engine test suites + e2e specs.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { buildWorkflowRoutes } from '../../src/routes/workflows.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import type { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';

let ctx: TestContext;
let engine: { startRun: ReturnType<typeof vi.fn>; cancelRun: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  ctx = await createTestContext();
  engine = { startRun: vi.fn().mockResolvedValue(undefined), cancelRun: vi.fn().mockResolvedValue(undefined) };
});

function app() {
  return ctx.buildApp([
    {
      path: '/v1/workflows',
      app: buildWorkflowRoutes({
        db: ctx.db,
        auth: ctx.auth,
        engine: engine as unknown as WorkflowEngine,
        bus: ctx.bus,
      }),
    },
  ]);
}

function trivialGraph() {
  return {
    version: 1 as const,
    nodes: [
      {
        id: 'start',
        type: 'trigger' as const,
        title: 'Manual',
        position: { x: 0, y: 0 },
        config: { kind: 'trigger' as const, triggerType: 'manual' as const },
      },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

function seedWorkflow(graph: WorkflowGraph = trivialGraph()) {
  const id = randomUUID();
  ctx.db
    .insert(schema.workflows)
    .values({
      id,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      title: 'Seeded',
      graph,
      settings: {},
    })
    .run();
  return id;
}

describe('GET /v1/workflows', () => {
  it('lists workspace workflows', async () => {
    seedWorkflow();
    const res = await app().request('/v1/workflows', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workflows: Array<{ id: string }> };
    expect(body.workflows).toHaveLength(1);
  });

  it('rejects without bearer token (401)', async () => {
    const res = await app().request('/v1/workflows');
    expect(res.status).toBe(401);
  });

  it('rejects without workspace header (422)', async () => {
    const res = await app().request('/v1/workflows', {
      headers: { Authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.status).toBe(422);
  });
});

describe('POST /v1/workflows', () => {
  it('creates a workflow with default empty graph', async () => {
    const res = await app().request('/v1/workflows', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ title: 'New WF' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { workflow: { id: string; title: string } };
    expect(body.workflow.title).toBe('New WF');
  });

  it('returns 422 on missing title', async () => {
    const res = await app().request('/v1/workflows', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });
});

describe('GET /v1/workflows/:id', () => {
  it('returns 404 for unknown id', async () => {
    const res = await app().request(`/v1/workflows/${randomUUID()}`, { headers: ctx.authHeaders });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('returns the workflow when present', async () => {
    const id = seedWorkflow();
    const res = await app().request(`/v1/workflows/${id}`, { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
  });
});

describe('PATCH /v1/workflows/:id', () => {
  it('updates the title', async () => {
    const id = seedWorkflow();
    const res = await app().request(`/v1/workflows/${id}`, {
      method: 'PATCH',
      headers: ctx.authHeaders,
      body: JSON.stringify({ title: 'Renamed' }),
    });
    expect(res.status).toBe(200);
  });
});

/** Insert a workflow_run row directly so the Runs/Output tabs have data. */
function seedRun(
  workflowId: string,
  opts: {
    status?: 'CREATED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
    startedAt?: string;
    completedAt?: string | null;
    completedNodeIds?: string[];
    nodeStates?: Record<string, unknown>;
  } = {},
) {
  const id = randomUUID();
  const status = opts.status ?? 'COMPLETED';
  ctx.db
    .insert(schema.workflowRuns)
    .values({
      id,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      workflowId,
      userId: ctx.user.id,
      status,
      runState: {
        runId: id,
        workflowId,
        status,
        readyQueue: [],
        waitingInputs: {},
        nodeStates: opts.nodeStates ?? {},
        activeExecutions: {},
        completedNodeIds: opts.completedNodeIds ?? [],
        failedNodeIds: [],
        skippedNodeIds: [],
        graphRevision: 0,
        replanCount: 0,
        lastLedgerSequence: 0,
      },
      startedAt: opts.startedAt ?? new Date().toISOString(),
      completedAt: opts.completedAt === undefined ? new Date().toISOString() : opts.completedAt,
    })
    .run();
  return id;
}

describe('GET /v1/workflows/:id/runs', () => {
  it('returns runs scoped to the workflow, newest-first', async () => {
    const id = seedWorkflow();
    seedRun(id, { status: 'COMPLETED' });
    seedRun(id, { status: 'FAILED' });
    const res = await app().request(`/v1/workflows/${id}/runs`, { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runs: Array<{ id: string; status: string; triggeredBy: string; durationMs: number | null }>;
    };
    expect(body.runs).toHaveLength(2);
    expect(body.runs[0]!.triggeredBy).toBe('manual');
    expect(['completed', 'failed']).toContain(body.runs[0]!.status);
  });

  it('returns 404 for an unknown workflow', async () => {
    const res = await app().request(`/v1/workflows/${randomUUID()}/runs`, { headers: ctx.authHeaders });
    expect(res.status).toBe(404);
  });
});

describe('GET /v1/workflows/:id/output', () => {
  it('returns null when no completed run exists', async () => {
    const id = seedWorkflow();
    const res = await app().request(`/v1/workflows/${id}/output`, { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lastRun: unknown; outputs: unknown[] };
    expect(body.lastRun).toBeNull();
    expect(body.outputs).toEqual([]);
  });

  it('surfaces sink node outputs of the latest completed run', async () => {
    const id = seedWorkflow();
    seedRun(id, {
      status: 'COMPLETED',
      completedNodeIds: ['start'],
      nodeStates: {
        start: {
          nodeId: 'start',
          status: 'COMPLETED',
          completedAt: new Date().toISOString(),
          outputData: { text: 'hello world' },
        },
      },
    });
    const res = await app().request(`/v1/workflows/${id}/output`, { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lastRun: { status: string };
      outputs: Array<{ nodeId: string; value: { text: string } }>;
    };
    expect(body.lastRun.status).toBe('completed');
    expect(body.outputs).toHaveLength(1);
    expect(body.outputs[0]!.nodeId).toBe('start');
    expect(body.outputs[0]!.value.text).toBe('hello world');
  });

  it('returns all completed sink outputs newest-first when no nodes are declared outputs', async () => {
    const graph: WorkflowGraph = {
      version: 1,
      nodes: [
        { id: 'start', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'draft', type: 'agent_task', title: 'Draft', position: { x: 100, y: -80 }, config: { kind: 'agent_task', prompt: 'Draft', capabilityTags: [], inputKeys: [], outputKeys: [] } },
        { id: 'summary', type: 'agent_task', title: 'Summary', position: { x: 100, y: 80 }, config: { kind: 'agent_task', prompt: 'Summarize', capabilityTags: [], inputKeys: [], outputKeys: [] } },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'draft' },
        { id: 'e2', source: 'start', target: 'summary' },
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    const id = seedWorkflow(graph);
    seedRun(id, {
      status: 'COMPLETED',
      completedNodeIds: ['start', 'draft', 'summary'],
      nodeStates: {
        start: { nodeId: 'start', status: 'COMPLETED', completedAt: '2026-01-01T10:00:00.000Z', outputData: { text: 'start' } },
        draft: { nodeId: 'draft', status: 'COMPLETED', completedAt: '2026-01-01T10:01:00.000Z', outputData: { text: 'draft' } },
        summary: { nodeId: 'summary', status: 'COMPLETED', completedAt: '2026-01-01T10:02:00.000Z', outputData: { text: 'summary' } },
      },
    });

    const res = await app().request(`/v1/workflows/${id}/output`, { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outputs: Array<{ nodeId: string }> };
    expect(body.outputs.map((output) => output.nodeId)).toEqual(['summary', 'draft']);
  });

  it('uses declared output nodes instead of sink fallback when any are marked', async () => {
    const graph: WorkflowGraph = {
      version: 1,
      nodes: [
        { id: 'start', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'draft', type: 'agent_task', title: 'Draft', position: { x: 100, y: -80 }, config: { kind: 'agent_task', prompt: 'Draft', capabilityTags: [], inputKeys: [], outputKeys: [], isOutput: true } },
        { id: 'summary', type: 'agent_task', title: 'Summary', position: { x: 100, y: 80 }, config: { kind: 'agent_task', prompt: 'Summarize', capabilityTags: [], inputKeys: [], outputKeys: [] } },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'draft' },
        { id: 'e2', source: 'start', target: 'summary' },
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    const id = seedWorkflow(graph);
    seedRun(id, {
      status: 'COMPLETED',
      completedNodeIds: ['start', 'draft', 'summary'],
      nodeStates: {
        start: { nodeId: 'start', status: 'COMPLETED', completedAt: '2026-01-01T10:00:00.000Z', outputData: { text: 'start' } },
        draft: { nodeId: 'draft', status: 'COMPLETED', completedAt: '2026-01-01T10:01:00.000Z', outputData: { text: 'draft' } },
        summary: { nodeId: 'summary', status: 'COMPLETED', completedAt: '2026-01-01T10:02:00.000Z', outputData: { text: 'summary' } },
      },
    });

    const res = await app().request(`/v1/workflows/${id}/output`, { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outputs: Array<{ nodeId: string; value: { text: string } }> };
    expect(body.outputs).toHaveLength(1);
    expect(body.outputs[0]!.nodeId).toBe('draft');
    expect(body.outputs[0]!.value.text).toBe('draft');
  });

  it('does not fall back to sink outputs when declared output nodes did not complete', async () => {
    const graph: WorkflowGraph = {
      version: 1,
      nodes: [
        { id: 'start', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'draft', type: 'agent_task', title: 'Draft', position: { x: 100, y: -80 }, config: { kind: 'agent_task', prompt: 'Draft', capabilityTags: [], inputKeys: [], outputKeys: [], isOutput: true } },
        { id: 'summary', type: 'agent_task', title: 'Summary', position: { x: 100, y: 80 }, config: { kind: 'agent_task', prompt: 'Summarize', capabilityTags: [], inputKeys: [], outputKeys: [] } },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'draft' },
        { id: 'e2', source: 'start', target: 'summary' },
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    const id = seedWorkflow(graph);
    seedRun(id, {
      status: 'COMPLETED',
      completedNodeIds: ['start', 'summary'],
      nodeStates: {
        start: { nodeId: 'start', status: 'COMPLETED', completedAt: '2026-01-01T10:00:00.000Z', outputData: { text: 'start' } },
        summary: { nodeId: 'summary', status: 'COMPLETED', completedAt: '2026-01-01T10:02:00.000Z', outputData: { text: 'summary' } },
      },
    });

    const res = await app().request(`/v1/workflows/${id}/output`, { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outputs: Array<{ nodeId: string }> };
    expect(body.outputs).toEqual([]);
  });
});

describe('GET /v1/workflows/:id/records', () => {
  it('returns an empty table list when the graph has no data_write nodes', async () => {
    const id = seedWorkflow();
    const res = await app().request(`/v1/workflows/${id}/records`, { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tables: unknown[] };
    expect(body.tables).toEqual([]);
  });
});

describe('POST /v1/workflows/:id/run', () => {
  it('rejects an empty-graph workflow with WORKFLOW_GRAPH_INVALID', async () => {
    const id = seedWorkflow({ version: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } });
    const res = await app().request(`/v1/workflows/${id}/run`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('WORKFLOW_GRAPH_INVALID');
  });

  it('starts a run and returns 202', async () => {
    const id = seedWorkflow();
    const res = await app().request(`/v1/workflows/${id}/run`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(202);
    expect(engine.startRun).toHaveBeenCalledOnce();
    const body = (await res.json()) as { runId: string };
    expect(body.runId).toBeTruthy();
  });
});
