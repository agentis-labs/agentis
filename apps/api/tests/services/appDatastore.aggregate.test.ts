/**
 * AppDatastore.aggregate — server-side count/sum/avg + group-by.
 *
 * Replaces client-side grouping of a capped page; correct over the full
 * collection. Drives Chart / DataBoard at scale (masterplan 4.1).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AppStore, AppDatastore } from '@agentis/app';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let ds: AppDatastore;
let appId: string;

beforeEach(async () => {
  ctx = await createTestContext();
  ds = new AppDatastore(ctx.db);
  appId = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Sales' }).id;
  ds.defineCollection(ctx.workspace.id, appId, {
    name: 'deals',
    schema: { fields: [{ key: 'stage', type: 'string', required: true }, { key: 'amount', type: 'number' }] },
  });
  const rows: Array<{ stage: string; amount: number }> = [
    { stage: 'won', amount: 100 },
    { stage: 'won', amount: 250 },
    { stage: 'lost', amount: 50 },
    { stage: 'open', amount: 400 },
    { stage: 'open', amount: 600 },
  ];
  for (const r of rows) ds.insert(ctx.workspace.id, appId, 'deals', r);
});
afterEach(() => ctx.close());

describe('AppDatastore.aggregate', () => {
  it('counts rows grouped by a field', () => {
    const buckets = ds.aggregate(ctx.workspace.id, appId, 'deals', { op: 'count', groupBy: 'stage' });
    const byStage = Object.fromEntries(buckets.map((b) => [b.group, b.value]));
    expect(byStage).toEqual({ won: 2, lost: 1, open: 2 });
  });

  it('sums a numeric field grouped by a field', () => {
    const buckets = ds.aggregate(ctx.workspace.id, appId, 'deals', { op: 'sum', field: 'amount', groupBy: 'stage' });
    const byStage = Object.fromEntries(buckets.map((b) => [b.group, b.value]));
    expect(byStage).toEqual({ won: 350, lost: 50, open: 1000 });
  });

  it('computes a single total when not grouped', () => {
    const [total] = ds.aggregate(ctx.workspace.id, appId, 'deals', { op: 'sum', field: 'amount' });
    expect(total).toEqual({ group: null, value: 1400 });
    const [n] = ds.aggregate(ctx.workspace.id, appId, 'deals', { op: 'count' });
    expect(n!.value).toBe(5);
  });

  it('respects a filter and computes avg', () => {
    const [avg] = ds.aggregate(ctx.workspace.id, appId, 'deals', { op: 'avg', field: 'amount', filter: { stage: 'open' } });
    expect(avg!.value).toBe(500); // (400 + 600) / 2
  });

  it('requires a field for non-count ops', () => {
    expect(() => ds.aggregate(ctx.workspace.id, appId, 'deals', { op: 'sum' })).toThrow(/requires a field/i);
  });
});
