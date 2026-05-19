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
import { REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';
import { safeJson, scoreText, tokenize } from '../brainText.js';

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
        id: 'agentis.brain.search',
        family: 'data',
        description: 'Search durable Brain atoms by semantic query.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            scope: { type: 'string', enum: ['workspace', 'app', 'both'] },
            appId: { type: 'string' },
            limit: { type: 'number' },
          },
          required: ['query'],
        },
        mutating: false,
      },
      handler: async (args, ctx) => {
        if (!deps.collectiveBrain) return { query: args.query, count: 0, atoms: [], note: 'CollectiveBrainService not wired' };
        const appId = args.appId ? String(args.appId) : appIdFromContext(ctx);
        const atoms = await deps.collectiveBrain.searchAtoms({
          workspaceId: ctx.workspaceId,
          appId,
          query: String(args.query ?? ''),
          scope: args.scope === 'workspace' || args.scope === 'app' || args.scope === 'both' ? args.scope : 'both',
          limit: clampNumber(args.limit, 5, 1, 20),
        });
        return { query: args.query, count: atoms.length, atoms };
      },
    },
    {
      definition: {
        id: 'agentis.brain.add',
        family: 'data',
        description: 'Add a durable fact or pattern to the Brain and make it available to the current session.',
        inputSchema: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            title: { type: 'string' },
            kind: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            appId: { type: 'string' },
            confidence: { type: 'number' },
          },
          required: ['content'],
        },
        mutating: true,
      },
      handler: async (args, ctx) => {
        const content = stringArg(args.content).trim();
        if (!content) throw new Error('brain.add requires content');
        const appId = args.appId ? String(args.appId) : appIdFromContext(ctx);
        const sessionId = ctx.conversationId ?? `chat:${ctx.agentId}`;
        const sessionAtom = deps.sessionAtoms?.add({
          workspaceId: ctx.workspaceId,
          sessionId,
          appId,
          content,
          confidence: typeof args.confidence === 'number' ? args.confidence : 0.72,
        }) ?? null;
        const queueId = deps.brainQueue?.enqueue({
          workspaceId: ctx.workspaceId,
          itemType: 'atom_promotion',
          priority: 'normal',
          payload: {
            workspaceId: ctx.workspaceId,
            appId,
            agentId: ctx.agentId,
            taskInput: { source: 'agentis.brain.add', sessionId },
            taskOutput: { summary: content },
          },
        }) ?? null;
        const atom = !queueId && deps.collectiveBrain
          ? await deps.collectiveBrain.addAtom({
              workspaceId: ctx.workspaceId,
              appId,
              agentId: ctx.agentId,
              content,
              title: typeof args.title === 'string' ? args.title : undefined,
              tags: parseStringArray(args.tags),
              confidence: typeof args.confidence === 'number' ? args.confidence : 0.72,
              source: 'agent_write',
              managed: true,
              metadata: { source: 'agentis.brain.add', sessionId, kind: args.kind ?? null },
            })
          : null;
        return { status: queueId ? 'queued' : 'created', queueId, atom, sessionAtom };
      },
    },
    {
      definition: {
        id: 'agentis.brain.summarize',
        family: 'data',
        description: 'Return Brain health and capacity summary for the current workspace/app/session.',
        inputSchema: {
          type: 'object',
          properties: { appId: { type: 'string' } },
        },
        mutating: false,
      },
      handler: async (args, ctx) => {
        if (!deps.collectiveBrain) return { note: 'CollectiveBrainService not wired' };
        return deps.collectiveBrain.summarize({
          workspaceId: ctx.workspaceId,
          appId: args.appId ? String(args.appId) : appIdFromContext(ctx),
          sessionId: ctx.conversationId ?? null,
        });
      },
    },
    {
      definition: {
        id: 'agentis.brain.refresh',
        family: 'data',
        description: 'Reload Brain context for the current conversation topic after a topic shift.',
        inputSchema: {
          type: 'object',
          properties: {
            reason: { type: 'string' },
            query: { type: 'string' },
            appId: { type: 'string' },
          },
        },
        mutating: false,
      },
      handler: async (args, ctx) => {
        if (!deps.collectiveBrain) return { freshAtoms: [], sessionAtoms: [], header: 'BRAIN REFRESH unavailable' };
        const appId = args.appId ? String(args.appId) : appIdFromContext(ctx);
        const query = String(args.query ?? args.reason ?? 'current conversation topic');
        const freshAtoms = await deps.collectiveBrain.searchAtoms({
          workspaceId: ctx.workspaceId,
          appId,
          query,
          scope: 'both',
          limit: 5,
        });
        const sessionAtoms = deps.sessionAtoms?.query({
          workspaceId: ctx.workspaceId,
          sessionId: ctx.conversationId ?? `chat:${ctx.agentId}`,
          query,
          limit: 10,
        }) ?? [];
        deps.sessionAtoms?.emitRefresh({
          workspaceId: ctx.workspaceId,
          appId,
          reason: typeof args.reason === 'string' ? args.reason : null,
          atomCount: freshAtoms.length,
          sessionAtomCount: sessionAtoms.length,
        });
        return {
          freshAtoms,
          sessionAtoms,
          header: `BRAIN REFRESHED [${freshAtoms.length} atoms | ${sessionAtoms.length} session-local | topic: ${query.slice(0, 80)}]`,
        };
      },
    },
    {
      definition: {
        id: 'agentis.brain.preload',
        family: 'data',
        description: 'Proactively surface Brain context most relevant to an upcoming task before work starts.',
        inputSchema: {
          type: 'object',
          properties: {
            taskDescription: { type: 'string' },
            peerId: { type: 'string' },
            appId: { type: 'string' },
            limit: { type: 'number' },
          },
          required: ['taskDescription'],
        },
        mutating: false,
      },
      handler: async (args, ctx) => {
        return runBrainPreload(deps, ctx, {
          taskDescription: String(args.taskDescription ?? ''),
          peerId: typeof args.peerId === 'string' ? args.peerId : ctx.userId ?? undefined,
          appId: typeof args.appId === 'string' ? args.appId : appIdFromContext(ctx) ?? undefined,
          limit: clampNumber(args.limit, 5, 1, 10),
        });
      },
    },
    {
      definition: {
        id: 'agentis.brain.forget',
        family: 'data',
        description: 'Dry-run or execute a selective forgetting cascade across Brain atoms, peer memory, and abilities.',
        inputSchema: {
          type: 'object',
          properties: {
            topic: { type: 'string' },
            scope: { type: 'string', enum: ['atoms', 'peer_conclusions', 'abilities', 'all'] },
            dryRun: { type: 'boolean' },
            confirmRequestId: { type: 'string' },
            limit: { type: 'number' },
          },
          required: ['topic'],
        },
        mutating: true,
      },
      handler: async (args, ctx) => {
        return runBrainForget(deps, ctx, {
          topic: String(args.topic ?? ''),
          scope: args.scope === 'atoms' || args.scope === 'peer_conclusions' || args.scope === 'abilities' || args.scope === 'all'
            ? args.scope
            : 'all',
          dryRun: args.dryRun !== false,
          confirmRequestId: typeof args.confirmRequestId === 'string' ? args.confirmRequestId : null,
          limit: clampNumber(args.limit, 25, 1, 200),
        });
      },
    },
    {
      definition: {
        id: 'agentis.session.search',
        family: 'data',
        description: 'Search prior workflow ledger events and conversation messages.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            limit: { type: 'number' },
          },
          required: ['query'],
        },
        mutating: false,
      },
      handler: async (args, ctx) => {
        if (!deps.sessionSearch) return { query: args.query, count: 0, hits: [], note: 'SessionSearchService not wired' };
        const hits = deps.sessionSearch.search({
          workspaceId: ctx.workspaceId,
          query: String(args.query ?? ''),
          limit: clampNumber(args.limit, 10, 1, 50),
        });
        return { query: args.query, count: hits.length, hits };
      },
    },
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

