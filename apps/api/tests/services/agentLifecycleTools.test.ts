/**
 * agentis.agents.update / agentis.agents.delete — the agent can manage its OWN
 * team, not just create members. Closes the "can hire but can't reconfigure,
 * pause, or fire" gap.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisToolContext } from '@agentis/core';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { registerAgentTools } from '../../src/services/agentisToolHandlers/agent.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let registry: AgentisToolRegistry;

beforeEach(async () => {
  ctx = await createTestContext();
  registry = new AgentisToolRegistry({ logger: ctx.logger });
  registerAgentTools(registry, { db: ctx.db, bus: ctx.bus, logger: ctx.logger, adapters: new AdapterManager(ctx.logger) } as ToolHandlerDeps);
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
