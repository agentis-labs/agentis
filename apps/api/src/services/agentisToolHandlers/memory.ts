/**
 * Memory Architecture tools — Plane 2 family.
 *
 * Spec: docs/memory/MEMORY-ARCHITECTURE.md.
 *
 * Exposes the Memory OS through the agent tool plane:
 *
 *   agentis.memory.episodes.search   — Layer 3 search
 *   agentis.memory.episodes.write    — Layer 3 write (operator/agent)
 *   agentis.memory.context.build     — Layer 5 composed context
 *   agentis.memory.working.summarize  — Layer 1 summary
 *   agentis.memory.working.read      — Layer 1 typed read
 *   agentis.memory.working.write     — Layer 1 typed write
 *   agentis.memory.promote           — promote a candidate (§10)
 *   agentis.memory.baselines.detect_anomalies — Layer 4 anomaly check
 *
 * All tools are no-ops (returning a clean "not wired" response) when the
 * memory dep is absent, so the registry stays operational during incremental
 * rollouts.
 */

import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';
import type { ObservedRunMetrics } from '../rollingBaselineStore.js';
import type {
  PromotionCandidate,
  RetrievalBudgetClass,
  RetrievalMode,
  RuntimeEpisodeType,
  WorkingMemoryKind,
  WorkingMemoryNamespace,
} from '@agentis/core';

const EPISODE_TYPES: RuntimeEpisodeType[] = [
  'decision','failure','recovery','success_pattern','approval',
  'evaluator_outcome','incident','artifact_outcome','distilled_lesson',
];