function appIdFromContext(ctx: { viewport?: { resourceKind?: string; resourceId?: string | null } | null }): string | null {
  return ctx.viewport?.resourceKind === 'app' && ctx.viewport.resourceId
    ? ctx.viewport.resourceId
    : null;
}

async function runBrainPreload(
  deps: ToolHandlerDeps,
  ctx: { workspaceId: string; agentId?: string | null; userId?: string | null },
  args: { taskDescription: string; peerId?: string; appId?: string; limit: number },
) {
  const taskDescription = args.taskDescription.trim();
  if (!taskDescription) throw new Error('brain.preload requires taskDescription');
  const relevantAtoms = deps.collectiveBrain
    ? await deps.collectiveBrain.searchAtoms({
        workspaceId: ctx.workspaceId,
        appId: args.appId ?? null,
        query: taskDescription,
        scope: args.appId ? 'both' : 'workspace',
        limit: args.limit,
        minConfidence: 0.45,
      })
    : [];
  const peerId = args.peerId ?? ctx.userId ?? null;
  const observerScope = ctx.agentId ?? 'global';
  const peerContext = peerId && deps.peerRepresentations
    ? [
        deps.peerRepresentations.renderSystemInstructions(ctx.workspaceId, 'user', peerId, observerScope),
        ...deps.peerRepresentations.renderContextFacts(ctx.workspaceId, 'user', peerId, observerScope),
      ].filter(Boolean).join('\n')
    : null;
  const suggestedAbilities = deps.abilities && ctx.agentId
    ? rankAbilities(
        deps.abilities.list(ctx.workspaceId, { agentId: ctx.agentId }).filter((ability) => ability.status === 'active'),
        taskDescription,
        5,
      )
    : [];
  const unknownGaps = peerContext && /\bBELIEF:/i.test(peerContext)
    ? ['Peer belief facts are present; verify them against current workspace atoms before correcting the operator.']
    : [];
  return {
    taskDescription,
    relevantAtoms,
    peerContext,
    suggestedAbilities,
    unknownGaps,
    summary: [
      `BRAIN PRELOAD [${relevantAtoms.length} atoms`,
      `${suggestedAbilities.length} abilities`,
      peerContext ? 'peer context loaded]' : 'no peer context]',
    ].join(' | '),
  };
}

