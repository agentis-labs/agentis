/**
 * Layer 7 §7.2 — InstinctEngine.
 *
 * Verifies repeat-failure pattern detection: when the same node fails with the
 * same root cause across enough recent runs, the engine proposes an instinct,
 * records it to DB-backed workspace memory, and emits INSTINCT_PROPOSED.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { REALTIME_EVENTS, type WorkflowRunState } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { InstinctEngine } from '../../src/services/instinctEngine.js';
import { MemoryStore } from '../../src/services/memoryStore.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let engine: InstinctEngine;
let workflowId: string;

beforeEach(async () => {
  ctx = await createTestContext();
  engine = new InstinctEngine(ctx.db, ctx.bus, new MemoryStore(ctx.db, ctx.logger), ctx.logger, 3);
  workflowId = randomUUID();
  ctx.db.insert(schema.workflows).values({
    id: workflowId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
    title: 'flaky', graph: { version: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }, settings: {},
  }).run();
});

afterEach(async () => {
  ctx.close();
});

function seedFailedRun(nodeId: string, error: string) {
  const runId = randomUUID();
  const state: Partial<WorkflowRunState> = {
    runId, workflowId, status: 'FAILED',
    failedNodeIds: [nodeId],
    completedNodeIds: [], skippedNodeIds: [],
    nodeStates: { [nodeId]: { nodeId, status: 'FAILED', error } },
  };
  ctx.db.insert(schema.workflowRuns).values({
    id: runId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, workflowId,
    userId: ctx.user.id, status: 'FAILED', runState: state as unknown as object,
  }).run();
  return { runId, state: state as WorkflowRunState };
}

describe('InstinctEngine', () => {
  it('proposes an instinct + writes DB memory after repeated same-cause failures', async () => {
    const events: Array<{ event: string; payload: unknown }> = [];
    const off = ctx.bus.subscribe((m) => { if (m.envelope.event === REALTIME_EVENTS.INSTINCT_PROPOSED) events.push({ event: m.envelope.event, payload: m.envelope.payload }); });

    // Three prior failures of the same node + cause, plus the current one.
    seedFailedRun('summarizer', 'CONTEXT_TOO_LONG: input was 52 items, 18000 tokens');
    seedFailedRun('summarizer', 'context too long — token limit exceeded');
    const last = seedFailedRun('summarizer', 'CONTEXT_TOO_LONG again');

    const proposal = await engine.onRunFailed({ workspaceId: ctx.workspace.id, workflowId, runId: last.runId, state: last.state });
    off();

    expect(proposal).not.toBeNull();
    expect(proposal!.nodeId).toBe('summarizer');
    expect(proposal!.rootCause).toBe('context_too_long');
    expect(proposal!.occurrences).toBeGreaterThanOrEqual(3);
    expect(proposal!.suggestion).toMatch(/truncate/i);
    expect(events).toHaveLength(1);

    const memory = ctx.db.select().from(schema.workspaceMemory).where(eq(schema.workspaceMemory.workspaceId, ctx.workspace.id)).all();
    expect(memory).toHaveLength(1);
    expect(memory[0]!.kind).toBe('lesson');
    expect(memory[0]!.source).toBe('system');
    expect(memory[0]!.content).toMatch(/summarizer.*repeatedly fails/i);
  });

  it('does not propose below the threshold', async () => {
    const last = seedFailedRun('soloNode', 'timeout');
    const proposal = await engine.onRunFailed({ workspaceId: ctx.workspace.id, workflowId, runId: last.runId, state: last.state });
    expect(proposal).toBeNull();
  });

  it('auto-patches a workflow: truncation before a context-overflow node', async () => {
    // Re-seed the workflow with a real graph: trigger → summarizer.
    ctx.db.update(schema.workflows).set({ graph: {
      version: 1, viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'M', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'summarizer', type: 'agent_task', title: 'Summarize', position: { x: 200, y: 0 }, config: { kind: 'agent_task', agentRole: 'writer', capabilityTags: [], prompt: 'go', inputKeys: [], outputKeys: [] } },
      ],
      edges: [{ id: 'e1', source: 'T', target: 'summarizer' }],
    } as object }).where(eq(schema.workflows.id, workflowId)).run();

    const res = await engine.applyInstinct({ workspaceId: ctx.workspace.id, workflowId, nodeId: 'summarizer', rootCause: 'context_too_long' });
    expect(res.applied).toBe(true);

    const graph = (ctx.db.select().from(schema.workflows).where(eq(schema.workflows.id, workflowId)).get()!.graph) as {
      nodes: Array<{ id: string; type: string }>; edges: Array<{ source: string; target: string }>;
    };
    // A truncation transform was inserted and the inbound edge rewired through it.
    expect(graph.nodes.some((n) => n.id === 'instinct_truncate_summarizer' && n.type === 'transform')).toBe(true);
    expect(graph.edges).toContainEqual(expect.objectContaining({ source: 'T', target: 'instinct_truncate_summarizer' }));
    expect(graph.edges).toContainEqual(expect.objectContaining({ source: 'instinct_truncate_summarizer', target: 'summarizer' }));
  });

  it('auto-patches retry hardening for rate limits on an http node', async () => {
    ctx.db.update(schema.workflows).set({ graph: {
      version: 1, viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'T', type: 'trigger', title: 'M', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'gh', type: 'http_request', title: 'GitHub', position: { x: 200, y: 0 }, config: { kind: 'http_request', method: 'GET', url: 'https://api.github.com' } },
      ],
      edges: [{ id: 'e1', source: 'T', target: 'gh' }],
    } as object }).where(eq(schema.workflows.id, workflowId)).run();

    const res = await engine.applyInstinct({ workspaceId: ctx.workspace.id, workflowId, nodeId: 'gh', rootCause: 'rate_limit' });
    expect(res.applied).toBe(true);
    const node = (ctx.db.select().from(schema.workflows).where(eq(schema.workflows.id, workflowId)).get()!.graph as {
      nodes: Array<{ id: string; config: { maxRetries?: number; retryOn?: number[] } }>;
    }).nodes.find((n) => n.id === 'gh')!;
    expect(node.config.maxRetries).toBeGreaterThanOrEqual(3);
    expect(node.config.retryOn).toContain(429);
  });
});