export function registerMemoryTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.registerMany([
    // ── Layer 3: episodes.search ─────────────────────────────
    {
      definition: {
        id: 'agentis.memory.episodes.search',
        family: 'data',
        description: 'Search durable runtime episodes — failures, recoveries, success patterns, approvals.',
        inputSchema: {
          type: 'object',
          properties: {
            appId: { type: 'string' },
            workflowId: { type: 'string' },
            query: { type: 'string' },
            types: { type: 'array', items: { type: 'string', enum: EPISODE_TYPES } },
            limit: { type: 'number', minimum: 1, maximum: 50 },
          },
        },
        mutating: false,
      },
      handler: async (args, ctx) => {
        if (!deps.memory) return { error: 'memory_runtime_not_wired', episodes: [] };
        const params: Parameters<typeof deps.memory.searchEpisodes>[0] = {
          workspaceId: ctx.workspaceId,
          query: String(args.query ?? ''),
        };
        if (args.appId) params.appId = String(args.appId);
        if (args.limit !== undefined) params.topK = Number(args.limit);
        const episodes = deps.memory.searchEpisodes(params);
        return { count: episodes.length, episodes };
      },
    },

    // ── Layer 3: episodes.write ──────────────────────────────
    {
      definition: {
        id: 'agentis.memory.episodes.write',
        family: 'data',
        description: 'Write a durable runtime episode (e.g. distilled lesson, decision rationale).',
        inputSchema: {
          type: 'object',
          properties: {
            appId: { type: 'string' },
            workflowId: { type: 'string' },
            runId: { type: 'string' },
            agentId: { type: 'string' },
            type: { type: 'string', enum: EPISODE_TYPES },
            title: { type: 'string' },
            summary: { type: 'string' },
            details: { type: 'string' },
            outcomeStatus: { type: 'string', enum: ['good','bad','mixed'] },
            tags: { type: 'array', items: { type: 'string' } },
            entities: { type: 'array', items: { type: 'string' } },
            source: { type: 'string', enum: ['agent_write','operator_write','system_write','run_promotion','evaluator_write'] },
          },
          required: ['type', 'title', 'summary'],
        },
        mutating: true,
      },
      handler: async (args, ctx) => {
        if (!deps.memory) return { error: 'memory_runtime_not_wired' };
        const episode = deps.memory.writeEpisode({
          workspaceId: ctx.workspaceId,
          type: String(args.type) as RuntimeEpisodeType,
          title: String(args.title),
          summary: String(args.summary),
          source: (args.source as 'agent_write' | 'operator_write' | 'system_write' | 'run_promotion' | 'evaluator_write') ?? 'agent_write',
          ...(args.appId !== undefined ? { appId: String(args.appId) } : {}),
          ...(args.workflowId !== undefined ? { workflowId: String(args.workflowId) } : {}),
          ...(args.runId !== undefined ? { runId: String(args.runId) } : {}),
          ...(args.agentId !== undefined ? { agentId: String(args.agentId) } : {}),
          ...(args.details !== undefined ? { details: String(args.details) } : {}),
          ...(args.outcomeStatus !== undefined ? { outcomeStatus: args.outcomeStatus as 'good' | 'bad' | 'mixed' } : {}),
          ...(args.tags !== undefined ? { tags: args.tags as string[] } : {}),
          ...(args.entities !== undefined ? { entities: args.entities as string[] } : {}),
        });
        return { episode };
      },
    },

    // ── Layer 5: composed context ────────────────────────────
    {
      definition: {
        id: 'agentis.memory.context.build',
        family: 'data',
        description: 'Compose a full memory context for a task: working summary + knowledge + episodes + evaluator examples + baselines, all token-budgeted.',
        inputSchema: {
          type: 'object',
          properties: {
            appId: { type: 'string' },
            workflowId: { type: 'string' },
            runId: { type: 'string' },
            agentId: { type: 'string' },
            taskDescription: { type: 'string' },
            budgetClass: { type: 'string', enum: ['cheap', 'balanced', 'power'] },
            tokenBudget: { type: 'number' },
            mode: { type: 'string', enum: ['strict', 'normal', 'exploratory'] },
            includeWorkingSummary: { type: 'boolean' },
          },
          required: ['taskDescription'],
        },
        mutating: false,
      },
      handler: async (args, ctx) => {
        if (!deps.memory) return { error: 'memory_runtime_not_wired', context: null };
        const params: Parameters<typeof deps.memory.buildContext>[0] = {
          workspaceId: ctx.workspaceId,
          taskDescription: String(args.taskDescription),
        };
        if (args.appId) params.appId = String(args.appId);
        if (args.workflowId) params.workflowId = String(args.workflowId);
        if (args.runId) params.runId = String(args.runId);
        if (args.agentId) params.agentId = String(args.agentId);
        if (args.budgetClass) params.budgetClass = args.budgetClass as RetrievalBudgetClass;
        if (args.tokenBudget) params.tokenBudget = Number(args.tokenBudget);
        if (args.mode) params.mode = args.mode as RetrievalMode;
        if (args.includeWorkingSummary !== undefined) params.includeWorkingSummary = Boolean(args.includeWorkingSummary);
        const context = deps.memory.buildContext(params);
        return { context };
      },
    },

    // ── Layer 1: working memory summary ──────────────────────
    {
      definition: {
        id: 'agentis.memory.working.summarize',
        family: 'data',
        description: 'Get the compact working-memory summary for a run (auto-compacts if needed).',
        inputSchema: {
          type: 'object',
          properties: { runId: { type: 'string' } },
          required: ['runId'],
        },
        mutating: false,
      },
      handler: async (args) => {
        if (!deps.memory) return { error: 'memory_runtime_not_wired' };
        const summary = deps.memory.summarizeWorking(String(args.runId));
        return { summary };
      },
    },

    // ── Layer 1: working memory typed read ───────────────────
    {
      definition: {
        id: 'agentis.memory.working.read',
        family: 'data',
        description: 'Read a typed working-memory entry (namespaced + kind-typed).',
        inputSchema: {
          type: 'object',
          properties: {
            runId: { type: 'string' },
            namespace: { type: 'string', enum: ['run','agent','subflow','turn','eval','artifact','system'] },
            kind: { type: 'string', enum: [
              'working_plan','working_summary','pending_questions','tool_result_cache',
              'artifact_draft','evaluation_state','turn_history','blocker','note',
            ] },
            key: { type: 'string' },
          },
          required: ['runId', 'namespace', 'kind', 'key'],
        },
        mutating: false,
      },
      handler: async (args) => {
        if (!deps.memory) return { error: 'memory_runtime_not_wired', value: null };
        const value = deps.memory.readWorking(
          String(args.runId),
          args.namespace as WorkingMemoryNamespace,
          args.kind as WorkingMemoryKind,
          String(args.key),
        );
        return { runId: args.runId, namespace: args.namespace, kind: args.kind, key: args.key, value };
      },
    },

    // ── Layer 1: working memory typed write ──────────────────
    {
      definition: {
        id: 'agentis.memory.working.write',
        family: 'data',
        description: 'Write a typed working-memory entry. Persists durably for run/eval/artifact namespaces.',
        inputSchema: {
          type: 'object',
          properties: {
            runId: { type: 'string' },
            namespace: { type: 'string', enum: ['run','agent','subflow','turn','eval','artifact','system'] },
            kind: { type: 'string', enum: [
              'working_plan','working_summary','pending_questions','tool_result_cache',
              'artifact_draft','evaluation_state','turn_history','blocker','note',
            ] },
            key: { type: 'string' },
            payload: {},
          },
          required: ['runId', 'namespace', 'kind', 'key', 'payload'],
        },
        mutating: true,
      },
      handler: async (args) => {
        if (!deps.memory) return { error: 'memory_runtime_not_wired' };
        deps.memory.writeWorking(
          String(args.runId),
          args.namespace as WorkingMemoryNamespace,
          args.kind as WorkingMemoryKind,
          String(args.key),
          args.payload,
        );
        return { written: true };
      },
    },

    // ── Promotion: agent-proposed candidates ─────────────────
    {
      definition: {
        id: 'agentis.memory.promote',
        family: 'data',
        description: 'Propose a memory candidate for promotion. Goes through the trust + dedup pipeline before being written.',
        inputSchema: {
          type: 'object',
          properties: {
            appId: { type: 'string' },
            workflowId: { type: 'string' },
            runId: { type: 'string' },
            candidate: {
              type: 'object',
              properties: {
                source: { type: 'string', enum: [
                  'evaluator_failure_summary','approval_rationale','replay_root_cause',
                  'tool_failure_pattern','winning_output_pattern','final_artifact_validation',
                  'operator_distillation','agent_proposal',
                ] },
                title: { type: 'string' },
                summary: { type: 'string' },
                details: { type: 'string' },
                type: { type: 'string', enum: EPISODE_TYPES },
                outcomeStatus: { type: 'string', enum: ['good','bad','mixed'] },
                signals: { type: 'object' },
                tags: { type: 'array', items: { type: 'string' } },
                entities: { type: 'array', items: { type: 'string' } },
              },
              required: ['source', 'title', 'summary', 'type'],
            },
          },
          required: ['candidate'],
        },
        mutating: true,
      },
      handler: async (args, ctx) => {
        if (!deps.memoryPromotion) return { error: 'memory_promotion_not_wired' };
        const candidate = args.candidate as PromotionCandidate;
        const params: Parameters<typeof deps.memoryPromotion.promoteCandidate>[0] = {
          workspaceId: ctx.workspaceId,
          candidate,
        };
        if (args.appId) params.appId = String(args.appId);
        if (args.workflowId) params.workflowId = String(args.workflowId);
        if (args.runId) params.runId = String(args.runId);
        const decision = deps.memoryPromotion.promoteCandidate(params);
        return { decision };
      },
    },

    // ── Layer 4: baseline anomaly detection ──────────────────
    {
      definition: {
        id: 'agentis.memory.baselines.detect_anomalies',
        family: 'data',
        description: 'Compare observed run metrics against rolling baselines and return deviation reports. Useful for the policy engine, cost compiler, and self-healing logic.',
        inputSchema: {
          type: 'object',
          properties: {
            workflowId: { type: 'string', description: 'Workflow to check against its baseline.' },
            appId: { type: 'string' },
            successRate: { type: 'number', minimum: 0, maximum: 1 },
            latencyMs: { type: 'number', minimum: 0 },
            costMicros: { type: 'number', minimum: 0 },
            replayCount: { type: 'number', minimum: 0 },
            approvalCount: { type: 'number', minimum: 0 },
            evaluatorPassRate: { type: 'number', minimum: 0, maximum: 1 },
          },
          required: ['workflowId', 'latencyMs', 'costMicros', 'replayCount', 'approvalCount'],
        },
        mutating: false,
      },
      handler: async (args, ctx) => {
        if (!deps.rollingBaselines) return { error: 'rolling_baselines_not_wired', anomalies: [] };
        const observed: ObservedRunMetrics = {
          workflowId: String(args.workflowId),
          latencyMs: Number(args.latencyMs),
          costMicros: Number(args.costMicros),
          replayCount: Number(args.replayCount),
          approvalCount: Number(args.approvalCount),
        };
        if (args.appId !== undefined) observed.appId = String(args.appId);
        if (args.successRate !== undefined) observed.successRate = Number(args.successRate);
        if (args.evaluatorPassRate !== undefined) observed.evaluatorPassRate = Number(args.evaluatorPassRate);
        const anomalies = deps.rollingBaselines.detectAnomalies(ctx.workspaceId, observed);
        return { count: anomalies.length, anomalies };
      },
    },
  ]);
}
