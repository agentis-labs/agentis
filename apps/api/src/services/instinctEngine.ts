/**
 * InstinctEngine.
 *
 * Detects repeated workflow failure patterns, records the lesson into the
 * canonical DB brain, and emits an operator-visible proposal.
 */

import { and, desc, eq } from 'drizzle-orm';
import { REALTIME_EVENTS, REALTIME_ROOMS, type WorkflowGraph, type WorkflowNode, type WorkflowRunState } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { validateWorkflowGraph } from '../engine/validateGraph.js';
import type { EventBus } from '../event-bus.js';
import type { Logger } from '../logger.js';
import type { MemoryStore } from './memoryStore.js';
import type { IssueService } from './issues.js';
import type { SkillService } from './skillService.js';
import { analyzeRunFailure } from './runFailureAnalysis.js';
import type { RunVerdict } from './workflowVerdict.js';

export interface InstinctProposal {
  workspaceId: string;
  workflowId: string;
  nodeId: string;
  rootCause: string;
  occurrences: number;
  confidence: number;
  suggestion: string;
}

const DEFAULT_THRESHOLD = 3;
const SCAN_WINDOW = 25;

export class InstinctEngine {
  /** PAVED-ROAD P4 — late-bound (IssueService is constructed after the engine). */
  #issues?: IssueService;
  /** Living Skills — late-bound; links failure lessons onto the run's active skills. */
  #skills?: SkillService;

  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly bus: EventBus,
    private readonly memory: MemoryStore,
    private readonly logger?: Logger,
    private readonly threshold = DEFAULT_THRESHOLD,
  ) {}

  /** PAVED-ROAD P4 — enable the Sentinel: failed runs file actionable Issues. */
  bindIssueService(issues: IssueService): void {
    this.#issues = issues;
  }

  /** Wire the skill library so failure lessons attach to the run's active skills. */
  bindSkillService(skills: SkillService): void {
    this.#skills = skills;
  }

  /** Called by the engine after a run reaches FAILED. Best-effort; never throws. */
  async onRunFailed(args: { workspaceId: string; workflowId: string | null; runId: string; state: WorkflowRunState; debugRun?: boolean; userId?: string }): Promise<InstinctProposal | null> {
    // PAVED-ROAD P4 — the Sentinel: a terminal-failed PRODUCTION run never dies
    // silently into the runs list. It files (or refreshes) a deduped Issue that
    // carries the grounded diagnosis + the exact next calls, so the operator or
    // any agent picks it up with zero archaeology. Debug runs never file — the
    // building agent is already watching. Deterministic, zero-LLM.
    if (!args.debugRun) {
      try {
        this.#fileSentinelIssue(args);
      } catch (err) {
        this.logger?.warn('instinct.sentinel_failed', { runId: args.runId, err: (err as Error).message });
      }
    }
    try {
      return await this.#analyze(args);
    } catch (err) {
      this.logger?.warn('instinct.analyze_failed', { runId: args.runId, err: (err as Error).message });
      return null;
    }
  }

  /**
   * SWIFT-T Sentinel on OUTCOMES: a production run that COMPLETED but whose
   * verdict is not `accomplished` files a deduped Issue exactly like a failed
   * run — completion is not accomplishment, and a hollow/deficient run must
   * never die silently into a green runs list. Carries the verdict evidence +
   * the regression-pin affordance. Best-effort; never throws.
   */
  onRunDeficient(args: { workspaceId: string; workflowId: string | null; runId: string; verdict: RunVerdict; userId?: string }): void {
    try {
      if (!this.#issues || !args.workflowId) return;
      const wf = this.db
        .select({ id: schema.workflows.id, title: schema.workflows.title, userId: schema.workflows.userId })
        .from(schema.workflows)
        .where(and(eq(schema.workflows.id, args.workflowId), eq(schema.workflows.workspaceId, args.workspaceId)))
        .get();
      if (!wf) return;
      const verdict = args.verdict;
      const primary = verdict.deficiencies[0];
      const signature = `sig:verdict:${primary?.checkId ?? verdict.outcome}`;
      const evidenceLines = verdict.checks
        .filter((c) => !c.passed)
        .slice(0, 6)
        .map((c) => `- **${c.claim}** — ${c.evidence}`);
      const description = [
        `Run \`${args.runId}\` of **${wf.title}** COMPLETED but its verdict is **${verdict.outcome.toUpperCase()}** — the world-check failed. Completion is not accomplishment.`,
        '',
        '**Failed checks (with evidence):**',
        ...(evidenceLines.length > 0 ? evidenceLines : ['- (sufficiency violations only — see below)']),
        ...(verdict.sufficiency.floorViolations.length > 0 ? ['', '**Hollow output:**', ...verdict.sufficiency.floorViolations.map((v) => `- ${v}`)] : []),
        ...(verdict.sufficiency.stubSuspects.length > 0 ? ['', '**Stub/advisory content:**', ...verdict.sufficiency.stubSuspects.slice(0, 3).map((v) => `- ${v}`)] : []),
        '',
        '**Next calls (operator or any agent):**',
        `- \`agentis.run.diagnose { "runId": "${args.runId}" }\` — the deficiencies name the producing nodes to re-work`,
        `- \`agentis.workflow.test { "workflowId": "${args.workflowId}", "action": "add", "case": { "name": "regression: ${(primary?.claim ?? verdict.outcome).replace(/"/g, "'").slice(0, 60)}", "kind": "regression", "inputs": {} } }\` — pin this as a regression case`,
        `- After the fix: \`agentis.workflow.dry_run\` → \`agentis.workflow.test\` → debug run → \`agentis.workflow.harden\` — the workflow was demoted and must re-earn hardened.`,
      ].join('\n');
      const title = `Run deficient: ${wf.title} — ${(primary?.claim ?? verdict.outcome)}`.slice(0, 255);
      const open = this.#issues
        .list(args.workspaceId)
        .find((issue) =>
          issue.linkedWorkflowId === args.workflowId
          && Array.isArray(issue.labels)
          && (issue.labels as string[]).includes(signature)
          && issue.status !== 'done'
          && issue.status !== 'cancelled');
      const now = new Date().toISOString();
      if (open) {
        this.#issues.update(args.workspaceId, open.id, { title, description });
        this.db.update(schema.issues).set({ activeRunId: args.runId, updatedAt: now })
          .where(and(eq(schema.issues.id, open.id), eq(schema.issues.workspaceId, args.workspaceId))).run();
        this.logger?.info('instinct.sentinel_verdict_refreshed', { issueId: open.id, runId: args.runId, signature });
        return;
      }
      const created = this.#issues.create({
        workspaceId: args.workspaceId,
        userId: args.userId ?? wf.userId,
        linkedWorkflowId: args.workflowId,
        title,
        description,
        status: 'todo',
        priority: 'high',
        labels: ['sentinel', 'verdict', verdict.outcome, signature],
      });
      this.db.update(schema.issues).set({ activeRunId: args.runId, updatedAt: now })
        .where(and(eq(schema.issues.id, created.id), eq(schema.issues.workspaceId, args.workspaceId))).run();
      this.logger?.info('instinct.sentinel_verdict_filed', { issueId: created.id, runId: args.runId, signature, outcome: verdict.outcome });
    } catch (err) {
      this.logger?.warn('instinct.sentinel_verdict_failed', { runId: args.runId, err: (err as Error).message });
    }
  }

  #fileSentinelIssue(args: { workspaceId: string; workflowId: string | null; runId: string; state: WorkflowRunState; userId?: string }): void {
    if (!this.#issues || !args.workflowId) return;
    const state = args.state;
    const failedNodeId = state.failedNodeIds?.[0]
      ?? (state.nodeStates ? Object.entries(state.nodeStates).find(([, n]) => Boolean(n?.error))?.[0] : undefined);
    if (!failedNodeId) return;
    const wf = this.db
      .select({ id: schema.workflows.id, title: schema.workflows.title, graph: schema.workflows.graph, userId: schema.workflows.userId })
      .from(schema.workflows)
      .where(and(eq(schema.workflows.id, args.workflowId), eq(schema.workflows.workspaceId, args.workspaceId)))
      .get();
    if (!wf) return; // ephemeral/synthetic workflow — nothing durable to link
    const error = state.nodeStates?.[failedNodeId]?.error ?? 'unknown error';
    const rootCause = classifyRootCause(error);
    const signature = `sig:${failedNodeId}:${rootCause}`;
    const nodeTitle = (wf.graph as WorkflowGraph | null)?.nodes?.find((n) => n.id === failedNodeId)?.title ?? failedNodeId;
    let diagnosis: ReturnType<typeof analyzeRunFailure> = null;
    try {
      diagnosis = analyzeRunFailure(this.db, args.workspaceId, args.runId);
    } catch { /* diagnosis is best-effort */ }
    const description = [
      `Run \`${args.runId}\` of **${wf.title}** failed at **${nodeTitle}** (\`${failedNodeId}\`, ${rootCause}).`,
      '',
      `**Error:** ${error.replace(/\s+/g, ' ').slice(0, 600)}`,
      ...(diagnosis?.recognized
        ? ['', `**Diagnosis:** ${diagnosis.explanation}`, ...(diagnosis.fixes.length ? ['', '**Fixes:**', ...diagnosis.fixes.map((f) => `- ${f}`)] : [])]
        : []),
      '',
      '**Next calls (operator or any agent):**',
      `- \`agentis.run.diagnose { "runId": "${args.runId}" }\` — grounded root cause + machine-actionable nextCalls`,
      `- \`agentis.run.replay { "sourceRunId": "${args.runId}", "mode": "replay-with-edited-node", "targetNodeId": "${failedNodeId}", "nodeConfigPatch": {} }\` — fix the node and re-run FROM it`,
      `- \`agentis.build_workflow { "workflowId": "${args.workflowId}", "description": "<the fix>", "patchDraft": {...} }\` then \`agentis.workflow.dry_run { "workflowId": "${args.workflowId}" }\` — patch the graph and re-prove the data flow`,
      '',
      '_Or press Replay on this issue to re-run the failed branch directly._',
    ].join('\n');
    const title = `Run failed: ${wf.title} — ${nodeTitle} (${rootCause})`.slice(0, 255);
    // Dedup per workflow + failure signature: refresh the open sentinel issue
    // instead of piling a new one on every recurrence.
    const open = this.#issues
      .list(args.workspaceId)
      .find((issue) =>
        issue.linkedWorkflowId === args.workflowId
        && Array.isArray(issue.labels)
        && (issue.labels as string[]).includes(signature)
        && issue.status !== 'done'
        && issue.status !== 'cancelled');
    const now = new Date().toISOString();
    if (open) {
      this.#issues.update(args.workspaceId, open.id, { title, description });
      this.db.update(schema.issues).set({ activeRunId: args.runId, updatedAt: now })
        .where(and(eq(schema.issues.id, open.id), eq(schema.issues.workspaceId, args.workspaceId))).run();
      this.logger?.info('instinct.sentinel_refreshed', { issueId: open.id, runId: args.runId, signature });
      return;
    }
    const created = this.#issues.create({
      workspaceId: args.workspaceId,
      userId: args.userId ?? wf.userId,
      linkedWorkflowId: args.workflowId,
      title,
      description,
      status: 'todo',
      priority: 'high',
      labels: ['sentinel', rootCause, signature],
    });
    this.db.update(schema.issues).set({ activeRunId: args.runId, updatedAt: now })
      .where(and(eq(schema.issues.id, created.id), eq(schema.issues.workspaceId, args.workspaceId))).run();
    this.logger?.info('instinct.sentinel_filed', { issueId: created.id, runId: args.runId, signature });
  }

  async #analyze(args: { workspaceId: string; workflowId: string | null; runId: string; state: WorkflowRunState }): Promise<InstinctProposal | null> {
    const { workspaceId, workflowId, state } = args;
    if (!workflowId) return null;
    const failedNodeId = state.failedNodeIds?.[0];
    if (!failedNodeId) return null;
    const error = state.nodeStates?.[failedNodeId]?.error ?? '';
    const rootCause = classifyRootCause(error);

    const recent = this.db
      .select({ id: schema.workflowRuns.id, runState: schema.workflowRuns.runState })
      .from(schema.workflowRuns)
      .where(and(
        eq(schema.workflowRuns.workspaceId, workspaceId),
        eq(schema.workflowRuns.workflowId, workflowId),
        eq(schema.workflowRuns.status, 'FAILED'),
      ))
      .orderBy(desc(schema.workflowRuns.createdAt))
      .limit(SCAN_WINDOW)
      .all();

    let occurrences = 0;
    for (const r of recent) {
      const st = r.runState as unknown as WorkflowRunState | null;
      const nodeErr = st?.nodeStates?.[failedNodeId]?.error;
      if (nodeErr && classifyRootCause(nodeErr) === rootCause) occurrences += 1;
    }
    if (occurrences < this.threshold) return null;

    const confidence = Math.min(0.99, 0.5 + 0.1 * occurrences);
    const suggestion = suggestionFor(rootCause, failedNodeId);
    const proposal: InstinctProposal = { workspaceId, workflowId, nodeId: failedNodeId, rootCause, occurrences, confidence, suggestion };

    const lessonId = this.memory.write({
      workspaceId,
      scopeId: null,
      kind: 'lesson',
      source: 'system',
      title: `Repeated failure: ${failedNodeId}`,
      content: `Node "${failedNodeId}" repeatedly fails (${rootCause}, ${occurrences}x). ${suggestion}`,
      trust: confidence,
      importance: 0.72,
      tags: ['instinct', 'failure_pattern', rootCause],
      provenance: {
        source: 'instinct_engine',
        workflowId,
        nodeId: failedNodeId,
        runId: args.runId,
        occurrences,
      },
    });

    // Living Skills — attach this war-story onto whatever skills were active in
    // the failing run, so the next agent that loads one carries the hindsight.
    try {
      this.#skills?.linkLessonToRunSkills(workspaceId, args.runId, lessonId);
    } catch (err) {
      this.logger?.warn('instinct.link_lesson_to_skills_failed', { runId: args.runId, err: (err as Error).message });
    }

    this.bus.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.INSTINCT_PROPOSED, proposal);
    this.logger?.info('instinct.proposed', { workspaceId, workflowId, nodeId: failedNodeId, rootCause, occurrences });
    return proposal;
  }

  /**
   * Apply an operator-approved instinct to the workflow graph and record the
   * effective pattern into the DB brain.
   */
  async applyInstinct(args: { workspaceId: string; workflowId: string; nodeId: string; rootCause: string }): Promise<{ applied: boolean; reason?: string }> {
    const wf = this.db.select().from(schema.workflows)
      .where(and(eq(schema.workflows.id, args.workflowId), eq(schema.workflows.workspaceId, args.workspaceId)))
      .get();
    if (!wf) return { applied: false, reason: 'workflow not found' };
    const graph = wf.graph as unknown as WorkflowGraph;
    const node = graph.nodes.find((n) => n.id === args.nodeId);
    if (!node) return { applied: false, reason: `node ${args.nodeId} not found` };

    let next: WorkflowGraph;
    if (args.rootCause === 'rate_limit' || args.rootCause === 'timeout') {
      next = mutateNodeForReliability(graph, node, args.rootCause);
    } else if (args.rootCause === 'context_too_long') {
      next = insertTruncationBefore(graph, node);
    } else {
      return { applied: false, reason: `no auto-patch for root cause '${args.rootCause}'` };
    }

    try {
      validateWorkflowGraph(next, { currentWorkflowId: args.workflowId });
    } catch (err) {
      return { applied: false, reason: `patch invalid: ${(err as Error).message}` };
    }
    this.db.update(schema.workflows)
      .set({ graph: next as unknown as object, updatedAt: new Date().toISOString() })
      .where(eq(schema.workflows.id, args.workflowId))
      .run();

    this.memory.write({
      workspaceId: args.workspaceId,
      scopeId: null,
      kind: 'pattern',
      source: 'system',
      title: `Auto-patch applied: ${args.nodeId}`,
      content: `Auto-patched "${args.nodeId}" for ${args.rootCause}. Verify the next run.`,
      trust: 0.8,
      importance: 0.68,
      tags: ['instinct', 'effective_pattern', args.rootCause],
      provenance: {
        source: 'instinct_engine',
        workflowId: args.workflowId,
        nodeId: args.nodeId,
        rootCause: args.rootCause,
      },
    });
    this.logger?.info('instinct.applied', { ...args });
    return { applied: true };
  }
}

