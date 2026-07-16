/**
 * Workflow Delivery Orchestrator — SWIFT enforcement, autonomous edition
 * (SWIFT-WORKFLOW-QUALITY-10X, ENFORCEMENT wave).
 *
 * The problem it solves: SWIFT is a multi-tool dance across many turns (scope →
 * build → dry-run → debug-run → read the verdict → fix the deficient nodes →
 * repeat → harden). Agents get lost in it, hit the per-turn tool-call cap, or
 * do one pass and give up — so "SWIFT exists" never became "agents deliver
 * verified results." This runs the ENTIRE loop server-side, in ONE call, and
 * returns exactly one honest answer:
 *
 *   - `accomplished`     — built, ran for real, VERIFIED against the world.
 *   - `blocked_on_human` — stopped at the one thing only a human can do
 *                          (an approval, a missing credential, a rate limit).
 *   - `failed`           — couldn't accomplish within the budget; here is the
 *                          exact last verdict + deficiencies + diagnosis.
 *   - `unverifiable`     — completed but has no worldly acceptance to verify
 *                          against (needs a human to say how success is proven).
 *
 * It NEVER loops forever and NEVER fakes success. Every exit is grounded in a
 * real run and its world-verified verdict. The agent makes one call and cannot
 * skip a step or misread a status, because it is not driving the loop.
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { WorkflowGraph, WorkflowRunState } from '@agentis/core';
import { buildInitialRunState } from '../../engine/initialRunState.js';
import { capabilityGapReason } from '../../engine/selfHeal/selfHealHelpers.js';
import { preflightWorkflow } from './workflowPreflight.js';
import { readWorkflowSpec, deriveSpecDraft, validateWorkflowSpec, type WorkflowSpec } from './workflowSpec.js';
import { compassForWorkflow, graphContentHash, type Compass } from './workflowCompass.js';
import type { RunVerdict } from './workflowVerdict.js';
import type { ToolHandlerDeps } from '../agentisToolHandlers/deps.js';

export type DeliveryOutcome = 'accomplished' | 'blocked_on_human' | 'failed' | 'unverifiable';

export interface DeliveryBlocker {
  kind: 'approval' | 'credential' | 'resource' | 'policy' | 'capability';
  detail: string;
  /** The exact thing the operator must do to unblock. */
  humanAction: string;
}

export interface DeliveryTimelineEntry { stage: string; detail: string; at: string }

export interface DeliveryResult {
  delivered: boolean;
  outcome: DeliveryOutcome;
  workflowId: string;
  appId?: string | null;
  runId?: string;
  iterations: number;
  verdict?: RunVerdict;
  blockers?: DeliveryBlocker[];
  timeline: DeliveryTimelineEntry[];
  compass?: Compass;
  message: string;
}

export interface DeliverArgs {
  /** Description for a NEW workflow (App-of-one). Omit when delivering an existing one. */
  goal?: string;
  /** Deliver an EXISTING workflow instead of building a new one. */
  workflowId?: string;
  /** Sample trigger inputs for the debug run. */
  inputs?: Record<string, unknown>;
  /** Build → verify → repair attempts before giving up honestly. Default 3, capped 5. */
  maxIterations?: number;
  /** Wall-clock budget across the whole delivery. Default 8 min, capped 20 min. */
  maxWallMs?: number;
  /**
   * Repair step for a FIXABLE deficiency (not a human blocker). Default:
   * re-synthesize the deficient nodes with the verdict evidence as context.
   * Injectable for tests. Must mutate the graph in place (persisted) and return.
   */
  repair?: (args: { deps: ToolHandlerDeps; ctx: DeliverCtx; workflowId: string; goal: string; verdict: RunVerdict; iteration: number }) => Promise<void>;
}

export interface DeliverCtx {
  workspaceId: string;
  userId: string;
  ambientId?: string | null;
  agentId?: string;
  conversationId?: string | null;
}

