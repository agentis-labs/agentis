import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LlmTraceSpan, WorkflowGraph, WorkflowRunState } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { createTelemetrySink, type TelemetrySink } from '../../src/services/telemetrySink.js';
import { buildTraceRoutes } from '../../src/routes/traces.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

describe('trace X-Ray routes', () => {
  let ctx: TestContext;
  let dataDir: string;
  let sink: TelemetrySink;

  beforeEach(async () => {
    ctx = await createTestContext();
    dataDir = mkdtempSync(path.join(tmpdir(), 'agentis-xray-route-'));
    sink = createTelemetrySink({ dataDir, logger: ctx.logger, flushIntervalMs: 0 });
  });

  afterEach(async () => {
    await sink.shutdown();
    ctx.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns sidecar LLM spans with main run observability', async () => {
    const workflowId = randomUUID();
    const runId = randomUUID();
    const traceId = randomUUID().replace(/-/g, '');
    const graph: WorkflowGraph = {
      version: 1,
      nodes: [
        {
          id: 'agent_1',
          type: 'agent_task',
          title: 'Research agent',
          position: { x: 0, y: 0 },
          config: {
            kind: 'agent_task',
            capabilityTags: [],
            prompt: 'Research this account',
            inputKeys: [],
            outputKeys: [],
          },
        },
      ],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    const runState: WorkflowRunState = {
      runId,
      workflowId,
      traceId,
      status: 'COMPLETED',
      readyQueue: [],
      waitingInputs: {},
      nodeStates: { agent_1: { nodeId: 'agent_1', status: 'COMPLETED' } },
      activeExecutions: {},
      completedNodeIds: ['agent_1'],
      failedNodeIds: [],
      skippedNodeIds: [],
      observability: {
        blockData: {},
        traceSpans: [],
        tokenUsage: { promptTokens: 900, completionTokens: 100, totalTokens: 1000 },
        costMicros: 250,
        graphSnapshot: graph,
        graphSnapshotHash: 'hash_xray',
      },
      graphRevision: 1,
      replanCount: 0,
      lastLedgerSequence: 0,
    };

    ctx.db.insert(schema.workflows).values({
      id: workflowId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      title: 'X-Ray Workflow',
      graph,
      settings: {},
    }).run();
    ctx.db.insert(schema.workflowRuns).values({
      id: runId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      workflowId,
      userId: ctx.user.id,
      status: 'COMPLETED',
      runState,
      traceId,
      tokenUsage: { promptTokens: 900, completionTokens: 100, totalTokens: 1000 },
      costMicros: 250,
      graphSnapshot: graph,
      graphSnapshotHash: 'hash_xray',
    }).run();

    const span: LlmTraceSpan = {
      traceId,
      runId,
      workflowId,
      workspaceId: ctx.workspace.id,
      nodeId: 'agent_1',
      nodeTitle: 'Research agent',
      nodeKind: 'agent_task',
      metrics: {
        promptTokens: 900,
        completionTokens: 100,
        cachedTokens: 0,
        totalTokens: 1000,
        totalCostMicros: 250,
        latencyMs: 1234,
      },
      payloads: { rawPrompt: 'Research this account', rawCompletion: 'Done', toolCalls: [] },
    };
    sink.emit(span);
    await sink.flush();

    const app = ctx.buildApp([{ path: '/v1/traces', app: buildTraceRoutes({ db: ctx.db, auth: ctx.auth, telemetrySink: sink }) }]);
    const res = await app.request(`/v1/traces/${runId}/xray`, { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = await res.json() as { llmSpans: LlmTraceSpan[]; summary: { totalTokens: number; totalCostMicros: number } };
    expect(body.llmSpans).toHaveLength(1);
    expect(body.llmSpans[0]?.nodeId).toBe('agent_1');
    expect(body.summary.totalTokens).toBe(1000);
    expect(body.summary.totalCostMicros).toBe(250);
  });
});