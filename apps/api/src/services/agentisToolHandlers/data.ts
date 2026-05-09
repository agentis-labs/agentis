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
          properties: { runId: { type: 'string' }, key: { type: 'string' } },
          required: ['runId', 'key'],
        },
        mutating: false,
      },
      handler: async (args, _ctx) => {
        const value = deps.scratchpad.read(String(args.runId), String(args.key));
        return { runId: args.runId, key: args.key, value: value ?? null, found: value !== undefined };
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
          },
          required: ['runId', 'key', 'value'],
        },
        mutating: true,
      },
      handler: async (args, _ctx) => {
        deps.scratchpad.write(String(args.runId), String(args.key), args.value);
        return { runId: args.runId, key: args.key, written: true };
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
            appId: { type: 'string' },
            query: { type: 'string' },
            limit: { type: 'number' },
            sources: {
              type: 'array',
              items: { type: 'string', enum: ['seed', 'import', 'promotion'] },
            },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['appId', 'query'],
        },
        mutating: false,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        if (!deps.knowledge) {
          return { query: String(args.query), results: [], note: 'KnowledgeStore not wired' };
        }
        const results = deps.knowledge.search({
          workspaceId: ctx.workspaceId,
          appId: String(args.appId),
          query: String(args.query),
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          sources: Array.isArray(args.sources) ? (args.sources as string[]).filter((s) =>
            ['seed', 'import', 'promotion'].includes(s),
          ) as ('seed' | 'import' | 'promotion')[] : undefined,
          tags: Array.isArray(args.tags) ? (args.tags as string[]) : undefined,
        });
        return {
          appId: args.appId,
          query: args.query,
          count: results.length,
          results,
        };
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
