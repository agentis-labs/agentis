/**
 * /v1/workflows — route unit tests (V1-SPEC §3.3).
 *
 * Engine.startRun is stubbed via vi.fn() since these tests cover the route
 * surface, not engine semantics. Engine internals are exercised by the
 * dedicated engine test suites + e2e specs.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { buildWorkflowRoutes } from '../../src/routes/workflows.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import type { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import type { TriggerRuntime } from '../../src/engine/TriggerRuntime.js';

let ctx: TestContext;
let engine: { startRun: ReturnType<typeof vi.fn>; cancelRun: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  ctx = await createTestContext();
  engine = { startRun: vi.fn().mockResolvedValue(undefined), cancelRun: vi.fn().mockResolvedValue(undefined) };
});

function app(triggerRuntime?: TriggerRuntime) {
  return ctx.buildApp([
    {
      path: '/v1/workflows',
      app: buildWorkflowRoutes({
        db: ctx.db,
        auth: ctx.auth,
        engine: engine as unknown as WorkflowEngine,
        bus: ctx.bus,
        triggerRuntime,
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

  it('enriches workflow cards with the latest active run state', async () => {
    const graph: WorkflowGraph = {
      version: 1,
      nodes: [
        { id: 'start', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'draft', type: 'agent_task', title: 'Draft', position: { x: 100, y: 0 }, config: { kind: 'agent_task', prompt: 'Draft', capabilityTags: [], inputKeys: [], outputKeys: [] } },
      ],
      edges: [{ id: 'e1', source: 'start', target: 'draft' }],
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    const id = seedWorkflow(graph);
    seedRun(id, {
      status: 'RUNNING',
      completedAt: null,
      completedNodeIds: ['start'],
      nodeStates: {
        start: { nodeId: 'start', status: 'COMPLETED' },
        draft: { nodeId: 'draft', status: 'RUNNING' },
      },
    });

    const res = await app().request('/v1/workflows', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workflows: Array<{ id: string; status?: string; triggerType?: string; activeRunStep?: { current: number; total: number }; lastRun?: { status: string } }>;
    };
    expect(body.workflows[0]).toMatchObject({
      id,
      status: 'running',
      triggerType: 'manual',
      activeRunStep: { current: 2, total: 2 },
      lastRun: { status: 'running' },
    });
  });

  it('reports recoverable blocked runs as paused on workflow cards', async () => {
    const id = seedWorkflow();
    seedRun(id, {
      status: 'WAITING',
      completedAt: null,
      nodeStates: {
        start: {
          nodeId: 'start',
          status: 'WAITING',
          blockedReason: 'The model account is out of credits. Add credits or switch the agent model, then resume the run.',
        },
      },
    });

    const res = await app().request('/v1/workflows', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workflows: Array<{ id: string; status?: string; lastRun?: { status: string } }> };
    expect(body.workflows[0]).toMatchObject({
      id,
      status: 'paused',
      lastRun: { status: 'paused' },
    });
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

describe('workflow deployment', () => {
  it('publishes a cron workflow through TriggerRuntime and exposes its deployment', async () => {
    const graph: WorkflowGraph = {
      version: 1,
      nodes: [
        {
          id: 'schedule',
          type: 'trigger',
          title: 'Every five minutes',
          position: { x: 0, y: 0 },
          config: {
            kind: 'trigger',
            triggerType: 'cron',
            schedule: '*/5 * * * *',
            timezone: 'UTC',
          },
        },
      ],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    const id = seedWorkflow(graph);
    const activate = vi.fn(async (trigger: { triggerId: string }) => {
      ctx.db
        .update(schema.triggers)
        .set({ status: 'active' })
        .where(eq(schema.triggers.id, trigger.triggerId))
        .run();
    });
    const runtime = {
      activate,
      deactivate: vi.fn(async (triggerId: string) => {
        ctx.db
          .update(schema.triggers)
          .set({ status: 'paused' })
          .where(eq(schema.triggers.id, triggerId))
          .run();
      }),
      listeners: undefined,
    } as unknown as TriggerRuntime;

    const publish = await app(runtime).request(`/v1/workflows/${id}/publish`, {
      method: 'POST',
      headers: ctx.authHeaders,
    });

    expect(publish.status).toBe(200);
    expect(await publish.json()).toMatchObject({
      deployment: {
        triggerType: 'cron',
        status: 'active',
        config: { expression: '*/5 * * * *', timezone: 'UTC' },
      },
    });
    expect(activate).toHaveBeenCalledOnce();

    const row = ctx.db
      .select()
      .from(schema.triggers)
      .where(eq(schema.triggers.workflowId, id))
      .get();
    expect(row).toMatchObject({
      triggerType: 'cron',
      status: 'active',
      config: { expression: '*/5 * * * *', timezone: 'UTC' },
    });

    const deployment = await app(runtime).request(`/v1/workflows/${id}/deployment`, {
      headers: ctx.authHeaders,
    });
    expect(deployment.status).toBe(200);
    expect(await deployment.json()).toMatchObject({
      deployment: {
        triggerId: row?.id,
        triggerType: 'cron',
        status: 'active',
      },
    });
  });
});

