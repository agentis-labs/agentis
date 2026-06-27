/**
 * AppDatastore — closed collection types + keyset pagination (masterplan 4.1).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AppStore, AppDatastore } from '@agentis/app';
import type { CollectionRecord } from '@agentis/core';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let ds: AppDatastore;
let appId: string;

beforeEach(async () => {
  ctx = await createTestContext();
  ds = new AppDatastore(ctx.db);
  appId = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Store' }).id;
});
afterEach(() => ctx.close());

describe('AppDatastore — closed (strict) collections', () => {
  it('rejects unknown keys when strict, accepts them when not', () => {
    ds.defineCollection(ctx.workspace.id, appId, { name: 'strict', schema: { strict: true, fields: [{ key: 'name', type: 'string', required: true }] } });
    ds.defineCollection(ctx.workspace.id, appId, { name: 'loose', schema: { fields: [{ key: 'name', type: 'string', required: true }] } });

    // Strict: an undeclared field is rejected.
    expect(() => ds.insert(ctx.workspace.id, appId, 'strict', { name: 'ok', rogue: 1 })).toThrow();
    // Strict: a declared field alone is fine.
    expect(ds.insert(ctx.workspace.id, appId, 'strict', { name: 'ok' }).data).toMatchObject({ name: 'ok' });
    // Loose (default): the extra key passes through.
    expect(ds.insert(ctx.workspace.id, appId, 'loose', { name: 'ok', extra: 2 }).data).toMatchObject({ name: 'ok', extra: 2 });
  });
});

describe('AppDatastore — keyset pagination', () => {
  it('walks every row exactly once across pages, in stable order', () => {
    ds.defineCollection(ctx.workspace.id, appId, { name: 'items', schema: { fields: [{ key: 'n', type: 'number', required: true }] } });
    for (const n of [3, 1, 4, 1, 5, 9, 2, 6]) ds.insert(ctx.workspace.id, appId, 'items', { n });

    const seen: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const res: { rows: CollectionRecord[]; nextCursor?: string } = ds.query(ctx.workspace.id, appId, 'items', { limit: 3, sort: [{ field: 'n', dir: 'asc' }], ...(cursor ? { cursor } : {}) });
      for (const r of res.rows) seen.push((r.data as { n: number }).n);
      cursor = res.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(10); // guard against a cursor that never advances
    } while (cursor);

    // All 8 rows, each once, in ascending order (ties broken by id — still total order).
    expect(seen).toHaveLength(8);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen); // already ascending
    expect([...seen].sort((a, b) => a - b)).toEqual([1, 1, 2, 3, 4, 5, 6, 9]);
  });

  it('paginates the default (updatedAt desc) order without skips', () => {
    ds.defineCollection(ctx.workspace.id, appId, { name: 'feed', schema: { fields: [{ key: 'label', type: 'string', required: true }] } });
    for (let i = 0; i < 7; i += 1) ds.insert(ctx.workspace.id, appId, 'feed', { label: `r${i}` });

    const labels = new Set<string>();
    let cursor: string | undefined;
    do {
      const res = ds.query(ctx.workspace.id, appId, 'feed', { limit: 2, ...(cursor ? { cursor } : {}) });
      for (const r of res.rows) labels.add((r.data as { label: string }).label);
      cursor = res.nextCursor;
    } while (cursor);

    expect(labels.size).toBe(7);
  });
});
