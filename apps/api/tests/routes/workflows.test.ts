/**
 * /v1/workflows — route unit tests (V1-SPEC §3.3).
 *
 * Engine.startRun is stubbed via vi.fn() since these tests cover the route
 * surface, not engine semantics. Engine internals are exercised by the
 * dedicated engine test suites + e2e specs.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
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

function seedWorkflow(graph: ReturnType<typeof trivialGraph> | { version: 1; nodes: []; edges: []; viewport: { x: 0; y: 0; zoom: 1 } } = trivialGraph()) {
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
