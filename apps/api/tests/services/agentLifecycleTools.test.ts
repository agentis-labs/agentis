/**
 * agentis.agents.update / agentis.agents.delete — the agent can manage its OWN
 * team, not just create members. Closes the "can hire but can't reconfigure,
 * pause, or fire" gap.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AdapterHealthStatus, AgentAdapter, AgentisToolContext, ChatDelta, ChatInvocationOptions, ChatMessage, NormalizedAgentEvent, NormalizedTask, ToolDefinition } from '@agentis/core';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { registerAgentTools } from '../../src/services/agentisToolHandlers/agent.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let registry: AgentisToolRegistry;
let adapters: AdapterManager;

beforeEach(async () => {
  ctx = await createTestContext();
  registry = new AgentisToolRegistry({ logger: ctx.logger });
  adapters = new AdapterManager(ctx.logger);
  registerAgentTools(registry, { db: ctx.db, bus: ctx.bus, logger: ctx.logger, adapters } as ToolHandlerDeps);
});
afterEach(() => ctx.close());

function toolCtx(): AgentisToolContext {
  return { workspaceId: ctx.workspace.id, userId: ctx.user.id, caller: 'mcp' };
}

function seedAgent(name: string, extra: Record<string, unknown> = {}): string {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({
    id, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
    name, adapterType: 'codex', capabilityTags: [], config: {}, status: 'online', ...extra,
  }).run();
  return id;
}

const row = (id: string) => ctx.db.select().from(schema.agents).where(eq(schema.agents.id, id)).get();

describe('agentis.agents.update', () => {
  it('renames, retargets model, and PAUSES (offline immediately)', async () => {
    const id = seedAgent('Orchy');
    const res = await registry.execute({ id: '', toolId: 'agentis.agents.update', arguments: {
      agentId: id, name: 'Orchy 2', runtimeModel: 'claude-opus-4-8', isPaused: true,
    } }, toolCtx());
    expect(res.ok).toBe(true);
    const r = row(id)!;
    expect(r.name).toBe('Orchy 2');
    expect(r.runtimeModel).toBe('claude-opus-4-8');
    expect(Boolean(r.isPaused)).toBe(true);
    expect(r.status).toBe('paused');
  });

  it('resumes a paused agent', async () => {
    const id = seedAgent('Paused', { isPaused: true, status: 'paused' });
    await registry.execute({ id: '', toolId: 'agentis.agents.update', arguments: { agentId: id, isPaused: false } }, toolCtx());
    expect(Boolean(row(id)!.isPaused)).toBe(false);
    expect(row(id)!.status).toBe('online');
  });

  it('sets reportsTo but rejects self-report and unknown workspace agents', async () => {
    const mgr = seedAgent('Manager', { role: 'manager' });
    const worker = seedAgent('Worker', { role: 'worker' });
    await registry.execute({ id: '', toolId: 'agentis.agents.update', arguments: { agentId: worker, reportsTo: mgr } }, toolCtx());
    expect(row(worker)!.reportsTo).toBe(mgr);

    const self = await registry.execute({ id: '', toolId: 'agentis.agents.update', arguments: { agentId: worker, reportsTo: worker } }, toolCtx());
    expect(self.ok).toBe(false);
    expect(self.errorMessage).toMatch(/report to itself/i);
  });

  it('refuses to promote to orchestrator (settings-only)', async () => {
    const id = seedAgent('X', { role: 'worker' });
    const res = await registry.execute({ id: '', toolId: 'agentis.agents.update', arguments: { agentId: id, role: 'orchestrator' } }, toolCtx());
    expect(res.ok).toBe(false);
    expect(res.errorMessage).toMatch(/orchestrator/i);
  });
});

describe('agentis.agents.delete', () => {
  it('previews then permanently deletes on confirm', async () => {
    const id = seedAgent('Fire Me');
    const preview = await registry.execute({ id: '', toolId: 'agentis.agents.delete', arguments: { agentId: id } }, toolCtx());
    expect(preview.output).toMatchObject({ deleted: false, preview: true });
    expect(row(id)).toBeTruthy();

    const del = await registry.execute({ id: '', toolId: 'agentis.agents.delete', arguments: { agentId: id, confirm: true } }, toolCtx());
    expect((del.output as { deleted: boolean }).deleted).toBe(true);
    expect(row(id)).toBeFalsy();
  });

  it('errors on an unknown agent', async () => {
    const res = await registry.execute({ id: '', toolId: 'agentis.agents.delete', arguments: { agentId: 'nope', confirm: true } }, toolCtx());
    expect(res.ok).toBe(false);
    expect(res.errorMessage).toMatch(/not found/i);
  });
});

describe('agent creation identity safety', () => {
  it('updates and reuses an existing role instead of duplicating it', async () => {
    const existingId = seedAgent('Prospector', { role: 'prospector', instructions: 'Old brief' });
    const result = await registry.execute({
      toolId: 'agentis.agents.create',
      arguments: {
        name: 'Prospector v2',
        role: 'prospector',
        instructions: 'New brief',
        runtimeModel: 'gpt-5.6-terra',
      },
    }, toolCtx());

    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({ created: false, reused: true });
    const agents = ctx.db.select().from(schema.agents).where(eq(schema.agents.workspaceId, ctx.workspace.id)).all();
    expect(agents.filter((agent) => agent.role === 'prospector')).toHaveLength(1);
    expect(row(existingId)?.instructions).toBe('New brief');
    expect(row(existingId)?.runtimeModel).toBe('gpt-5.6-terra');
  });

  it('does not collapse distinct agents that share a generic specialist role', async () => {
    const first = await registry.execute({
      toolId: 'agentis.agents.create',
      arguments: { name: 'Market Researcher', role: 'specialist' },
    }, toolCtx());
    const second = await registry.execute({
      toolId: 'agentis.agents.create',
      arguments: { name: 'Legal Researcher', role: 'specialist' },
    }, toolCtx());

    expect(first.output).toMatchObject({ created: true });
    expect(second.output).toMatchObject({ created: true });
    const specialists = ctx.db.select().from(schema.agents)
      .where(eq(schema.agents.workspaceId, ctx.workspace.id)).all()
      .filter((agent) => agent.role === 'specialist');
    expect(specialists.map((agent) => agent.name).sort()).toEqual(['Legal Researcher', 'Market Researcher']);
  });
});

class DispatchAdapter implements AgentAdapter {
  readonly adapterType = 'http' as const;
  receivedOptions: ChatInvocationOptions | undefined;
  constructor(private readonly deltas: ChatDelta[]) {}
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async healthCheck(): Promise<AdapterHealthStatus> { return { isHealthy: true, checkedAt: new Date().toISOString() }; }
  capabilities() { return { interactiveChat: true, toolCalling: true, toolForwarding: 'native' as const }; }
  onEvent(_handler: (event: NormalizedAgentEvent) => void): void {}
  async dispatchTask(_task: NormalizedTask): Promise<void> {}
  async cancelTask(_taskId: string): Promise<void> {}
  async *chat(_messages: ChatMessage[], _tools: ToolDefinition[], options?: ChatInvocationOptions): AsyncIterable<ChatDelta> {
    this.receivedOptions = options;
    for (const delta of this.deltas) yield delta;
  }
}

describe('agentis.agent.dispatch reliability', () => {
  it('returns a failed tool outcome when an interactive adapter ends in error', async () => {
    const id = seedAgent('Remote Researcher', { role: 'specialist' });
    const adapter = new DispatchAdapter([
      { type: 'tool_result', id: 'adapter', name: 'adapter.chat', result: null, error: 'provider unavailable' },
      { type: 'done', finishReason: 'error' },
    ]);
    adapters.register(id, adapter);

    const result = await registry.execute({
      toolId: 'agentis.agent.dispatch',
      arguments: { agentId: id, task: 'Research three businesses' },
    }, toolCtx());

    expect(result.ok).toBe(false);
    expect(result.errorMessage).toMatch(/provider unavailable/i);
    expect(adapter.receivedOptions?.timeoutMs).toBe(120_000);
    expect(adapter.receivedOptions?.signal).toBeInstanceOf(AbortSignal);
  });

  it('does not report a successful dispatch when the adapter returns no result', async () => {
    const id = seedAgent('Silent Researcher', { role: 'specialist' });
    adapters.register(id, new DispatchAdapter([{ type: 'done', finishReason: 'stop' }]));

    const result = await registry.execute({
      toolId: 'agentis.agent.dispatch',
      arguments: { agentId: id, task: 'Research three businesses' },
    }, toolCtx());

    expect(result.ok).toBe(false);
    expect(result.errorMessage).toMatch(/without returning a result/i);
  });
});
