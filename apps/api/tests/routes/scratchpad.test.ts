/**
 * /v1/runs/:id/scratchpad — route unit tests.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { buildScratchpadRoutes } from '../../src/routes/scratchpad.js';
import { ScratchpadService } from '../../src/services/scratchpad.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let scratchpad: ScratchpadService;

beforeEach(async () => {
  ctx = await createTestContext();
  scratchpad = new ScratchpadService(ctx.bus, ctx.logger);
});

function app() {
  return ctx.buildApp([
    {
      path: '/v1/runs',
      app: buildScratchpadRoutes({ db: ctx.db, auth: ctx.auth, scratchpad }),
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
  return runId;
}

describe('GET /v1/runs/:id/scratchpad', () => {
  it('returns an empty snapshot for a fresh run', async () => {
    const runId = seedRun();
    const res = await app().request(`/v1/runs/${runId}/scratchpad`, { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scratchpad: Record<string, unknown> };
    expect(body.scratchpad).toEqual({});
  });

  it('reflects scratchpad writes', async () => {
    const runId = seedRun();
    scratchpad.write(runId, 'foo', 'bar');
    const res = await app().request(`/v1/runs/${runId}/scratchpad`, { headers: ctx.authHeaders });
    const body = (await res.json()) as { scratchpad: Record<string, unknown> };
    expect(body.scratchpad.foo).toBe('bar');
  });

  it('returns 404 with WORKFLOW_RUN_NOT_FOUND for unknown run', async () => {
    const res = await app().request(`/v1/runs/${randomUUID()}/scratchpad`, { headers: ctx.authHeaders });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('WORKFLOW_RUN_NOT_FOUND');
  });

  it('rejects without auth (401)', async () => {
    const runId = seedRun();
    const res = await app().request(`/v1/runs/${runId}/scratchpad`);
    expect(res.status).toBe(401);
  });
});