/** Add retry/timeout hardening to a node's config (config-only, no edge surgery). */
function mutateNodeForReliability(graph: WorkflowGraph, node: WorkflowNode, rootCause: string): WorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      if (n.id !== node.id) return n;
      const cfg = { ...(n.config as unknown as Record<string, unknown>) };
      if (cfg.kind === 'http_request') {
        cfg.maxRetries = Math.max(Number(cfg.maxRetries ?? 0), 3);
        cfg.retryOn = Array.isArray(cfg.retryOn) ? cfg.retryOn : [429, 503];
        if (rootCause === 'timeout') cfg.timeoutMs = Math.max(Number(cfg.timeoutMs ?? 0), 60_000);
      } else {
        cfg.retryPolicy = { selfHeal: true, maxSelfHealAttempts: 2 };
      }
      return { ...n, config: cfg as unknown as WorkflowNode['config'] };
    }),
  };
}

/** Insert a truncation transform before `node` and rewire its inbound edges. */
function insertTruncationBefore(graph: WorkflowGraph, node: WorkflowNode): WorkflowGraph {
  const truncId = `instinct_truncate_${node.id}`;
  if (graph.nodes.some((n) => n.id === truncId)) return graph;
  const truncNode: WorkflowNode = {
    id: truncId,
    type: 'transform',
    title: 'Truncate (instinct)',
    position: { x: Math.max(0, node.position.x - 220), y: node.position.y },
    config: {
      kind: 'transform',
      expression: 'Object.fromEntries(Object.entries(input).map(([k, v]) => [k, Array.isArray(v) ? v.slice(0, 20) : v]))',
    },
  };
  const edges = graph.edges.map((e) => (e.target === node.id ? { ...e, target: truncId } : e));
  edges.push({ id: `edge_${truncId}_${node.id}`, source: truncId, target: node.id });
  return { ...graph, nodes: [...graph.nodes, truncNode], edges };
}

