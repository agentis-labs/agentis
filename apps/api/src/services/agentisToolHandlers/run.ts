/**
 * Run tools â€” agent triggers, cancels, replays, resumes work.
 *
 * Mutating tools always require explicit ids; the registry's argument
 * validation refuses calls missing required keys before reaching here.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { REALTIME_EVENTS, REALTIME_ROOMS, type WorkflowGraph, type WorkflowRunState } from '@agentis/core';
import { buildInitialRunState } from '../../engine/initialRunState.js';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import { collectFailedNodeIds, failedNodeCount } from '../runStateFailures.js';
import { analyzeRunFailure } from '../runFailureAnalysis.js';
import { recordWorkflowLesson, recallWorkflowLessons } from '../workflowPlaybook.js';
import type { ToolHandlerDeps } from './deps.js';

export function registerRunTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.registerMany([
    {
      definition: {
        id: 'agentis.workflow.run',
        family: 'run',
        description: 'Start a workflow run with optional inputs.',
        inputSchema: {
          type: 'object',
          properties: {
            workflowId: { type: 'string' },
            taskId: { type: 'string' },
            planId: { type: 'string' },
            inputs: { type: 'object' },
            input: { type: 'string' },
          },
          required: ['workflowId'],
        },
        mutating: true,
      },
      handler: async (args, ctx) => {
        const wf = deps.db
          .select()
          .from(schema.workflows)
          .where(eq(schema.workflows.id, String(args.workflowId)))
          .get();
        if (!wf || wf.workspaceId !== ctx.workspaceId) {
          throw new Error(`workflow ${args.workflowId} not found in workspace`);
        }
        const graph = wf.graph as WorkflowGraph;
        const runId = randomUUID();
        const planId = args.planId ? String(args.planId) : args.taskId ? String(args.taskId) : null;
        const inputs = parseInputs(args.inputs ?? args.input);
        const initialState: WorkflowRunState = buildInitialRunState({
          runId,
          workflowId: wf.id,
          graph,
          inputs,
        });
        deps.db.insert(schema.workflowRuns).values({
          id: runId,
          workspaceId: ctx.workspaceId,
          ambientId: ctx.ambientId ?? null,
          workflowId: wf.id,
          conversationId: ctx.conversationId ?? null,
          userId: ctx.userId,
          status: 'CREATED',
          runState: initialState,
          triggerId: null,
        }).run();
        deps.bus.publish(REALTIME_ROOMS.workspace(ctx.workspaceId), REALTIME_EVENTS.RUN_CREATED, {
          runId,
          workflowId: wf.id,
          ambientId: ctx.ambientId ?? null,
        });
        const handle = await deps.engine.startRun({
          workspaceId: ctx.workspaceId,
          ambientId: ctx.ambientId ?? null,
          conversationId: ctx.conversationId ?? null,
          workflowId: wf.id,
          ...(planId ? { planId } : {}),
          userId: ctx.userId,
          triggerId: null,
          inputs,
          initialState,
          graph,
        });
        return { runId: handle.runId, workflowId: handle.workflowId, status: 'started' };
      },
    },
    {
      definition: {
        id: 'agentis.run.cancel',
        family: 'run',
        description: 'Cancel a running workflow run.',
        inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] },
        mutating: true,
      },
      handler: async (args, ctx) => {
        const run = deps.db
          .select()
          .from(schema.workflowRuns)
          .where(eq(schema.workflowRuns.id, String(args.runId)))
          .get();
        if (!run || run.workspaceId !== ctx.workspaceId) {
          throw new Error(`run ${args.runId} not found`);
        }
        await deps.engine.cancelRun(run.id);
        return { runId: run.id, status: 'cancelled' };
      },
    },
    {
      definition: {
        id: 'agentis.run.status',
        family: 'run',
        description: 'Quick status check on a run (lighter than agentis.run.inspect).',
        inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] },
        mutating: false,
      },
      handler: async (args, ctx) => {
        return runStatus(deps, ctx.workspaceId, String(args.runId));
      },
    },
    {
      definition: {
        id: 'agentis.workflow.status',
        family: 'run',
        description: 'Get run status, progress, active node, and failed-node summary.',
        inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] },
        mutating: false,
      },
      handler: async (args, ctx) => runStatus(deps, ctx.workspaceId, String(args.runId)),
    },
    {
      definition: {
        id: 'agentis.workflow.list',
        family: 'inspect',
        description: 'List recent workflow runs in the workspace.',
        inputSchema: {
          type: 'object',
          properties: { status: { type: 'string' }, limit: { type: 'number' } },
        },
        mutating: false,
      },
      handler: async (args, ctx) => listRuns(deps, ctx.workspaceId, {
        status: args.status ? String(args.status) : undefined,
        limit: clampNumber(args.limit, 20, 1, 50),
      }),
    },
    {
      definition: {
        id: 'agentis.run.query',
        family: 'inspect',
        description: 'Query run history by workflow, status, date, and limit.',
        inputSchema: {
          type: 'object',
          properties: {
            workflowId: { type: 'string' },
            status: { type: 'string' },
            since: { type: 'string' },
            limit: { type: 'number' },
          },
        },
        mutating: false,
      },
      handler: async (args, ctx) => listRuns(deps, ctx.workspaceId, {
        workflowId: args.workflowId ? String(args.workflowId) : undefined,
        status: args.status ? String(args.status) : undefined,
        since: args.since ? String(args.since) : undefined,
        limit: clampNumber(args.limit, 20, 1, 100),
      }),
    },
    {
      definition: {
        id: 'agentis.run.diagnose',
        family: 'inspect',
        description: 'Diagnose a failed or stalled run using state and recent ledger events.',
        inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] },
        mutating: false,
      },
      handler: async (args, ctx) => {
        const runId = String(args.runId);
        const status = runStatus(deps, ctx.workspaceId, runId);
        if (!status.found) return status;
        const events = await deps.ledger.listForRun({ runId, limit: 50 });
        const failures = events.filter((event) => /failed|error/i.test(event.eventType) || JSON.stringify(event.payload).toLowerCase().includes('error'));
        // Grounded, rule-mapped diagnosis (real error → concrete fixes).
        const analysis = analyzeRunFailure(deps.db, ctx.workspaceId, runId);

        // Phase 5 (self-improving playbook) — when the cause is RECOGNIZED, append
        // the failure-mode → fix to the workspace playbook so future builds design
        // around it. Deduped on the lesson title; best-effort, never throws.
        let learned: { recorded: boolean; memoryId?: string } = { recorded: false };
        if (analysis?.recognized && analysis.error) {
          try {
            const failureMode = `${analysis.failedNodeTitle ?? analysis.nodeKind ?? 'node'} failed: ${analysis.error.replace(/\s+/g, ' ').trim().slice(0, 160)}`;
            const fix = analysis.fixes[0] ?? analysis.explanation;
            const exists = recallWorkflowLessons(deps.memory, ctx.workspaceId, 50)
              .some((lesson) => lesson.title.toLowerCase() === failureMode.slice(0, 120).toLowerCase());
            if (!exists && fix) {
              const memoryId = recordWorkflowLesson(deps.memory, ctx.workspaceId, { failureMode, fix }, ctx.agentId);
              if (memoryId) learned = { recorded: true, memoryId };
            }
          } catch {
            /* learning is best-effort — never fail a diagnosis over it */
          }
        }

        return {
          ...status,
          failureEvents: failures,
          ...(analysis ? { analysis } : {}),
          diagnosis: analysis?.recognized
            ? analysis.explanation
            : failures.length > 0
              ? `Found ${failures.length} failure-related ledger events. Start with the latest node/task error.`
              : 'No explicit failure events found in the recent ledger slice. Check active nodes and adapter health.',
          suggestedActions: analysis?.recognized && analysis.fixes.length > 0
            ? analysis.fixes
            : [
                'Inspect the failed node payload.',
                'Check the assigned agent or extension configuration.',
                'Patch timeout or routing settings before retrying if the cause is configuration-related.',
              ],
          learned,
        };
      },
    },
    {
      definition: {
        id: 'agentis.run.replay',
        family: 'run',
        description: 'Create a child run that replays from a chosen point.',
        inputSchema: {
          type: 'object',
          properties: {
            sourceRunId: { type: 'string' },
            mode: {
              type: 'string',
              enum: ['replay-from-node', 'replay-failed-branch', 'replay-with-edited-node', 'replay-from-checkpoint'],
            },
            targetNodeId: { type: 'string' },
            nodeConfigPatch: { type: 'object' },
          },
          required: ['sourceRunId', 'mode'],
        },
        mutating: true,
      },
      handler: async (args, ctx) => {
        const prepared = deps.replay.prepare({
          workspaceId: ctx.workspaceId,
          sourceRunId: String(args.sourceRunId),
          mode: args.mode as 'replay-from-node' | 'replay-failed-branch' | 'replay-with-edited-node' | 'replay-from-checkpoint',
          targetNodeId: args.targetNodeId ? String(args.targetNodeId) : undefined,
          nodeConfigPatch: args.nodeConfigPatch as Record<string, unknown> | undefined,
          userId: ctx.userId,
        });
        const handle = await deps.engine.startRun({
          workspaceId: prepared.workspaceId,
          ambientId: prepared.ambientId,
          workflowId: prepared.workflowId,
          userId: prepared.userId,
          triggerId: null,
          inputs: prepared.inputs,
          initialState: prepared.initialState,
          graph: prepared.graph,
        });
        return { runId: handle.runId, parentRunId: String(args.sourceRunId), status: 'started' };
      },
    },
    {
      definition: {
        id: 'agentis.memory.write',
        family: 'run',
        description: 'Store a new memory entry in the workspace persistent memory.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            content: { type: 'string' },
            kind: { type: 'string' },
            importance: { type: 'string' },
            tags: { type: 'string' },
            agentId: { type: 'string' },
          },
          required: ['title', 'content'],
        },
        mutating: true,
      },
      handler: async (args, ctx) => {
        const title = String(args.title);
        const content = String(args.content);
        const kind = String(args.kind ?? 'fact');
        const scopeId = String(args.agentId ?? '');

        let importanceVal = 0.5;
        if (args.importance !== undefined && args.importance !== null) {
          const num = Number(args.importance);
          if (Number.isFinite(num)) {
            importanceVal = num > 1 ? Math.min(num / 10, 1) : Math.max(0, num);
          }
        }

        let parsedTags: string[] = [];
        if (args.tags) {
          if (Array.isArray(args.tags)) {
            parsedTags = args.tags.map(String);
          } else if (typeof args.tags === 'string') {
            try {
              const parsed = JSON.parse(args.tags);
              parsedTags = Array.isArray(parsed) ? parsed.map(String) : [String(args.tags)];
            } catch {
              parsedTags = args.tags.split(',').map((t) => t.trim()).filter(Boolean);
            }
          }
        }

        // §B4 — write typed memory through the unified MemoryStore facade.
        if (!deps.memory) throw new Error('workspace memory service not available');
        const id = deps.memory.write({
          workspaceId: ctx.workspaceId,
          scopeId: scopeId || null,
          kind: kind as Parameters<NonNullable<typeof deps.memory>['write']>[0]['kind'],
          source: 'operator',
          title,
          content,
          trust: 0.7,
          importance: importanceVal,
          tags: parsedTags,
        });

        return { id, title, kind, importance: importanceVal, tags: parsedTags, status: 'created' };
      },
    },
    {
      definition: {
        id: 'agentis.memory.delete',
        family: 'run',
        description: 'Delete a memory entry from the workspace persistent memory.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            agentId: { type: 'string' },
          },
          required: ['id'],
        },
        mutating: true,
      },
      handler: async (args, ctx) => {
        const id = String(args.id);
        const scopeId = args.agentId ? String(args.agentId) : null;
        // §B4 — delete through the unified MemoryStore facade (scoped, then global).
        if (!deps.memory) throw new Error('workspace memory service not available');
        const deleted = (scopeId !== null && deps.memory.delete(ctx.workspaceId, scopeId, id))
          || deps.memory.delete(ctx.workspaceId, null, id);
        if (!deleted) {
          throw new Error(`Memory entry ${id} not found in workspace`);
        }
        return { id, deleted: true };
      },
    },
    {
      definition: {
        id: 'agentis.knowledge.write',
        family: 'run',
        description: 'Index a document into the workspace knowledge base.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            content: { type: 'string' },
            url: { type: 'string' },
            tags: { type: 'string' },
            knowledgeBaseId: { type: 'string' },
          },
          required: ['title', 'content'],
        },
        mutating: true,
      },
      handler: async (args, ctx) => {
        if (!deps.knowledgeBases) {
          throw new Error('Knowledge base service not available');
        }

        let kbId = args.knowledgeBaseId ? String(args.knowledgeBaseId) : '';
        if (!kbId) {
          const bases = deps.knowledgeBases.listKnowledgeBases(ctx.workspaceId);
          if (bases.length > 0) {
            kbId = bases[0]!.id;
          } else {
            const defaultKb = deps.knowledgeBases.createKnowledgeBase({
              workspaceId: ctx.workspaceId,
              name: 'Default Knowledge Base',
              description: 'Automatically created for agent inputs',
            });
            kbId = defaultKb.id;
          }
        }

        const title = String(args.title);
        const content = String(args.content);

        const doc = await deps.knowledgeBases.addDocument({
          workspaceId: ctx.workspaceId,
          knowledgeBaseId: kbId,
          name: title,
          content,
        });

        return {
          id: doc.id,
          name: title,
          knowledgeBaseId: kbId,
          status: 'ready',
          chunks: doc.chunks,
        };
      },
    },
    {
      definition: {
        id: 'agentis.knowledge.archive',
        family: 'run',
        description: 'Archive a document in the knowledge base by documentId and knowledgeBaseId.',
        inputSchema: {
          type: 'object',
          properties: {
            documentId: { type: 'string' },
            knowledgeBaseId: { type: 'string' },
          },
          required: ['documentId', 'knowledgeBaseId'],
        },
        mutating: true,
      },
      handler: async (args, ctx) => {
        if (!deps.knowledgeBases) {
          throw new Error('Knowledge base service not available');
        }
        const documentId = String(args.documentId);
        const knowledgeBaseId = String(args.knowledgeBaseId);
        const result = deps.knowledgeBases.archiveDocument(ctx.workspaceId, knowledgeBaseId, documentId);
        return result;
      },
    },
  ]);
}

