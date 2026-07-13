/**
 * /v1/mcp/rpc — protocol-compliant MCP JSON-RPC server (Pillar 5, expose half).
 * Verifies initialize, resource discovery, tools/list (workflows + registry),
 * and tools/call for both.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AgentAdapter, ChatDelta, WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { buildMcpRoutes } from '../../src/routes/mcp.js';
import { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import { LedgerService } from '../../src/services/ledger.js';
import { ScratchpadService } from '../../src/services/scratchpad.js';
import { ActivityFeedService } from '../../src/services/activityFeed.js';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { registerBuildTools } from '../../src/services/agentisToolHandlers/build.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';
import type { ExtensionRuntime } from '../../src/services/extensionRuntime.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let engine: WorkflowEngine;
let registry: AgentisToolRegistry;
let adapters: AdapterManager;

beforeEach(async () => {
  ctx = await createTestContext();
  const ledger = new LedgerService(ctx.db, ctx.bus);
  const scratchpad = new ScratchpadService(ctx.bus, ctx.logger);
  const activity = new ActivityFeedService(ctx.db, ctx.bus);
  const approvals = new ApprovalInboxService(ctx.db, ctx.bus);
  adapters = new AdapterManager(ctx.logger);
  engine = new WorkflowEngine({
    db: ctx.db, bus: ctx.bus, logger: ctx.logger,
    ledger,
    scratchpad,
    activity,
    approvals,
    skills: {} as unknown as ExtensionRuntime,
    adapters,
  });
  registry = new AgentisToolRegistry({ logger: ctx.logger });
  registerBuildTools(registry, {
    db: ctx.db,
    logger: ctx.logger,
    bus: ctx.bus,
    engine,
    adapters,
    ledger,
    scratchpad,
    approvals,
    activity,
    replay: {} as ToolHandlerDeps['replay'],
  } as ToolHandlerDeps);
  registry.register(
    { id: 'agentis.echo', family: 'inspect', description: 'Echo back the input', inputSchema: { type: 'object' }, mutating: false, mcpExposed: true },
    (args) => ({ echoed: args }),
  );
  registry.register(
    { id: 'agentis.secret', family: 'inspect', description: 'Not exposed', inputSchema: { type: 'object' }, mutating: false, mcpExposed: false },
    () => ({ nope: true }),
  );
  registry.register(
    { id: 'agentis.ctx', family: 'inspect', description: 'Return MCP call context', inputSchema: { type: 'object' }, mutating: false, mcpExposed: true },
    (_args, toolCtx) => ({ agentId: toolCtx.agentId ?? null }),
  );
  registry.register(
    { id: 'agentis.mutate', family: 'build', description: 'A mutating tool', inputSchema: { type: 'object' }, mutating: true, mcpExposed: true },
    () => ({ mutated: true }),
  );
});

afterEach(() => ctx.close());

function app() {
  return ctx.buildApp([{ path: '/v1/mcp', app: buildMcpRoutes({ db: ctx.db, auth: ctx.auth, engine, toolRegistry: registry }) }]);
}

function seedPublishedWorkflow(slug: string): void {
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
    title: 'Greeter', description: 'Greets', graph, settings: { mcp: { published: true, slug } },
  }).run();
}

function seedAgent(): string {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({
    id,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    name: 'MCP Agent',
    adapterType: 'codex',
    capabilityTags: [],
    config: {},
    status: 'online',
  }).run();
  return id;
}

function registerGraphBuilderAgent(agentId: string): void {
  const graph: WorkflowGraph = {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'trigger_manual', type: 'trigger', title: 'Manual Trigger', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      { id: 'produce_output', type: 'transform', title: 'Produce Output', position: { x: 280, y: 0 }, config: { kind: 'transform', expression: '{"text":"Workflow is working"}' } },
      { id: 'return_output', type: 'return_output', title: 'Return Output', position: { x: 560, y: 0 }, config: { kind: 'return_output', renderAs: 'text' } },
    ],
    edges: [
      { id: 'edge_trigger_manual_produce_output', source: 'trigger_manual', target: 'produce_output' },
      { id: 'edge_produce_output_return_output', source: 'produce_output', target: 'return_output' },
    ],
  };
  const adapter: AgentAdapter = {
    adapterType: 'codex' as AgentAdapter['adapterType'],
    async connect() {},
    async disconnect() {},
    async healthCheck() { return { isHealthy: true, checkedAt: new Date().toISOString() }; },
    capabilities: () => ({ interactiveChat: true }),
    onEvent() {},
    async dispatchTask() {},
    async cancelTask() {},
    chat(messages) {
      const system = String(messages.find((message) => message.role === 'system')?.content ?? '');
      const payload = system.includes('REVIEWER')
        ? { critiques: [] }
        : { graph };
      return (async function* () {
        yield { type: 'text', delta: JSON.stringify(payload) } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      })();
    },
  };
  adapters.register(agentId, adapter);
}

function rpc(a: ReturnType<typeof app>, method: string, params?: unknown, id: number | string = 1, headers: Record<string, string> = {}) {
  return a.request('/v1/mcp/rpc', {
    method: 'POST', headers: { ...ctx.authHeaders, ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
}

describe('/v1/mcp/rpc', () => {
  it('handles initialize', async () => {
    const res = await rpc(app(), 'initialize');
    const body = await res.json() as {
      result: {
        serverInfo: { name: string };
        protocolVersion: string;
        capabilities: { tools?: unknown; resources?: unknown };
        instructions?: string;
      };
    };
    expect(body.result.serverInfo.name).toBe('agentis');
    expect(typeof body.result.protocolVersion).toBe('string');
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.capabilities.resources).toBeDefined();
    // PAVED-ROAD P2 — doctrine at the door: external harnesses receive the
    // build loop + data-flow contract in the initialize result.
    expect(body.result.instructions).toBeTruthy();
    expect(body.result.instructions).toContain('AGENTIS BUILD LOOP');
    expect(body.result.instructions).toContain('agentis.workflow.dry_run');
    expect(body.result.instructions).toContain('agentis.workflow.loop_status');
  });

  it('exposes read-only workspace state as MCP resources (not an empty stub)', async () => {
    const resources = await (await rpc(app(), 'resources/list')).json() as {
      result: { resources: Array<{ uri: string; name: string; mimeType: string }> };
    };
    const uris = resources.result.resources.map((r) => r.uri);
    expect(uris).toContain('agentis://workspace');
    expect(uris).toContain('agentis://workflows');
    expect(uris).toContain('agentis://apps');
    expect(uris).toContain('agentis://agents');
    expect(uris).toContain('agentis://runs/recent');
    // Templates remain intentionally empty.
    const templates = await (await rpc(app(), 'resources/templates/list')).json() as { result: { resourceTemplates: unknown[] } };
    expect(templates.result.resourceTemplates).toEqual([]);
  });

  it('reads a resource: agentis://workflows reflects live workspace state', async () => {
    seedPublishedWorkflow('greeter');
    const res = await rpc(app(), 'resources/read', { uri: 'agentis://workflows' });
    const body = await res.json() as { result: { contents: Array<{ uri: string; mimeType: string; text: string }> } };
    const content = body.result.contents[0]!;
    expect(content.uri).toBe('agentis://workflows');
    expect(content.mimeType).toBe('application/json');
    const workflows = JSON.parse(content.text) as Array<{ title: string; publishedOverMcp: boolean }>;
    expect(workflows.find((w) => w.title === 'Greeter')?.publishedOverMcp).toBe(true);
  });

  it('reads the workspace overview with live counts', async () => {
    seedPublishedWorkflow('greeter');
    seedAgent();
    const res = await rpc(app(), 'resources/read', { uri: 'agentis://workspace' });
    const body = await res.json() as { result: { contents: Array<{ text: string }> } };
    const overview = JSON.parse(body.result.contents[0]!.text) as { counts: { workflows: number; agents: number } };
    expect(overview.counts.workflows).toBe(1);
    expect(overview.counts.agents).toBe(1);
  });

  it('rejects an unknown resource URI with invalid params', async () => {
    const res = await rpc(app(), 'resources/read', { uri: 'agentis://nope' });
    const body = await res.json() as { error?: { code: number } };
    expect(body.error?.code).toBe(-32602);
  });

  it('requires a uri for resources/read', async () => {
    const res = await rpc(app(), 'resources/read', {});
    const body = await res.json() as { error?: { code: number } };
    expect(body.error?.code).toBe(-32602);
  });

  it('lists published workflows and mcp-exposed registry tools, hiding non-exposed ones', async () => {
    seedPublishedWorkflow('greeter');
    const res = await rpc(app(), 'tools/list');
    const tools = (await res.json() as { result: { tools: Array<{ name: string }> } }).result.tools;
    const names = tools.map((t) => t.name);
    expect(names).toContain('agentis__greeter');
    expect(names).toContain('agentis.echo');
    expect(names).toContain('agentis.build_workflow');
    expect(names).not.toContain('agentis.secret');
  });

  it('calls a registry tool via tools/call', async () => {
    const res = await rpc(app(), 'tools/call', { name: 'agentis.echo', arguments: { hello: 'world' } });
    const body = await res.json() as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(body.result.isError).toBeFalsy();
    expect(JSON.parse(body.result.content[0]!.text)).toEqual({ echoed: { hello: 'world' } });
  });

  it('passes the MCP agent header into registry tool context', async () => {
    const agentId = seedAgent();
    const res = await rpc(app(), 'tools/call', { name: 'agentis.ctx', arguments: {} }, 1, { 'x-agentis-agent': agentId });
    const body = await res.json() as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(body.result.isError).toBeFalsy();
    expect(JSON.parse(body.result.content[0]!.text)).toEqual({ agentId });
  });

  it('creates a workflow through MCP build_workflow using the current agent model', async () => {
    const agentId = seedAgent();
    registerGraphBuilderAgent(agentId);

    const res = await rpc(app(), 'tools/call', {
      name: 'agentis.build_workflow',
      arguments: {
        title: 'Hello World MCP',
        description: 'Create a manual Hello World workflow that returns the fixed object { text: "Workflow is working" }.',
      },
    }, 1, { 'x-agentis-agent': agentId });
    const body = await res.json() as { result: { content: Array<{ text: string }>; isError?: boolean } };

    expect(body.result.isError).toBeFalsy();
    const output = JSON.parse(body.result.content[0]!.text) as { workflowId: string };
    const workflow = ctx.db.select().from(schema.workflows).all().find((row) => row.id === output.workflowId);
    expect(workflow?.title).toBe('Hello World MCP');
  });

  it('calls a published workflow via tools/call', async () => {
    seedPublishedWorkflow('greeter');
    const res = await rpc(app(), 'tools/call', { name: 'agentis__greeter', arguments: { name: 'ada' } });
    const body = await res.json() as { result: { content: Array<{ text: string }> } };
    const payload = JSON.parse(body.result.content[0]!.text) as { status: string; output: Record<string, { greeting?: string }> };
    expect(payload.status).toBe('COMPLETED');
    expect(payload.output.R.greeting).toBe('hi ada');
  });

  it('blocks a mutating tool in Plan mode (x-agentis-execution-mode: plan), but allows a read tool', async () => {
    // Mutating tool is registry-blocked, not just discouraged by the prompt.
    const blocked = await rpc(app(), 'tools/call', { name: 'agentis.mutate', arguments: {} }, 1, { 'x-agentis-execution-mode': 'plan' });
    const blockedBody = await blocked.json() as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(blockedBody.result.isError).toBe(true);
    expect(JSON.parse(blockedBody.result.content[0]!.text).code).toBe('PLAN_MODE_MUTATION_BLOCKED');

    // A read-only tool still works in Plan mode — inspection is never blocked.
    const allowed = await rpc(app(), 'tools/call', { name: 'agentis.echo', arguments: { ok: 1 } }, 2, { 'x-agentis-execution-mode': 'plan' });
    const allowedBody = await allowed.json() as { result: { isError?: boolean } };
    expect(allowedBody.result.isError).toBeFalsy();
  });

  it('blocks a mutating tool in Ask mode with a confirmation-required directive, but allows a read tool', async () => {
    const blocked = await rpc(app(), 'tools/call', { name: 'agentis.mutate', arguments: {} }, 1, { 'x-agentis-execution-mode': 'ask' });
    const blockedBody = await blocked.json() as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(blockedBody.result.isError).toBe(true);
    const payload = JSON.parse(blockedBody.result.content[0]!.text);
    expect(payload.code).toBe('ASK_MODE_CONFIRMATION_REQUIRED');
    // The directive must tell the model NOT to retry and to ask the operator.
    expect(payload.error).toMatch(/do not retry/i);
    expect(payload.error).toMatch(/approve|Auto/i);

    const allowed = await rpc(app(), 'tools/call', { name: 'agentis.echo', arguments: { ok: 1 } }, 2, { 'x-agentis-execution-mode': 'ask' });
    expect((await allowed.json() as { result: { isError?: boolean } }).result.isError).toBeFalsy();
  });

  it('allows the same mutating tool on a normal (chat) turn — no execution-mode header', async () => {
    const res = await rpc(app(), 'tools/call', { name: 'agentis.mutate', arguments: {} });
    const body = await res.json() as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(body.result.isError).toBeFalsy();
    expect(JSON.parse(body.result.content[0]!.text)).toEqual({ mutated: true });
  });

  it('refuses to call a non-exposed registry tool', async () => {
    const res = await rpc(app(), 'tools/call', { name: 'agentis.secret', arguments: {} });
    const body = await res.json() as { result: { isError?: boolean } };
    expect(body.result.isError).toBe(true);
  });

  it('returns method-not-found for unknown methods', async () => {
    const res = await rpc(app(), 'does/not/exist');
    const body = await res.json() as { error?: { code: number } };
    expect(body.error?.code).toBe(-32601);
  });
});
