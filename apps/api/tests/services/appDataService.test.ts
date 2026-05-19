/**
 * AppDataService — the app's operational Data layer (AGENTIS-PLATFORM-10X §A1).
 *
 * Covers table provisioning, CRUD, query filtering, the DATA_RECORD_CHANGED
 * event contract, and safe schema migration.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { REALTIME_EVENTS, type AppDataTable } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { AppDataService } from '../../src/services/appDataService.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let service: AppDataService;
let appId: string;

const leadsTable: AppDataTable = {
  name: 'leads',
  description: 'Outbound leads',
  schema: {
    company: { type: 'string', required: true },
    score: { type: 'number' },
    qualified: { type: 'boolean' },
    payload: { type: 'json' },
  },
  indexes: [{ field: 'company', type: 'index' }],
};

beforeEach(() => {
  ctx = undefined as unknown as TestContext;
});
afterEach(() => ctx?.close());

async function setup() {
  ctx = await createTestContext();
  service = new AppDataService(ctx.db, ctx.bus, ctx.logger);
  appId = randomUUID();
  ctx.db
    .insert(schema.appInstances)
    .values({
      id: appId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      slug: 'sdr-engine',
      name: 'SDR Engine',
      version: '1.0.0',
      status: 'active',
      packageContents: {},
    })
    .run();
  service.provisionTables(ctx.workspace.id, appId, [leadsTable]);
}

describe('AppDataService', () => {
  it('provisions a table and records its schema', async () => {
    await setup();
    const tables = service.listTables(appId);
    expect(tables).toHaveLength(1);
    expect(tables[0]!.name).toBe('leads');
    expect(service.schema(appId, 'leads')?.schema.company.type).toBe('string');
  });

  it('inserts, reads back, and round-trips typed values', async () => {
    await setup();
    const { id } = service.insert(ctx.workspace.id, appId, 'leads', {
      company: 'Acme',
      score: 87,
      qualified: true,
      payload: { tier: 'enterprise' },
    });
    const record = service.getRecord(appId, 'leads', id);
    expect(record).toMatchObject({
      company: 'Acme',
      score: 87,
      qualified: true,
      payload: { tier: 'enterprise' },
    });
  });

  it('emits DATA_RECORD_CHANGED on insert', async () => {
    await setup();
    const capture = ctx.captureBus();
    service.insert(ctx.workspace.id, appId, 'leads', { company: 'Globex' });
    capture.stop();
    const changed = capture.events.filter(
      (e) => e.envelope.event === REALTIME_EVENTS.DATA_RECORD_CHANGED,
    );
    expect(changed.length).toBeGreaterThan(0);
    const payload = changed[0]!.envelope.payload as { event: string; table: string };
    expect(payload.event).toBe('insert');
    expect(payload.table).toBe('leads');
  });

  it('queries with equality filters and pagination', async () => {
    await setup();
    service.insert(ctx.workspace.id, appId, 'leads', { company: 'Acme', score: 10 });
    service.insert(ctx.workspace.id, appId, 'leads', { company: 'Acme', score: 20 });
    service.insert(ctx.workspace.id, appId, 'leads', { company: 'Globex', score: 30 });
    const all = service.query(appId, 'leads');
    expect(all.total).toBe(3);
    const acme = service.query(appId, 'leads', { where: { company: 'Acme' } });
    expect(acme.total).toBe(2);
    const paged = service.query(appId, 'leads', { limit: 1 });
    expect(paged.records).toHaveLength(1);
  });

  it('updates and deletes records', async () => {
    await setup();
    const { id } = service.insert(ctx.workspace.id, appId, 'leads', { company: 'Acme', score: 1 });
    service.update(ctx.workspace.id, appId, 'leads', id, { score: 99 });
    expect(service.getRecord(appId, 'leads', id)?.score).toBe(99);
    service.delete(ctx.workspace.id, appId, 'leads', id);
    expect(service.getRecord(appId, 'leads', id)).toBeNull();
  });

  it('upserts on a match field', async () => {
    await setup();
    const first = service.upsert(
      ctx.workspace.id,
      appId,
      'leads',
      { company: 'Acme', score: 1 },
      'company',
    );
    expect(first.created).toBe(true);
    const second = service.upsert(
      ctx.workspace.id,
      appId,
      'leads',
      { company: 'Acme', score: 2 },
      'company',
    );
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    expect(service.query(appId, 'leads').total).toBe(1);
    expect(service.getRecord(appId, 'leads', first.id)?.score).toBe(2);
  });

  it('rejects an insert that omits a required field', async () => {
    await setup();
    expect(() => service.insert(ctx.workspace.id, appId, 'leads', { score: 5 })).toThrow(
      /required field "company"/,
    );
    // A present required field passes.
    expect(() =>
      service.insert(ctx.workspace.id, appId, 'leads', { company: 'Acme' }),
    ).not.toThrow();
  });

  it('enforces the maxRows retention cap on insert', async () => {
    ctx = await createTestContext();
    service = new AppDataService(ctx.db, ctx.bus, ctx.logger);
    appId = randomUUID();
    ctx.db
      .insert(schema.appInstances)
      .values({
        id: appId,
        workspaceId: ctx.workspace.id,
        ambientId: ctx.ambient.id,
        userId: ctx.user.id,
        slug: 'capped',
        name: 'Capped',
        version: '1.0.0',
        status: 'active',
        packageContents: {},
      })
      .run();
    const capped: AppDataTable = {
      name: 'events',
      schema: { label: { type: 'string' } },
      retention: { maxRows: 3 },
    };
    service.provisionTables(ctx.workspace.id, appId, [capped]);
    for (let i = 0; i < 6; i += 1) {
      service.insert(ctx.workspace.id, appId, 'events', { label: `e${i}` });
    }
    // Oldest rows are pruned; only the cap survives.
    expect(service.count(appId, 'events')).toBe(3);
  });

  it('sweeps ttl-expired rows', async () => {
    ctx = await createTestContext();
    service = new AppDataService(ctx.db, ctx.bus, ctx.logger);
    appId = randomUUID();
    ctx.db
      .insert(schema.appInstances)
      .values({
        id: appId,
        workspaceId: ctx.workspace.id,
        ambientId: ctx.ambient.id,
        userId: ctx.user.id,
        slug: 'ttl',
        name: 'Ttl',
        version: '1.0.0',
        status: 'active',
        packageContents: {},
      })
      .run();
    const ttlTable: AppDataTable = {
      name: 'logs',
      schema: { msg: { type: 'string' } },
      retention: { ttlDays: 7 },
    };
    service.provisionTables(ctx.workspace.id, appId, [ttlTable]);
    service.insert(ctx.workspace.id, appId, 'logs', { msg: 'fresh' });
    service.insert(ctx.workspace.id, appId, 'logs', { msg: 'stale' });
    // Backdate every row well beyond the 7-day TTL window.
    const physical = `appdata_${appId.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()}_logs`;
    ctx.db.run(sql.raw(`UPDATE "${physical}" SET created_at = '2000-01-01T00:00:00.000Z'`));
    expect(service.count(appId, 'logs')).toBe(2);
    const result = service.sweepRetention();
    expect(result.rowsPruned).toBe(2);
    expect(service.count(appId, 'logs')).toBe(0);
  });

  it('migrates a table by adding a new column without dropping data', async () => {
    await setup();
    const { id } = service.insert(ctx.workspace.id, appId, 'leads', { company: 'Acme' });
    const evolved: AppDataTable = {
      ...leadsTable,
      schema: { ...leadsTable.schema, region: { type: 'string' } },
    };
    service.ensureTable(ctx.workspace.id, appId, evolved);
    // Existing row survives; the new column is queryable.
    expect(service.getRecord(appId, 'leads', id)?.company).toBe('Acme');
    service.update(ctx.workspace.id, appId, 'leads', id, { region: 'EU' });
    expect(service.getRecord(appId, 'leads', id)?.region).toBe('EU');
  });
});
