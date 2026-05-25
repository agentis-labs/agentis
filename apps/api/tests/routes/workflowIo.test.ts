/**
 * /v1/workflows export/import — Workflow as Code (§4).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { parse } from 'yaml';
import type { WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { buildWorkflowIoRoutes } from '../../src/routes/workflowIo.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

function app() {
  return ctx.buildApp([{ path: '/v1/workflows', app: buildWorkflowIoRoutes({ db: ctx.db, auth: ctx.auth }) }]);
}

function seed(): string {
  const id = randomUUID();
  const graph: WorkflowGraph = {
    version: 1, viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      { id: 'X', type: 'transform', title: 'Shape', position: { x: 200, y: 0 }, config: { kind: 'transform', expression: '({ ok: true })' } },
    ],
    edges: [{ id: 'e1', source: 'T', target: 'X' }],
  };
  ctx.db.insert(schema.workflows).values({
    id, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
    title: 'Round Trip', summary: 'rt', graph, settings: {},
  }).run();
  return id;
}

describe('/v1/workflows export+import', () => {
  it('exports a workflow to YAML and imports it back losslessly', async () => {
    const id = seed();
    const a = app();
    const exp = await a.request(`/v1/workflows/${id}/export`, { headers: ctx.authHeaders });
    expect(exp.status).toBe(200);
    const yaml = await exp.text();
    const doc = parse(yaml) as { name: string; graph: WorkflowGraph };
    expect(doc.name).toBe('Round Trip');
    expect(doc.graph.nodes).toHaveLength(2);

    const imp = await a.request('/v1/workflows/import', { method: 'POST', headers: ctx.authHeaders, body: JSON.stringify({ yaml }) });
    expect(imp.status).toBe(201);
    const out = await imp.json() as { workflowId: string; nodeCount: number };
    expect(out.nodeCount).toBe(2);
    const created = ctx.db.select().from(schema.workflows).all().find((w) => w.id === out.workflowId)!;
    expect((created.graph as WorkflowGraph).edges).toHaveLength(1);
  });

  it('plans a request into phase cards (Builder Session §9)', async () => {
    const a = app();
    const res = await a.request('/v1/workflows/plan', {
      method: 'POST', headers: ctx.authHeaders,
      body: JSON.stringify({ description: 'Fetch tech blogs, analyze and rank the AI stories, then draft a digest and email it' }),
    });
    expect(res.status).toBe(200);
    const { plan } = await res.json() as { plan: { phases: Array<{ name: string; agentRole?: string }>; totalEstimatedCostCents: [number, number] } };
    expect(plan.phases.length).toBeGreaterThanOrEqual(3);
    expect(plan.phases.some((p) => p.agentRole === 'researcher')).toBe(true);
    expect(plan.totalEstimatedCostCents).toHaveLength(2);
  });

  it('rejects YAML with an invalid graph', async () => {
    const a = app();
    const bad = await a.request('/v1/workflows/import', { method: 'POST', headers: ctx.authHeaders, body: JSON.stringify({ yaml: 'name: Bad\ngraph:\n  nodes:\n    - id: A\n      type: transform\n      title: A\n      position: { x: 0, y: 0 }\n      config: { kind: transform, expression: "1" }\n  edges:\n    - id: e1\n      source: A\n      target: GHOST\n' }) });
    expect(bad.status).toBe(422);
  });
});
