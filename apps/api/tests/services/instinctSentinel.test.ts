/**
 * PAVED-ROAD P4 — the Sentinel: a failed PRODUCTION run files a deduped,
 * actionable Issue (diagnosis + exact next calls); a debug run never does.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { WorkflowGraph, WorkflowRunState } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { InstinctEngine } from '../../src/services/instinctEngine.js';
import { IssueService } from '../../src/services/issues.js';
import { MemoryStore } from '../../src/services/memory/memoryStore.js';
import { LedgerService } from '../../src/services/ledger.js';
import type { WorkflowEngine } from '../../src/engine/WorkflowEngine.js';
import type { ConversationStore } from '../../src/services/conversation/conversationStore.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let instincts: InstinctEngine;
let issues: IssueService;
let workflowId: string;

const graph: WorkflowGraph = {
  version: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [
    { id: 'T', type: 'trigger', title: 'Manual', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
    { id: 'scout', type: 'agent_task', title: 'Instagram Scout', position: { x: 200, y: 0 }, config: { kind: 'agent_task', prompt: 'scout' } },
  ],
  edges: [{ id: 'e1', source: 'T', target: 'scout' }],
};

function seedFailedRun(error: string): { runId: string; state: WorkflowRunState } {
  const runId = randomUUID();
  const state = {
    runId,
    workflowId,
    status: 'FAILED',
    nodeStates: { scout: { status: 'FAILED', error } },
    failedNodeIds: ['scout'],
    completedNodeIds: [],
    readyQueue: [],
    activeExecutions: {},
  } as unknown as WorkflowRunState;
  ctx.db.insert(schema.workflowRuns).values({
    id: runId,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    workflowId,
    userId: ctx.user.id,
    status: 'FAILED',
    runState: state,
    triggerId: null,
  }).run();
  return { runId, state };
}

beforeEach(async () => {
  ctx = await createTestContext();
  const memory = new MemoryStore(ctx.db, ctx.logger);
  instincts = new InstinctEngine(ctx.db, ctx.bus, memory, ctx.logger);
  issues = new IssueService({
    db: ctx.db,
    bus: ctx.bus,
    engine: {} as WorkflowEngine,
    ledger: new LedgerService(ctx.db, ctx.bus),
    conversations: {} as ConversationStore,
    logger: ctx.logger,
  });
  instincts.bindIssueService(issues);
  workflowId = randomUUID();
  ctx.db.insert(schema.workflows).values({
    id: workflowId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
    title: 'Fashion Store Factory', description: 'discovers stores', graph, settings: {},
  }).run();
});

afterEach(() => ctx.close());

describe('the Sentinel', () => {
  it('files ONE actionable issue for a failed production run', async () => {
    const { runId, state } = seedFailedRun('rate limit 429 from instagram');
    await instincts.onRunFailed({ workspaceId: ctx.workspace.id, workflowId, runId, state, debugRun: false, userId: ctx.user.id });

    const list = issues.list(ctx.workspace.id);
    expect(list).toHaveLength(1);
    const issue = list[0]!;
    expect(issue.title).toContain('Fashion Store Factory');
    expect(issue.title).toContain('Instagram Scout');
    expect(issue.linkedWorkflowId).toBe(workflowId);
    expect(issue.priority).toBe('high');
    expect(issue.labels as string[]).toContain('sentinel');
    // The description hands over the exact next calls with real ids.
    expect(issue.description).toContain('agentis.run.diagnose');
    expect(issue.description).toContain(runId);
    expect(issue.description).toContain('agentis.workflow.dry_run');
    // activeRunId powers the one-click replay on the Issues page.
    const row = ctx.db.select().from(schema.issues).all()[0]!;
    expect(row.activeRunId).toBe(runId);
  });

  it('dedups by workflow + failure signature: a recurrence REFRESHES the open issue', async () => {
    const first = seedFailedRun('rate limit 429 from instagram');
    await instincts.onRunFailed({ workspaceId: ctx.workspace.id, workflowId, runId: first.runId, state: first.state, debugRun: false, userId: ctx.user.id });
    const second = seedFailedRun('429 rate limit again');
    await instincts.onRunFailed({ workspaceId: ctx.workspace.id, workflowId, runId: second.runId, state: second.state, debugRun: false, userId: ctx.user.id });

    const list = issues.list(ctx.workspace.id);
    expect(list).toHaveLength(1); // refreshed, not duplicated
    const row = ctx.db.select().from(schema.issues).all()[0]!;
    expect(row.activeRunId).toBe(second.runId); // points at the LATEST failed run
  });

  it('a DIFFERENT failure signature files a separate issue', async () => {
    const a = seedFailedRun('rate limit 429');
    await instincts.onRunFailed({ workspaceId: ctx.workspace.id, workflowId, runId: a.runId, state: a.state, debugRun: false, userId: ctx.user.id });
    const b = seedFailedRun('credential expired: 401 unauthorized');
    await instincts.onRunFailed({ workspaceId: ctx.workspace.id, workflowId, runId: b.runId, state: b.state, debugRun: false, userId: ctx.user.id });
    expect(issues.list(ctx.workspace.id)).toHaveLength(2);
  });

  it('a DEBUG run never files — the building agent is already watching', async () => {
    const { runId, state } = seedFailedRun('rate limit 429');
    await instincts.onRunFailed({ workspaceId: ctx.workspace.id, workflowId, runId, state, debugRun: true, userId: ctx.user.id });
    expect(issues.list(ctx.workspace.id)).toHaveLength(0);
  });

  it('SWIFT: a COMPLETED-but-deficient production run files a verdict Issue with evidence + dedups on recurrence', () => {
    const verdict = {
      outcome: 'failed_checks' as const,
      at: new Date().toISOString(),
      graphHash: 'h1',
      checks: [{ checkId: 'live', claim: 'store is live', passed: false, evidence: 'GET https://store.vercel.app → 404 (12 bytes)' }],
      deficiencies: [{ checkId: 'live', claim: 'store is live', detail: 'GET https://store.vercel.app → 404 (12 bytes)', producingNodeIds: ['scout'] }],
      sufficiency: { typedEmptyFills: [], stubSuspects: [], floorViolations: [] },
    };
    instincts.onRunDeficient({ workspaceId: ctx.workspace.id, workflowId, runId: randomUUID(), verdict, userId: ctx.user.id });
    const filed = issues.list(ctx.workspace.id);
    expect(filed).toHaveLength(1);
    expect(filed[0]!.title).toMatch(/Run deficient/);
    expect(filed[0]!.description).toMatch(/404/);                 // the EVIDENCE travels
    expect(filed[0]!.description).toMatch(/pin this as a regression|workflow\.test/);
    // Recurrence refreshes, never piles on.
    instincts.onRunDeficient({ workspaceId: ctx.workspace.id, workflowId, runId: randomUUID(), verdict, userId: ctx.user.id });
    expect(issues.list(ctx.workspace.id)).toHaveLength(1);
  });
});
