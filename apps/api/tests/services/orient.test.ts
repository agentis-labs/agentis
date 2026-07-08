/**
 * agentis.orient — the platform describes itself (Agent-Native §F7). Proves the tool
 * returns the six-primitive model AND the caller's real inventory, so an agent binds
 * to what exists instead of minting duplicates.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { AppStore } from '@agentis/app';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { registerOrientTools } from '../../src/services/agentisToolHandlers/orient.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';
import type { AgentisToolContext } from '@agentis/core';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

function toolCtx(): AgentisToolContext {
  return { workspaceId: ctx.workspace.id, userId: ctx.user.id, caller: 'mcp' };
}

describe('agentis.orient', () => {
  it('returns the six-primitive model + the workspace inventory', async () => {
    // Seed a small world.
    const appId = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Acme Outreach' }).id;
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId, workspaceId: ctx.workspace.id, userId: ctx.user.id, name: 'Scout', adapterType: 'http',
      config: { residency: { enabled: true, intervalMinutes: 5 } },
    } as typeof schema.agents.$inferInsert).run();
    ctx.db.insert(schema.channelConnections).values({
      id: randomUUID(), workspaceId: ctx.workspace.id, userId: ctx.user.id, agentId, kind: 'whatsapp', name: 'Sales line', tokenEncrypted: 'x',
    }).run();

    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerOrientTools(registry, { db: ctx.db } as ToolHandlerDeps);
    const res = await registry.execute({ id: '', toolId: 'agentis.orient', arguments: {} }, toolCtx());

    expect(res.ok).toBe(true);
    const out = res.output as {
      model: { primitives: Record<string, string> };
      inventory: { apps: Array<{ name: string }>; agents: Array<{ name: string; resident: boolean }>; connections: Array<{ kind: string }>; counts: Record<string, number> };
      next: string;
    };
    // The ontology is present and complete.
    expect(Object.keys(out.model.primitives)).toEqual(['Agent', 'Subject', 'Connection', 'Orchestration', 'Experiment', 'Interface']);
    // The real inventory is reflected — the anti-duplication signal.
    expect(out.inventory.apps.some((a) => a.name === 'Acme Outreach')).toBe(true);
    expect(out.inventory.agents.find((a) => a.name === 'Scout')?.resident).toBe(true);
    expect(out.inventory.connections.some((c) => c.kind === 'whatsapp')).toBe(true);
    expect(out.inventory.counts.apps).toBe(1);
    expect(out.next).toMatch(/existing/i);
  });
});
