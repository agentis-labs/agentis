/**
 * Grounded run-failure analysis (auto-diagnosis core).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { analyzeRunFailure, diagnosisToCardBody } from '../../src/services/runFailureAnalysis.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

function seedFailedRun(nodeId: string, nodeConfig: Record<string, unknown>, error: string): string {
  const wfId = randomUUID();
  const graph = { version: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [
    { id: nodeId, type: nodeConfig.kind, title: 'Compose Payload', position: { x: 0, y: 0 }, config: nodeConfig },
  ], edges: [] };
  ctx.db.insert(schema.workflows).values({ id: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, title: 'W', graph }).run();
  const runId = randomUUID();
  ctx.db.insert(schema.workflowRuns).values({
    id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, status: 'FAILED',
    runState: { runId, workflowId: wfId, status: 'FAILED', readyQueue: [], waitingInputs: {}, nodeStates: { [nodeId]: { nodeId, status: 'FAILED', error } }, activeExecutions: {}, completedNodeIds: [], failedNodeIds: [nodeId], skippedNodeIds: [], graphRevision: 1, replanCount: 0, lastLedgerSequence: 0 },
  }).run();
  return runId;
}

describe('analyzeRunFailure', () => {
  it('recognizes an expression failure and gives concrete, grounded fixes', () => {
    const runId = seedFailedRun('compose', { kind: 'transform', expression: 'return {x:1}' }, "expression evaluation failed: Unexpected token 'return'");
    const d = analyzeRunFailure(ctx.db, ctx.workspace.id, runId)!;
    expect(d.recognized).toBe(true);
    expect(d.failedNodeTitle).toBe('Compose Payload');
    expect(d.explanation).toContain('Compose Payload');
    expect(d.fixes.length).toBeGreaterThan(0);
    expect(diagnosisToCardBody(d)).toContain('To fix:');
  });

  it('recognizes a missing credential and points to connecting the account', () => {
    const runId = seedFailedRun('send', { kind: 'integration', integrationId: 'agentmail' }, 'INTEGRATION_CREDENTIAL_MISSING: bearer integration requires a credential');
    const d = analyzeRunFailure(ctx.db, ctx.workspace.id, runId)!;
    expect(d.recognized).toBe(true);
    expect(d.fixes.join(' ')).toMatch(/connect/i);
  });

  it('falls through with the real error for an unrecognized failure (no hallucination)', () => {
    const runId = seedFailedRun('x', { kind: 'transform', expression: '1' }, 'kaboom: disk on fire');
    const d = analyzeRunFailure(ctx.db, ctx.workspace.id, runId)!;
    expect(d.recognized).toBe(false);
    expect(d.explanation).toContain('kaboom: disk on fire');
  });

  it('diagnoses a node that errored but was "handled" by an error edge (COMPLETED_WITH_ERRORS)', () => {
    // The node ends COMPLETED (handled) but carries an error and is NOT in
    // failedNodeIds — the analyzer must still find + explain it.
    const wfId = randomUUID();
    ctx.db.insert(schema.workflows).values({ id: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, title: 'W', graph: { version: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: 'send', type: 'integration', title: 'Send Email', position: { x: 0, y: 0 }, config: { kind: 'integration', integrationId: 'agentmail', operationId: 'send_email' } }], edges: [] } }).run();
    const runId = randomUUID();
    ctx.db.insert(schema.workflowRuns).values({
      id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, status: 'COMPLETED_WITH_ERRORS',
      runState: { runId, workflowId: wfId, status: 'COMPLETED_WITH_ERRORS', readyQueue: [], waitingInputs: {}, nodeStates: { send: { nodeId: 'send', status: 'COMPLETED', error: "operation 'send_email' is not supported by agentmail" } }, activeExecutions: {}, completedNodeIds: ['send'], failedNodeIds: [], skippedNodeIds: [], graphRevision: 1, replanCount: 0, lastLedgerSequence: 0 },
    }).run();
    const d = analyzeRunFailure(ctx.db, ctx.workspace.id, runId)!;
    expect(d.failedNodeTitle).toBe('Send Email');
    expect(d.error).toContain('not supported by agentmail');
    expect(d.explanation.length).toBeGreaterThan(0);
  });

  it('returns null for a foreign / missing run', () => {
    expect(analyzeRunFailure(ctx.db, ctx.workspace.id, randomUUID())).toBeNull();
  });
});