function parseInputs(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : { input: parsed };
    } catch {
      return { input: trimmed };
    }
  }
  return { input: value };
}

function runStatus(deps: ToolHandlerDeps, workspaceId: string, runId: string) {
  const run = deps.db
    .select()
    .from(schema.workflowRuns)
    .where(and(eq(schema.workflowRuns.id, runId), eq(schema.workflowRuns.workspaceId, workspaceId)))
    .get();
  if (!run) return { found: false, runId };
  const state = run.runState as WorkflowRunState;
  const workflow = run.workflowId
    ? deps.db.select().from(schema.workflows).where(eq(schema.workflows.id, run.workflowId)).get()
    : null;
  const graph = (workflow?.graph ?? run.graphSnapshot ?? undefined) as WorkflowGraph | undefined;
  const total = Math.max(Object.keys(state.nodeStates ?? {}).length, graph?.nodes.length ?? 0, 1);
  const completed = state.completedNodeIds?.length ?? 0;
  const failed = failedNodeCount(state);
  const failedNodeIds = collectFailedNodeIds(state);
  const activeNodeId = Object.keys(state.activeExecutions ?? {})[0] ?? state.readyQueue?.[0]?.nodeId ?? null;
  const activeNode = activeNodeId ? graph?.nodes.find((node) => node.id === activeNodeId) : null;
  return {
    found: true,
    runId: run.id,
    workflowId: run.workflowId,
    workflowTitle: workflow?.title ?? run.ephemeralTitle ?? null,
    isEphemeral: run.isEphemeral,
    status: run.status,
    progress: Math.min(1, (completed + failed) / total),
    currentNode: activeNode ? { id: activeNode.id, title: activeNode.title, type: activeNode.type } : null,
    completedNodeCount: completed,
    failedNodeCount: failed,
    failedNodes: failedNodeIds.map((nodeId) => ({
      nodeId,
      title: graph?.nodes.find((node) => node.id === nodeId)?.title ?? nodeId,
      error: state.nodeStates[nodeId]?.error ?? null,
    })),
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
  };
}

