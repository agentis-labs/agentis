/**
 * Inspect tools — agent reads runtime state, costs, traces, approvals.
 *
 * All tools are read-only and side-effect free. Output shapes are stable so
 * the LLM can rely on them across versions.
 */

import { and, desc, eq } from 'drizzle-orm';
import type { ExtensionManifest } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';
import { BUILTIN_EXTENSION_ENTRYPOINTS } from '../builtinExtensions.js';

type ExtensionRow = typeof schema.extensions.$inferSelect;

export function registerInspectTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.registerMany([
    {
      definition: {
        id: 'agentis.package.inspect',
        family: 'inspect',
        description: 'Inspect an installed registry package and its components.',
        inputSchema: { type: 'object', properties: { entryId: { type: 'string' } }, required: ['entryId'] },
        mutating: false,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        const entryId = String(args.entryId);
        const installed = deps.db
          .select()
          .from(schema.installedRegistryArtifacts)
          .where(
            and(
              eq(schema.installedRegistryArtifacts.workspaceId, ctx.workspaceId),
              eq(schema.installedRegistryArtifacts.entryId, entryId),
            ),
          )
          .get();
        if (!installed) return { found: false };
        return {
          found: true,
          entryId,
          version: installed.version,
          entryType: installed.entryType,
          installedAt: installed.installedAt,
          localResourceId: installed.localResourceId,
        };
      },
    },
    {
      definition: {
        id: 'agentis.workflow.inspect',
        family: 'inspect',
        description: 'Read the canonical workflow graph by id.',
        inputSchema: { type: 'object', properties: { workflowId: { type: 'string' } }, required: ['workflowId'] },
        mutating: false,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        const wf = deps.db
          .select()
          .from(schema.workflows)
          .where(eq(schema.workflows.id, String(args.workflowId)))
          .get();
        if (!wf || wf.workspaceId !== ctx.workspaceId) return { found: false };
        return { found: true, id: wf.id, title: wf.title, graph: wf.graph, createdAt: wf.createdAt };
      },
    },
    {
      definition: {
        id: 'agentis.run.inspect',
        family: 'inspect',
        description: 'Inspect a run’s status, node states, and cost summary.',
        inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] },
        mutating: false,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        const run = deps.db
          .select()
          .from(schema.workflowRuns)
          .where(eq(schema.workflowRuns.id, String(args.runId)))
          .get();
        if (!run || run.workspaceId !== ctx.workspaceId) return { found: false };
        return {
          found: true,
          runId: run.id,
          workflowId: run.workflowId,
          status: run.status,
          createdAt: run.createdAt,
          completedAt: run.completedAt,
          replanCount: run.replanCount,
          parentRunId: run.parentRunId,
          state: run.runState,
        };
      },
    },
    {
      definition: {
        id: 'agentis.trace.inspect',
        family: 'inspect',
        description: 'Read a paginated slice of the run ledger.',
        inputSchema: {
          type: 'object',
          properties: {
            runId: { type: 'string' },
            afterSequence: { type: 'number' },
            limit: { type: 'number' },
          },
          required: ['runId'],
        },
        mutating: false,
        mcpExposed: true,
      },
      handler: async (args, _ctx) => {
        const limit = Math.min(Math.max(Number(args.limit ?? 50), 1), 200);
        const after = Number(args.afterSequence ?? 0);
        const events = await deps.ledger.listForRun({
          runId: String(args.runId),
          afterSequence: after,
          limit,
        });
        return { runId: String(args.runId), afterSequence: after, count: events.length, events };
      },
    },
    {
      definition: {
        id: 'agentis.audit_trail',
        family: 'inspect',
        description: 'Read recent ledger events for a workflow run.',
        inputSchema: {
          type: 'object',
          properties: { runId: { type: 'string' }, limit: { type: 'number' } },
          required: ['runId'],
        },
        mutating: false,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        const run = deps.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, String(args.runId))).get();
        if (!run || run.workspaceId !== ctx.workspaceId) return { found: false, events: [] };
        const limit = Math.min(Math.max(Number(args.limit ?? 100), 1), 500);
        const events = await deps.ledger.listForRun({ runId: run.id, limit });
        return { found: true, runId: run.id, count: events.length, events };
      },
    },
    {
      definition: {
        id: 'agentis.approval.list',
        family: 'inspect',
        description: 'List pending approvals for the workspace.',
        inputSchema: { type: 'object', properties: { runId: { type: 'string' } } },
        mutating: false,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        const items = deps.approvals.list(ctx.workspaceId, 'pending').filter((r) => !args.runId || r.runId === String(args.runId));
        return { count: items.length, approvals: items };
      },
    },
    {
      definition: {
        id: 'agentis.extensions.list',
        family: 'inspect',
        description:
          'List workspace extensions with real extensionIds, schemas, runtimes, and capability tags. Use this before creating extension_task workflow nodes.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            runtime: { type: 'string', enum: ['builtin', 'node_worker', 'docker_sandbox'] },
            capabilityTag: { type: 'string' },
            limit: { type: 'number' },
          },
        },
        mutating: false,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
        const runtime = typeof args.runtime === 'string' ? args.runtime : null;
        const capabilityTag = typeof args.capabilityTag === 'string' ? args.capabilityTag.trim().toLowerCase() : '';
        const limit = clampLimit(args.limit, 50, 200);
        const rows = deps.db
          .select()
          .from(schema.extensions)
          .where(eq(schema.extensions.workspaceId, ctx.workspaceId))
          .orderBy(desc(schema.extensions.createdAt))
          .all();

        const filtered = rows
          .map(toExtensionSummary)
          .filter((extension) => !runtime || extension.runtime === runtime)
          .filter((extension) => !capabilityTag || extension.capabilityTags.some((tag) => tag.toLowerCase() === capabilityTag))
          .filter((extension) => {
            if (!query) return true;
            const haystack = [
              extension.id,
              extension.name,
              extension.slug,
              extension.entrypoint,
              extension.runtime,
              ...extension.capabilityTags,
            ].join(' ').toLowerCase();
            return haystack.includes(query);
          });

        const installedBuiltinEntrypoints = new Set(
          rows
            .filter((row) => row.runtime === 'builtin')
            .map((row) => manifestFromRow(row).entrypoint)
            .filter((entrypoint): entrypoint is string => typeof entrypoint === 'string' && entrypoint.length > 0),
        );
        const missingWorkspaceRows = BUILTIN_EXTENSION_ENTRYPOINTS.filter((entrypoint) => !installedBuiltinEntrypoints.has(entrypoint));

        return {
          count: Math.min(filtered.length, limit),
          total: filtered.length,
          extensions: filtered.slice(0, limit),
          builtinExecutors: {
            entrypoints: BUILTIN_EXTENSION_ENTRYPOINTS,
            missingWorkspaceRows,
            usableInWorkflows: missingWorkspaceRows.length === 0,
            note: missingWorkspaceRows.length > 0
              ? 'Builtin executors exist in code, but extension_task nodes need an installed workspace extension row so the graph can reference a real extensionId.'
              : 'Builtin extensions are installed in this workspace and can be referenced by extensionId.',
          },
        };
      },
    },
    {
      definition: {
        id: 'agentis.extension.inspect',
        family: 'inspect',
        description:
          'Inspect a single workspace extension by extensionId, slug, or builtin entrypoint. Returns the manifest and whether it can be used in workflow extension_task nodes.',
        inputSchema: {
          type: 'object',
          properties: {
            extensionId: { type: 'string' },
            slug: { type: 'string' },
            entrypoint: { type: 'string' },
          },
        },
        mutating: false,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        const extensionId = typeof args.extensionId === 'string' ? args.extensionId.trim() : '';
        const slug = typeof args.slug === 'string' ? args.slug.trim() : '';
        const entrypoint = typeof args.entrypoint === 'string' ? args.entrypoint.trim() : '';
        if (!extensionId && !slug && !entrypoint) {
          return { found: false, error: 'Provide one of extensionId, slug, or entrypoint.' };
        }

        const row = deps.db
          .select()
          .from(schema.extensions)
          .where(eq(schema.extensions.workspaceId, ctx.workspaceId))
          .all()
          .find((candidate) => {
            const manifest = manifestFromRow(candidate);
            return (!!extensionId && candidate.id === extensionId)
              || (!!slug && candidate.slug === slug)
              || (!!entrypoint && manifest.entrypoint === entrypoint);
          });

        if (!row) {
          const requested = entrypoint || slug || extensionId;
          const builtinExecutorAvailable = BUILTIN_EXTENSION_ENTRYPOINTS.includes(requested);
          return {
            found: false,
            requested,
            builtinExecutorAvailable,
            usableInWorkflows: false,
            message: builtinExecutorAvailable
              ? 'The builtin executor exists, but this workspace does not have an installed extension row for it. Run seed/bootstrap or install the extension before using it in a workflow graph.'
              : 'No workspace extension matched the requested identifier.',
          };
        }

        return {
          found: true,
          extension: toExtensionDetail(row),
          usableInWorkflows: true,
        };
      },
    },
    {
      definition: {
        id: 'agentis.skills.list',
        family: 'inspect',
        description:
          'List workspace skills with real skillIds, schemas, runtimes, and capability tags. Use this before creating skill_task workflow nodes.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            runtime: { type: 'string', enum: ['builtin', 'node_worker', 'docker_sandbox'] },
            capabilityTag: { type: 'string' },
            limit: { type: 'number' },
          },
        },
        mutating: false,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
        const runtime = typeof args.runtime === 'string' ? args.runtime : null;
        const capabilityTag = typeof args.capabilityTag === 'string' ? args.capabilityTag.trim().toLowerCase() : '';
        const limit = clampLimit(args.limit, 50, 200);
        const rows = deps.db
          .select()
          .from(schema.extensions)
          .where(eq(schema.extensions.workspaceId, ctx.workspaceId))
          .orderBy(desc(schema.extensions.createdAt))
          .all();

        const filtered = rows
          .map(toExtensionSummary)
          .filter((extension) => !runtime || extension.runtime === runtime)
          .filter((extension) => !capabilityTag || extension.capabilityTags.some((tag) => tag.toLowerCase() === capabilityTag))
          .filter((extension) => {
            if (!query) return true;
            const haystack = [
              extension.id,
              extension.name,
              extension.slug,
              extension.entrypoint,
              extension.runtime,
              ...extension.capabilityTags,
            ].join(' ').toLowerCase();
            return haystack.includes(query);
          });

        const installedBuiltinEntrypoints = new Set(
          rows
            .filter((row) => row.runtime === 'builtin')
            .map((row) => manifestFromRow(row).entrypoint)
            .filter((entrypoint): entrypoint is string => typeof entrypoint === 'string' && entrypoint.length > 0),
        );
        const missingWorkspaceRows = BUILTIN_EXTENSION_ENTRYPOINTS.filter((entrypoint) => !installedBuiltinEntrypoints.has(entrypoint));

        return {
          count: Math.min(filtered.length, limit),
          total: filtered.length,
          extensions: filtered.slice(0, limit),
          builtinExecutors: {
            entrypoints: BUILTIN_EXTENSION_ENTRYPOINTS,
            missingWorkspaceRows,
            usableInWorkflows: missingWorkspaceRows.length === 0,
            note: missingWorkspaceRows.length > 0
              ? 'Builtin executors exist in code, but skill_task nodes need an installed workspace skill row so the graph can reference a real skillId.'
              : 'Builtin skills are installed in this workspace and can be referenced by skillId.',
          },
        };
      },
    },
    {
      definition: {
        id: 'agentis.skill.inspect',
        family: 'inspect',
        description:
          'Inspect a single workspace skill by skillId, slug, or builtin entrypoint. Returns the manifest and whether it can be used in workflow skill_task nodes.',
        inputSchema: {
          type: 'object',
          properties: {
            skillId: { type: 'string' },
            slug: { type: 'string' },
            entrypoint: { type: 'string' },
          },
        },
        mutating: false,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        const skillId = typeof args.skillId === 'string' ? args.skillId.trim() : '';
        const slug = typeof args.slug === 'string' ? args.slug.trim() : '';
        const entrypoint = typeof args.entrypoint === 'string' ? args.entrypoint.trim() : '';
        if (!skillId && !slug && !entrypoint) {
          return { found: false, error: 'Provide one of skillId, slug, or entrypoint.' };
        }

        const row = deps.db
          .select()
          .from(schema.extensions)
          .where(eq(schema.extensions.workspaceId, ctx.workspaceId))
          .all()
          .find((candidate) => {
            const manifest = manifestFromRow(candidate);
            return (!!skillId && candidate.id === skillId)
              || (!!slug && candidate.slug === slug)
              || (!!entrypoint && manifest.entrypoint === entrypoint);
          });

        if (!row) {
          const requested = entrypoint || slug || skillId;
          const builtinExecutorAvailable = BUILTIN_EXTENSION_ENTRYPOINTS.includes(requested);
          return {
            found: false,
            requested,
            builtinExecutorAvailable,
            usableInWorkflows: false,
            message: builtinExecutorAvailable
              ? 'The builtin executor exists, but this workspace does not have an installed skill row for it. Run seed/bootstrap or install the skill before using it in a workflow graph.'
              : 'No workspace skill matched the requested identifier.',
          };
        }

        return {
          found: true,
          skill: toExtensionDetail(row),
          usableInWorkflows: true,
        };
      },
    },
    {
      definition: {
        id: 'agentis.space.summary',
        family: 'inspect',
        description: 'High-level workspace or space summary: agents, workflows, runs, approvals, and output labels.',
        inputSchema: { type: 'object', properties: { spaceId: { type: 'string' }, window: { type: 'string' } } },
        mutating: false,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        const agents = deps.db.select().from(schema.agents).where(eq(schema.agents.workspaceId, ctx.workspaceId)).all();
        const workflows = deps.db.select().from(schema.workflows).where(eq(schema.workflows.workspaceId, ctx.workspaceId)).all()
          .filter((workflow) => !args.spaceId || ((workflow.settings as Record<string, unknown> | null)?.spaceId === String(args.spaceId)));
        const workflowIds = new Set(workflows.map((workflow) => workflow.id));
        const runs = deps.db
          .select()
          .from(schema.workflowRuns)
          .where(eq(schema.workflowRuns.workspaceId, ctx.workspaceId))
          .orderBy(desc(schema.workflowRuns.createdAt))
          .limit(100)
          .all()
          .filter((run): run is typeof run & { workflowId: string } => run.workflowId !== null && (workflowIds.size === 0 || workflowIds.has(run.workflowId)))
          .filter((run) => isInsideWindow(run.createdAt, String(args.window ?? '7d')));
        const pendingApprovals = deps.approvals.list(ctx.workspaceId, 'pending');
        const outputLabels = aggregateOutputLabels(workflows, runs);
        return {
          spaceId: args.spaceId ?? null,
          window: args.window ?? '7d',
          agentCount: agents.length,
          workflowCount: workflows.length,
          runCount: runs.length,
          successRate: runs.length > 0 ? runs.filter((run) => run.status === 'COMPLETED').length / runs.length : null,
          outputLabels,
          recentRuns: runs.slice(0, 10).map((r) => ({ id: r.id, workflowId: r.workflowId, status: r.status, createdAt: r.createdAt })),
          pendingApprovalCount: pendingApprovals.length,
        };
      },
    },
    {
      definition: {
        id: 'agentis.memory.read',
        family: 'inspect',
        description: 'Search persistent memory for workspace notes and learnings.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            kind: { type: 'string' },
            agentId: { type: 'string' },
            limit: { type: 'number' },
          },
        },
        mutating: false,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
        const kind = typeof args.kind === 'string' ? args.kind : null;
        const agentId = typeof args.agentId === 'string' ? args.agentId : null;
        const limit = clampLimit(args.limit, 20, 100);

        let selectQuery = deps.db
          .select()
          .from(schema.workspaceMemory)
          .where(
            and(
              eq(schema.workspaceMemory.workspaceId, ctx.workspaceId),
              ...(kind ? [eq(schema.workspaceMemory.kind, kind)] : []),
              ...(agentId ? [eq(schema.workspaceMemory.scopeId, agentId)] : []),
            )
          )
          .orderBy(desc(schema.workspaceMemory.updatedAt))
          .limit(limit)
          .$dynamic();

        const rows = selectQuery.all();
        let memories = rows.map((r) => ({
          id: r.id,
          workspaceId: r.workspaceId,
          scopeId: r.scopeId,
          kind: r.kind,
          source: r.source,
          title: r.title,
          content: r.content,
          trust: Number(r.trust),
          importance: Number(r.importance),
          tags: Array.isArray(r.tags) ? r.tags : [],
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        }));

        if (query) {
          memories = memories.filter((m) =>
            m.title.toLowerCase().includes(query) ||
            m.content.toLowerCase().includes(query)
          );
        }

        return { memories };
      },
    },
    {
      definition: {
        id: 'agentis.knowledge.search',
        family: 'inspect',
        description: 'Full-text search across documents and knowledge base entries.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            limit: { type: 'number' },
          },
          required: ['query'],
        },
        mutating: false,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        if (!deps.knowledgeBases) {
          return { error: 'Knowledge base service not available' };
        }
        const query = String(args.query);
        const limit = clampLimit(args.limit, 5, 20);

        const bases = deps.knowledgeBases.listKnowledgeBases(ctx.workspaceId);
        const results: any[] = [];
        for (const base of bases) {
          try {
            const hits = await deps.knowledgeBases.search({
              workspaceId: ctx.workspaceId,
              knowledgeBaseId: base.id,
              query,
              topK: limit,
            });
            results.push(...hits.map((h) => ({ ...h, knowledgeBaseName: base.name })));
          } catch (err) {
            // ignore base search failure
          }
        }

        results.sort((a, b) => b.score - a.score);
        return {
          results: results.slice(0, limit).map((r) => ({
            id: r.id,
            documentId: r.documentId,
            chunkIndex: r.chunkIndex,
            content: r.content,
            score: r.score,
            metadata: r.metadata,
            knowledgeBaseName: r.knowledgeBaseName,
          })),
        };
      },
    },
  ]);
}