function runBrainForget(
  deps: ToolHandlerDeps,
  ctx: { workspaceId: string; userId?: string | null },
  args: { topic: string; scope: 'atoms' | 'peer_conclusions' | 'abilities' | 'all'; dryRun: boolean; confirmRequestId: string | null; limit: number },
) {
  const topic = args.topic.trim();
  if (!topic) throw new Error('brain.forget requires topic');
  const now = new Date().toISOString();
  if (!args.dryRun) {
    if (!args.confirmRequestId) {
      throw new Error('brain.forget requires confirmRequestId from a prior dry run before executing deletion.');
    }
    return executeBrainForgetRequest(deps, ctx.workspaceId, args.confirmRequestId, now);
  }

  const matches = computeForgetMatches(deps, ctx.workspaceId, topic, args.scope, args.limit);
  const auditEventId = randomUUID();
  deps.db.insert(schema.brainForgetRequests).values({
    id: auditEventId,
    workspaceId: ctx.workspaceId,
    requestedByUserId: ctx.userId ?? null,
    topic,
    scope: args.scope,
    status: 'pending',
    matches,
    counts: forgetCounts(matches, deps, ctx.workspaceId),
    createdAt: now,
    executedAt: null,
  }).run();

  return {
    dryRun: true,
    topic,
    scope: args.scope,
    confirmRequestId: auditEventId,
    matches,
    ...forgetCounts(matches, deps, ctx.workspaceId),
    auditEventId: null,
  };
}

