import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkflowGraph } from '@agentis/core';
import { AppStore } from '@agentis/app';
import { schema } from '@agentis/db/sqlite';
import { and, eq } from 'drizzle-orm';
import { migrateWorkspaceAppReliability } from '../../src/services/app/appReliabilityMigration.js';
import { WorkflowRevisionService } from '../../src/services/workflow/workflowRevisionService.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

const graph: WorkflowGraph = {
  version: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [
    { id: 'trigger', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
    { id: 'return', type: 'return_output', title: 'Return', position: { x: 200, y: 0 }, config: { kind: 'return_output' } },
  ],
  edges: [{ id: 'edge', source: 'trigger', target: 'return' }],
};

describe('App fleet reliability migration', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestContext(); });
  afterEach(() => ctx.close());

  it('invalidates false clean proof and reports business-contract work without inventing it', () => {
    const app = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Legacy fleet app' });
    const workflowId = randomUUID();
    ctx.db.insert(schema.workflows).values({
      id: workflowId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      appId: app.id, title: 'Legacy workflow', graph, settings: {},
    }).run();
    const revisions = new WorkflowRevisionService(ctx.db);
    const active = revisions.ensureWorkflow(ctx.workspace.id, workflowId).active;
    const runId = randomUUID();
    ctx.db.insert(schema.workflowRuns).values({
      id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId,
      workflowRevisionId: active.id, userId: ctx.user.id,
      status: 'COMPLETED_WITH_CONTRACT_VIOLATION',
      runState: { verdict: { outcome: 'accomplished' } }, graphSnapshot: graph,
    }).run();
    revisions.recordProof({
      workspaceId: ctx.workspace.id, workflowId, revisionId: active.id,
      gate: 'clean_debug', status: 'passed', runId, evidence: { legacy: true },
    });

    const preview = migrateWorkspaceAppReliability(ctx.db, revisions, ctx.workspace.id);
    expect(preview.committed).toBe(false);
    expect(preview.apps[0]!.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'DIRTY_CLEAN_PROOF', autoFixable: true }),
      expect.objectContaining({ code: 'OUTPUT_CONTRACT_MISSING', autoFixable: false }),
      expect.objectContaining({ code: 'DEFINITION_OF_DONE_MISSING', autoFixable: false }),
    ]));

    const migrated = migrateWorkspaceAppReliability(ctx.db, revisions, ctx.workspace.id, { dryRun: false });
    expect(migrated.totals.applied).toBeGreaterThan(0);
    const proof = ctx.db.select().from(schema.workflowRevisionProofs).where(and(
      eq(schema.workflowRevisionProofs.revisionId, active.id),
      eq(schema.workflowRevisionProofs.gate, 'clean_debug'),
    )).get();
    expect(proof?.status).toBe('failed');
    const workflow = ctx.db.select().from(schema.workflows).where(eq(schema.workflows.id, workflowId)).get();
    expect(workflow?.trustState).toBe('regressed');
    expect(migrated.apps[0]!.findings.some((finding) => finding.code === 'DEFINITION_OF_DONE_MISSING')).toBe(true);
  });
});
