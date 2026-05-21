/**
 * /v1/agents — route unit tests (GET surface).
 *
 * The mutation surface (POST/PATCH/DELETE/terminal/cancel-task) is built
 * by buildAgentMutationRoutes and exercised by D30 e2e specs; these unit
 * tests focus on the spec-required GET endpoints.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { buildAgentRoutes } from '../../src/routes/agents.js';
import { buildAgentMutationRoutes } from '../../src/routes/agentMutations.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import { ConversationStore } from '../../src/services/conversationStore.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let adapters: AdapterManager;
let conversations: ConversationStore;

beforeEach(async () => {
  ctx = await createTestContext();
  adapters = new AdapterManager(ctx.logger);
  conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
});

function app() {
  return ctx.buildApp([
    {
      path: '/v1/agents',
      app: buildAgentRoutes({
        db: ctx.db,
        auth: ctx.auth,
        vault: ctx.vault,
        adapters,
        logger: ctx.logger,
        conversations,
      }),
    },
  ]);
}

function mutationApp() {
  return ctx.buildApp([
    {
      path: '/v1/agents',
      app: buildAgentMutationRoutes({
        db: ctx.db,
        auth: ctx.auth,
        vault: ctx.vault,
        adapters,
        logger: ctx.logger,
        conversations,
      }),
    },
  ]);
}

function seedAgent() {
  const id = randomUUID();
  ctx.db
    .insert(schema.agents)
    .values({
      id,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'Test Agent',
      adapterType: 'http',
      capabilityTags: [],
      config: {},
      status: 'offline',
    })
    .run();
  return id;
}

describe('GET /v1/agents', () => {
  it('returns the workspace agents', async () => {
    seedAgent();
    const res = await app().request('/v1/agents', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: unknown[] };
    expect(body.agents).toHaveLength(1);
  });

  it('returns an empty list when none exist', async () => {
    const res = await app().request('/v1/agents', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: unknown[] };
    expect(body.agents).toEqual([]);
  });

  it('rejects without auth (401)', async () => {
    const res = await app().request('/v1/agents');
    expect(res.status).toBe(401);
  });

  it('includes daily metrics and connection counts for hierarchy nodes', async () => {
    const agentId = seedAgent();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const taskId = randomUUID();
    const now = new Date().toISOString();

    ctx.db
      .insert(schema.workflows)
      .values({
        id: workflowId,
        workspaceId: ctx.workspace.id,
        ambientId: ctx.ambient.id,
        userId: ctx.user.id,
        title: 'Agent workflow',
        summary: 'Daily execution path',
        graph: { nodes: [{ id: 'agent-step', agentId }] },
      })
      .run();

    ctx.db
      .insert(schema.workflowRuns)
      .values({
        id: runId,
        workspaceId: ctx.workspace.id,
        ambientId: ctx.ambient.id,
        workflowId,
        userId: ctx.user.id,
        status: 'COMPLETED',
        runState: { observability: { costMicros: 250_000 } },
        createdAt: now,
        updatedAt: now,
      })
      .run();

    ctx.db
      .insert(schema.tasks)
      .values({
        id: taskId,
        workspaceId: ctx.workspace.id,
        ambientId: ctx.ambient.id,
        workflowId,
        runId,
        userId: ctx.user.id,
        nodeId: 'agent-step',
        title: 'Handle request',
        description: 'Respond to today queue',
        executorType: 'agent',
        executorRef: agentId,
        capabilityTags: [],
        status: 'COMPLETED',
        inputData: {},
        outputData: {},
        createdAt: now,
        updatedAt: now,
      })
      .run();

    ctx.db
      .insert(schema.approvalRequests)
      .values({
        id: randomUUID(),
        workspaceId: ctx.workspace.id,
        ambientId: ctx.ambient.id,
        userId: ctx.user.id,
        runId,
        taskId,
        gatewayId: null,
        source: 'checkpoint',
        title: 'Approve outbound reply',
        summary: 'Needs operator review before sending.',
        confidence: 90,
        status: 'pending',
        createdAt: now,
      })
      .run();

    const res = await app().request('/v1/agents', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agents: Array<{
        id: string;
        runsToday: number;
        spendTodayCents: number;
        pendingApprovals: number;
        connectionCounts: { workflows: number };
      }>;
    };
    expect(body.agents).toEqual([
      expect.objectContaining({
        id: agentId,
        runsToday: 1,
        spendTodayCents: 25,
        pendingApprovals: 1,
        connectionCounts: { workflows: 1 },
      }),
    ]);
  });
});

describe('GET /v1/agents/:id', () => {
  it('returns the agent', async () => {
    const id = seedAgent();
    const res = await app().request(`/v1/agents/${id}`, { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agent: { id: string } };
    expect(body.agent.id).toBe(id);
  });

  it('returns 404 RESOURCE_NOT_FOUND for unknown id', async () => {
    const res = await app().request(`/v1/agents/${randomUUID()}`, { headers: ctx.authHeaders });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('agent hierarchy mutations', () => {
  it('keeps background-install agents in setting_up until setup reports a new status', async () => {
    const api = mutationApp();
    const created = await api.request('/v1/agents', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({
        name: 'Background Claude',
        adapterType: 'claude_code',
        role: 'worker',
        status: 'setting_up',
        config: { model: 'claude-sonnet-4-6' },
      }),
    });

    expect(created.status).toBe(201);
    const body = (await created.json()) as { agent: { id: string; status: string } };
    expect(body.agent.status).toBe('setting_up');

    const inserted = ctx.db
      .select({ status: schema.agents.status })
      .from(schema.agents)
      .where(eq(schema.agents.id, body.agent.id))
      .get();
    expect(inserted?.status).toBe('setting_up');

    const patched = await api.request(`/v1/agents/${body.agent.id}`, {
      method: 'PATCH',
      headers: ctx.authHeaders,
      body: JSON.stringify({ status: 'error' }),
    });
    expect(patched.status).toBe(200);

    const updated = ctx.db
      .select({ status: schema.agents.status })
      .from(schema.agents)
      .where(eq(schema.agents.id, body.agent.id))
      .get();
    expect(updated?.status).toBe('error');
  });

  it('rejects creating a second orchestrator in the same workspace', async () => {
    const api = mutationApp();
    const first = await api.request('/v1/agents', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({
        name: 'Workspace Orchestrator',
        adapterType: 'http',
        role: 'orchestrator',
        config: {},
      }),
    });
    expect(first.status).toBe(201);

    const second = await api.request('/v1/agents', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({
        name: 'Another Orchestrator',
        adapterType: 'http',
        role: 'orchestrator',
        config: {},
      }),
    });

    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: { code: string; details?: { id?: string } } };
    expect(body.error.code).toBe('WORKSPACE_ORCHESTRATOR_EXISTS');
    expect(body.error.details?.id).toBeTruthy();
  });

  it('rejects promoting a worker when an orchestrator already exists', async () => {
    const orchestratorId = seedAgent();
    const workerId = seedAgent();
    ctx.db.update(schema.agents).set({ role: 'orchestrator' }).where(eq(schema.agents.id, orchestratorId)).run();
    ctx.db.update(schema.agents).set({ role: 'worker' }).where(eq(schema.agents.id, workerId)).run();

    const res = await mutationApp().request(`/v1/agents/${workerId}`, {
      method: 'PATCH',
      headers: ctx.authHeaders,
      body: JSON.stringify({ role: 'orchestrator' }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; details?: { id?: string } } };
    expect(body.error.code).toBe('WORKSPACE_ORCHESTRATOR_EXISTS');
    expect(body.error.details?.id).toBe(orchestratorId);
  });

  it('puts runtime in standby immediately when isPaused is enabled', async () => {
    const api = mutationApp();
    const created = await api.request('/v1/agents', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({
        name: 'HTTP Worker',
        adapterType: 'http',
        config: { dispatchUrl: 'https://example.com/dispatch' },
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { agent: { id: string } };
    const agentId = createdBody.agent.id;
    expect(adapters.get(agentId)).toBeTruthy();

    const patched = await api.request(`/v1/agents/${agentId}`, {
      method: 'PATCH',
      headers: ctx.authHeaders,
      body: JSON.stringify({ isPaused: true }),
    });
    expect(patched.status).toBe(200);
    expect(adapters.get(agentId)).toBeUndefined();

    const row = ctx.db
      .select({ isPaused: schema.agents.isPaused, status: schema.agents.status })
      .from(schema.agents)
      .where(eq(schema.agents.id, agentId))
      .get();
    expect(row).toEqual(expect.objectContaining({ isPaused: true, status: 'paused' }));
  });

  it('reconnects runtime when leaving standby and persists operations fields', async () => {
    const managerId = seedAgent();
    const api = mutationApp();
    const created = await api.request('/v1/agents', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({
        name: 'Paused Worker',
        adapterType: 'http',
        isPaused: true,
        config: { dispatchUrl: 'https://example.com/dispatch' },
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { agent: { id: string } };
    const agentId = createdBody.agent.id;
    expect(adapters.get(agentId)).toBeUndefined();

    const patched = await api.request(`/v1/agents/${agentId}`, {
      method: 'PATCH',
      headers: ctx.authHeaders,
      body: JSON.stringify({
        isPaused: false,
        monthlyBudgetCents: 125_00,
        reportsTo: managerId,
      }),
    });
    expect(patched.status).toBe(200);
    expect(adapters.get(agentId)).toBeTruthy();

    const row = ctx.db
      .select({
        isPaused: schema.agents.isPaused,
        status: schema.agents.status,
        monthlyBudgetCents: schema.agents.monthlyBudgetCents,
        reportsTo: schema.agents.reportsTo,
      })
      .from(schema.agents)
      .where(eq(schema.agents.id, agentId))
      .get();
    expect(row).toEqual(expect.objectContaining({
      isPaused: false,
      status: 'online',
      monthlyBudgetCents: 125_00,
      reportsTo: managerId,
    }));
  });
});
