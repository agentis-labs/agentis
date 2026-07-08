/**
 * /v1/runs/:runId/replay — route unit tests.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { buildReplayRoutes } from '../../src/routes/replay.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import type { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import type { PartialReplayService } from '../../src/services/partialReplay.js';

let ctx: TestContext;
let engine: { startRun: ReturnType<typeof vi.fn> };
let replay: { prepare: ReturnType<typeof vi.fn>; persistChildRun: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  ctx = await createTestContext();
  engine = { startRun: vi.fn().mockResolvedValue(undefined) };
  replay = {
    prepare: vi.fn(),
    persistChildRun: vi.fn(),
  };
});

function app() {
  return ctx.buildApp([
    {
      path: '/v1/runs',
      app: buildReplayRoutes({
        db: ctx.db,
        auth: ctx.auth,
        engine: engine as unknown as WorkflowEngine,
        replay: replay as unknown as PartialReplayService,
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
      status: 'COMPLETED',
      runState: {},
    })
    .run();
  return { wfId, runId };
}

describe('POST /v1/runs/:runId/replay', () => {
  it('starts a replay and returns 202 with new runId', async () => {
    const { wfId, runId } = seedRun();
    const newRunId = randomUUID();
    replay.prepare.mockReturnValue({
      runId: newRunId,
      workflowId: wfId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      inputs: {},
      initialState: {},
      graph: { version: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
    });
    const res = await app().request(`/v1/runs/${runId}/replay`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ mode: 'replay-from-checkpoint' }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { runId: string; parentRunId: string };
    expect(body.runId).toBe(newRunId);
    expect(body.parentRunId).toBe(runId);
    expect(engine.startRun).toHaveBeenCalledOnce();
  });

  it('returns 404 WORKFLOW_RUN_NOT_FOUND for unknown source run', async () => {
    const res = await app().request(`/v1/runs/${randomUUID()}/replay`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ mode: 'replay-from-checkpoint' }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('WORKFLOW_RUN_NOT_FOUND');
  });

  it('returns 422 on invalid replay mode', async () => {
    const { runId } = seedRun();
    const res = await app().request(`/v1/runs/${runId}/replay`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ mode: 'not-a-mode' }),
    });
    expect(res.status).toBe(422);
  });

  it('rejects without auth (401)', async () => {
    const { runId } = seedRun();
    const res = await app().request(`/v1/runs/${runId}/replay`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'replay-from-checkpoint' }),
    });
    expect(res.status).toBe(401);
  });
});
