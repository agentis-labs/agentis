/**
 * Data tools — agent reads and writes scratchpad / memory / knowledge.
 *
 * V1.1: knowledge.search is wired to the real KnowledgeStore (lexical TF-IDF).
 * Memory tools split into two layers:
 *   - scratchpad (per-run ephemeral) — the existing memory.read/write
 *   - app memory (durable, app-scoped) — new tools for recall and write
 *
 * Wedge-specific tools (gated behind optional deps so the registry boots cleanly
 * even when the wedge isn't fully wired):
 *   - agentis.knowledge.search          — Class 1+2 retrieval
 *   - agentis.app.memory.recall         — Class 1+4 memory recall
 *   - agentis.app.memory.write          — operator-style memory write (mutating)
 *   - agentis.app.evaluator.examples    — Class 3 example listing
 *   - agentis.app.baselines             — workflow baselines for an app
 *   - agentis.app.intelligence.compose  — full composed context (one-shot)
 *   - agentis.app.promotion.promote     — write-back to Class 4
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';

export function registerDataTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.registerMany([
    // ── Scratchpad (per-run ephemeral memory) ─────────────────────
    {
      definition: {
        id: 'agentis.memory.read',
        family: 'data',
        description: 'Read a scratchpad key for the current run.',
        inputSchema: {
          type: 'object',
          properties: {
            runId: { type: 'string' },
            key: { type: 'string' },
            query: { type: 'string' },
            kind: { type: 'string' },
            agentId: { type: 'string' },
            teamId: { type: 'string' },
            limit: { type: 'number' },
          },
        },
        mutating: false,
      },
      handler: async (args, ctx) => {
        if (args.runId && args.key) {
          const value = deps.scratchpad.read(String(args.runId), String(args.key));
          return { runId: args.runId, key: args.key, value: value ?? null, found: value !== undefined };
        }

        const limit = clampNumber(args.limit, 20, 1, 100);
        const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
        const rows = deps.db
          .select()
          .from(schema.memoryEntries)
          .where(and(
            eq(schema.memoryEntries.workspaceId, ctx.workspaceId),
            isNull(schema.memoryEntries.archivedAt),
          ))
          .orderBy(desc(schema.memoryEntries.importance), desc(schema.memoryEntries.updatedAt))
          .all()
          .filter((entry) => {
            if (args.kind && entry.kind !== String(args.kind)) return false;
            if (args.agentId && entry.agentId !== String(args.agentId)) return false;
            if (args.teamId && entry.teamId !== String(args.teamId)) return false;
            if (!query) return true;
            const tags = Array.isArray(entry.tags) ? entry.tags.join(' ') : '';
            return `${entry.title} ${entry.content} ${tags}`.toLowerCase().includes(query);
          })
          .slice(0, limit);
        return {
          query: args.query ?? null,
          count: rows.length,
          memories: rows.map((entry) => ({
            id: entry.id,
            kind: entry.kind,
            title: entry.title,
            content: entry.content,
            importance: entry.importance,
            confidence: entry.confidence,
            tags: entry.tags,
            agentId: entry.agentId,
            teamId: entry.teamId,
            updatedAt: entry.updatedAt,
          })),
        };
      },
    },
    {
      definition: {
        id: 'agentis.memory.write',
        family: 'data',
        description: 'Write a scratchpad key for the current run.',
        inputSchema: {
          type: 'object',
          properties: {
            runId: { type: 'string' },
            key: { type: 'string' },
            value: {},
            title: { type: 'string' },
            content: { type: 'string' },
            kind: { type: 'string' },
            importance: { type: 'number' },
            tags: { type: 'array', items: { type: 'string' } },
            agentId: { type: 'string' },
          },
        },
        mutating: true,
      },
      handler: async (args, ctx) => {
        if (args.runId && args.key && 'value' in args) {
          deps.scratchpad.write(String(args.runId), String(args.key), args.value);
          return { runId: args.runId, key: args.key, written: true, scope: 'scratchpad' };
        }

        const title = stringArg(args.title).trim();
        const content = stringArg(args.content).trim();
        if (!title || !content) throw new Error('memory.write requires title and content');
        const now = new Date().toISOString();
        const id = randomUUID();
        const importance = Math.min(clampNumber(args.importance, 5, 1, 10), 7);
        const tags = parseStringArray(args.tags);
        deps.db.insert(schema.memoryEntries).values({
          id,
          workspaceId: ctx.workspaceId,
          teamId: null,
          agentId: args.agentId ? String(args.agentId) : ctx.agentId ?? null,
          userId: ctx.userId,
          sourceType: ctx.caller === 'system' ? 'system' : 'agent',
          sourceId: ctx.agentId ?? null,
          kind: args.kind ? String(args.kind) : 'note',
          title,
          content,
          importance,
          confidence: 0.85,
          tags,
          metadata: { source: 'agentis.memory.write', conversationId: ctx.conversationId ?? null },
          archivedAt: null,
          createdAt: now,
          updatedAt: now,
        }).run();
        return { memoryId: id, written: true, scope: 'workspace_memory', importance };
      },
    },

    // ── Knowledge plane (Class 1 + Class 2) ───────────────────────
    {
      definition: {
        id: 'agentis.knowledge.search',
        family: 'data',
        description: 'Search the knowledge plane for an app — seeds + imported documents.',
        inputSchema: {
          type: 'object',
          properties: {
            knowledgeBaseId: { type: 'string' },
            appId: { type: 'string' },
            query: { type: 'string' },
            limit: { type: 'number' },
            sources: {
              type: 'array',
              items: { type: 'string', enum: ['seed', 'import', 'promotion'] },
            },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['query'],
        },
        mutating: false,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        const query = String(args.query ?? '').trim();
        const limit = clampNumber(args.limit, 5, 1, 20);
        if (!query) return { query, count: 0, results: [] };

        if (deps.knowledgeBases && args.knowledgeBaseId) {
          const results = deps.knowledgeBases.search({
            workspaceId: ctx.workspaceId,
            knowledgeBaseId: String(args.knowledgeBaseId),
            query,
            topK: limit,
          });
          return { knowledgeBaseId: args.knowledgeBaseId, query, count: results.length, results };
        }

        if (deps.knowledge && args.appId) {
          const results = deps.knowledge.search({
            workspaceId: ctx.workspaceId,
            appId: String(args.appId),
            query,
            limit,
            sources: Array.isArray(args.sources) ? (args.sources as string[]).filter((s) =>
              ['seed', 'import', 'promotion'].includes(s),
            ) as ('seed' | 'import' | 'promotion')[] : undefined,
            tags: Array.isArray(args.tags) ? (args.tags as string[]) : undefined,
          });
          return {
            appId: args.appId,
            query,
            count: results.length,
            results,
          };
        }

        return searchWorkspaceKnowledge(deps, ctx.workspaceId, query, limit);
      },
    },
    {
      definition: {
        id: 'agentis.knowledge.write',
        family: 'data',
        description: 'Index a text document into a workspace knowledge base or app knowledge plane.',
        inputSchema: {
          type: 'object',
          properties: {
            knowledgeBaseId: { type: 'string' },
            appId: { type: 'string' },
            title: { type: 'string' },
            content: { type: 'string' },
            url: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['title', 'content'],
        },
        mutating: true,
      },
      handler: async (args, ctx) => {
        const title = stringArg(args.title).trim();
        const content = stringArg(args.content).trim();
        if (!title || !content) throw new Error('knowledge.write requires title and content');
        const tags = parseStringArray(args.tags);

        if (deps.knowledgeBases) {
          const knowledgeBaseId = args.knowledgeBaseId
            ? String(args.knowledgeBaseId)
            : ensureWorkspaceKnowledgeBase(deps, ctx.workspaceId).id;
          const document = deps.knowledgeBases.addDocument({
            workspaceId: ctx.workspaceId,
            knowledgeBaseId,
            name: title,
            mimeType: 'text/plain',
            content,
          });
          return { knowledgeBaseId, document, written: true };
        }

        if (deps.knowledge && args.appId) {
          const chunk = deps.knowledge.write({
            workspaceId: ctx.workspaceId,
            appId: String(args.appId),
            title,
            content,
            source: 'import',
            tags,
            provenance: { url: args.url ? String(args.url) : null, source: 'agentis.knowledge.write' },
          });
          return { appId: args.appId, chunk, written: true };
        }

        const id = randomUUID();
        const now = new Date().toISOString();
        deps.db.insert(schema.knowledgeChunks).values({
          id,
          workspaceId: ctx.workspaceId,
          appId: 'workspace',
          title,
          content,
          contentTokens: tokenize(content),
          source: 'import',
          provenance: { url: args.url ? String(args.url) : null, source: 'agentis.knowledge.write' },
          tags,
          embedding: null,
          trust: '0.85',
          createdAt: now,
          updatedAt: now,
        }).run();
        return { knowledgeChunkId: id, written: true };
      },
    },

    // ── App memory (Class 1 + Class 4) ────────────────────────────
    {
      definition: {
        id: 'agentis.app.memory.recall',
        family: 'data',
        description: 'Recall app memory — facts, preferences, rules, patterns, lessons.',
        inputSchema: {
          type: 'object',
          properties: {
            appId: { type: 'string' },
            hint: { type: 'string' },
            limit: { type: 'number' },
            kinds: {
              type: 'array',
              items: { type: 'string', enum: ['fact', 'preference', 'pattern', 'rule', 'lesson'] },
            },
          },
          required: ['appId'],
        },
        mutating: false,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        if (!deps.appMemory) {
          return { appId: args.appId, episodes: [], note: 'AppMemoryStore not wired' };
        }
        const episodes = deps.appMemory.recall({
          workspaceId: ctx.workspaceId,
          appId: String(args.appId),
          hint: typeof args.hint === 'string' ? args.hint : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          kinds: Array.isArray(args.kinds)
            ? ((args.kinds as string[]).filter((k) =>
                ['fact', 'preference', 'pattern', 'rule', 'lesson'].includes(k),
              ) as ('fact' | 'preference' | 'pattern' | 'rule' | 'lesson')[])
            : undefined,
        });
        return { appId: args.appId, count: episodes.length, episodes };
      },
    },
    {
      definition: {
        id: 'agentis.app.memory.write',
        family: 'data',
        description:
          'Write to app memory (operator/agent-confirmed fact, preference, rule, pattern, or lesson).',
        inputSchema: {
          type: 'object',
          properties: {
            appId: { type: 'string' },
            kind: { type: 'string', enum: ['fact', 'preference', 'pattern', 'rule', 'lesson'] },
            title: { type: 'string' },
            content: { type: 'string' },
            trust: { type: 'number' },
            importance: { type: 'number' },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['appId', 'kind', 'title', 'content'],
        },
        mutating: true,
      },
      handler: async (args, ctx) => {
        if (!deps.appMemory) {
          throw new Error('AppMemoryStore not wired');
        }
        const id = deps.appMemory.write({
          workspaceId: ctx.workspaceId,
          appId: String(args.appId),
          kind: args.kind as 'fact',
          source: 'operator',
          title: String(args.title),
          content: String(args.content),
          trust: typeof args.trust === 'number' ? args.trust : undefined,
          importance: typeof args.importance === 'number' ? args.importance : undefined,
          tags: Array.isArray(args.tags) ? (args.tags as string[]) : undefined,
        });
        return { appId: args.appId, episodeId: id, written: true };
      },
    },

    // ── Evaluator examples (Class 3) ──────────────────────────────
    {
      definition: {
        id: 'agentis.app.evaluator.examples',
        family: 'data',
        description: 'List evaluator examples for an app, optionally filtered by evaluator key.',
        inputSchema: {
          type: 'object',
          properties: {
            appId: { type: 'string' },
            evaluatorKey: { type: 'string' },
            limit: { type: 'number' },
          },
          required: ['appId'],
        },
        mutating: false,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        if (!deps.evaluators) {
          return { appId: args.appId, examples: [], note: 'EvaluatorExampleStore not wired' };
        }
        const examples = deps.evaluators.list({
          workspaceId: ctx.workspaceId,
          appId: String(args.appId),
          evaluatorKey: typeof args.evaluatorKey === 'string' ? args.evaluatorKey : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
        });
        return { appId: args.appId, count: examples.length, examples };
      },
    },

    // ── Baselines ─────────────────────────────────────────────────
    {
      definition: {
        id: 'agentis.app.baselines',
        family: 'data',
        description: 'Read the latest workflow baselines for an app.',
        inputSchema: {
          type: 'object',
          properties: { appId: { type: 'string' } },
          required: ['appId'],
        },
        mutating: false,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        if (!deps.baselines) {
          return { appId: args.appId, baselines: [], note: 'WorkflowBaselineStore not wired' };
        }
        const baselines = deps.baselines.latestForApp(ctx.workspaceId, String(args.appId));
        return { appId: args.appId, count: baselines.length, baselines };
      },
    },

    // ── Composed context (full wedge in one shot) ─────────────────
    {
      definition: {
        id: 'agentis.app.intelligence.compose',
        family: 'data',
        description:
          'Compose the full intelligence context for an app — knowledge, memory, evaluator examples, baselines, promoted patterns.',
        inputSchema: {
          type: 'object',
          properties: {
            appId: { type: 'string' },
            query: { type: 'string' },
            tokenBudget: { type: 'number' },
          },
          required: ['appId', 'query'],
        },
        mutating: false,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        if (!deps.intelligence) {
          return {
            appId: args.appId,
            query: args.query,
            note: 'AppIntelligenceRuntime not wired',
          };
        }
        const composed = deps.intelligence.compose({
          workspaceId: ctx.workspaceId,
          appId: String(args.appId),
          query: String(args.query),
          tokenBudget: typeof args.tokenBudget === 'number' ? args.tokenBudget : undefined,
        });
        return composed;
      },
    },

    // ── Promotion (Class 4 write-back) ────────────────────────────
    {
      definition: {
        id: 'agentis.app.promotion.promote',
        family: 'data',
        description:
          'Promote (or reinforce) a pattern in the app intelligence layer — successful playbook, business rule, etc.',
        inputSchema: {
          type: 'object',
          properties: {
            appId: { type: 'string' },
            kind: {
              type: 'string',
              enum: [
                'successful_playbook',
                'failure_with_fix',
                'approved_output_pattern',
                'business_rule',
                'recurring_exception',
              ],
            },
            title: { type: 'string' },
            summary: { type: 'string' },
            payload: { type: 'object' },
            confidenceHint: { type: 'number' },
          },
          required: ['appId', 'kind', 'title', 'summary'],
        },
        mutating: true,
      },
      handler: async (args, ctx) => {
        if (!deps.promotion) {
          throw new Error('IntelligencePromotion not wired');
        }
        const result = deps.promotion.promoteOrReinforce({
          workspaceId: ctx.workspaceId,
          appId: String(args.appId),
          kind: args.kind as 'successful_playbook',
          title: String(args.title),
          summary: String(args.summary),
          payload: (args.payload as Record<string, unknown>) ?? {},
          provenance: { source: 'tool_call', caller: ctx.caller },
          confidenceHint:
            typeof args.confidenceHint === 'number' ? args.confidenceHint : undefined,
        });
        return result;
      },
    },
  ]);
}

function stringArg(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
}

function tokenize(input: string): string[] {
  return input.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
}

function scoreText(queryTokens: Set<string>, text: string): number {
  if (queryTokens.size === 0) return 0;
  const contentTokens = new Set(tokenize(text));
  let hits = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) hits += 1;
  }
  return hits / queryTokens.size;
}

function searchWorkspaceKnowledge(
  deps: ToolHandlerDeps,
  workspaceId: string,
  query: string,
  limit: number,
) {
  const queryTokens = new Set(tokenize(query));
  const kbResults = deps.db
    .select()
    .from(schema.kbChunks)
    .where(eq(schema.kbChunks.workspaceId, workspaceId))
    .all()
    .map((chunk) => ({
      source: 'knowledge_base' as const,
      id: chunk.id,
      documentId: chunk.documentId,
      knowledgeBaseId: chunk.knowledgeBaseId,
      content: chunk.content,
      metadata: chunk.metadata,
      score: scoreText(queryTokens, chunk.content),
    }));
  const appResults = deps.db
    .select()
    .from(schema.knowledgeChunks)
    .where(eq(schema.knowledgeChunks.workspaceId, workspaceId))
    .all()
    .map((chunk) => ({
      source: 'app_knowledge' as const,
      id: chunk.id,
      appId: chunk.appId,
      title: chunk.title,
      content: chunk.content,
      metadata: chunk.provenance,
      score: scoreText(queryTokens, `${chunk.title} ${chunk.content}`),
    }));

  const results = [...kbResults, ...appResults]
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return { query, count: results.length, results };
}

function ensureWorkspaceKnowledgeBase(deps: ToolHandlerDeps, workspaceId: string) {
  if (!deps.knowledgeBases) throw new Error('KnowledgeBaseService not wired');
  const existing = deps.knowledgeBases
    .listKnowledgeBases(workspaceId)
    .find((kb) => kb.name === 'Workspace Knowledge');
  return existing ?? deps.knowledgeBases.createKnowledgeBase({
    workspaceId,
    name: 'Workspace Knowledge',
    description: 'General workspace knowledge indexed by Agentis.',
  });
}
