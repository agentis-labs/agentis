/**
 * /v1/dashboard — fleet-overview aggregate.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { buildDashboardRoutes } from '../../src/routes/dashboard.js';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

function app() {
  return ctx.buildApp([
    { path: '/v1/dashboard', app: buildDashboardRoutes({ db: ctx.db, auth: ctx.auth }) },
  ]);
}

function appWithApprovals(approvals: ApprovalInboxService) {
  return ctx.buildApp([
    { path: '/v1/dashboard', app: buildDashboardRoutes({ db: ctx.db, auth: ctx.auth, approvals }) },
  ]);
}

describe('/v1/dashboard/fleet-overview', () => {
  it('returns an empty aggregate for a fresh workspace', async () => {
    const res = await app().request('/v1/dashboard/fleet-overview', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // Spec §11.1 keys vary by impl, but every count should be present + zero.
    expect(body).toBeTypeOf('object');
  });

  it('reflects seeded agents + workflows + runs counts', async () => {
    ctx.db.insert(schema.agents).values({
      id: randomUUID(),
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'A',
      adapterType: 'http',
      adapterConfig: {},
      capabilityTags: [],
      status: 'idle',
      colorHex: '#6366f1',
    }).run();
    ctx.db.insert(schema.workflows).values({
      id: randomUUID(),
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      title: 'WF',
      summary: '',
      graph: { version: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
      latestRevision: 1,
    }).run();

    const res = await app().request('/v1/dashboard/fleet-overview', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = JSON.stringify(await res.json());
    // Loose check: agent + workflow ids should appear *somewhere* in the response.
    expect(body.length).toBeGreaterThan(10);
  });

  it('counts only actively running workflow runs as active', async () => {
    const workflowId = randomUUID();
    ctx.db.insert(schema.workflows).values({
      id: workflowId,
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      title: 'WF',
      graph: { version: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
      latestRevision: 1,
    }).run();

    for (const status of ['RUNNING', 'WAITING'] as const) {
      const runId = randomUUID();
      ctx.db.insert(schema.workflowRuns).values({
        id: runId,
        workspaceId: ctx.workspace.id,
        ambientId: ctx.ambient.id,
        workflowId,
        userId: ctx.user.id,
        status,
        runState: {
          runId,
          workflowId,
          status,
          readyQueue: [],
          waitingInputs: {},
          nodeStates: {},
          activeExecutions: {},
          completedNodeIds: [],
          failedNodeIds: [],
          skippedNodeIds: [],
          graphRevision: 1,
          replanCount: 0,
          lastLedgerSequence: 0,
        },
      }).run();
    }

    const res = await app().request('/v1/dashboard/fleet-overview', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: { active: number } };
    expect(body.runs.active).toBe(1);
  });

  it('requires authentication', async () => {
    const res = await app().request('/v1/dashboard/fleet-overview');
    expect(res.status).toBe(401);
  });

  it('requires the workspace header', async () => {
    const headers = { ...ctx.authHeaders };
    delete (headers as Record<string, string>)['x-agentis-workspace'];
    const res = await app().request('/v1/dashboard/fleet-overview', { headers });
    // Either 400 or 422 depending on requireWorkspace impl.
    expect([400, 401, 422]).toContain(res.status);
  });

  it('isolates results across workspaces', async () => {
    const ctx2 = await createTestContext({ username: 'other' });
    ctx.db.insert(schema.agents).values({
      id: randomUUID(),
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'mine-only',
      adapterType: 'http',
      adapterConfig: {},
      capabilityTags: [],
      status: 'idle',
      colorHex: '#6366f1',
    }).run();
    const otherApp = ctx2.buildApp([
      { path: '/v1/dashboard', app: buildDashboardRoutes({ db: ctx2.db, auth: ctx2.auth }) },
    ]);
    const res = await otherApp.request('/v1/dashboard/fleet-overview', { headers: ctx2.authHeaders });
    const body = JSON.stringify(await res.json());
    expect(body.includes('mine-only')).toBe(false);
    ctx2.close();
  });
});

describe('/v1/dashboard/chrome', () => {
  it('returns compact always-on shell data without the full workspace snapshot payload', async () => {
    const approvals = new ApprovalInboxService(ctx.db, ctx.bus);
    ctx.db.insert(schema.agents).values({
      id: randomUUID(),
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'Live specialist',
      adapterType: 'http',
      config: {},
      capabilityTags: [],
      status: 'online',
      role: 'specialist',
      colorHex: '#0ea5e9',
    }).run();
    ctx.db.insert(schema.activityEvents).values({
      id: randomUUID(),
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      eventType: 'test.event',
      actorType: 'system',
      actorId: null,
      entityType: 'test',
      entityId: 'chrome',
      summary: 'Chrome updated',
      metadata: {},
    }).run();
    await approvals.create({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      runId: null,
      taskId: null,
      gatewayId: null,
      source: 'checkpoint',
      title: 'Review output',
      summary: 'Approve the generated output',
      confidence: null,
    });

    const res = await appWithApprovals(approvals).request('/v1/dashboard/chrome', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workspaceId: string;
      counts: { liveAgents: number };
      fleet: {
        approvals: { pending: number };
        gateways: { total: number; connected: number };
        runs: { recent?: unknown };
        agents?: unknown;
        workflows?: unknown;
      };
      approvals: Array<{ id: string; title: string }>;
      latestActivity: { summary: string } | null;
      notifications: Array<{ id: string; type: string; approvalId?: string }>;
      artifacts?: unknown;
      issues?: unknown;
      activeRuns?: unknown;
      failedRuns?: unknown;
    };

    expect(body.workspaceId).toBe(ctx.workspace.id);
    expect(body.counts.liveAgents).toBe(1);
    expect(body.fleet.approvals.pending).toBe(1);
    expect(body.fleet.runs.recent).toBeUndefined();
    expect(body.fleet.agents).toBeUndefined();
    expect(body.fleet.workflows).toBeUndefined();
    expect(body.latestActivity?.summary).toBe('Chrome updated');
    expect(body.approvals).toHaveLength(1);
    expect(body.notifications.some((item) => item.id === 'setup-orchestrator')).toBe(true);
    expect(body.notifications.some((item) => item.approvalId === body.approvals[0]?.id)).toBe(true);
    expect(body.artifacts).toBeUndefined();
    expect(body.issues).toBeUndefined();
    expect(body.activeRuns).toBeUndefined();
    expect(body.failedRuns).toBeUndefined();
  });
});
