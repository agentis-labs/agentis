/**
 * Regression — querying an App collection by an INDEXED BOOLEAN field must not
 * 500 with "SQLite3 can only bind numbers, strings, bigints, buffers, and null".
 * better-sqlite3 rejects a raw boolean bind; the indexed-lookup predicate must
 * bind 0/1 (the index column stores 0/1, like Drizzle's coercing insert path).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppStore, AppDatastore } from '@agentis/app';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

describe('AppDatastore.query — indexed boolean field', () => {
  function seed() {
    const appId = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Protocols' }).id;
    const data = new AppDatastore(ctx.db);
    data.defineCollection(ctx.workspace.id, appId, {
      name: 'protocol_rules',
      schema: { fields: [
        { key: 'name', type: 'string', required: true },
        { key: 'active', type: 'boolean', indexed: true },
      ] },
    });
    data.insert(ctx.workspace.id, appId, 'protocol_rules', { name: 'r1', active: true }, ctx.user.id);
    data.insert(ctx.workspace.id, appId, 'protocol_rules', { name: 'r2', active: false }, ctx.user.id);
    data.insert(ctx.workspace.id, appId, 'protocol_rules', { name: 'r3', active: true }, ctx.user.id);
    return { appId, data };
  }

  it('filters by a boolean (operator form) without a bind error', () => {
    const { appId, data } = seed();
    const res = data.query(ctx.workspace.id, appId, 'protocol_rules', { filter: { active: { op: 'eq', value: true } } });
    expect(res.rows.map((r) => (r.data as { name: string }).name).sort()).toEqual(['r1', 'r3']);
  });

  it('filters by a boolean (bare value) without a bind error', () => {
    const { appId, data } = seed();
    const res = data.query(ctx.workspace.id, appId, 'protocol_rules', { filter: { active: false } });
    expect(res.rows.map((r) => (r.data as { name: string }).name)).toEqual(['r2']);
  });
});
