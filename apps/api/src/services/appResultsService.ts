/**
 * AppResultsService — APP-OUTPUT-REPLAN.md §5.6.
 *
 * `app_results` is the materialized projection of run outputs and the source
 * of truth for the App Output surface (Hero, Activity Feed, Result Detail).
 *
 *   - `workflow_runs` remains the source of truth for execution.
 *   - On RUN_COMPLETED, `materialize(runId)` reads `app_instances.packageContents`
 *     to learn which output keys this app declares, then resolves each key's
 *     value from the run's `blockData` and writes one row per key.
 *   - `output_surface` is an *App Canvas* (system-composition) node type and
 *     never appears in `workflow_runs.graphSnapshot`. We do NOT scan the
 *     graph snapshot for outputs.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, lt, sql } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { REALTIME_EVENTS, REALTIME_ROOMS, AgentisError } from '@agentis/core';
import type { EventBus } from '../event-bus.js';
import type { Logger } from '../logger.js';

export interface AppResultRow {
  id: string;
  appId: string;
  workspaceId: string;
  runId: string;
  outputKey: string;
  artifactType: string;
  content: unknown;
  summary: string | null;
  triggeredBy: string;
  createdAt: string;
}

export interface OutputComponentSpec {
  /** Stable key referenced by `app_results.output_key`. */
  key?: string;
  /** Optional alias — some manifests use `path`. */
  path?: string;
  label?: string;
  /** digest | document | metric | list | decision | table | file | link | chart | custom */
  artifactType?: string;
  format?: string;
}

export interface MaterializeOptions {
  /** Override the trigger source (default: 'scheduled'). */
  triggeredBy?: 'scheduled' | 'operator' | 'event' | 'manual';
}

export interface MaterializeResult {
  written: AppResultRow[];
  skipped: { reason: string; outputKey?: string }[];
}

export class AppResultsService {
  constructor(
    private readonly deps: {
      db: AgentisSqliteDb;
      bus: EventBus;
      logger: Logger;
    },
  ) {}

