/**
 * MCP resource surface — Agentis workspace state as read-only MCP resources.
 *
 * MCP has two ways for a client to reach a server: TOOLS (verbs the model
 * invokes) and RESOURCES (nouns the model *reads* by URI). Agentis always had a
 * rich tool surface but returned an empty `resources/list`, so a well-behaved
 * MCP harness that tries to "read the current state" the canonical way — via
 * resources — found nothing. In plan mode, where mutation is off, a Codex/Claude
 * harness would then conclude it could do nothing at all and give up
 * ("no resources were exposed, and plan mode forbids mutating") instead of
 * falling back to the read-only observe tools.
 *
 * This module closes that gap: it projects the workspace's live state
 * (workflows, apps, agents, recent runs, plus a rollup overview) into first-class
 * MCP resources that ANY client — Codex, Claude Code, Cursor, an external MCP
 * app — can read without mutating anything. Because resources are inherently
 * read-only they are always safe in plan mode, giving an inspecting turn a real
 * window into the workspace.
 *
 * PERF: every query is column-scoped and NEVER selects a large JSON blob
 * (`graph`, `run_state`, `manifest_json`, …). Reading those multi-MB columns on
 * a list path is the exact hot-path stall documented in the platform-slowness
 * work — resources summarize, they do not hydrate.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';

/** MCP resource descriptor as returned by `resources/list`. */
export interface McpResourceDescriptor {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

/** MCP resource contents as returned by `resources/read`. */
export interface McpResourceContents {
  contents: Array<{ uri: string; mimeType: string; text: string }>;
}

const JSON_MIME = 'application/json';
const RECENT_RUN_LIMIT = 25;

/**
 * The fixed set of read-only resources every workspace exposes. Kept static (no
 * per-row resource explosion) so `resources/list` is O(1) and the model sees a
 * small, legible menu of state to pull.
 */
const RESOURCE_CATALOG: readonly McpResourceDescriptor[] = [
  {
    uri: 'agentis://workspace',
    name: 'Workspace overview',
    description: 'Rollup counts of workflows, apps, agents, and recent runs in this workspace.',
    mimeType: JSON_MIME,
  },
  {
    uri: 'agentis://workflows',
    name: 'Workflows',
    description: 'All workflows: id, title, description, owning app, and whether published over MCP.',
    mimeType: JSON_MIME,
  },
  {
    uri: 'agentis://apps',
    name: 'Apps',
    description: 'All Agentic Apps: id, slug, name, status, and version.',
    mimeType: JSON_MIME,
  },
  {
    uri: 'agentis://agents',
    name: 'Agents',
    description: 'Registered agents: id, name, adapter, runtime model, role, and status.',
    mimeType: JSON_MIME,
  },
  {
    uri: 'agentis://runs/recent',
    name: 'Recent runs',
    description: `The ${RECENT_RUN_LIMIT} most recent workflow runs: id, workflow, status, and timestamps.`,
    mimeType: JSON_MIME,
  },
];

/** `resources/list` — the read-only state surface for a workspace. */
export function listMcpResources(): McpResourceDescriptor[] {
  return [...RESOURCE_CATALOG];
}

/**
 * `resources/read` — resolve one `agentis://…` URI to its JSON contents, scoped
 * to the workspace. Returns null for an unknown URI so the caller can answer with
 * a proper JSON-RPC "invalid params" instead of a 500.
 */
export function readMcpResource(db: AgentisSqliteDb, workspaceId: string, uri: string): McpResourceContents | null {
  const payload = resolvePayload(db, workspaceId, uri);
  if (payload === null) return null;
  return { contents: [{ uri, mimeType: JSON_MIME, text: JSON.stringify(payload) }] };
}

function resolvePayload(db: AgentisSqliteDb, workspaceId: string, uri: string): unknown | null {
  switch (uri) {
    case 'agentis://workspace':
      return workspaceOverview(db, workspaceId);
    case 'agentis://workflows':
      return listWorkflows(db, workspaceId);
    case 'agentis://apps':
      return listApps(db, workspaceId);
    case 'agentis://agents':
      return listAgents(db, workspaceId);
    case 'agentis://runs/recent':
      return listRecentRuns(db, workspaceId);
    default:
      return null;
  }
}

function countOf(db: AgentisSqliteDb, table: typeof schema.workflows | typeof schema.apps | typeof schema.agents | typeof schema.workflowRuns, workspaceId: string): number {
  const row = db
    .select({ c: sql<number>`count(*)` })
    .from(table)
    .where(eq(table.workspaceId, workspaceId))
    .get();
  return row?.c ?? 0;
}

function workspaceOverview(db: AgentisSqliteDb, workspaceId: string): Record<string, unknown> {
  const ws = db
    .select({ id: schema.workspaces.id, name: schema.workspaces.name })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .get();
  return {
    id: workspaceId,
    name: ws?.name ?? null,
    counts: {
      workflows: countOf(db, schema.workflows, workspaceId),
      apps: countOf(db, schema.apps, workspaceId),
      agents: countOf(db, schema.agents, workspaceId),
      runs: countOf(db, schema.workflowRuns, workspaceId),
    },
    resources: RESOURCE_CATALOG.map((r) => ({ uri: r.uri, name: r.name })),
  };
}

/** Small, safe read of `workflow.settings.mcp` for the published flag. */
function mcpPublished(settings: unknown): boolean {
  const mcp = settings && typeof settings === 'object' ? (settings as Record<string, unknown>).mcp : undefined;
  return Boolean(mcp && typeof mcp === 'object' && (mcp as Record<string, unknown>).published);
}

function listWorkflows(db: AgentisSqliteDb, workspaceId: string): Array<Record<string, unknown>> {
  return db
    .select({
      id: schema.workflows.id,
      title: schema.workflows.title,
      description: schema.workflows.description,
      appId: schema.workflows.appId,
      settings: schema.workflows.settings,
      updatedAt: schema.workflows.updatedAt,
    })
    .from(schema.workflows)
    .where(eq(schema.workflows.workspaceId, workspaceId))
    .orderBy(desc(schema.workflows.updatedAt))
    .all()
    .map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      appId: r.appId,
      publishedOverMcp: mcpPublished(r.settings),
      updatedAt: r.updatedAt,
    }));
}

