/**
 * AppDashboardService — the dashboard surface (AGENTIS-PLATFORM-10X §Layer 1).
 *
 * Covers manifest-declared metrics/charts and the auto-generated fallback.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AppDataTable, AppDashboard } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { AppDataService } from '../../src/services/appDataService.js';
import { AppDashboardService } from '../../src/services/appDashboardService.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
afterEach(() => ctx?.close());

const leads: AppDataTable = {
  name: 'leads',
  schema: {
    company: { type: 'string' },
    score: { type: 'number' },
    status: { type: 'string' },
  },
};

async function setup(): Promise<{ data: AppDataService; dash: AppDashboardService; appId: string }> {
  ctx = await createTestContext();
  const data = new AppDataService(ctx.db, ctx.bus, ctx.logger);
  const dash = new AppDashboardService(data);
  const appId = randomUUID();
  ctx.db
    .insert(schema.appInstances)
    .values({
      id: appId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      slug: 'sdr',
      name: 'SDR',
      version: '1.0.0',
      status: 'active',
      packageContents: {},
    })
    .run();
  data.provisionTables(ctx.workspace.id, appId, [leads]);
  for (const row of [
    { company: 'Acme', score: 80, status: 'qualified' },
    { company: 'Globex', score: 40, status: 'new' },
    { company: 'Initech', score: 90, status: 'qualified' },
  ]) {
    data.insert(ctx.workspace.id, appId, 'leads', row);
  }
  return { data, dash, appId };
}

describe('AppDashboardService', () => {
  it('computes manifest-declared metrics', async () => {
    const { dash, appId } = await setup();
    const decl: AppDashboard = {
      metrics: [
        { label: 'Total leads', table: 'leads', field: 'company', aggregation: 'count' },
        { label: 'Qualified', table: 'leads', field: 'company', aggregation: 'count', filter: "status == 'qualified'" },
        { label: 'Avg score', table: 'leads', field: 'score', aggregation: 'avg' },
      ],
    };
    const payload = dash.compute(appId, decl);
    expect(payload.generated).toBe('manifest');
    expect(payload.metrics.find((m) => m.label === 'Total leads')?.value).toBe(3);
    expect(payload.metrics.find((m) => m.label === 'Qualified')?.value).toBe(2);
    expect(payload.metrics.find((m) => m.label === 'Avg score')?.value).toBe(70);
  });

  it('auto-generates a dashboard when none is declared', async () => {
    const { dash, appId } = await setup();
    const payload = dash.compute(appId, undefined);
    expect(payload.generated).toBe('auto');
    // One count metric + one chart per table.
    expect(payload.metrics.some((m) => m.table === 'leads' && m.value === 3)).toBe(true);
    expect(payload.charts.some((ch) => ch.table === 'leads')).toBe(true);
    expect(payload.tables.find((t) => t.name === 'leads')?.rowCount).toBe(3);
  });

  it('builds chart points grouped by a field', async () => {
    const { dash, appId } = await setup();
    const decl: AppDashboard = {
      charts: [
        { type: 'bar', label: 'By status', table: 'leads', valueField: '', groupBy: 'status', aggregation: 'count' },
      ],
    };
    const payload = dash.compute(appId, decl);
    const chart = payload.charts[0]!;
    expect(chart.points.find((p) => p.label === 'qualified')?.value).toBe(2);
    expect(chart.points.find((p) => p.label === 'new')?.value).toBe(1);
  });
});
