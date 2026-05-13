import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import type { WorkflowGraph } from '@agentis/core';
import { WorkflowEngine, type EngineDeps } from '../../src/engine/WorkflowEngine.js';
import { LedgerService } from '../../src/services/ledger.js';
import { ScratchpadService } from '../../src/services/scratchpad.js';
import { ActivityFeedService } from '../../src/services/activityFeed.js';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import type { SkillRuntime } from '../../src/services/skillRuntime.js';
import { WorkflowDeploymentService } from '../../src/services/workflowDeployments.js';
import { McpInteropService } from '../../src/services/mcpInterop.js';
import { buildDeploymentRoutes, buildPublicDeploymentRoutes } from '../../src/routes/deployments.js';
import { buildMcpProtocolRoutes, buildMcpRoutes } from '../../src/routes/mcp.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let deployments: WorkflowDeploymentService;
let mcp: McpInteropService;

beforeEach(async () => {
  ctx = await createTestContext();
  const ledger = new LedgerService(ctx.db, ctx.bus);
  const scratchpad = new ScratchpadService(ctx.bus, ctx.logger);
  const activity = new ActivityFeedService(ctx.db, ctx.bus);
  const approvals = new ApprovalInboxService(ctx.db, ctx.bus);
  const adapters = new AdapterManager(ctx.logger);
  const engineDeps: EngineDeps = {
    db: ctx.db,
    bus: ctx.bus,
    logger: ctx.logger,
    ledger,
    scratchpad,
    activity,
    approvals,
    skills: {} as unknown as SkillRuntime,
    adapters,
  };
  const engine = new WorkflowEngine(engineDeps);
  deployments = new WorkflowDeploymentService(ctx.db, engine, ctx.bus);
  mcp = new McpInteropService(ctx.db, ctx.vault, deployments);
  engineDeps.mcp = mcp;
});

function app() {
  return ctx.buildApp([
    { path: '/v1/deployments', app: buildDeploymentRoutes({ db: ctx.db, auth: ctx.auth, deployments }) },
    { path: '/d', app: buildPublicDeploymentRoutes({ deployments }) },
    { path: '/v1/mcp', app: buildMcpRoutes({ db: ctx.db, auth: ctx.auth, mcp }) },
    { path: '/mcp', app: buildMcpProtocolRoutes({ mcp }) },
  ]);
}

function seedWorkflow(graph: WorkflowGraph) {
  const id = randomUUID();
  ctx.db.insert(schema.workflows).values({
    id,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    title: 'Deployable echo',
    graph,
    settings: {},
  }).run();
  return id;
}

const responseGraph: WorkflowGraph = {
  version: 1,
  nodes: [
    {
      id: 'trigger',
      type: 'trigger',
      title: 'Trigger',
      position: { x: 0, y: 0 },
      config: { kind: 'trigger', triggerType: 'manual' },
    },
    {
      id: 'response',
      type: 'response',
      title: 'Response',
      position: { x: 200, y: 0 },
      config: { kind: 'response', content: { ok: true }, statusCode: 200 },
    },
  ],
  edges: [{ id: 'e1', source: 'trigger', target: 'response' }],
  viewport: { x: 0, y: 0, zoom: 1 },
  variables: [],
};

afterEach(() => ctx.close());

describe('Sprint C deployments and MCP routes', () => {
  it('snapshots a workflow deployment and executes it through the public endpoint', async () => {
    const workflowId = seedWorkflow(responseGraph);
    const createRes = await app().request('/v1/deployments', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ workflowId, chatEnabled: true }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { deployment: { id: string; version: number }; apiKey: string };
    expect(created.deployment.version).toBe(1);

    const unauthorized = await app().request(`/d/${created.deployment.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inputs: {} }),
    });
    expect(unauthorized.status).toBe(403);

    const runRes = await app().request(`/d/${created.deployment.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agentis-api-key': created.apiKey },
      body: JSON.stringify({ inputs: { message: 'hello' }, syncTimeoutMs: 2000 }),
    });
    expect(runRes.status).toBe(200);
    const runBody = (await runRes.json()) as { status: string; response: { body?: { ok?: boolean } } };
    expect(runBody.status).toBe('COMPLETED');
    expect(runBody.response.body?.ok).toBe(true);
  });

  it('exposes a deployed workflow as an MCP tool', async () => {
    const workflowId = seedWorkflow(responseGraph);
    const deploymentRes = await app().request('/v1/deployments', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ workflowId }),
    });
    const deployment = (await deploymentRes.json()) as { deployment: { id: string } };

    const serverRes = await app().request('/v1/mcp/servers', {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ name: 'Workflow MCP', direction: 'expose' }),
    });
    expect(serverRes.status).toBe(201);
    const server = (await serverRes.json()) as { server: { id: string }; apiKey: string };

    const toolRes = await app().request(`/v1/mcp/servers/${server.server.id}/tools`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ deploymentId: deployment.deployment.id, toolName: 'echo_workflow' }),
    });
    expect(toolRes.status).toBe(201);

    const listRes = await app().request(`/mcp/${server.server.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mcp-api-key': server.apiKey },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const listBody = (await listRes.json()) as { result: { tools: Array<{ name: string }> } };
    expect(listBody.result.tools[0]?.name).toBe('echo_workflow');

    const callRes = await app().request(`/mcp/${server.server.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mcp-api-key': server.apiKey },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo_workflow', arguments: { message: 'hi' } } }),
    });
    const callBody = (await callRes.json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(callBody.result.isError).toBe(false);
    expect(callBody.result.content[0]?.text).toContain('ok');
  });
});
