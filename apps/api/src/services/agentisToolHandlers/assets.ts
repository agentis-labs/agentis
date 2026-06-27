/**
 * Assets tool family (Assets 10x §3) — agent-facing access to the asset library.
 *
 * Agents already WRITE artifacts (via `agentis.browser.screenshot`, the workflow
 * artifact nodes, and channel delivery). This family lets them DISCOVER and REUSE
 * what has already been produced — by themselves, other agents, apps, or workflow
 * runs — instead of regenerating it blindly. That reuse loop is what makes the
 * library valuable to agents, who touch it far more than humans.
 *
 * `list`/`search` return metadata only (no payloads) so a survey stays cheap;
 * `read` returns the content (capped) for a single asset by id.
 */

import { and, desc, eq, like } from 'drizzle-orm';
import { AgentisError, ARTIFACT_TYPES, isArtifactType, type AgentisToolContext } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';

const ARTIFACT_ORIGINS = ['agent', 'app', 'workflow', 'channel', 'manual'] as const;

/** Max characters of content `assets.read` returns inline (binary data: URLs can be large). */
const MAX_READ_CHARS = 200_000;

type ArtifactRow = typeof schema.artifacts.$inferSelect;

function summary(row: ArtifactRow) {
  return {
    id: row.id,
    ref: `artifact:${row.id}`,
    url: `/v1/artifacts/${row.id}`,
    title: row.title,
    type: row.type,
    origin: row.origin,
    appId: row.appId,
    agentId: row.agentId,
    workflowId: row.workflowId,
    runId: row.runId,
    createdAt: row.createdAt,
  };
}

/** An App id from an explicit arg, or the App the operator is viewing. */
function optionalAppId(args: Record<string, unknown>, ctx: AgentisToolContext): string | undefined {
  if (typeof args.appId === 'string' && args.appId.trim()) return args.appId.trim();
  if (ctx.viewport?.resourceKind === 'app' && ctx.viewport.resourceId) return ctx.viewport.resourceId;
  return undefined;
}

function buildFilters(
  ctx: AgentisToolContext,
  args: Record<string, unknown>,
  appId: string | undefined,
) {
  const filters = [eq(schema.artifacts.workspaceId, ctx.workspaceId)];
  if (isArtifactType(args.type)) filters.push(eq(schema.artifacts.type, args.type));
  if (typeof args.origin === 'string' && ARTIFACT_ORIGINS.includes(args.origin as (typeof ARTIFACT_ORIGINS)[number])) {
    filters.push(eq(schema.artifacts.origin, args.origin as string));
  }
  if (appId) filters.push(eq(schema.artifacts.appId, appId));
  if (typeof args.agentId === 'string' && args.agentId.trim()) filters.push(eq(schema.artifacts.agentId, args.agentId.trim()));
  return filters;
}

function clampLimit(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), 100);
}

const sharedProps = {
  type: { type: 'string', enum: [...ARTIFACT_TYPES], description: 'Filter by asset type.' },
  origin: { type: 'string', enum: [...ARTIFACT_ORIGINS], description: 'Filter by what produced it.' },
  appId: { type: 'string', description: 'Scope to an App. Omit to use the App currently open.' },
  agentId: { type: 'string', description: 'Scope to a producing agent.' },
  limit: { type: 'number', description: 'Max results (1–100, default 25).' },
} as const;

export function registerAssetTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.registerMany([
    {
      definition: {
        id: 'agentis.assets.list',
        family: 'run',
        description:
          'List assets (artifacts) produced in this workspace — screenshots, docs, code, data, HTML. Returns metadata only ({ id, ref, title, type, origin, … }); call agentis.assets.read for content. Filter by type/origin/appId/agentId. Use before producing something to reuse an existing asset.',
        inputSchema: { type: 'object', properties: { ...sharedProps } },
        mutating: false,
        autoExecute: true,
        mcpExposed: true,
      },
      handler: (args, ctx) => {
        const appId = optionalAppId(args, ctx);
        const rows = deps.db
          .select()
          .from(schema.artifacts)
          .where(and(...buildFilters(ctx, args, appId)))
          .orderBy(desc(schema.artifacts.createdAt))
          .limit(clampLimit(args.limit, 25))
          .all();
        return { assets: rows.map(summary), count: rows.length };
      },
    },
    {
      definition: {
        id: 'agentis.assets.search',
        family: 'run',
        description:
          'Search assets by title (case-insensitive substring), optionally scoped by type/origin/appId/agentId. Returns metadata only. Use to find a prior screenshot/doc/export to reuse or deliver.',
        inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Title substring to match.' }, ...sharedProps }, required: ['query'] },
        mutating: false,
        autoExecute: true,
        mcpExposed: true,
      },
      handler: (args, ctx) => {
        const q = typeof args.query === 'string' ? args.query.trim() : '';
        if (!q) throw new AgentisError('VALIDATION_FAILED', "'query' must be a non-empty string");
        const appId = optionalAppId(args, ctx);
        const filters = buildFilters(ctx, args, appId);
        filters.push(like(schema.artifacts.title, `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`));
        const rows = deps.db
          .select()
          .from(schema.artifacts)
          .where(and(...filters))
          .orderBy(desc(schema.artifacts.createdAt))
          .limit(clampLimit(args.limit, 25))
          .all();
        return { assets: rows.map(summary), count: rows.length };
      },
    },
    {
      definition: {
        id: 'agentis.assets.read',
        family: 'run',
        description:
          'Read a single asset by id. Returns metadata + content (text, or a data: URL for binary, capped at 200k chars). To deliver an image/file to a channel, pass its `ref` (e.g. "artifact:<id>") to agentis.channel.send instead of inlining the bytes.',
        inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Asset id (or an "artifact:<id>" ref).' } }, required: ['id'] },
        mutating: false,
        autoExecute: true,
        mcpExposed: true,
      },
      handler: (args, ctx) => {
        const raw = typeof args.id === 'string' ? args.id.trim() : '';
        if (!raw) throw new AgentisError('VALIDATION_FAILED', "'id' must be a non-empty string");
        const id = raw.startsWith('artifact:') ? raw.slice('artifact:'.length).trim() : raw;
        const row = deps.db
          .select()
          .from(schema.artifacts)
          .where(and(eq(schema.artifacts.id, id), eq(schema.artifacts.workspaceId, ctx.workspaceId)))
          .get();
        if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `asset ${id} not found in this workspace`);
        const content = row.content ?? '';
        const truncated = content.length > MAX_READ_CHARS;
        return {
          ...summary(row),
          metadata: row.metadata,
          truncated,
          content: truncated ? content.slice(0, MAX_READ_CHARS) : content,
        };
      },
    },
  ]);
}
