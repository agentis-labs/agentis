import { test, expect } from '../fixtures';
import { apiAuth, type ApiAuthCtx } from './_helpers';

let ctx: ApiAuthCtx;

test.beforeAll(async ({ request }) => {
  ctx = await apiAuth(request);
});

function scratchpadGraph() {
  return {
    version: 1,
    nodes: [
      {
        id: 'scratch_1',
        type: 'scratchpad',
        title: 'Capture input',
        position: { x: 0, y: 0 },
        config: { kind: 'scratchpad', operation: 'write', key: 'payload' },
      },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

test.describe('/v1/ephemeral', () => {
  test('runs a temporary graph without creating a workflow parent', async ({ request }) => {
    const res = await request.post('/v1/ephemeral/run', {
      headers: ctx.headers,
      data: {
        title: 'One-off scratchpad capture',
        graph: scratchpadGraph(),
        inputs: { value: 'hello' },
        maxDurationMs: 5000,
      },
    });
    expect(res.status()).toBe(202);
    const body = await res.json();
    expect(body.runId).toBeTruthy();
    expect(body.workflowId).toBeNull();
    expect(body.isEphemeral).toBe(true);

    const runRes = await request.get(`/v1/runs/${body.runId}`, { headers: ctx.headers });
    expect(runRes.ok()).toBeTruthy();
    const runBody = await runRes.json();
    expect(runBody.run.workflowId).toBeNull();
    expect(runBody.run.isEphemeral).toBe(true);
    expect(runBody.run.ephemeralTitle).toBe('One-off scratchpad capture');
    expect(runBody.run.graphSnapshot.nodes).toHaveLength(1);
  });

  test('promotes an ephemeral run graph into a saved workflow', async ({ request }) => {
    const runRes = await request.post('/v1/ephemeral/run', {
      headers: ctx.headers,
      data: { title: 'Promotable one-off', graph: scratchpadGraph(), inputs: {} },
    });
    expect(runRes.status()).toBe(202);
    const runBody = await runRes.json();

    const promoteRes = await request.post(`/v1/ephemeral/${runBody.runId}/promote`, {
      headers: ctx.headers,
      data: { title: 'Saved from chat' },
    });
    expect(promoteRes.status()).toBe(201);
    const promoteBody = await promoteRes.json();
    expect(promoteBody.workflow.id).toBeTruthy();
    expect(promoteBody.workflow.title).toBe('Saved from chat');
    expect(promoteBody.workflow.graph.nodes).toHaveLength(1);

    const workflowRes = await request.get(`/v1/workflows/${promoteBody.workflow.id}`, { headers: ctx.headers });
    expect(workflowRes.ok()).toBeTruthy();
  });
});
