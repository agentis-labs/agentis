/**
 * Agentis-native KnowledgeSource — the first-party organizational event
 * stream (RFC §7.6 "Agentis native", §3.2). Agents, workflows, runs, and
 * abilities are evidence of how the operation actually works; they are NOT
 * automatically authoritative (invariant 11) — formation gating still applies.
 *
 * Zero-credential: it reads the workspace's own tables. Boundary defaults are
 * agentis_native / internal / delegated_agents, never customer-safe by default.
 */

import { and, eq, gt } from 'drizzle-orm';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { schema } from '@agentis/db/sqlite';
import type {
  BackfillRequest,
  CanonicalSourceObject,
  DiscoveredSourceScope,
  IncrementalSyncRequest,
  InformationBoundary,
  KnowledgeSource,
  SourceCapabilities,
  SourceChangeBatch,
  SourceConnectionHealth,
  SourceSyncContext,
} from '../types.js';

const NATIVE_BOUNDARY: InformationBoundary = {
  origin: 'agentis_native',
  confidentiality: 'internal',
  audience: 'delegated_agents',
  customerSafe: false,
  trainingAllowed: true,
  exportAllowed: false,
  policySource: 'owner_rule',
};

const SCOPES = ['agents', 'workflows', 'runs'] as const;
type NativeScope = (typeof SCOPES)[number];

export class AgentisNativeSource implements KnowledgeSource {
  readonly sourceType = 'agentis_native';
  readonly displayName = 'Agentis';
  readonly capabilities: SourceCapabilities = {
    supportsBackfill: true,
    supportsIncrementalCursor: true,
    supportsWebhooks: false,
    supportsDeletes: false,
    supportsAclSync: false,
    supportsIdentityDirectory: false,
    supportsAttachments: false,
    supportsHistory: true,
    consistency: 'strong',
  };

  constructor(private readonly db: AgentisSqliteDb) {}

  async validateConnection(_ctx: SourceSyncContext): Promise<SourceConnectionHealth> {
    return { ok: true, detail: 'Workspace-local source.' };
  }

  async discoverScopes(_ctx: SourceSyncContext): Promise<DiscoveredSourceScope[]> {
    return SCOPES.map((id) => ({ id, label: id, kind: 'native_table', recommended: true }));
  }

  async *backfill(request: BackfillRequest): AsyncIterable<SourceChangeBatch> {
    yield* this.emit(request, null);
  }

  async *synchronize(request: IncrementalSyncRequest): AsyncIterable<SourceChangeBatch> {
    yield* this.emit(request, request.cursor ?? null);
  }