const TERMINAL = new Set(['COMPLETED', 'COMPLETED_WITH_CONTRACT_VIOLATION', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED']);
const SETTLE_POLL_MS = 400;

export async function deliverWorkflow(deps: ToolHandlerDeps, ctx: DeliverCtx, args: DeliverArgs): Promise<DeliveryResult> {
  const timeline: DeliveryTimelineEntry[] = [];
  const mark = (stage: string, detail: string) => {
    timeline.push({ stage, detail, at: new Date().toISOString() });
    deps.logger.info('deliver.stage', { stage, detail, workspaceId: ctx.workspaceId });
  };
  const maxIterations = Math.max(1, Math.min(args.maxIterations ?? 3, 5));
  const maxWallMs = Math.max(30_000, Math.min(args.maxWallMs ?? 480_000, 1_200_000));
  const deadline = Date.now() + maxWallMs;
  const autoHarden = false; // delivery proves accomplishment; hardening/arming stays an explicit operator step.

  // ── 1. Build a new workflow, or load an existing one. ──────────────────────
  let workflowId = args.workflowId ?? '';
  let appId: string | null | undefined;
  if (!workflowId) {
    if (!args.goal?.trim()) {
      return fail(timeline, '', 'failed', 'deliver requires either a goal (to build) or a workflowId (to deliver an existing workflow).');
    }
    mark('scope', 'Deriving acceptance + building the workflow');
    // Lazy import avoids a build.ts <-> orchestrator module cycle.
    const { createWorkflowFromDescription } = await import('../agentisToolHandlers/build.js');
    let built: { workflowId: string; appId?: string | null };
    try {
      built = await createWorkflowFromDescription(deps, {
        description: args.goal,
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        ambientId: ctx.ambientId ?? null,
        ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
        ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
      });
    } catch (err) {
      return fail(timeline, '', 'failed', `The workflow could not be built: ${(err as Error).message}`);
    }
    workflowId = built.workflowId;
    appId = built.appId ?? null;
    mark('build', `Built workflow ${workflowId}`);
  }

  const loadRow = () => deps.db.select().from(schema.workflows).where(and(eq(schema.workflows.id, workflowId), eq(schema.workflows.workspaceId, ctx.workspaceId))).get();
  const row0 = loadRow();
  if (!row0) return fail(timeline, workflowId, 'failed', `workflow ${workflowId} not found`);
  if (appId === undefined) appId = null;

  // Ensure the workflow is scoped (build auto-scopes; an existing one might not
  // be). Without acceptance, a run can only be `unverifiable`.
  ensureScoped(deps, ctx, workflowId, row0.settings, args.goal ?? row0.title ?? '');

  // ── 2. Iterate: dry-run → debug-run → verdict → repair, bounded. ───────────
  let iterations = 0;
  let lastVerdict: RunVerdict | undefined;
  let lastRunId: string | undefined;
  // Preflight is deterministic for a graph + fixed delivery inputs. A repair may
  // legitimately fix external state without changing the graph; do not recompute
  // the exact same full-graph proof before its next real verification run.
  const preflightByGraph = new Map<string, ReturnType<typeof preflightWorkflow>>();
  for (let i = 1; i <= maxIterations; i += 1) {
    iterations = i;
    if (Date.now() > deadline) return fail(timeline, workflowId, 'failed', `Delivery budget (${Math.round(maxWallMs / 1000)}s) exhausted after ${i - 1} attempt(s).`, { appId, runId: lastRunId, verdict: lastVerdict, iterations: i - 1 });

    const row = loadRow()!;
    const graph = row.graph as WorkflowGraph;

    // 2a. Dry-run — deterministic, free. Catch lost/empty payloads pre-spend.
    const graphHash = graphContentHash(graph);
    let report = preflightByGraph.get(graphHash);
    if (report) {
      mark('dry_run_reused', `Attempt ${i}: reused unchanged deterministic data-flow proof`);
    } else {
      mark('dry_run', `Attempt ${i}: proving the data flow (deterministic)`);
      report = preflightWorkflow({ db: deps.db, workspaceId: ctx.workspaceId, workflowId, graph, inputs: args.inputs, mode: 'canvas' });
      preflightByGraph.set(graphHash, report);
    }
    const blocking = report.issues.filter((issue) => issue.severity === 'error');
    if (blocking.length > 0) {
      if (i < maxIterations) { mark('repair', `Dry-run blocked (${blocking[0]!.message}); repairing`); await runRepair(deps, ctx, args, workflowId, args.goal ?? '', syntheticVerdict(blocking.map((b) => b.message)), i); continue; }
      return fail(timeline, workflowId, 'failed', `Dry-run still blocked after ${i} attempt(s): ${blocking.slice(0, 3).map((b) => b.message).join(' | ')}`, { appId, iterations: i });
    }

    // 2b. Debug-run — real execution, self-heal OFF, verdict ON.
    mark('debug_run', `Attempt ${i}: running for real and verifying against the world`);
    const settle = await startDebugRunAndSettle(deps, ctx, workflowId, graph, args.inputs ?? {}, deadline);
    lastRunId = settle.runId;
    lastVerdict = settle.verdict;

    if (settle.kind === 'timeout') {
      return fail(timeline, workflowId, 'failed', `The run did not settle within the delivery budget (last status ${settle.status}).`, { appId, runId: settle.runId, verdict: settle.verdict, iterations: i });
    }
    if (settle.kind === 'blocked') {
      mark('blocked', settle.blocker.detail);
      return blockedOnHuman(timeline, workflowId, appId, settle.runId, [settle.blocker], settle.verdict, i);
    }

    // 2c. Read the verdict — the single source of truth.
    const verdict = settle.verdict;
    if (!verdict) {
      // No spec → the outcome is unverifiable. Completion is not proof.
      if (settle.status.startsWith('COMPLETED')) {
        return {
          delivered: false, outcome: 'unverifiable', workflowId, appId, runId: settle.runId, iterations,
          timeline, compass: compassOf(deps, ctx, workflowId),
          message: `The workflow ran to ${settle.status}, but it has no worldly acceptance to verify against — so accomplishment cannot be proven. Define how success is verified (a URL, a record, a file), then re-deliver.`,
        };
      }
      // A hard failure with no verdict — classify it.
      const blocker = classifyFailure(settle.failedError ?? settle.status);
      if (blocker) return blockedOnHuman(timeline, workflowId, appId, settle.runId, [blocker], undefined, i);
      if (i < maxIterations) { mark('repair', `Run ${settle.status}; diagnosing + repairing`); await runRepair(deps, ctx, args, workflowId, args.goal ?? '', syntheticVerdict([settle.failedError ?? settle.status]), i); continue; }
      return fail(timeline, workflowId, 'failed', `The run ended ${settle.status} after ${i} attempt(s): ${(settle.failedError ?? 'unknown').slice(0, 200)}`, { appId, runId: settle.runId, iterations: i });
    }

    // 2d. ACCOMPLISHED — verified against the world. Done.
    if (verdict.outcome === 'accomplished') {
      mark('accomplished', `Verified: ${verdict.checks.filter((c) => c.passed).length}/${verdict.checks.length} acceptance check(s) passed`);
      void autoHarden;
      return {
        delivered: true, outcome: 'accomplished', workflowId, appId, runId: settle.runId, iterations, verdict,
        timeline, compass: compassOf(deps, ctx, workflowId),
        message: `Delivered and VERIFIED against the world in ${i} attempt(s): ${verdict.checks.filter((c) => c.passed).map((c) => c.claim).join('; ')}. `
          + `Harden it (agentis.workflow.harden) to freeze the proof and enable unattended triggers.`,
      };
    }

    // 2e. Deficient — is it something only a human can resolve, or a fixable bug?
    const blocker = classifyDeficiency(settle.failedError, verdict);
    if (blocker) {
      mark('blocked', blocker.detail);
      return blockedOnHuman(timeline, workflowId, appId, settle.runId, [blocker], verdict, i);
    }
    if (i < maxIterations) {
      mark('repair', `Verdict ${verdict.outcome}: re-working ${verdict.deficiencies.length} deficiency(ies)`);
      await runRepair(deps, ctx, args, workflowId, args.goal ?? row0.title ?? '', verdict, i);
      continue;
    }
    // Budget exhausted with a fixable-but-unfixed deficiency — honest failure.
    return {
      delivered: false, outcome: 'failed', workflowId, appId, runId: settle.runId, iterations, verdict,
      timeline, compass: compassOf(deps, ctx, workflowId),
      message: `Not accomplished after ${i} attempt(s) — verdict ${verdict.outcome.toUpperCase()}. `
        + `Unresolved: ${verdict.deficiencies.slice(0, 3).map((d) => d.detail).join(' | ')}. `
        + `Inspect run ${settle.runId} (agentis.run.diagnose) — the producing nodes are named in the deficiencies.`,
    };
  }

  return fail(timeline, workflowId, 'failed', 'Delivery loop exited without a verdict.', { appId, runId: lastRunId, verdict: lastVerdict });
}

// ─── Run + settle ────────────────────────────────────────────────────────────

interface SettleResult {
  kind: 'settled' | 'blocked' | 'timeout';
  runId: string;
  status: string;
  verdict?: RunVerdict;
  failedError?: string;
  blocker?: DeliveryBlocker;
}

/** Start a debug run (heal OFF, verdict ON) and await settlement — terminal, a
 *  human block (approval / out-of-credits), or the delivery deadline. */
async function startDebugRunAndSettle(
  deps: ToolHandlerDeps,
  ctx: DeliverCtx,
  workflowId: string,
  graph: WorkflowGraph,
  inputs: Record<string, unknown>,
  deadline: number,
): Promise<SettleResult & { blocker: DeliveryBlocker }> {
  const runId = randomUUID();
  const initialState: WorkflowRunState = buildInitialRunState({ runId, workflowId, graph, inputs });
  deps.db.insert(schema.workflowRuns).values({
    id: runId,
    workspaceId: ctx.workspaceId,
    ambientId: ctx.ambientId ?? null,
    workflowId,
    conversationId: ctx.conversationId ?? null,
    userId: ctx.userId,
    status: 'CREATED',
    runState: initialState,
    triggerId: null,
  }).run();

  try {
    await deps.engine.startRun({
      workspaceId: ctx.workspaceId,
      ambientId: ctx.ambientId ?? null,
      conversationId: ctx.conversationId ?? null,
      workflowId,
      userId: ctx.userId,
      triggerId: null,
      inputs,
      initialState,
      debugRun: true,
      graph,
    });
  } catch (err) {
    return { kind: 'settled', runId, status: 'FAILED', failedError: (err as Error).message } as SettleResult & { blocker: DeliveryBlocker };
  }

  // Poll to settlement. A debug run legitimately executes for minutes (agent /
  // extension / integration nodes), so we poll the persisted row rather than
  // block the engine.
  for (;;) {
    const row = deps.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get();
    const status = row?.status ?? 'CREATED';
    const state = (row?.runState as WorkflowRunState | undefined) ?? undefined;
    if (TERMINAL.has(status)) {
      const verdict = (state as unknown as { verdict?: RunVerdict } | undefined)?.verdict;
      const failedNodeId = state?.failedNodeIds?.[0];
      const failedError = failedNodeId ? state?.nodeStates?.[failedNodeId]?.error ?? undefined : undefined;
      return { kind: 'settled', runId, status, verdict, ...(failedError ? { failedError } : {}) } as SettleResult & { blocker: DeliveryBlocker };
    }
    // WAITING / PAUSED — is it an approval (expected human gate) or a resource block?
    if (status === 'WAITING' || status === 'PAUSED') {
      const approval = deps.approvals?.list(ctx.workspaceId, 'pending').find((a) => (a as { runId?: string }).runId === runId);
      if (approval) {
        return { kind: 'blocked', runId, status, blocker: { kind: 'approval', detail: `The run is paused for your approval before an irreversible step${(approval as { nodeTitle?: string }).nodeTitle ? ` ("${(approval as { nodeTitle?: string }).nodeTitle}")` : ''}.`, humanAction: 'Approve or reject it in the Approvals inbox, then re-deliver — delivery does not auto-approve irreversible actions.' } };
      }
      const blockedReason = state ? Object.values(state.nodeStates ?? {}).find((n) => n?.status === 'WAITING' && n?.blockedReason)?.blockedReason : undefined;
      if (blockedReason) {
        const classified = classifyFailure(blockedReason) ?? { kind: 'resource' as const, detail: blockedReason, humanAction: 'Resolve the resource limit (credits / rate limit), then re-deliver.' };
        return { kind: 'blocked', runId, status, blocker: classified };
      }
    }
    if (Date.now() > deadline) {
      await deps.engine.cancelRun?.(runId).catch(() => {});
      return { kind: 'timeout', runId, status } as SettleResult & { blocker: DeliveryBlocker };
    }
    await sleep(SETTLE_POLL_MS);
  }
}

// ─── Repair ──────────────────────────────────────────────────────────────────

async function runRepair(deps: ToolHandlerDeps, ctx: DeliverCtx, args: DeliverArgs, workflowId: string, goal: string, verdict: RunVerdict, iteration: number): Promise<void> {
  if (args.repair) { await args.repair({ deps, ctx, workflowId, goal, verdict, iteration }); return; }
  // Default repair: re-synthesize with the verdict evidence as explicit context,
  // so the model fixes the NAMED producing nodes rather than guessing. Best-
  // effort — a repair that can't improve the graph just leaves it, and the next
  // run's verdict decides honestly.
  try {
    const deficiencyBrief = verdict.deficiencies.slice(0, 6).map((d) => `- ${d.claim}: ${d.detail}${d.producingNodeIds.length ? ` (nodes: ${d.producingNodeIds.join(', ')})` : ''}`).join('\n');
    const { createWorkflowFromDescription } = await import('../agentisToolHandlers/build.js');
    await createWorkflowFromDescription(deps, {
      workflowId,
      description: `${goal}\n\nThe previous run FAILED verification. Fix the producing nodes so the output SATISFIES the acceptance — real content, no placeholders, no advisory text. Deficiencies:\n${deficiencyBrief}`,
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      ambientId: ctx.ambientId ?? null,
      ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
    });
  } catch (err) {
    deps.logger.warn('deliver.repair_failed', { workflowId, iteration, error: (err as Error).message });
  }
}

// ─── Classification ──────────────────────────────────────────────────────────

/** Classify a hard-failure error string into a human blocker, or null (fixable). */
function classifyFailure(error: string): DeliveryBlocker | null {
  const e = error || '';
  if (/\bBLOCKED_POLICY|allowedServices|outside this workflow'?s scoped|BLOCKED_LIFECYCLE/i.test(e)) {
    return { kind: 'policy', detail: e.slice(0, 240), humanAction: 'This step is outside the workflow’s scoped policy. Widen the scope (agentis.workflow.scope) if the call is intended.' };
  }
  if (capabilityGapReason(e)) {
    return { kind: 'capability', detail: capabilityGapReason(e)!, humanAction: 'A required runtime/binary/provider is not available in this environment. Install/enable it, then re-deliver.' };
  }
  if (/\b(401|403|unauthorized|forbidden|invalid[_ ]?api[_ ]?key|missing.*credential|credential.*missing|no .* token|authentication)/i.test(e)) {
    return { kind: 'credential', detail: e.slice(0, 240), humanAction: 'Connect the missing credential (Settings → Connections / MCP), then re-deliver.' };
  }
  if (/\b(429|rate.?limit|too many requests|quota|out of credits|usage limit|insufficient_quota)/i.test(e)) {
    return { kind: 'resource', detail: e.slice(0, 240), humanAction: 'Wait for the rate/usage limit to reset (or add capacity), then re-deliver.' };
  }
  return null;
}

/** A deficient (completed-but-not-accomplished) run: prefer the failed-node
 *  error, fall back to scanning deficiency details for a human-blocker signal. */
function classifyDeficiency(failedError: string | undefined, verdict: RunVerdict): DeliveryBlocker | null {
  if (failedError) { const b = classifyFailure(failedError); if (b) return b; }
  const joined = verdict.deficiencies.map((d) => d.detail).join(' | ');
  return classifyFailure(joined);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ensureScoped(deps: ToolHandlerDeps, ctx: DeliverCtx, workflowId: string, settings: unknown, goal: string): void {
  try {
    const current = (settings as Record<string, unknown> | null) ?? {};
    if (readWorkflowSpec(current)) return;
    const row = deps.db.select({ graph: schema.workflows.graph }).from(schema.workflows).where(eq(schema.workflows.id, workflowId)).get();
    const graph = row?.graph as WorkflowGraph | undefined;
    if (!graph) return;
    const derived = deriveSpecDraft({ description: goal, graph });
    const spec: WorkflowSpec = { ...derived.spec, verification: 'probes_only', reconciledHash: graphContentHash(graph) };
    if (validateWorkflowSpec(spec, { graph }).length === 0) {
      deps.db.update(schema.workflows).set({ settings: { ...current, spec }, updatedAt: new Date().toISOString() }).where(eq(schema.workflows.id, workflowId)).run();
    }
  } catch { /* best-effort scope */ }
}

function compassOf(deps: ToolHandlerDeps, ctx: DeliverCtx, workflowId: string): Compass | undefined {
  try {
    const row = deps.db.select().from(schema.workflows).where(eq(schema.workflows.id, workflowId)).get();
    if (!row) return undefined;
    return compassForWorkflow({ workflowId, graph: row.graph as WorkflowGraph, settings: row.settings });
  } catch { return undefined; }
}

function syntheticVerdict(details: string[]): RunVerdict {
  return {
    outcome: 'failed_checks', at: new Date().toISOString(), graphHash: '',
    checks: [], deficiencies: details.map((d, i) => ({ checkId: `dry_${i}`, claim: d, detail: d, producingNodeIds: [] })),
    sufficiency: { typedEmptyFills: [], stubSuspects: [], floorViolations: [] },
  };
}

function fail(timeline: DeliveryTimelineEntry[], workflowId: string, outcome: DeliveryOutcome, message: string, extra: { appId?: string | null; runId?: string; verdict?: RunVerdict; iterations?: number } = {}): DeliveryResult {
  const { iterations = 0, ...rest } = extra;
  return { delivered: false, outcome, workflowId, iterations, timeline, message, ...rest };
}

function blockedOnHuman(timeline: DeliveryTimelineEntry[], workflowId: string, appId: string | null | undefined, runId: string | undefined, blockers: DeliveryBlocker[], verdict: RunVerdict | undefined, iterations = 1): DeliveryResult {
  return {
    delivered: false, outcome: 'blocked_on_human', workflowId, appId, ...(runId ? { runId } : {}), iterations,
    ...(verdict ? { verdict } : {}), blockers, timeline,
    message: `Delivery stopped at a step only you can resolve: ${blockers.map((b) => `${b.kind} — ${b.detail} → ${b.humanAction}`).join(' | ')}`,
  };
}

function sleep(ms: number): Promise<void> { return new Promise((resolve) => { const t = setTimeout(resolve, ms); (t as { unref?: () => void }).unref?.(); }); }