/** Insert a workflow_run row directly so the Runs/Output tabs have data. */
function seedRun(
  workflowId: string,
  opts: {
    status?: 'CREATED' | 'PLANNING' | 'RUNNING' | 'WAITING' | 'COMPLETED' | 'COMPLETED_WITH_CONTRACT_VIOLATION' | 'COMPLETED_WITH_ERRORS' | 'FAILED' | 'CANCELLED';
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

  it('surfaces COMPLETED_WITH_ERRORS as failed instead of pending', async () => {
    const id = seedWorkflow();
    seedRun(id, { status: 'COMPLETED_WITH_ERRORS' });
    const res = await app().request(`/v1/workflows/${id}/runs`, { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: Array<{ status: string }> };
    expect(body.runs[0]?.status).toBe('failed');
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

  it('returns immutable output history newest-first', async () => {
    const id = seedWorkflow();
    const olderId = seedRun(id, {
      status: 'COMPLETED',
      startedAt: '2026-06-07T10:00:00.000Z',
      completedAt: '2026-06-07T10:01:00.000Z',
      completedNodeIds: ['start'],
      nodeStates: {
        start: { nodeId: 'start', status: 'COMPLETED', outputData: { text: 'older output' } },
      },
    });
    const newerId = seedRun(id, {
      status: 'COMPLETED',
      startedAt: '2026-06-08T10:00:00.000Z',
      completedAt: '2026-06-08T10:01:00.000Z',
      completedNodeIds: ['start'],
      nodeStates: {
        start: { nodeId: 'start', status: 'COMPLETED', outputData: { text: 'newer output' } },
      },
    });

    const res = await app().request(`/v1/workflows/${id}/output`, { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lastRun: { id: string };
      outputs: Array<{ value: { text: string } }>;
      runs: Array<{ run: { id: string }; outputs: Array<{ value: { text: string } }> }>;
    };
    expect(body.lastRun.id).toBe(newerId);
    expect(body.outputs[0]!.value.text).toBe('newer output');
    expect(body.runs.map((entry) => entry.run.id)).toEqual([newerId, olderId]);
    expect(body.runs[1]!.outputs[0]!.value.text).toBe('older output');
  });

  it('reconstructs the exact rendered email as a delivery output for historical runs', async () => {
    const graph: WorkflowGraph = {
      version: 1,
      nodes: [
        { id: 'start', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'draft', type: 'transform', title: 'Digest draft', position: { x: 100, y: 0 }, config: { kind: 'transform', expression: '({})' } },
        {
          id: 'send',
          type: 'integration',
          title: 'Send digest',
          position: { x: 200, y: 0 },
          config: {
            kind: 'integration',
            integrationId: 'agentmail',
            operationId: 'send_message',
            inputs: {
              to: 'operator@example.com',
              subject: '{{nodes.draft.subject}}',
              body: '{{nodes.draft.markdownBody}}',
              format: 'markdown',
            },
          } as never,
        },
        {
          id: 'summary',
          type: 'return_output',
          title: 'Delivery summary',
          position: { x: 300, y: 0 },
          config: { kind: 'return_output', renderAs: 'json' },
        },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'draft' },
        { id: 'e2', source: 'draft', target: 'send' },
        { id: 'e3', source: 'send', target: 'summary' },
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    const id = seedWorkflow(graph);
    seedRun(id, {
      status: 'COMPLETED',
      completedNodeIds: ['start', 'draft', 'send', 'summary'],
      nodeStates: {
        start: { nodeId: 'start', status: 'COMPLETED', inputData: {} },
        draft: {
          nodeId: 'draft',
          status: 'COMPLETED',
          outputData: {
            subject: 'Daily digest',
            markdownBody: '# Top story\n\n[Read it](https://example.com)',
          },
        },
        send: {
          nodeId: 'send',
          status: 'COMPLETED',
          outputData: { ok: true, status: 200 },
        },
        summary: {
          nodeId: 'summary',
          status: 'COMPLETED',
          outputData: { renderAs: 'json', value: { sent: true } },
        },
      },
    });

    const res = await app().request(`/v1/workflows/${id}/output`, { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      outputs: Array<{
        nodeId: string;
        role?: string;
        renderAs?: string;
        value: unknown;
        delivery?: { recipient?: string; subject?: string; contentType?: string };
      }>;
    };
    expect(body.outputs).toHaveLength(2);
    expect(body.outputs[0]).toMatchObject({
      nodeId: 'send',
      role: 'delivery',
      renderAs: 'html',
      delivery: {
        recipient: 'operator@example.com',
        subject: 'Daily digest',
        contentType: 'html',
      },
    });
    expect(String(body.outputs[0]!.value)).toContain('<h1>Top story</h1>');
    expect(String(body.outputs[0]!.value)).toContain('href="https://example.com"');
    expect(body.outputs[1]).toMatchObject({ nodeId: 'summary', role: 'declared', renderAs: 'json' });
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

  it('uses the latest terminal output even when the run finished with handled errors', async () => {
    const id = seedWorkflow();
    seedRun(id, {
      status: 'COMPLETED_WITH_ERRORS',
      completedNodeIds: ['start'],
      nodeStates: {
        start: {
          nodeId: 'start',
          status: 'COMPLETED',
          outputData: { text: 'caught and returned' },
          error: 'upstream failed but was handled',
        },
      },
    });
    const res = await app().request(`/v1/workflows/${id}/output`, { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lastRun: { status: string } | null; outputs: Array<{ value: { text?: string } }> };
    expect(body.lastRun?.status).toBe('failed');
    expect(body.outputs[0]?.value.text).toBe('caught and returned');
  });
});

describe('POST /v1/workflows/:id/run', () => {
  it('repairs integration operations generically before dispatching the run', async () => {
    const graph: WorkflowGraph = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: 'start',
          type: 'trigger',
          title: 'Manual',
          position: { x: 0, y: 0 },
          config: { kind: 'trigger', triggerType: 'manual' },
        },
        {
          id: 'send',
          type: 'integration',
          title: 'Send',
          position: { x: 200, y: 0 },
          config: { kind: 'integration', integrationId: 'agentmail', operationId: 'send_email', inputs: {} } as never,
        },
      ],
      edges: [{ id: 'e1', source: 'start', target: 'send' }],
    };
    const id = seedWorkflow(graph);
    const res = await app().request(`/v1/workflows/${id}/run`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ inputs: {} }),
    });
    expect(res.status).toBe(202);
    expect(engine.startRun).toHaveBeenCalledTimes(1);
    const call = engine.startRun.mock.calls[0]?.[0] as { graph: WorkflowGraph } | undefined;
    expect((call?.graph.nodes.find((node) => node.id === 'send')?.config as { operationId?: string } | undefined)?.operationId).toBe('send_message');
    const persisted = ctx.db.select().from(schema.workflows).where(eq(schema.workflows.id, id)).get();
    const send = ((persisted?.graph as WorkflowGraph).nodes.find((node) => node.id === 'send')?.config as { operationId?: string } | undefined);
    expect(send?.operationId).toBe('send_message');
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
