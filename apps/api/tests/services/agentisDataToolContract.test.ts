/**
 * Agentis data-tool CONTRACT tests — the n8n lesson applied: what the agent is
 * told (advertised inputSchema) must match what is enforced (zod), the error on a
 * wrong shape must be instructive, and the target App must resolve without the
 * agent hunting for it. These are the exact failures captured in the live run
 * (`data_query` sort drift → INTERNAL_TOOL_ERROR; "no App in context").
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataQuerySchema, type AgentisToolContext } from '@agentis/core';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { registerAppDataTools } from '../../src/services/agentisToolHandlers/appData.js';
import { MemoryStore } from '../../src/services/memoryStore.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';
import { createInProcessEventBus } from '../../src/event-bus.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let registry: AgentisToolRegistry;
let baseCtx: AgentisToolContext;

beforeEach(async () => {
  ctx = await createTestContext();
  registry = new AgentisToolRegistry({ logger: ctx.logger });
  registerAppDataTools(registry, {
    db: ctx.db, logger: ctx.logger, bus: createInProcessEventBus(), memory: new MemoryStore(ctx.db, ctx.logger),
  } as unknown as ToolHandlerDeps);
  baseCtx = { workspaceId: ctx.workspace.id, userId: ctx.user.id, caller: 'mcp' };
});
afterEach(() => ctx.close());

const exec = (toolId: string, args: Record<string, unknown>) => registry.execute({ id: 'r', toolId, arguments: args }, baseCtx);

async function makeApp(name: string): Promise<string> {
  const res = await exec('agentis.app.create', { name });
  return (res.output as { appId: string }).appId;
}

describe('agentis data tool contract', () => {
  it('advertises the EXACT sort shape it enforces (no drift)', () => {
    const tool = registry.catalog().tools.find((t) => t.id === 'agentis.data.query')!;
    const sort = (tool.inputSchema as { properties: { sort: { type: string; items?: { type: string; required?: string[] } } } }).properties.sort;
    // Advertised: array of OBJECTS requiring `field` — matching querySortSchema.
    expect(sort.type).toBe('array');
    expect(sort.items?.type).toBe('object');
    expect(sort.items?.required).toContain('field');
    // Enforced zod agrees: object form passes, the string form the agent guessed fails.
    expect(() => dataQuerySchema.parse({ sort: [{ field: 'name', dir: 'asc' }] })).not.toThrow();
    expect(() => dataQuerySchema.parse({ sort: ['name'] })).toThrow();
  });

  it('accepts the documented sort shape and returns an INSTRUCTIVE error on the wrong one', async () => {
    const appId = await makeApp('Store');
    await exec('agentis.data.define_collection', { appId, name: 'orders', schema: { fields: [{ key: 'total', type: 'number', required: true }] } });

    const good = await exec('agentis.data.query', { appId, collection: 'orders', sort: [{ field: 'total', dir: 'desc' }] });
    expect(good.ok).toBe(true);

    const bad = await exec('agentis.data.query', { appId, collection: 'orders', sort: ['total'] });
    expect(bad.ok).toBe(false);
    expect(bad.errorCode).toBe('VALIDATION_FAILED');
    // Names the offending field + expected shape, not a raw ZodError dump.
    expect(bad.errorMessage).toMatch(/sort/);
    expect(bad.errorMessage).toMatch(/expected object/i);
    expect(bad.errorMessage).not.toMatch(/\[\s*\{[\s\S]*"code"/); // not the raw JSON array dump
  });

  it('auto-resolves the App when the workspace has exactly one (no appId, no viewport)', async () => {
    const appId = await makeApp('Solo App');
    await exec('agentis.data.define_collection', { appId, name: 'items', schema: { fields: [{ key: 'name', type: 'string', required: true }] } });
    const res = await exec('agentis.data.query', { collection: 'items' }); // NO appId
    expect(res.ok).toBe(true);
  });

  it('lists the available Apps (with ids) instead of a blind "no App in context"', async () => {
    const a = await makeApp('Alpha');
    await makeApp('Beta');
    await exec('agentis.data.define_collection', { appId: a, name: 'items', schema: { fields: [{ key: 'name', type: 'string', required: true }] } });
    const res = await exec('agentis.data.query', { collection: 'items' }); // ambiguous → instructive
    expect(res.ok).toBe(false);
    expect(res.errorMessage).toMatch(/Available apps/);
    expect(res.errorMessage).toMatch(/Alpha/);
    expect(res.errorMessage).toMatch(/Beta/);
  });
});
