/**
 * /v1/traces — workflow trace export for OTel/provenance tooling.
 */

import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { AgentisError, type LlmTraceSpan, type WorkflowGraph, type WorkflowRunState } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { TelemetrySink } from '../services/telemetrySink.js';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';

export function buildTraceRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  telemetrySink?: Pick<TelemetrySink, 'listSpans'>;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/:runId/xray', async (c) => {
    const ws = getWorkspace(c);
    const runId = c.req.param('runId');
    const run = loadRun(deps.db, ws.workspaceId, runId);
    const traceId = run.traceId ?? run.id.replace(/-/g, '').slice(0, 32);
    const llmSpans = await loadLlmSpans(deps.telemetrySink, traceId);
    const state = run.runState as unknown as WorkflowRunState;
    const workflow = deps.db
      .select()
      .from(schema.workflows)
      .where(eq(schema.workflows.id, run.workflowId))
      .get();
    const graph = (run.graphSnapshot as WorkflowGraph | null)
      ?? state.observability?.graphSnapshot
      ?? (workflow?.graph as WorkflowGraph | undefined)
      ?? null;
    const blockData = run.blockData ?? state.observability?.blockData ?? {};
    const tokenUsage = run.tokenUsage ?? state.observability?.tokenUsage ?? {};
    const costMicros = run.costMicros ?? state.observability?.costMicros ?? 0;
    return c.json({
      schema: 'agentis.xray.v1',
      run: {
        id: run.id,
        workflowId: run.workflowId,
        workspaceId: run.workspaceId,
        status: run.status,
        traceId,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        graphSnapshotHash: run.graphSnapshotHash,
      },
      summary: summarizeXray(llmSpans, tokenUsage, costMicros),
      graph,
      blockData,
      traceSpans: Array.isArray(run.traceSpans) ? run.traceSpans : [],
      llmSpans,
    });
  });

  app.get('/:runId/export', async (c) => {
    const ws = getWorkspace(c);
    const runId = c.req.param('runId');
    const run = loadRun(deps.db, ws.workspaceId, runId);

    const ledger = deps.db
      .select()
      .from(schema.ledgerEvents)
      .where(eq(schema.ledgerEvents.runId, runId))
      .all()
      .sort((left, right) => left.sequenceNumber - right.sequenceNumber);
    const traceId = run.traceId ?? run.id.replace(/-/g, '').slice(0, 32);
    const traceSpans = Array.isArray(run.traceSpans) ? run.traceSpans : [];
    const llmSpans = await loadLlmSpans(deps.telemetrySink, traceId);
    const exportedAt = new Date().toISOString();

    c.header('content-disposition', `attachment; filename="agentis-trace-${runId}.json"`);
    return c.json({
      schema: 'agentis.trace.export.v1',
      exportedAt,
      run: {
        id: run.id,
        workflowId: run.workflowId,
        workspaceId: run.workspaceId,
        status: run.status,
        traceId,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        graphSnapshotHash: run.graphSnapshotHash,
      },
      spans: traceSpans,
      llmSpans,
      ledger: ledger.map((event) => ({
        id: event.id,
        sequenceNumber: event.sequenceNumber,
        eventType: event.eventType,
        nodeId: event.nodeId,
        taskId: event.taskId,
        payloadHash: event.payloadHash,
        signaturePem: event.signaturePem,
        traceId: event.traceId ?? traceId,
        createdAt: event.createdAt,
      })),
      otlp: toOtlpLikeExport({ traceId, runId, spans: [...traceSpans, ...llmSpans], ledger }),
    });
  });

  return app;
}

function toOtlpLikeExport(args: {
  traceId: string;
  runId: string;
  spans: unknown[];
  ledger: Array<{ sequenceNumber: number; eventType: string; nodeId: string | null; createdAt: string }>;
}) {
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'agentis-api' } }] },
        scopeSpans: [
          {
            scope: { name: 'agentis.workflow' },
            spans: args.spans,
            events: args.ledger.map((event) => ({
              name: event.eventType,
              timeUnixNano: unixNano(event.createdAt),
              attributes: [
                { key: 'agentis.run_id', value: { stringValue: args.runId } },
                { key: 'agentis.trace_id', value: { stringValue: args.traceId } },
                { key: 'agentis.sequence_number', value: { intValue: String(event.sequenceNumber) } },
                ...(event.nodeId ? [{ key: 'agentis.node_id', value: { stringValue: event.nodeId } }] : []),
              ],
            })),
          },
        ],
      },
    ],
  };
}

function unixNano(iso: string): string {
  const millis = Date.parse(iso);
  return Number.isFinite(millis) ? String(BigInt(millis) * 1_000_000n) : '0';
}

function loadRun(db: AgentisSqliteDb, workspaceId: string, runId: string) {
  const run = db
    .select()
    .from(schema.workflowRuns)
    .where(and(eq(schema.workflowRuns.id, runId), eq(schema.workflowRuns.workspaceId, workspaceId)))
    .get();
  if (!run) throw new AgentisError('WORKFLOW_RUN_NOT_FOUND', 'Run not found');
  return run;
}

async function loadLlmSpans(
  telemetrySink: Pick<TelemetrySink, 'listSpans'> | undefined,
  traceId: string,
): Promise<LlmTraceSpan[]> {
  if (!telemetrySink) return [];
  return telemetrySink.listSpans({ traceId, limit: 1_000 }).catch(() => []);
}

function summarizeXray(
  llmSpans: LlmTraceSpan[],
  tokenUsage: unknown,
  costMicros: number,
) {
  const sidecarTokens = llmSpans.reduce((total, span) => total + span.metrics.totalTokens, 0);
  const sidecarCostMicros = llmSpans.reduce((total, span) => total + span.metrics.totalCostMicros, 0);
  const mainTokens = typeof tokenUsage === 'object' && tokenUsage !== null
    ? Number((tokenUsage as { totalTokens?: unknown; total_tokens?: unknown }).totalTokens
      ?? (tokenUsage as { total_tokens?: unknown }).total_tokens
      ?? 0)
    : 0;
  const truncatedTokens = llmSpans.reduce((total, span) => {
    return total + (span.contextStrategy?.blocks ?? []).reduce((blockTotal, block) => blockTotal + block.truncatedTokens, 0);
  }, 0);
  return {
    llmSpanCount: llmSpans.length,
    totalTokens: sidecarTokens || (Number.isFinite(mainTokens) ? mainTokens : 0),
    totalCostMicros: sidecarCostMicros || costMicros,
    truncatedTokens,
    maxLatencyMs: llmSpans.reduce((max, span) => Math.max(max, span.metrics.latencyMs), 0),
  };
}