function computeForgetMatches(
  deps: ToolHandlerDeps,
  workspaceId: string,
  topic: string,
  scope: 'atoms' | 'peer_conclusions' | 'abilities' | 'all',
  limit: number,
) {
  const tokens = new Set(tokenize(topic));
  const include = (candidate: string) => scope === 'all' || scope === candidate;

  const atoms = include('atoms')
    ? deps.db.select().from(schema.memoryEpisodes)
        .where(and(eq(schema.memoryEpisodes.workspaceId, workspaceId), isNull(schema.memoryEpisodes.archivedAt)))
        .all()
        .filter((row) => row.status !== 'archived')
        .map((row) => ({ id: row.id, title: row.title, summary: row.summary, score: scoreText(tokens, `${row.title} ${row.summary}`) }))
        .filter((row) => row.score >= 0.35)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
    : [];
  const conclusions = include('peer_conclusions')
    ? deps.db.select().from(schema.peerRepresentationConclusions)
        .where(and(eq(schema.peerRepresentationConclusions.workspaceId, workspaceId), eq(schema.peerRepresentationConclusions.status, 'active')))
        .all()
        .map((row) => ({ id: row.id, peerId: row.subjectPeerId, content: row.content, score: scoreText(tokens, row.content) }))
        .filter((row) => row.score >= 0.35)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
    : [];
  const abilities = include('abilities')
    ? deps.db.select().from(schema.agentAbilities)
        .where(and(eq(schema.agentAbilities.workspaceId, workspaceId), eq(schema.agentAbilities.status, 'active')))
        .all()
        .map((row) => ({ id: row.id, title: row.title, content: row.content, score: scoreText(tokens, `${row.title} ${row.content}`) }))
        .filter((row) => row.score >= 0.35)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
    : [];
  const peerCardPreview = include('peer_conclusions') ? previewPeerCardRemovals(deps, workspaceId, tokens) : { global: [], directional: [] };

  return { atoms, peerConclusions: conclusions, abilities, peerCardFacts: peerCardPreview };
}

function executeBrainForgetRequest(deps: ToolHandlerDeps, workspaceId: string, requestId: string, now: string) {
  const request = deps.db.select().from(schema.brainForgetRequests)
    .where(and(
      eq(schema.brainForgetRequests.workspaceId, workspaceId),
      eq(schema.brainForgetRequests.id, requestId),
      eq(schema.brainForgetRequests.status, 'pending'),
    ))
    .get();
  if (!request) throw new Error('brain.forget confirmation request was not found or was already executed.');

  const matches = parseForgetMatches(request.matches);
  const counts = forgetCounts(matches, deps, workspaceId);
  let linksRemoved = 0;
  let peerCardFactsRemoved = 0;

  deps.db.transaction((tx) => {
    for (const atom of matches.atoms) {
      tx.update(schema.memoryEpisodes)
        .set({ status: 'archived', archivedAt: now, updatedAt: now })
        .where(and(eq(schema.memoryEpisodes.workspaceId, workspaceId), eq(schema.memoryEpisodes.id, atom.id)))
        .run();
    }
    for (const atom of matches.atoms) {
      linksRemoved += tx.update(schema.knowledgeLinks)
        .set({ confidence: 0, relation: 'forgotten', updatedAt: now })
        .where(and(eq(schema.knowledgeLinks.workspaceId, workspaceId), eq(schema.knowledgeLinks.sourceId, atom.id)))
        .run().changes;
      linksRemoved += tx.update(schema.knowledgeLinks)
        .set({ confidence: 0, relation: 'forgotten', updatedAt: now })
        .where(and(eq(schema.knowledgeLinks.workspaceId, workspaceId), eq(schema.knowledgeLinks.targetId, atom.id)))
        .run().changes;
    }
    for (const conclusion of matches.peerConclusions) {
      tx.update(schema.peerRepresentationConclusions)
        .set({ status: 'archived', updatedAt: now })
        .where(and(eq(schema.peerRepresentationConclusions.workspaceId, workspaceId), eq(schema.peerRepresentationConclusions.id, conclusion.id)))
        .run();
    }
    peerCardFactsRemoved = removePeerCardFacts({ db: tx } as unknown as ToolHandlerDeps, workspaceId, matches.peerCardFacts);
    for (const ability of matches.abilities) {
      tx.update(schema.agentAbilities)
        .set({ status: 'archived', updatedAt: now })
        .where(and(eq(schema.agentAbilities.workspaceId, workspaceId), eq(schema.agentAbilities.id, ability.id)))
        .run();
    }
    tx.update(schema.brainForgetRequests)
      .set({ status: 'executed', executedAt: now, counts: { ...counts, peerCardFactsRemoved, knowledgeLinksRemoved: linksRemoved } })
      .where(eq(schema.brainForgetRequests.id, requestId))
      .run();
    tx.insert(schema.brainQualityEvents).values({
      id: requestId,
      workspaceId,
      appId: null,
      agentId: null,
      eventType: 'brain_forget_completed',
      atomId: null,
      abilityId: null,
      runId: null,
      delta: null,
      metadata: { topic: request.topic, scope: request.scope, requestId, matches, counts: { ...counts, peerCardFactsRemoved, knowledgeLinksRemoved: linksRemoved } },
      createdAt: now,
    }).run();
  });

  const result = {
    dryRun: false,
    topic: request.topic,
    scope: request.scope,
    atomsArchived: matches.atoms.length,
    peerConclusionsArchived: matches.peerConclusions.length,
    peerCardFactsRemoved,
    abilitiesArchived: matches.abilities.length,
    knowledgeLinksRemoved: linksRemoved,
    auditEventId: requestId,
  };
  deps.bus.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.BRAIN_FORGET_COMPLETED, { workspaceId, ...result });
  return result;
}

