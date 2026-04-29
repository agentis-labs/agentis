/**
 * /v1/runs/:id/ledger — route unit tests (dedicated builder).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { buildLedgerRoutes } from '../../src/routes/ledger.js';
import { LedgerService } from '../../src/services/ledger.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let ledger: LedgerService;

beforeEach(async () => {
  ctx = await createTestContext();
  ledger = new LedgerService(ctx.db, ctx.bus);
});

function app() {
  return ctx.buildApp([
    {
      path: '/v1/runs',
      app: buildLedgerRoutes({ db: ctx.db, auth: ctx.auth, ledger }),
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
      runState: {},
    })
    .run();
  return runId;
}

describe('GET /v1/runs/:id/ledger (dedicated)', () => {
  it('returns events from the ledger service', async () => {
    const runId = seedRun();
    await ledger.append({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      runId,
      eventType: 'test.event',
      payload: { hello: 'world' },
    });
    const res = await app().request(`/v1/runs/${runId}/ledger`, { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<{ eventType: string }> };
    expect(body.events).toHaveLength(1);
    expect(body.events[0].eventType).toBe('test.event');
  });

  it('honors the ?after_sequence query parameter', async () => {
    const runId = seedRun();
    await ledger.append({ workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, runId, eventType: 'a' });
    await ledger.append({ workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, runId, eventType: 'b' });
    const res = await app().request(`/v1/runs/${runId}/ledger?after_sequence=1`, { headers: ctx.authHeaders });
    const body = (await res.json()) as { events: Array<{ eventType: string }> };
    expect(body.events).toHaveLength(1);
    expect(body.events[0].eventType).toBe('b');
  });

  it('returns 404 WORKFLOW_RUN_NOT_FOUND for unknown id', async () => {
    const res = await app().request(`/v1/runs/${randomUUID()}/ledger`, { headers: ctx.authHeaders });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('WORKFLOW_RUN_NOT_FOUND');
  });

  it('rejects without auth (401)', async () => {
    const runId = seedRun();
    const res = await app().request(`/v1/runs/${runId}/ledger`);
    expect(res.status).toBe(401);
  });
});