function listRuns(
  deps: ToolHandlerDeps,
  workspaceId: string,
  opts: { workflowId?: string; status?: string; since?: string; limit: number },
) {
  const rows = deps.db
    .select()
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.workspaceId, workspaceId))
    .orderBy(desc(schema.workflowRuns.createdAt))
    .limit(Math.max(opts.limit * 3, opts.limit))
    .all()
    .filter((run) => {
      if (opts.workflowId && run.workflowId !== opts.workflowId) return false;
      if (opts.status && normalizeStatus(run.status) !== normalizeStatus(opts.status)) return false;
      if (opts.since && run.createdAt < opts.since) return false;
      return true;
    })
    .slice(0, opts.limit);
  const workflows = new Map(
    deps.db.select().from(schema.workflows).where(eq(schema.workflows.workspaceId, workspaceId)).all()
      .map((workflow) => [workflow.id, workflow]),
  );
  return {
    count: rows.length,
    runs: rows.map((run) => ({
      id: run.id,
      workflowId: run.workflowId,
      workflowTitle: run.workflowId ? workflows.get(run.workflowId)?.title ?? null : run.ephemeralTitle ?? null,
      isEphemeral: run.isEphemeral,
      status: run.status,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    })),
  };
}

function normalizeStatus(status: string): string {
  const upper = status.toUpperCase();
  if (upper === 'PENDING') return 'CREATED';
  if (upper === 'COMPLETED_WITH_ERRORS') return 'FAILED';
  return upper;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}
