/**
 * /v1/a2a — Agent Cards (discovery) + message:send (task reception), Pillar 5.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { buildA2aRoutes } from '../../src/routes/a2a.js';
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
let adapters: AdapterManager;

beforeEach(async () => {
  ctx = await createTestContext();
  adapters = new AdapterManager(ctx.logger);
  engine = new WorkflowEngine({
    db: ctx.db, bus: ctx.bus, logger: ctx.logger,
    ledger: new LedgerService(ctx.db, ctx.bus),
    scratchpad: new ScratchpadService(ctx.bus, ctx.logger),
    activity: new ActivityFeedService(ctx.db, ctx.bus),
    approvals: new ApprovalInboxService(ctx.db, ctx.bus),
    skills: {} as unknown as ExtensionRuntime,
    adapters,
  });
});

afterEach(() => ctx.close());

function app() {
  return ctx.buildApp([{ path: '/v1/a2a', app: buildA2aRoutes({ db: ctx.db, auth: ctx.auth, adapters, engine }) }]);
}

function seedAgent(name: string): string {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({
    id, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
    name, description: 'A capable agent', adapterType: 'claude_code', capabilityTags: ['research'], config: {}, status: 'offline',
  }).run();
  return id;
}

function seedPublishedWorkflow(slug: string): void {
  const id = randomUUID();
  const graph: WorkflowGraph = {
    version: 1, viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      { id: 'P', type: 'transform', title: 'Produce', position: { x: 200, y: 0 }, config: { kind: 'transform', expression: '({ greeting: "hi " + (input.input || "world") })' } },
      { id: 'R', type: 'return_output', title: 'Return', position: { x: 400, y: 0 }, config: { kind: 'return_output', renderAs: 'json' } },
    ],
    edges: [{ id: 'e1', source: 'T', target: 'P' }, { id: 'e2', source: 'P', target: 'R' }],
  };
  ctx.db.insert(schema.workflows).values({
    id, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
    title: 'Greeter', description: 'Greets', graph, settings: { mcp: { published: true, slug } },
  }).run();
}

describe('/v1/a2a', () => {
  it('serves the workspace agent card with published workflows as skills', async () => {
    seedPublishedWorkflow('greeter');
    const res = await app().request('/v1/a2a/agent-card.json', { headers: ctx.authHeaders });
    const card = await res.json() as { protocolVersion: string; skills: Array<{ id: string }> };
    expect(card.protocolVersion).toBeTruthy();
    expect(card.skills.map((s) => s.id)).toContain('greeter');
  });

  it('serves a per-agent card with capability tags as skills', async () => {
    const agentId = seedAgent('Scout');
    const res = await app().request(`/v1/a2a/agents/${agentId}/card`, { headers: ctx.authHeaders });
    const card = await res.json() as { name: string; skills: Array<{ id: string }> };
    expect(card.name).toBe('Scout');
    expect(card.skills.map((s) => s.id)).toContain('tag:research');
  });

  it('runs a skill via message:send and returns an A2A task with the output artifact', async () => {
    seedPublishedWorkflow('greeter');
    const res = await app().request('/v1/a2a/message:send', {
      method: 'POST', headers: ctx.authHeaders,
      body: JSON.stringify({ skillId: 'greeter', message: { role: 'user', parts: [{ kind: 'text', text: 'ada' }] } }),
    });
    const task = await res.json() as { kind: string; status: { state: string }; artifacts: Array<{ parts: Array<{ data: unknown }> }> };
    expect(task.kind).toBe('task');
    expect(task.status.state).toBe('completed');
    expect((task.artifacts[0]!.parts[0]!.data as { R: { greeting: string } }).R.greeting).toBe('hi ada');
  });

  it('404s message:send for an unknown skill', async () => {
    const res = await app().request('/v1/a2a/message:send', {
      method: 'POST', headers: ctx.authHeaders,
      body: JSON.stringify({ skillId: 'nope', message: { parts: [{ kind: 'text', text: 'x' }] } }),
    });
    expect(res.status).toBe(404);
  });
});