function listApps(db: AgentisSqliteDb, workspaceId: string): Array<Record<string, unknown>> {
  return db
    .select({
      id: schema.apps.id,
      slug: schema.apps.slug,
      name: schema.apps.name,
      description: schema.apps.description,
      status: schema.apps.status,
      version: schema.apps.version,
    })
    .from(schema.apps)
    .where(eq(schema.apps.workspaceId, workspaceId))
    .all();
}

function listAgents(db: AgentisSqliteDb, workspaceId: string): Array<Record<string, unknown>> {
  return db
    .select({
      id: schema.agents.id,
      name: schema.agents.name,
      adapterType: schema.agents.adapterType,
      runtimeModel: schema.agents.runtimeModel,
      role: schema.agents.role,
      status: schema.agents.status,
    })
    .from(schema.agents)
    .where(eq(schema.agents.workspaceId, workspaceId))
    .all();
}

function listRecentRuns(db: AgentisSqliteDb, workspaceId: string): Array<Record<string, unknown>> {
  return db
    .select({
      id: schema.workflowRuns.id,
      workflowId: schema.workflowRuns.workflowId,
      status: schema.workflowRuns.status,
      isEphemeral: schema.workflowRuns.isEphemeral,
      startedAt: schema.workflowRuns.startedAt,
      completedAt: schema.workflowRuns.completedAt,
      createdAt: schema.workflowRuns.createdAt,
    })
    .from(schema.workflowRuns)
    .where(and(eq(schema.workflowRuns.workspaceId, workspaceId)))
    .orderBy(desc(schema.workflowRuns.createdAt))
    .limit(RECENT_RUN_LIMIT)
    .all();
}
