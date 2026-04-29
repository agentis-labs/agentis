/**
 * /v1/runs — route unit tests.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { buildRunRoutes } from '../../src/routes/runs.js';
import { LedgerService } from '../../src/services/ledger.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import type { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';

let ctx: TestContext;
let engine: { startRun: ReturnType<typeof vi.fn>; cancelRun: ReturnType<typeof vi.fn> };
let ledger: LedgerService;

beforeEach(async () => {
  ctx = await createTestContext();
  engine = { startRun: vi.fn().mockResolvedValue(undefined), cancelRun: vi.fn().mockResolvedValue(undefined) };
  ledger = new LedgerService(ctx.db, ctx.bus);
});

function app() {
  return ctx.buildApp([
    {
      path: '/v1/runs',
      app: buildRunRoutes({
        db: ctx.db,
        auth: ctx.auth,
        engine: engine as unknown as WorkflowEngine,
        ledger,
      }),
    },
  ]);
}

function seedRun() {
  const wfId = randomUUID();
  const runId = randomUUID();
  ctx.db
    .insert(schema.workflows)
    .values({
      id: wfId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      title: 'WF',
      graph: { version: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
      settings: {},
    })
    .run();
  ctx.db
    .insert(schema.workflowRuns)
    .values({
      id: runId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      workflowId: wfId,
      userId: ctx.user.id,
      status: 'CREATED',
      runState: { runId, workflowId: wfId, status: 'CREATED', nodes: {} },
    })
    .run();
  return { wfId, runId };
}

describe('GET /v1/runs', () => {
  it('lists runs in the workspace', async () => {
    seedRun();
    const res = await app().request('/v1/runs', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: unknown[] };
    expect(body.runs).toHaveLength(1);
  });

  it('rejects without auth (401)', async () => {
    const res = await app().request('/v1/runs');
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/runs/:id', () => {
  it('returns the run', async () => {
    const { runId } = seedRun();
    const res = await app().request(`/v1/runs/${runId}`, { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
  });

  it('returns 404 with WORKFLOW_RUN_NOT_FOUND for unknown id', async () => {
    const res = await app().request(`/v1/runs/${randomUUID()}`, { headers: ctx.authHeaders });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('WORKFLOW_RUN_NOT_FOUND');
  });
});

describe('POST /v1/runs/:id/cancel', () => {
  it('calls engine.cancelRun and returns ok', async () => {
    const { runId } = seedRun();
    const res = await app().request(`/v1/runs/${runId}/cancel`, {
      method: 'POST',
      headers: ctx.authHeaders,
    });
    expect(res.status).toBe(200);
    expect(engine.cancelRun).toHaveBeenCalledWith(runId);
  });

  it('returns 404 for unknown run', async () => {
    const res = await app().request(`/v1/runs/${randomUUID()}/cancel`, {
      method: 'POST',
      headers: ctx.authHeaders,
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /v1/runs/:id/ledger', () => {
  it('returns an empty list for a fresh run', async () => {
    const { runId } = seedRun();
    const res = await app().request(`/v1/runs/${runId}/ledger`, { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[] };
    expect(Array.isArray(body.events)).toBe(true);
  });
});
