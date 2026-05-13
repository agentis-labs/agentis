import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { llmTraceSpanSchema, type LlmTraceSpan } from '@agentis/core';

const telemetryDbs = new Map<string, Database.Database>();

export interface ListTelemetrySpanOptions {
  traceId: string;
  nodeId?: string;
  limit?: number;
}

/**
 * Opens or returns the singleton telemetry database.
 * Uses WAL mode for asynchronous high-throughput writing.
 */
export function openTelemetrySqlite(baseDir: string): Database.Database {
  const dbPath = path.join(baseDir, 'agentis_telemetry.sqlite');
  const existing = telemetryDbs.get(dbPath);
  if (existing?.open) return existing;

  mkdirSync(path.dirname(dbPath), { recursive: true });
  const telemetryDb = new Database(dbPath);

  // Essential for telemetry: WAL mode ensures writers don't block readers
  telemetryDb.pragma('journal_mode = WAL');
  telemetryDb.pragma('synchronous = NORMAL');
  telemetryDb.pragma('temp_store = MEMORY');
  telemetryDb.pragma('busy_timeout = 5000');

  ensureTelemetrySchema(telemetryDb);

  telemetryDbs.set(dbPath, telemetryDb);
  return telemetryDb;
}

export function closeTelemetrySqlite(baseDir?: string): void {
  const entries = baseDir
    ? [[path.join(baseDir, 'agentis_telemetry.sqlite'), telemetryDbs.get(path.join(baseDir, 'agentis_telemetry.sqlite'))] as const]
    : [...telemetryDbs.entries()];
  for (const [dbPath, db] of entries) {
    if (!db) continue;
    if (db.open) db.close();
    telemetryDbs.delete(dbPath);
  }
}

function ensureTelemetrySchema(telemetryDb: Database.Database) {
  renamePreSpanIdTelemetryTable(telemetryDb);

  telemetryDb.exec(`
    CREATE TABLE IF NOT EXISTS llm_trace_spans (
      span_id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      run_id TEXT,
      workflow_id TEXT,
      workspace_id TEXT,
      node_id TEXT NOT NULL,
      node_title TEXT,
      node_kind TEXT,
      created_at TEXT NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      prompt_tokens INTEGER NOT NULL,
      completion_tokens INTEGER NOT NULL,
      cached_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      total_cost_micros INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL,
      context_strategy TEXT,
      payloads TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_llm_trace_spans_trace_time ON llm_trace_spans(trace_id, timestamp_ms);
    CREATE INDEX IF NOT EXISTS idx_llm_trace_spans_run ON llm_trace_spans(run_id);
    CREATE INDEX IF NOT EXISTS idx_llm_trace_spans_node ON llm_trace_spans(trace_id, node_id);
  `);
}

function renamePreSpanIdTelemetryTable(telemetryDb: Database.Database) {
  const legacyColumns = telemetryDb
    .prepare("PRAGMA table_info('llm_trace_spans')")
    .all() as Array<{ name: string }>;
  if (legacyColumns.length > 0 && !legacyColumns.some((column) => column.name === 'span_id')) {
    const legacyName = `llm_trace_spans_legacy_${Date.now()}`;
    telemetryDb.exec(`ALTER TABLE llm_trace_spans RENAME TO ${legacyName};`);
  }
}

/**
 * Inserts a trace span into the telemetry database.
 * This should ideally be called by an async worker draining a queue.
 */
