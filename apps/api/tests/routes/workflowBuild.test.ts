/**
 * Builder Session §9 — POST /v1/workflows/build creates a workflow from a
 * natural-language description (deterministic path, no LLM configured).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@agentis/db/sqlite';
import { buildWorkflowBuildRoutes } from '../../src/routes/workflowBuild.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

function app() {
  // Only db/bus/logger are exercised by the deterministic build path.
  const tools = { db: ctx.db, bus: ctx.bus, logger: ctx.logger } as unknown as ToolHandlerDeps;
  return ctx.buildApp([{ path: '/v1/workflows', app: buildWorkflowBuildRoutes({ auth: ctx.auth, tools }) }]);
}

describe('/v1/workflows/build', () => {
  it('builds a persisted workflow from a description (no stream)', async () => {
    const a = app();
    const res = await a.request('/v1/workflows/build', {
      method: 'POST', headers: ctx.authHeaders,
      body: JSON.stringify({ description: 'Fetch tech blogs, rank the AI stories, and draft a digest', stream: false }),
    });
    expect(res.status).toBe(201);
    const out = await res.json() as { workflowId: string; nodeCount: number; graph: { nodes: unknown[] } };
    expect(out.nodeCount).toBeGreaterThan(0);

    const row = ctx.db.select().from(schema.workflows).all().find((w) => w.id === out.workflowId);
    expect(row).toBeTruthy();
    // stream:false persists the full graph immediately.
    expect((row!.graph as { nodes: unknown[] }).nodes.length).toBe(out.nodeCount);
  });

  it('builds deterministically from an approved (edited) plan — one node per phase', async () => {
    const a = app();
    const plan = {
      archetype: 'pipeline',
      phases: [
        { name: 'Gather', description: 'fetch sources', nodeKinds: ['agent_task'], agentRole: 'researcher', estimatedCostCents: [0, 1] },
        { name: 'Analyze', description: 'rank them', nodeKinds: ['agent_task'], agentRole: 'analyst', model: 'gpt-4o', estimatedCostCents: [1, 3] },
        { name: 'Deliver', description: 'email it', nodeKinds: ['integration'], requiredCredential: 'gmail', estimatedCostCents: [0, 0] },
      ],
      totalEstimatedCostCents: [1, 4],
      missingDependencies: [],
      requiresConfirmation: false,
    };
    const res = await a.request('/v1/workflows/build', {
      method: 'POST', headers: ctx.authHeaders,
      body: JSON.stringify({ description: 'research, analyze, email', stream: false, plan }),
    });
    expect(res.status).toBe(201);
    const out = await res.json() as { workflowId: string; graph: { nodes: Array<{ type: string; config: Record<string, unknown> }>; phases?: unknown[] } };
    const roles = out.graph.nodes.filter((n) => n.type === 'agent_task').map((n) => n.config.agentRole);
    expect(roles).toEqual(['researcher', 'analyst']);
    // Per-phase model edit round-trips onto the node.
    expect(out.graph.nodes.find((n) => n.config.agentRole === 'analyst')?.config.modelOverride).toBe('gpt-4o');
    // Delivery phase → integration node carrying the slug.
    expect(out.graph.nodes.some((n) => n.type === 'integration' && n.config.integrationId === 'gmail')).toBe(true);
    // Plan phases become real graph phase groups.
    expect(out.graph.phases?.length).toBe(3);
  });

  it('rejects an empty description', async () => {
    const a = app();
    const res = await a.request('/v1/workflows/build', {
      method: 'POST', headers: ctx.authHeaders, body: JSON.stringify({ description: '' }),
    });
    expect(res.status).toBe(422);
  });
});
