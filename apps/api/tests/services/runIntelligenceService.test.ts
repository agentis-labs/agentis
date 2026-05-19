/**
 * RunIntelligenceService — the compound learning loop (AGENTIS-PLATFORM-10X §Layer 4).
 *
 * Verifies that a terminal run automatically derives an updated performance
 * baseline from the workflow's recent run cohort — the loop closure that lets
 * `AppIntelligenceRuntime` feed an up-to-date target into the next run.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { RunIntelligenceService } from '../../src/services/runIntelligenceService.js';
import { WorkflowBaselineStore } from '../../src/services/workflowBaselineStore.js';
import { RollingBaselineStore } from '../../src/services/rollingBaselineStore.js';
import { EvaluatorRuntime } from '../../src/services/evaluatorRuntime.js';
import { EvaluatorExampleStore } from '../../src/services/evaluatorExampleStore.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
afterEach(() => ctx?.close());

describe('RunIntelligenceService', () => {
  it('derives a workflow baseline from the terminal run cohort', async () => {
    ctx = await createTestContext();
    const baselines = new WorkflowBaselineStore(ctx.db);
    const service = new RunIntelligenceService({
      db: ctx.db,
      logger: ctx.logger,
      workflowBaselines: baselines,
      rollingBaselines: new RollingBaselineStore(ctx.db),
      evaluatorRuntime: new EvaluatorRuntime(ctx.db, ctx.logger),
      evaluatorExamples: new EvaluatorExampleStore(ctx.db, ctx.logger),
    });

    const appId = randomUUID();
    const wfId = randomUUID();
    ctx.db
      .insert(schema.workflows)
      .values({
        id: wfId,
        workspaceId: ctx.workspace.id,
        ambientId: ctx.ambient.id,
        userId: ctx.user.id,
        title: 'sdr-entry',
        graph: { version: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
        settings: {},
        appId,
      })
      .run();
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
        entryWorkflowId: wfId,
        packageContents: {},
      })
      .run();

    // 4 COMPLETED + 1 FAILED → expected successRate 0.8.
    const statuses: Array<'COMPLETED' | 'FAILED'> = [
      'COMPLETED',
      'COMPLETED',
      'COMPLETED',
      'COMPLETED',
      'FAILED',
    ];
    let lastRunId = '';
    for (const status of statuses) {
      const runId = randomUUID();
      lastRunId = runId;
      const started = new Date(Date.now() - 5000).toISOString();
      const completed = new Date().toISOString();
      ctx.db
        .insert(schema.workflowRuns)
        .values({
          id: runId,
          workspaceId: ctx.workspace.id,
          ambientId: ctx.ambient.id,
          workflowId: wfId,
          userId: ctx.user.id,
          status,
          runState: { completedNodeIds: [], nodeStates: {} },
          startedAt: started,
          completedAt: completed,
        })
        .run();
    }

    await service.onTerminalRun(lastRunId, 'FAILED');

    const baseline = baselines.latest(ctx.workspace.id, appId, wfId);
    expect(baseline).not.toBeNull();
    expect(baseline?.source).toBe('derived');
    expect(baseline?.successRate).toBeCloseTo(0.8, 5);
    expect(baseline?.sampleSize).toBe(5);
  });
});
