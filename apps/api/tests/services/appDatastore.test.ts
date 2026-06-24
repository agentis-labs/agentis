/**
 * AppDatastore — typed collections + schema-validated records (AGENTIC-APPS-10X §5).
 *
 * Proves migration v83 is live and that the store enforces the field schema on
 * write, filters via json_extract, sorts, paginates, and upserts. This is the
 * operational backend an agent-authored UI binds to — distinct from the Brain.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import { AppDatastore, AppStore } from '@agentis/app';
import { schema } from '@agentis/db/sqlite';
import { and, eq } from 'drizzle-orm';

let ctx: TestContext;
let store: AppStore;
let data: AppDatastore;
let appId: string;

beforeEach(async () => {
  ctx = await createTestContext();
  store = new AppStore(ctx.db);
  data = new AppDatastore(ctx.db);
  appId = store.create(ctx.workspace.id, ctx.user.id, { name: 'CRM' }).id;
  data.defineCollection(ctx.workspace.id, appId, {
    name: 'leads',
    schema: {
      fields: [
        { key: 'name', type: 'string', required: true, indexed: false },
        { key: 'score', type: 'number', required: false, indexed: true },
        { key: 'won', type: 'boolean', required: false, indexed: false },
      ],
    },
  });
});

afterEach(() => ctx.close());

describe('AppDatastore', () => {
  it('validates records against the field schema on write', () => {
    expect(() => data.insert(ctx.workspace.id, appId, 'leads', { score: 5 })).toThrowError(); // missing required name
    expect(() => data.insert(ctx.workspace.id, appId, 'leads', { name: 'Acme', score: 'high' })).toThrowError(); // wrong type
    const ok = data.insert(ctx.workspace.id, appId, 'leads', { name: 'Acme', score: 80, won: true });
    expect(ok.data.name).toBe('Acme');
    expect(ok.version).toBe(1);
  });

  it('filters with operators and bare-equality, sorts, and bumps version on update', () => {
    data.insert(ctx.workspace.id, appId, 'leads', { name: 'Low', score: 10 });
    data.insert(ctx.workspace.id, appId, 'leads', { name: 'High', score: 90 });
    data.insert(ctx.workspace.id, appId, 'leads', { name: 'Mid', score: 50 });

    const hot = data.query(ctx.workspace.id, appId, 'leads', { filter: { score: { op: 'gte', value: 50 } }, sort: [{ field: 'score', dir: 'desc' }], limit: 50 });
    expect(hot.rows.map((r) => r.data.name)).toEqual(['High', 'Mid']);

    const exact = data.query(ctx.workspace.id, appId, 'leads', { filter: { name: 'Low' }, limit: 50 });
    expect(exact.rows).toHaveLength(1);

    const updated = data.update(ctx.workspace.id, appId, 'leads', exact.rows[0]!.id, { score: 11 });
    expect(updated.version).toBe(2);
    expect(updated.data.score).toBe(11);
  });

  it('paginates with a cursor', () => {
    for (let i = 0; i < 5; i += 1) data.insert(ctx.workspace.id, appId, 'leads', { name: `L${i}`, score: i });
    const page1 = data.query(ctx.workspace.id, appId, 'leads', { sort: [{ field: 'score', dir: 'asc' }], limit: 2 });
    expect(page1.rows).toHaveLength(2);
    expect(page1.nextCursor).toBeDefined();
    const page2 = data.query(ctx.workspace.id, appId, 'leads', { sort: [{ field: 'score', dir: 'asc' }], limit: 2, cursor: page1.nextCursor });
    expect(page2.rows.map((r) => r.data.name)).toEqual(['L2', 'L3']);
  });

  it('upserts by match (insert then update)', () => {
    const first = data.upsert(ctx.workspace.id, appId, 'leads', { name: 'Unique' }, { score: 1 });
    expect(first.data.score).toBe(1);
    const second = data.upsert(ctx.workspace.id, appId, 'leads', { name: 'Unique' }, { score: 2 });
    expect(second.id).toBe(first.id); // same row
    expect(second.data.score).toBe(2);
    expect(data.query(ctx.workspace.id, appId, 'leads', { filter: { name: 'Unique' }, limit: 50 }).rows).toHaveLength(1);
  });

  it('redefining a collection updates its schema in place', () => {
    const before = data.listCollections(ctx.workspace.id, appId);
    expect(before).toHaveLength(1);
    data.defineCollection(ctx.workspace.id, appId, {
      name: 'leads',
      schema: { fields: [{ key: 'name', type: 'string', required: true, indexed: false }] },
    });
    const after = data.listCollections(ctx.workspace.id, appId);
    expect(after).toHaveLength(1); // no duplicate
    expect(after[0]!.schema.fields).toHaveLength(1);
  });

  it('maintains indexed fields in the sidecar index through insert, update, and delete', () => {
    const lead = data.insert(ctx.workspace.id, appId, 'leads', { name: 'Indexed', score: 50 });
    const collection = data.listCollections(ctx.workspace.id, appId)[0]!;
    let indexRows = ctx.db
      .select()
      .from(schema.appRecordIndex)
      .where(and(eq(schema.appRecordIndex.collectionId, collection.id), eq(schema.appRecordIndex.recordId, lead.id)))
      .all();
    expect(indexRows).toHaveLength(1);
    expect(indexRows[0]).toMatchObject({ fieldKey: 'score', valueNumber: 50 });

    data.update(ctx.workspace.id, appId, 'leads', lead.id, { score: 90 });
    indexRows = ctx.db
      .select()
      .from(schema.appRecordIndex)
      .where(and(eq(schema.appRecordIndex.collectionId, collection.id), eq(schema.appRecordIndex.recordId, lead.id)))
      .all();
    expect(indexRows[0]).toMatchObject({ fieldKey: 'score', valueNumber: 90 });
    expect(data.query(ctx.workspace.id, appId, 'leads', { filter: { score: { op: 'in', value: [90] } }, limit: 10 }).rows).toHaveLength(1);

    data.delete(ctx.workspace.id, appId, 'leads', lead.id);
    expect(
      ctx.db
        .select()
        .from(schema.appRecordIndex)
        .where(eq(schema.appRecordIndex.recordId, lead.id))
        .all(),
    ).toEqual([]);
  });
});
