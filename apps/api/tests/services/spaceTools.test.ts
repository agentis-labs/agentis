/**
 * agentis.space.create/update/delete — the agent can organize the org structure
 * (Domains/Spaces), not just read it. Mirrors the /v1/domains REST semantics.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisToolContext } from '@agentis/core';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { registerSpaceTools } from '../../src/services/agentisToolHandlers/spaceTools.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let registry: AgentisToolRegistry;
beforeEach(async () => {
  ctx = await createTestContext();
  registry = new AgentisToolRegistry({ logger: ctx.logger });
  registerSpaceTools(registry, { db: ctx.db, bus: ctx.bus, logger: ctx.logger } as ToolHandlerDeps);
});
afterEach(() => ctx.close());

const toolCtx = (): AgentisToolContext => ({ workspaceId: ctx.workspace.id, userId: ctx.user.id, caller: 'mcp' });
const domain = (id: string) => ctx.db.select().from(schema.domains).where(eq(schema.domains.id, id)).get();
function seedAgent(name: string): string {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({ id, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, name, adapterType: 'codex', capabilityTags: [], config: {}, status: 'online' }).run();
  return id;
}

describe('space tools', () => {
  it('creates a Domain and assigns the manager as its responsible specialist', async () => {
    const mgr = seedAgent('Lead');
    const res = await registry.execute({ id: '', toolId: 'agentis.space.create', arguments: { name: 'Marketing', managerId: mgr, colorHex: '#3b82f6' } }, toolCtx());
    expect(res.ok).toBe(true);
    const spaceId = (res.output as { spaceId: string }).spaceId;
    expect(domain(spaceId)!.name).toBe('Marketing');
    const agent = ctx.db.select().from(schema.agents).where(eq(schema.agents.id, mgr)).get()!;
    expect(agent.spaceId).toBe(spaceId);
    expect(agent.spaceTag).toBe('Marketing');
  });

  it('updates and rejects self-parenting', async () => {
    const spaceId = (await registry.execute({ id: '', toolId: 'agentis.space.create', arguments: { name: 'Ops' } }, toolCtx())).output as { spaceId: string };
    await registry.execute({ id: '', toolId: 'agentis.space.update', arguments: { spaceId: spaceId.spaceId, name: 'Operations', iconEmoji: '⚙️' } }, toolCtx());
    expect(domain(spaceId.spaceId)!.name).toBe('Operations');
    const bad = await registry.execute({ id: '', toolId: 'agentis.space.update', arguments: { spaceId: spaceId.spaceId, parentDomainId: spaceId.spaceId } }, toolCtx());
    expect(bad.ok).toBe(false);
    expect(bad.errorMessage).toMatch(/own parent/i);
  });

  it('deletes a Domain and un-groups its agents (spaceId cleared)', async () => {
    const mgr = seedAgent('Owner');
    const spaceId = ((await registry.execute({ id: '', toolId: 'agentis.space.create', arguments: { name: 'Sales', managerId: mgr } }, toolCtx())).output as { spaceId: string }).spaceId;
    expect(ctx.db.select().from(schema.agents).where(eq(schema.agents.id, mgr)).get()!.spaceId).toBe(spaceId);
    const del = await registry.execute({ id: '', toolId: 'agentis.space.delete', arguments: { spaceId } }, toolCtx());
    expect((del.output as { deleted: boolean }).deleted).toBe(true);
    expect(domain(spaceId)).toBeFalsy();
    // Agent survives, just un-grouped (FK set null).
    expect(ctx.db.select().from(schema.agents).where(eq(schema.agents.id, mgr)).get()!.spaceId).toBeNull();
  });
});
