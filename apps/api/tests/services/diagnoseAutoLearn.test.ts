/**
 * Self-improving playbook — auto-capture (WORKFLOW-DESIGN-10X Phase 5 finish).
 * Proves agentis.run.diagnose records a RECOGNIZED failure as a workspace playbook
 * lesson (once, deduped) so future builds design around it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import type { AgentisToolContext } from '@agentis/core';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { registerRunTools } from '../../src/services/agentisToolHandlers/run.js';
import { MemoryStore } from '../../src/services/memoryStore.js';
import { recallWorkflowLessons } from '../../src/services/workflowPlaybook.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let registry: AgentisToolRegistry;
let memory: MemoryStore;
let baseCtx: AgentisToolContext;

beforeEach(async () => {
  ctx = await createTestContext();
  memory = new MemoryStore(ctx.db, ctx.logger);
  registry = new AgentisToolRegistry({ logger: ctx.logger });
  const deps = {
    db: ctx.db,
    logger: ctx.logger,
    memory,
    ledger: { listForRun: async () => [] },
  } as unknown as ToolHandlerDeps;
  registerRunTools(registry, deps);
  baseCtx = { workspaceId: ctx.workspace.id, userId: ctx.user.id, caller: 'chat' };
});
afterEach(() => ctx.close());

function seedFailedRun(nodeId: string, nodeConfig: Record<string, unknown>, error: string): string {
  const wfId = randomUUID();
  const graph = { version: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: nodeId, type: nodeConfig.kind, title: 'Compose Payload', position: { x: 0, y: 0 }, config: nodeConfig }], edges: [] };
  ctx.db.insert(schema.workflows).values({ id: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, title: 'W', graph }).run();
  const runId = randomUUID();
  ctx.db.insert(schema.workflowRuns).values({
    id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId: wfId, userId: ctx.user.id, status: 'FAILED',
    runState: { runId, workflowId: wfId, status: 'FAILED', readyQueue: [], waitingInputs: {}, nodeStates: { [nodeId]: { nodeId, status: 'FAILED', error } }, activeExecutions: {}, completedNodeIds: [], failedNodeIds: [nodeId], skippedNodeIds: [], graphRevision: 1, replanCount: 0, lastLedgerSequence: 0 },
  }).run();
  return runId;
}

const diagnose = (runId: string) => registry.execute({ id: 'r', toolId: 'agentis.run.diagnose', arguments: { runId } }, baseCtx);

describe('run.diagnose auto-learn', () => {
  it('records a recognized failure as a playbook lesson, once (deduped)', async () => {
    const runId = seedFailedRun('compose', { kind: 'transform', expression: 'return {x:1}' }, "expression evaluation failed: Unexpected token 'return'");

    const first = await diagnose(runId);
    expect(first.ok).toBe(true);
    expect((first.output as { learned: { recorded: boolean } }).learned.recorded).toBe(true);

    const lessons = recallWorkflowLessons(memory, ctx.workspace.id);
    expect(lessons.length).toBe(1);
    expect(lessons[0]!.content).toMatch(/expression evaluation failed/);

    // Diagnosing the same recognized failure again must NOT add a duplicate lesson.
    const second = await diagnose(runId);
    expect((second.output as { learned: { recorded: boolean } }).learned.recorded).toBe(false);
    expect(recallWorkflowLessons(memory, ctx.workspace.id).length).toBe(1);
  });

  it('does not record a lesson for an unrecognized failure', async () => {
    const runId = seedFailedRun('x', { kind: 'transform', expression: '1' }, 'kaboom: disk on fire');
    const res = await diagnose(runId);
    expect((res.output as { learned: { recorded: boolean } }).learned.recorded).toBe(false);
    expect(recallWorkflowLessons(memory, ctx.workspace.id).length).toBe(0);
  });
});