  /**
   * One pass over the native tables. Cursor = max(updatedAt) ISO string seen;
   * incremental passes emit only rows updated after it. Single batch per scope
   * keeps memory flat for the embedded driver.
   */
  private async *emit(ctx: SourceSyncContext, cursor: string | null): AsyncIterable<SourceChangeBatch> {
    const include = (scope: NativeScope) =>
      ctx.includedScopes.length === 0 || ctx.includedScopes.includes(scope);
    const excluded = new Set(ctx.excludedScopes);
    let maxSeen = cursor ?? '';
    const track = (at: string | null | undefined) => {
      if (at && at > maxSeen) maxSeen = at;
    };

    if (include('agents') && !excluded.has('agents')) {
      const rows = this.db.select().from(schema.agents)
        .where(cursor
          ? and(eq(schema.agents.workspaceId, ctx.workspaceId), gt(schema.agents.updatedAt, cursor))
          : eq(schema.agents.workspaceId, ctx.workspaceId))
        .all();
      const objects: CanonicalSourceObject[] = rows.map((a) => {
        track(a.updatedAt);
        return {
          externalId: `agent:${a.id}`,
          objectType: 'agent',
          title: a.name,
          nativeUrl: `/agents/${a.id}`,
          observedAt: new Date().toISOString(),
          createdAt: a.createdAt,
          modifiedAt: a.updatedAt,
          content: [
            `Agent "${a.name}" (${a.role ?? 'worker'}, ${a.adapterType}).`,
            a.description ? `Mission: ${a.description}` : '',
            a.instructions ? `Instructions: ${a.instructions}` : '',
            `Status: ${a.status}${a.isPaused ? ' (paused)' : ''}.`,
          ].filter(Boolean).join('\n'),
          attributes: { role: a.role, adapterType: a.adapterType, spaceTag: a.spaceTag },
          boundary: NATIVE_BOUNDARY,
        };
      });
      if (objects.length > 0) yield { objects, deletions: [], cursor: maxSeen || cursor };
    }

    if (include('workflows') && !excluded.has('workflows')) {
      const rows = this.db.select().from(schema.workflows)
        .where(cursor
          ? and(eq(schema.workflows.workspaceId, ctx.workspaceId), gt(schema.workflows.updatedAt, cursor))
          : eq(schema.workflows.workspaceId, ctx.workspaceId))
        .all();
      const objects: CanonicalSourceObject[] = rows.map((w) => {
        track(w.updatedAt);
        const graph = (w.graph ?? {}) as { nodes?: Array<{ type?: string; title?: string }> };
        const nodeSummary = Array.isArray(graph.nodes)
          ? graph.nodes.slice(0, 12).map((n) => n.title ?? n.type ?? 'step').join(' -> ')
          : '';
        return {
          externalId: `workflow:${w.id}`,
          externalVersionId: w.contentHash ?? undefined,
          objectType: 'workflow',
          title: w.title,
          nativeUrl: `/workflows/${w.id}`,
          observedAt: new Date().toISOString(),
          createdAt: w.createdAt,
          modifiedAt: w.updatedAt,
          content: [
            `Workflow "${w.title}".`,
            w.description ? `Purpose: ${w.description}` : '',
            nodeSummary ? `Steps: ${nodeSummary}` : '',
          ].filter(Boolean).join('\n'),
          attributes: { tags: w.tags },
          boundary: NATIVE_BOUNDARY,
        };
      });
      if (objects.length > 0) yield { objects, deletions: [], cursor: maxSeen || cursor };
    }

    if (include('runs') && !excluded.has('runs')) {
      const rows = this.db.select().from(schema.workflowRuns)
        .where(cursor
          ? and(eq(schema.workflowRuns.workspaceId, ctx.workspaceId), gt(schema.workflowRuns.updatedAt, cursor))
          : eq(schema.workflowRuns.workspaceId, ctx.workspaceId))
        .all();
      const objects: CanonicalSourceObject[] = rows
        .filter((r) => r.status === 'COMPLETED' || r.status === 'FAILED' || r.status === 'CANCELLED')
        .map((r) => {
          track(r.updatedAt);
          return {
            externalId: `run:${r.id}`,
            objectType: 'workflow_run',
            title: r.ephemeralTitle ?? `Run ${r.id.slice(0, 8)}`,
            nativeUrl: `/runs/${r.id}`,
            observedAt: new Date().toISOString(),
            createdAt: r.createdAt,
            modifiedAt: r.updatedAt,
            content: [
              `Workflow run ${r.status.toLowerCase()}.`,
              r.workflowId ? `Workflow: ${r.workflowId}` : 'Ephemeral run.',
              r.startedAt && r.completedAt ? `Duration: ${r.startedAt} -> ${r.completedAt}.` : '',
              r.replanCount > 0 ? `Replans: ${r.replanCount}.` : '',
            ].filter(Boolean).join('\n'),
            attributes: { status: r.status, workflowId: r.workflowId, isReplay: r.isReplay },
            boundary: NATIVE_BOUNDARY,
          };
        });
      if (objects.length > 0) yield { objects, deletions: [], cursor: maxSeen || cursor };
    }


    // Terminal empty batch commits the final cursor even when nothing changed.
    yield { objects: [], deletions: [], cursor: maxSeen || cursor, done: true };
  }
}