function isInsideWindow(createdAt: string, window: string): boolean {
  const ms = window === '24h' ? 86_400_000 : window === '30d' ? 2_592_000_000 : 604_800_000;
  return new Date(createdAt).getTime() >= Date.now() - ms;
}

function aggregateOutputLabels(
  workflows: Array<{ id: string; settings: unknown }>,
  runs: Array<{ workflowId: string; status: string }>,
) {
  const labelsByWorkflow = new Map<string, string[]>();
  for (const workflow of workflows) {
    const settings = (workflow.settings as Record<string, unknown> | null) ?? {};
    const outputLabels = Array.isArray(settings.outputLabels) ? settings.outputLabels.map(String) : [];
    labelsByWorkflow.set(workflow.id, outputLabels);
  }
  const counts: Record<string, number> = {};
  for (const run of runs) {
    if (run.status !== 'COMPLETED') continue;
    for (const label of labelsByWorkflow.get(run.workflowId) ?? []) {
      counts[label] = (counts[label] ?? 0) + 1;
    }
  }
  return counts;
}

function clampLimit(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), 1), max);
}

function manifestFromRow(row: ExtensionRow): Partial<ExtensionManifest> {
  return recordFromUnknown(row.manifest) as Partial<ExtensionManifest>;
}

function toExtensionSummary(row: ExtensionRow) {
  const manifest = manifestFromRow(row);
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    version: row.version,
    runtime: row.runtime,
    entrypoint: typeof manifest.entrypoint === 'string' ? manifest.entrypoint : row.slug,
    packageId: row.packageId,
    ambientId: row.ambientId,
    capabilityTags: stringArray(manifest.capabilityTags),
    operations: Array.isArray(manifest.operations) ? manifest.operations : [],
    timeoutMs: typeof manifest.timeoutMs === 'number' ? manifest.timeoutMs : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toExtensionDetail(row: ExtensionRow) {
  const manifest = manifestFromRow(row);
  return {
    ...toExtensionSummary(row),
    manifest,
    allowedDomains: stringArray(manifest.allowedDomains),
    hasInlineSource: typeof manifest.source === 'string' && manifest.source.length > 0,
    bundleDir: typeof manifest.bundleDir === 'string' ? manifest.bundleDir : null,
  };
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
