/**
 * The orchestrator/manager are BUILDERS, never task workers. materializeCast must
 * never leave an agent_task executed by the orchestrator — whether the node pinned
 * the orchestrator's id or was authored with role 'orchestrator' — and should
 * REUSE a capability-matched existing specialist before minting a new role.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { isSpecialistRole, type WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { SpecialistAgentService } from '../../src/services/specialist/specialistAgents.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import { materializeCast } from '../../src/services/agentisToolHandlers/build.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

function castDeps(): ToolHandlerDeps {
  return {
    db: ctx.db,
    specialists: new SpecialistAgentService(ctx.db),
    adapters: new AdapterManager(ctx.logger),
  } as unknown as ToolHandlerDeps;
}

function seedAgent(role: string): string {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({
    id, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
    name: role, role, adapterType: 'http', capabilityTags: [], config: {}, status: 'online',
  }).run();
  return id;
}

function agentTaskGraph(config: Record<string, unknown>): WorkflowGraph {
  return {
    nodes: [{ id: 'A', type: 'agent_task', title: 'Instagram Scout', position: { x: 0, y: 0 }, config: { kind: 'agent_task', prompt: 'find stores', ...config } }],
    edges: [],
  } as unknown as WorkflowGraph;
}

describe('materializeCast — orchestrator never executes a task', () => {
  it('re-casts a real specialist when a node pins the orchestrator', () => {
    const orchId = seedAgent('orchestrator');
    const { graph, cast } = materializeCast(
      agentTaskGraph({ agentId: orchId, capabilityTags: ['instagram-prospecting'] }),
      castDeps(), ctx.workspace.id, ctx.user.id,
    );
    const chosen = (graph.nodes[0]!.config as { agentId?: string }).agentId!;
    expect(chosen).not.toBe(orchId);
    const row = ctx.db.select({ role: schema.agents.role }).from(schema.agents).where(eq(schema.agents.id, chosen)).get();
    expect(isSpecialistRole(row?.role ?? null)).toBe(true);
    expect(cast.every((c) => c.agentId !== orchId)).toBe(true);
  });

  it('re-casts a specialist when a node is authored with role orchestrator', () => {
    seedAgent('orchestrator');
    const { graph } = materializeCast(
      agentTaskGraph({ agentRole: 'orchestrator', capabilityTags: ['fashion-icp-auditor'] }),
      castDeps(), ctx.workspace.id, ctx.user.id,
    );
    const role = (graph.nodes[0]!.config as { agentRole?: string }).agentRole!;
    expect(isSpecialistRole(role)).toBe(true);
    expect(role).not.toBe('orchestrator');
  });

  it('connects a freshly-cast specialist to a runtime (not an offline placeholder)', () => {
    const adapters = new AdapterManager(ctx.logger);
    const runtimeAdapter = {
      adapterType: 'claude_code',
      capabilities: () => ({ interactiveChat: true, toolCalling: false, toolForwarding: 'none' }),
      connect: async () => {},
      disconnect: async () => {},
      healthCheck: async () => ({ isHealthy: true, checkedAt: new Date().toISOString() }),
      dispatchTask: async () => {},
      cancelTask: async () => {},
      onEvent: () => {},
    } as unknown as import('@agentis/core').AgentAdapter;
    const deps = {
      db: ctx.db,
      logger: ctx.logger,
      specialists: new SpecialistAgentService(ctx.db),
      adapters,
      resolveAgentRuntime: () => runtimeAdapter,
    } as unknown as ToolHandlerDeps;

    const { graph } = materializeCast(agentTaskGraph({ agentRole: 'data_engineer' }), deps, ctx.workspace.id, ctx.user.id);
    const agentId = (graph.nodes[0]!.config as { agentId?: string }).agentId!;

    expect(adapters.get(agentId)).toBeTruthy(); // adapter registered = connected
    const row = ctx.db.select({ status: schema.agents.status, adapterType: schema.agents.adapterType })
      .from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    expect(row?.status).toBe('online');
    expect(row?.adapterType).toBe('claude_code');
  });

  it('reuses a capability-matched existing specialist instead of minting a new role', () => {
    const scoutId = seedAgent('instagram_fashion_store_scout');
    ctx.db.update(schema.agents).set({ capabilityTags: ['instagram-prospecting', 'fashion-icp-auditor'] }).where(eq(schema.agents.id, scoutId)).run();
    const { graph } = materializeCast(
      // no role, just capability tags that overlap the existing scout
      agentTaskGraph({ capabilityTags: ['instagram-prospecting'] }),
      castDeps(), ctx.workspace.id, ctx.user.id,
    );
    expect((graph.nodes[0]!.config as { agentId?: string }).agentId).toBe(scoutId);
  });
});
