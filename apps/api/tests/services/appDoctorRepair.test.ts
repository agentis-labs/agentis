import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { AppStore } from '@agentis/app';
import { migrateWorkspaceAppConformance, repairAppConformance } from '../../src/services/app/appDoctorRepair.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

const graph: WorkflowGraph = {
  version: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [
    { id: 'trigger', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
    { id: 'return', type: 'return_output', title: 'Return', position: { x: 200, y: 0 }, config: { kind: 'return_output', renderAs: 'json' } },
  ],
  edges: [{ id: 'edge', source: 'trigger', target: 'return' }],
} as WorkflowGraph;

describe('App Doctor deterministic repair and migration', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestContext(); });
  afterEach(() => ctx.close());

  function seedBrokenApp() {
    const app = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: `Repair ${randomUUID()}` });
    const sourceId = randomUUID();
    const targetId = randomUUID();
    ctx.db.insert(schema.workflows).values([
      {
        id: sourceId, workspaceId: ctx.workspace.id, userId: ctx.user.id, appId: app.id,
        title: 'Source', graph, settings: { appBinding: { dependsOn: [sourceId] } },
      },
      {
        id: targetId, workspaceId: ctx.workspace.id, userId: ctx.user.id, appId: app.id,
        title: 'Target', graph, settings: { appBinding: { dependsOn: [] } },
      },
    ]).run();
    const ruleId = randomUUID();
    ctx.db.insert(schema.workflowEventSubscriptions).values({
      id: ruleId, workspaceId: ctx.workspace.id, sourceWorkflowId: sourceId, targetWorkflowId: targetId,
      eventType: 'run.failed', sourceNodeId: 'deleted-node', inputMapping: {}, enabled: true,
    }).run();
    return { app, sourceId, ruleId };
  }

  it('previews safe actions without mutation, then applies only those actions', () => {
    const { app, sourceId, ruleId } = seedBrokenApp();
    const preview = repairAppConformance(ctx.db, ctx.workspace.id, app.id);
    expect(preview.committed).toBe(false);
    expect(preview.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'BINDING_SELF_DEPENDENCY', safety: 'safe' }),
      expect.objectContaining({ code: 'EVENT_SUBSCRIPTION_SOURCE_NODE_MISSING', safety: 'safe' }),
    ]));
    expect(((ctx.db.select().from(schema.workflows).all().find((row) => row.id === sourceId)!.settings as { appBinding: { dependsOn: string[] } }).appBinding.dependsOn)).toEqual([sourceId]);

    const repaired = repairAppConformance(ctx.db, ctx.workspace.id, app.id, { dryRun: false });
    expect(repaired.applied).toHaveLength(2);
    expect(repaired.report.findings.map((finding) => finding.code)).not.toContain('BINDING_SELF_DEPENDENCY');
    expect(repaired.report.findings.map((finding) => finding.code)).not.toContain('EVENT_SUBSCRIPTION_SOURCE_NODE_MISSING');
    expect(ctx.db.select().from(schema.workflowEventSubscriptions).all().find((row) => row.id === ruleId)?.sourceNodeId).toBeNull();
  });

  it('audits and safely migrates existing Apps workspace-wide without claiming review items were fixed', () => {
    seedBrokenApp();
    const preview = migrateWorkspaceAppConformance(ctx.db, ctx.workspace.id);
    expect(preview.committed).toBe(false);
    expect(preview.totals.scanned).toBe(1);
    expect(preview.totals.applied).toBe(0);

    const migrated = migrateWorkspaceAppConformance(ctx.db, ctx.workspace.id, { dryRun: false });
    expect(migrated.committed).toBe(true);
    expect(migrated.totals.applied).toBe(2);
    expect(migrated.apps[0]!.report.findings.map((finding) => finding.code)).not.toContain('BINDING_SELF_DEPENDENCY');
    expect(migrated.apps[0]!.report.findings.map((finding) => finding.code)).not.toContain('EVENT_SUBSCRIPTION_SOURCE_NODE_MISSING');
  });
});
