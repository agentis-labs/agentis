/**
 * ActiveWorkflowRegistry — V1-SPEC §7.1.
 *
 * In-memory map of currently-live triggers backed by `triggers.status`
 * column updates on activate / deactivate.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { ActiveWorkflowRegistry, type ActiveTrigger } from '../../src/engine/ActiveWorkflowRegistry.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let registry: ActiveWorkflowRegistry;

beforeEach(async () => {
  ctx = await createTestContext();
  registry = new ActiveWorkflowRegistry(ctx.db, ctx.logger);
});
afterEach(() => ctx.close());

function seedTrigger(opts: { status?: string; type?: string; expression?: string } = {}) {
  const wfId = randomUUID();
  const triggerId = randomUUID();
  ctx.db
    .insert(schema.workflows)
    .values({
      id: wfId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      title: 'wf',
      graph: { version: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
      settings: {},
    })
    .run();
  ctx.db
    .insert(schema.triggers)
    .values({
      id: triggerId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      workflowId: wfId,
      userId: ctx.user.id,
      triggerType: opts.type ?? 'cron',
      config: opts.expression ? { expression: opts.expression } : {},
      status: opts.status ?? 'paused',
    })
    .run();
  const t: ActiveTrigger = {
    triggerId,
    workflowId: wfId,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    triggerType: (opts.type ?? 'cron') as ActiveTrigger['triggerType'],
    config: opts.expression ? { expression: opts.expression } : {},
  };
  return t;
}

describe('ActiveWorkflowRegistry', () => {
  it('activate stores in-memory and flips DB row to active', () => {
    const t = seedTrigger();
    registry.activate(t, async () => {});
    expect(registry.get(t.triggerId)).toEqual(t);
    expect(registry.list()).toHaveLength(1);
    const row = ctx.db.select().from(schema.triggers).where(eq(schema.triggers.id, t.triggerId)).get()!;
    expect(row.status).toBe('active');
  });

  it('deactivate runs cleanup, drops in-memory entry, flips DB row to paused', async () => {
    const t = seedTrigger();
    const cleanup = vi.fn().mockResolvedValue(undefined);
    registry.activate(t, cleanup);
    await registry.deactivate(t.triggerId);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(registry.get(t.triggerId)).toBeUndefined();
    expect(registry.list()).toHaveLength(0);
    const row = ctx.db.select().from(schema.triggers).where(eq(schema.triggers.id, t.triggerId)).get()!;
    expect(row.status).toBe('paused');
  });

  it('deactivate swallows cleanup errors but still drops the entry', async () => {
    const t = seedTrigger();
    const cleanup = vi.fn().mockRejectedValue(new Error('cron stop failed'));
    registry.activate(t, cleanup);
    await registry.deactivate(t.triggerId);
    expect(registry.get(t.triggerId)).toBeUndefined();
  });

  it('deactivating an unknown triggerId is a safe no-op (still updates DB)', async () => {
    await expect(registry.deactivate(randomUUID())).resolves.toBeUndefined();
  });

  it('loadActiveFromDb returns rows with status=active and parses config', () => {
    seedTrigger({ status: 'active', expression: '*/5 * * * *' });
    seedTrigger({ status: 'paused' });
    const list = registry.loadActiveFromDb();
    expect(list).toHaveLength(1);
    expect(list[0]!.config).toEqual({ expression: '*/5 * * * *' });
  });

  it('shutdown deactivates every live trigger', async () => {
    const t1 = seedTrigger();
    const t2 = seedTrigger();
    const c1 = vi.fn().mockResolvedValue(undefined);
    const c2 = vi.fn().mockResolvedValue(undefined);
    registry.activate(t1, c1);
    registry.activate(t2, c2);
    await registry.shutdown();
    expect(c1).toHaveBeenCalledOnce();
    expect(c2).toHaveBeenCalledOnce();
    expect(registry.list()).toHaveLength(0);
  });
});