function rankAbilities(abilities: Array<{ id: string; title: string; content: string; confidence: number; usageCount: number }>, query: string, limit: number) {
  const tokens = new Set(tokenize(query));
  return abilities
    .map((ability) => ({ ...ability, score: scoreText(tokens, `${ability.title} ${ability.content}`) + ability.confidence * 0.1 }))
    .filter((ability) => ability.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function estimateKnowledgeLinks(deps: ToolHandlerDeps, workspaceId: string, atomIds: string[]): number {
  if (atomIds.length === 0) return 0;
  const idSet = new Set(atomIds);
  return deps.db.select().from(schema.knowledgeLinks)
    .where(eq(schema.knowledgeLinks.workspaceId, workspaceId))
    .all()
    .filter((link) => idSet.has(link.sourceId) || idSet.has(link.targetId)).length;
}

function forgetCounts(
  matches: ReturnType<typeof computeForgetMatches>,
  deps: ToolHandlerDeps,
  workspaceId: string,
) {
  return {
    atomsArchived: matches.atoms.length,
    peerConclusionsArchived: matches.peerConclusions.length,
    peerCardFactsRemoved: matches.peerCardFacts.global.length + matches.peerCardFacts.directional.length,
    abilitiesArchived: matches.abilities.length,
    knowledgeLinksRemoved: estimateKnowledgeLinks(deps, workspaceId, matches.atoms.map((atom) => atom.id)),
  };
}

function parseForgetMatches(raw: unknown): ReturnType<typeof computeForgetMatches> {
  const value = typeof raw === 'string' ? safeJson(raw) : raw;
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const array = (key: string) => Array.isArray(record[key]) ? record[key] as Array<Record<string, unknown>> : [];
  const peerCardRaw = record.peerCardFacts && typeof record.peerCardFacts === 'object' && !Array.isArray(record.peerCardFacts)
    ? record.peerCardFacts as Record<string, unknown>
    : {};
  return {
    atoms: array('atoms').map((item) => ({
      id: String(item.id ?? ''),
      title: String(item.title ?? ''),
      summary: String(item.summary ?? ''),
      score: Number(item.score ?? 0),
    })).filter((item) => item.id),
    peerConclusions: array('peerConclusions').map((item) => ({
      id: String(item.id ?? ''),
      peerId: String(item.peerId ?? ''),
      content: String(item.content ?? ''),
      score: Number(item.score ?? 0),
    })).filter((item) => item.id),
    abilities: array('abilities').map((item) => ({
      id: String(item.id ?? ''),
      title: String(item.title ?? ''),
      content: String(item.content ?? ''),
      score: Number(item.score ?? 0),
    })).filter((item) => item.id),
    peerCardFacts: {
      global: (Array.isArray(peerCardRaw.global) ? peerCardRaw.global as Array<Record<string, unknown>> : [])
        .map((item) => ({ peerId: String(item.peerId ?? ''), category: String(item.category ?? ''), content: String(item.content ?? '') }))
        .filter((item) => item.peerId && item.content),
      directional: (Array.isArray(peerCardRaw.directional) ? peerCardRaw.directional as Array<Record<string, unknown>> : [])
        .map((item) => ({
          observerPeerId: String(item.observerPeerId ?? ''),
          subjectPeerId: String(item.subjectPeerId ?? ''),
          category: String(item.category ?? ''),
          content: String(item.content ?? ''),
        }))
        .filter((item) => item.observerPeerId && item.subjectPeerId && item.content),
    },
  };
}

function previewPeerCardRemovals(deps: ToolHandlerDeps, workspaceId: string, tokens: Set<string>) {
  const global = deps.db.select().from(schema.peerRepresentations)
    .where(eq(schema.peerRepresentations.workspaceId, workspaceId))
    .all()
    .flatMap((row) => peerCardFacts(row.peerCard)
      .filter((fact) => scoreText(tokens, fact.content) >= 0.35)
      .map((fact) => ({ peerId: row.peerId, category: fact.category, content: fact.content })));
  const directional = deps.db.select().from(schema.agentPeerCards)
    .where(eq(schema.agentPeerCards.workspaceId, workspaceId))
    .all()
    .flatMap((row) => peerCardFacts(row.peerCard)
      .filter((fact) => scoreText(tokens, fact.content) >= 0.35)
      .map((fact) => ({ observerPeerId: row.observerPeerId, subjectPeerId: row.subjectPeerId, category: fact.category, content: fact.content })));
  return { global, directional };
}

function removePeerCardFacts(deps: ToolHandlerDeps, workspaceId: string, matches: ReturnType<typeof computeForgetMatches>['peerCardFacts']): number {
  let removed = 0;
  const now = new Date().toISOString();
  const globalTargets = new Map<string, Set<string>>();
  for (const item of matches.global) {
    const set = globalTargets.get(item.peerId) ?? new Set<string>();
    set.add(`${item.category}:${item.content}`);
    globalTargets.set(item.peerId, set);
  }
  const directionalTargets = new Map<string, Set<string>>();
  for (const item of matches.directional) {
    const key = `${item.observerPeerId}:${item.subjectPeerId}`;
    const set = directionalTargets.get(key) ?? new Set<string>();
    set.add(`${item.category}:${item.content}`);
    directionalTargets.set(key, set);
  }
  for (const row of deps.db.select().from(schema.peerRepresentations).where(eq(schema.peerRepresentations.workspaceId, workspaceId)).all()) {
    const targets = globalTargets.get(row.peerId);
    if (!targets) continue;
    const facts = peerCardFacts(row.peerCard);
    const kept = facts.filter((fact) => !targets.has(`${fact.category}:${fact.content}`));
    if (kept.length === facts.length) continue;
    removed += facts.length - kept.length;
    deps.db.update(schema.peerRepresentations)
      .set({ peerCard: kept, updatedAt: now })
      .where(eq(schema.peerRepresentations.id, row.id))
      .run();
  }
  for (const row of deps.db.select().from(schema.agentPeerCards).where(eq(schema.agentPeerCards.workspaceId, workspaceId)).all()) {
    const targets = directionalTargets.get(`${row.observerPeerId}:${row.subjectPeerId}`);
    if (!targets) continue;
    const facts = peerCardFacts(row.peerCard);
    const kept = facts.filter((fact) => !targets.has(`${fact.category}:${fact.content}`));
    if (kept.length === facts.length) continue;
    removed += facts.length - kept.length;
    deps.db.update(schema.agentPeerCards)
      .set({ peerCard: kept, updatedAt: now })
      .where(eq(schema.agentPeerCards.id, row.id))
      .run();
  }
  return removed;
}

function peerCardFacts(raw: unknown): Array<{ category: string; content: string }> {
  const value = typeof raw === 'string' ? safeJson(raw) : raw;
  return Array.isArray(value)
    ? value
        .filter((item) => item && typeof item === 'object')
        .map((item) => item as Record<string, unknown>)
        .filter((item) => typeof item.content === 'string')
        .map((item) => ({ category: String(item.category ?? 'CONTEXT'), content: String(item.content) }))
    : [];
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