/** Bucket an error message into a coarse root-cause class for pattern matching. */
function classifyRootCause(error: string): string {
  const e = error.toLowerCase();
  if (/context|too long|token|18000|exceed/.test(e)) return 'context_too_long';
  if (/rate.?limit|429|403/.test(e)) return 'rate_limit';
  if (/timeout|timed out|etimedout/.test(e)) return 'timeout';
  if (/credential|unauthor|401|auth/.test(e)) return 'auth';
  if (/not found|404|missing/.test(e)) return 'not_found';
  if (/parse|json|invalid/.test(e)) return 'parse_error';
  return 'generic_failure';
}

function suggestionFor(rootCause: string, nodeId: string): string {
  switch (rootCause) {
    case 'context_too_long': return `Add a Transform before "${nodeId}" to truncate the input (e.g. top 20 items).`;
    case 'rate_limit': return `Add retry + backoff (3 attempts, 2s initial) to "${nodeId}".`;
    case 'timeout': return `Raise the timeout on "${nodeId}" or split its work into smaller steps.`;
    case 'auth': return `Check the credential bound to "${nodeId}" - it may be missing or expired.`;
    case 'parse_error': return `Add an evaluator/guardrails gate after "${nodeId}" to enforce output shape.`;
    default: return `Review "${nodeId}" - it has failed repeatedly with the same root cause.`;
  }
}
