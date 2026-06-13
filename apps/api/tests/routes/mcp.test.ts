/**
 * /v1/mcp — MCP publication layer (WORKFLOW-10X-MASTERPLAN §5).
 * Uses a real engine so run-and-return actually executes a deterministic workflow.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { buildMcpRoutes } from '../../src/routes/mcp.js';
import { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import { LedgerService } from '../../src/services/ledger.js';
import { ScratchpadService } from '../../src/services/scratchpad.js';
import { ActivityFeedService } from '../../src/services/activityFeed.js';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let engine: WorkflowEngine;

beforeEach(async () => {
  ctx = await createTestContext();
  engine = new WorkflowEngine({
    db: ctx.db, bus: ctx.bus, logger: ctx.logger,
    ledger: new LedgerService(ctx.db, ctx.bus),
    scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
    activity: new ActivityFeedService(ctx.db, ctx.bus),
    approvals: new ApprovalInboxService(ctx.db, ctx.bus),
    skills: {} as unknown as ExtensionRuntime,
    adapters: new AdapterManager(ctx.logger),
  });
});

afterEach(() => ctx.close());

function app() {
  return ctx.buildApp([{ path: '/v1/mcp', app: buildMcpRoutes({ db: ctx.db, auth: ctx.auth, engine }) }]);
}

function seedWorkflow(): string {
  const id = randomUUID();
  const graph: WorkflowGraph = {
    version: 1, viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      { id: 'P', type: 'transform', title: 'Produce', position: { x: 200, y: 0 }, config: { kind: 'transform', expression: '({ greeting: "hi " + (input.name || "world") })' } },
      { id: 'R', type: 'return_output', title: 'Return', position: { x: 400, y: 0 }, config: { kind: 'return_output', renderAs: 'json' } },
    ],
    edges: [{ id: 'e1', source: 'T', target: 'P' }, { id: 'e2', source: 'P', target: 'R' }],
  };
  ctx.db.insert(schema.workflows).values({
    id, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
    title: 'Greeter', description: 'Greets', graph, settings: {},
  }).run();
  return id;
}

describe('/v1/mcp', () => {
  it('publishes, lists, and runs a workflow as an MCP tool', async () => {
    const workflowId = seedWorkflow();
    const a = app();

    const pub = await a.request('/v1/mcp/publish', { method: 'POST', headers: ctx.authHeaders, body: JSON.stringify({ workflowId, slug: 'greeter' }) });
    expect(pub.status).toBe(200);
    expect((await pub.json()).toolName).toBe('agentis__greeter');

    const list = await a.request('/v1/mcp/tools', { headers: ctx.authHeaders });
    const tools = (await list.json()).tools as Array<{ name: string; slug: string }>;
    expect(tools.find((t) => t.slug === 'greeter')?.name).toBe('agentis__greeter');

    const run = await a.request('/v1/mcp/tools/greeter', { method: 'POST', headers: ctx.authHeaders, body: JSON.stringify({ inputs: { name: 'ada' } }) });
    expect(run.status).toBe(200);
    const result = await run.json() as { status: string; output: Record<string, { greeting?: string }> };
    expect(result.status).toBe('COMPLETED');
    expect(result.output.R.greeting).toBe('hi ada');
  });

  it('404s an unpublished slug', async () => {
    const a = app();
    const run = await a.request('/v1/mcp/tools/nope', { method: 'POST', headers: ctx.authHeaders, body: JSON.stringify({}) });
    expect(run.status).toBe(404);
  });
});