  /**
   * Project run outputs into `app_results`. Idempotent: a unique index on
   * (run_id, output_key) means re-running for the same run is a no-op.
   *
   * Resolution order:
   *   1. Look up `workflow_runs(runId)` → workspaceId, workflowId, runState.observability.blockData
   *   2. Find the `app_instances` row whose `entry_workflow_id = workflowId`
   *      AND `workspace_id = workspaceId` (multi-tenancy guard)
   *   3. Read `app_instances.packageContents.outputComponents` (or .outputs)
   *      for the list of declared keys + artifact types
   *   4. For each key: resolve a value from blockData (best-effort) and write
   */
  async materialize(runId: string, options: MaterializeOptions = {}): Promise<MaterializeResult> {
    const result: MaterializeResult = { written: [], skipped: [] };

    const runRow = this.deps.db
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, runId))
      .get();
    if (!runRow) {
      result.skipped.push({ reason: 'run_not_found' });
      return result;
    }
    if (runRow.status !== 'COMPLETED') {
      result.skipped.push({ reason: `run_status_${runRow.status}` });
      return result;
    }
    if (!runRow.workflowId) {
      result.skipped.push({ reason: 'ephemeral_run_no_app_workflow' });
      return result;
    }

    const appRow = this.deps.db
      .select()
      .from(schema.appInstances)
      .where(
        and(
          eq(schema.appInstances.workspaceId, runRow.workspaceId),
          eq(schema.appInstances.entryWorkflowId, runRow.workflowId),
        ),
      )
      .get();
    if (!appRow) {
      result.skipped.push({ reason: 'no_app_for_workflow' });
      return result;
    }

    const pkg = (appRow.packageContents ?? {}) as Record<string, unknown>;
    const outputComponents = extractOutputComponents(pkg);
    if (outputComponents.length === 0) {
      result.skipped.push({ reason: 'no_output_components_declared' });
      return result;
    }

    // Pull blockData / output map from the run's observability snapshot.
    const observability = readObservability(runRow.runState);
    const blockData = (observability?.blockData ?? {}) as Record<string, { outputData?: unknown }>;

    const triggeredBy = options.triggeredBy ?? 'scheduled';
    const createdAt = new Date().toISOString();

    for (const component of outputComponents) {
      const key = component.key ?? component.path;
      if (!key) {
        result.skipped.push({ reason: 'component_missing_key' });
        continue;
      }
      const resolved = resolveValueFromBlockData(blockData, key, component.path);
      if (resolved === undefined) {
        result.skipped.push({ reason: 'value_unresolved', outputKey: key });
        continue;
      }

      const artifactType = component.artifactType ?? inferArtifactType(resolved, component.format);
      const summary = buildSummary(resolved, component.label);

      const id = randomUUID();
      const row: AppResultRow = {
        id,
        appId: appRow.id,
        workspaceId: runRow.workspaceId,
        runId,
        outputKey: key,
        artifactType,
        content: resolved,
        summary,
        triggeredBy,
        createdAt,
      };

      try {
        this.deps.db
          .insert(schema.appResults)
          .values({
            id,
            appId: appRow.id,
            workspaceId: runRow.workspaceId,
            runId,
            outputKey: key,
            artifactType,
            content: resolved as never,
            summary,
            triggeredBy,
            createdAt,
          })
          .run();
        result.written.push(row);

        // Push notification on the workflow room — App Thread component
        // subscribes to workflow(entryWorkflowId). Also push on workspace room
        // for cross-app aggregators.
        this.deps.bus.publish(
          REALTIME_ROOMS.workflow(runRow.workflowId),
          REALTIME_EVENTS.APP_RESULT_CREATED,
          { resultId: id, appId: appRow.id, runId, outputKey: key, artifactType, summary, createdAt },
        );
        this.deps.bus.publish(
          REALTIME_ROOMS.workspace(runRow.workspaceId),
          REALTIME_EVENTS.APP_RESULT_CREATED,
          { resultId: id, appId: appRow.id, runId, outputKey: key, artifactType, summary, createdAt },
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Unique constraint on (run_id, output_key) means this is idempotent.
        if (/UNIQUE constraint/i.test(message)) {
          result.skipped.push({ reason: 'already_materialized', outputKey: key });
          continue;
        }
        this.deps.logger.warn('app_results.materialize_row_failed', { runId, outputKey: key, error: message });
        result.skipped.push({ reason: 'insert_failed', outputKey: key });
      }
    }

    return result;
  }

  /** Activity Feed source. Returns rows in reverse-chronological order. */
  list(args: {
    workspaceId: string;
    appId: string;
    limit?: number;
    /** Keyset cursor: results created strictly *before* this ISO timestamp. */
    before?: string;
  }): AppResultRow[] {
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const conditions = [
      eq(schema.appResults.workspaceId, args.workspaceId),
      eq(schema.appResults.appId, args.appId),
    ];
    if (args.before) conditions.push(lt(schema.appResults.createdAt, args.before));
    const rows = this.deps.db
      .select()
      .from(schema.appResults)
      .where(and(...conditions))
      .orderBy(desc(schema.appResults.createdAt))
      .limit(limit)
      .all();
    return rows.map(rowToAppResult);
  }

  /** Hero on page load — single most-recent result for an app. */
  latest(workspaceId: string, appId: string): AppResultRow | null {
    const row = this.deps.db
      .select()
      .from(schema.appResults)
      .where(and(eq(schema.appResults.workspaceId, workspaceId), eq(schema.appResults.appId, appId)))
      .orderBy(desc(schema.appResults.createdAt))
      .limit(1)
      .get();
    return row ? rowToAppResult(row) : null;
  }

  /** Result Detail page source. Throws RESOURCE_NOT_FOUND if missing or wrong workspace. */
  get(workspaceId: string, resultId: string): AppResultRow {
    const row = this.deps.db
      .select()
      .from(schema.appResults)
      .where(and(eq(schema.appResults.id, resultId), eq(schema.appResults.workspaceId, workspaceId)))
      .get();
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `result '${resultId}' not found`);
    return rowToAppResult(row);
  }

  /** Prev/Next neighbours for the Result Detail page footer. */
  neighbours(workspaceId: string, appId: string, createdAt: string): { prev: AppResultRow | null; next: AppResultRow | null } {
    const prev = this.deps.db
      .select()
      .from(schema.appResults)
      .where(
        and(
          eq(schema.appResults.workspaceId, workspaceId),
          eq(schema.appResults.appId, appId),
          lt(schema.appResults.createdAt, createdAt),
        ),
      )
      .orderBy(desc(schema.appResults.createdAt))
      .limit(1)
      .get();
    const next = this.deps.db
      .select()
      .from(schema.appResults)
      .where(
        and(
          eq(schema.appResults.workspaceId, workspaceId),
          eq(schema.appResults.appId, appId),
          gt(schema.appResults.createdAt, createdAt),
        ),
      )
      .orderBy(schema.appResults.createdAt)
      .limit(1)
      .get();
    return {
      prev: prev ? rowToAppResult(prev) : null,
      next: next ? rowToAppResult(next) : null,
    };
  }

  /** FTS5 full-text search over (summary, content) scoped to an app. */
  search(args: { workspaceId: string; appId: string; query: string; limit?: number }): AppResultRow[] {
    const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
    // FTS5 prefix-match query; sanitize the user input by quoting tokens.
    const fts = sanitizeFtsQuery(args.query);
    if (!fts) return [];
    try {
      const rows = this.deps.db.all<typeof schema.appResults.$inferSelect>(sql`
        SELECT app_results.*
        FROM app_results_fts
        JOIN app_results ON app_results.rowid = app_results_fts.rowid
        WHERE app_results.workspace_id = ${args.workspaceId}
          AND app_results.app_id = ${args.appId}
          AND app_results_fts MATCH ${fts}
        ORDER BY app_results.created_at DESC
        LIMIT ${limit}
      `);
      return rows.map(rowToAppResult);
    } catch (err) {
      this.deps.logger.warn('app_results.fts_query_failed', {
        appId: args.appId,
        query: args.query,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function rowToAppResult(row: typeof schema.appResults.$inferSelect): AppResultRow {
  return {
    id: row.id,
    appId: row.appId,
    workspaceId: row.workspaceId,
    runId: row.runId,
    outputKey: row.outputKey,
    artifactType: row.artifactType,
    content: row.content,
    summary: row.summary,
    triggeredBy: row.triggeredBy,
    createdAt: row.createdAt,
  };
}

function readObservability(runState: unknown): { blockData?: unknown } | undefined {
  if (!runState || typeof runState !== 'object') return undefined;
  const obs = (runState as Record<string, unknown>).observability;
  if (!obs || typeof obs !== 'object') return undefined;
  return obs as { blockData?: unknown };
}

function extractOutputComponents(pkg: Record<string, unknown>): OutputComponentSpec[] {
  // Accept either `outputComponents` (canonical, AGENTIS-APP-FORMAT.md)
  // or `outputLabels` (older alias used by app_instances payload).
  const candidates = [pkg.outputComponents, pkg.outputs, pkg.outputLabels];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return (candidate as Array<Record<string, unknown>>).map((c) => ({
        key: typeof c.key === 'string' ? c.key : typeof c.label === 'string' ? slugify(c.label) : undefined,
        path: typeof c.path === 'string' ? c.path : undefined,
        label: typeof c.label === 'string' ? c.label : undefined,
        artifactType: typeof c.artifactType === 'string' ? c.artifactType : undefined,
        format: typeof c.format === 'string' ? c.format : undefined,
      }));
    }
  }
  return [];
}

function slugify(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

/**
 * Best-effort value resolution from `blockData`.
 *
 *   - First try `blockData[key].outputData`
 *   - Then try the JSON path `path` against every node's outputData
 *   - Then try `outputData[key]` on each node (last writer wins)
 */
function resolveValueFromBlockData(
  blockData: Record<string, { outputData?: unknown }>,
  key: string,
  path: string | undefined,
): unknown {
  const direct = blockData[key];
  if (direct && direct.outputData !== undefined) return direct.outputData;

  for (const entry of Object.values(blockData)) {
    if (path) {
      const v = readJsonPath(entry?.outputData, path);
      if (v !== undefined) return v;
    }
    const out = entry?.outputData;
    if (out && typeof out === 'object' && !Array.isArray(out) && key in (out as Record<string, unknown>)) {
      return (out as Record<string, unknown>)[key];
    }
  }
  return undefined;
}

/** Tiny dot-path reader; supports `a.b.c` and `a.0.b` for arrays. */
function readJsonPath(value: unknown, path: string): unknown {
  if (value === undefined || value === null) return undefined;
  const parts = path.split('.').filter(Boolean);
  let current: unknown = value;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const idx = Number(part);
      if (!Number.isInteger(idx)) return undefined;
      current = current[idx];
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function inferArtifactType(value: unknown, format: string | undefined): string {
  if (format === 'currency' || format === 'number' || format === 'percent') return 'metric';
  if (Array.isArray(value)) return value.every((v) => v && typeof v === 'object' && !Array.isArray(v)) ? 'table' : 'list';
  if (value && typeof value === 'object') return 'document';
  if (typeof value === 'number') return 'metric';
  return 'document';
}

function buildSummary(value: unknown, label: string | undefined): string | null {
  if (value === null || value === undefined) return label ?? null;
  if (typeof value === 'string') return clip(value);
  if (typeof value === 'number' || typeof value === 'boolean') return label ? `${label}: ${value}` : String(value);
  if (Array.isArray(value)) return label ? `${label} (${value.length} items)` : `${value.length} items`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const candidate = obj.title ?? obj.headline ?? obj.summary ?? obj.name;
    if (typeof candidate === 'string') return clip(candidate);
    return label ?? null;
  }
  return label ?? null;
}

function clip(text: string, max = 240): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/** Quote each whitespace-separated token, drop FTS punctuation. */
function sanitizeFtsQuery(input: string): string {
  const cleaned = input.replace(/["()*+\-:^]/g, ' ');
  const tokens = cleaned.split(/\s+/).map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"`).join(' ');
}