export function insertTelemetrySpan(db: Database.Database, span: LlmTraceSpan) {
  const timestampMs = span.timestampMs ?? Date.now();
  const createdAt = span.createdAt ?? new Date(timestampMs).toISOString();
  const totalTokens = span.metrics.totalTokens || span.metrics.promptTokens + span.metrics.completionTokens;
  const validated = llmTraceSpanSchema.parse({
    ...span,
    spanId: span.spanId ?? randomUUID(),
    timestampMs,
    createdAt,
    metrics: { ...span.metrics, totalTokens },
  });
  const stmt = db.prepare(`
    INSERT INTO llm_trace_spans (
      span_id, trace_id, run_id, workflow_id, workspace_id, node_id, node_title, node_kind,
      created_at, timestamp_ms, prompt_tokens, completion_tokens, cached_tokens, total_tokens,
      total_cost_micros, latency_ms, context_strategy, payloads
    ) VALUES (
      @spanId, @traceId, @runId, @workflowId, @workspaceId, @nodeId, @nodeTitle, @nodeKind,
      @createdAt, @timestampMs, @promptTokens, @completionTokens, @cachedTokens, @totalTokens,
      @totalCostMicros, @latencyMs, @contextStrategy, @payloads
    )
    ON CONFLICT(span_id) DO UPDATE SET
      prompt_tokens = excluded.prompt_tokens,
      completion_tokens = excluded.completion_tokens,
      cached_tokens = excluded.cached_tokens,
      total_tokens = excluded.total_tokens,
      total_cost_micros = excluded.total_cost_micros,
      latency_ms = excluded.latency_ms,
      context_strategy = excluded.context_strategy,
      payloads = excluded.payloads
  `);

  stmt.run({
    spanId: validated.spanId,
    traceId: validated.traceId,
    runId: validated.runId ?? null,
    workflowId: validated.workflowId ?? null,
    workspaceId: validated.workspaceId ?? null,
    nodeId: validated.nodeId,
    nodeTitle: validated.nodeTitle ?? null,
    nodeKind: validated.nodeKind ?? null,
    createdAt: validated.createdAt,
    timestampMs: validated.timestampMs,
    promptTokens: validated.metrics.promptTokens,
    completionTokens: validated.metrics.completionTokens,
    cachedTokens: validated.metrics.cachedTokens,
    totalTokens: validated.metrics.totalTokens,
    totalCostMicros: validated.metrics.totalCostMicros,
    latencyMs: validated.metrics.latencyMs,
    contextStrategy: validated.contextStrategy ? JSON.stringify(validated.contextStrategy) : null,
    payloads: validated.payloads ? JSON.stringify(validated.payloads) : null,
  });
}

export function listTelemetrySpans(
  db: Database.Database,
  options: ListTelemetrySpanOptions,
): LlmTraceSpan[] {
  const limit = Math.min(Math.max(options.limit ?? 500, 1), 2_000);
  const rows = options.nodeId
    ? db.prepare(`
        SELECT * FROM llm_trace_spans
        WHERE trace_id = @traceId AND node_id = @nodeId
        ORDER BY timestamp_ms ASC
        LIMIT @limit
      `).all({ traceId: options.traceId, nodeId: options.nodeId, limit })
    : db.prepare(`
        SELECT * FROM llm_trace_spans
        WHERE trace_id = @traceId
        ORDER BY timestamp_ms ASC
        LIMIT @limit
      `).all({ traceId: options.traceId, limit });
  return (rows as TelemetryRow[]).map(rowToSpan);
}

interface TelemetryRow {
  span_id: string;
  trace_id: string;
  run_id: string | null;
  workflow_id: string | null;
  workspace_id: string | null;
  node_id: string;
  node_title: string | null;
  node_kind: string | null;
  created_at: string;
  timestamp_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  total_tokens: number;
  total_cost_micros: number;
  latency_ms: number;
  context_strategy: string | null;
  payloads: string | null;
}

function rowToSpan(row: TelemetryRow): LlmTraceSpan {
  return llmTraceSpanSchema.parse({
    spanId: row.span_id,
    traceId: row.trace_id,
    runId: row.run_id ?? undefined,
    workflowId: row.workflow_id ?? undefined,
    workspaceId: row.workspace_id ?? undefined,
    nodeId: row.node_id,
    nodeTitle: row.node_title ?? undefined,
    nodeKind: row.node_kind ?? undefined,
    createdAt: row.created_at,
    timestampMs: row.timestamp_ms,
    metrics: {
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      cachedTokens: row.cached_tokens,
      totalTokens: row.total_tokens,
      totalCostMicros: row.total_cost_micros,
      latencyMs: row.latency_ms,
    },
    contextStrategy: parseJson(row.context_strategy),
    payloads: parseJson(row.payloads),
  });
}

function parseJson(value: string | null): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
