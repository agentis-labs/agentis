/**
 * Workflow Compass — the Paved Road's navigation layer (PAVED-ROAD §P1).
 *
 * Two jobs, both deterministic (no LLM, no I/O beyond the workflow row):
 *
 *  1. **Loop-state as state, not folklore.** Every step of the build loop
 *     (author → dry-run → debug-run → production run) stamps durable evidence
 *     onto `workflow.settings.buildLoop`, keyed to a content hash of the graph
 *     so evidence goes stale the moment the graph changes. One read answers
 *     "where am I with this workflow?" for any agent or human.
 *
 *  2. **Every tool result becomes a signpost.** `compassForWorkflow` /
 *     `compassForRun` compute `{ stage, summary, next: [{tool, args, why}] }`
 *     with REAL ids baked into the args — the exact next call an agent should
 *     make. LLM agents follow gradients; the compass IS the gradient. Tool
 *     handlers attach it to their results so an agent is carried along the
 *     loop instead of having to remember doctrine.
 *
 * This module is pure + engine-agnostic on purpose: handlers and the engine
 * pass rows in; nothing here imports the engine.
 */

import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { WorkflowGraph } from '@agentis/core';

// ─── Loop-state shape (persisted at workflow.settings.buildLoop) ────────────

export interface BuildLoopDryRunStamp {
  at: string;
  ok: boolean;
  /** Blocking issues + failed assertions at that dry-run. */
  issueCount: number;
  /** Graph hash the evidence was produced against. */
  graphHash: string;
}

export interface BuildLoopRunStamp {
  at: string;
  runId: string;
  /** Terminal run status (COMPLETED / FAILED / …). */
  status: string;
  graphHash: string;
  /** SWIFT layer-3: the run's verified outcome (absent = never verified). */
  verdict?: 'accomplished' | 'partial' | 'hollow' | 'failed_checks';
}

export interface BuildLoopSuiteStamp {
  at: string;
  graphHash: string;
  total: number;
  passed: number;
  ok: boolean;
}

export interface BuildLoopHardenedStamp {
  at: string;
  graphHash: string;
  /** Hash of the spec the workflow was hardened against. */
  specHash: string;
  /** Frozen YAML export artifact id (the version-controlled locked spec). */
  exportRef?: string;
}

export interface BuildLoopOutcomeHealth {
  /** Most-recent-first 1/0 accomplishment results, capped at 20. */
  recent: Array<0 | 1>;
  lastDeficientRunId?: string;
}

/**
 * BRAIN-BLUEPRINT-10X — the BLESSED graph: the last graph (by hash) whose
 * PRODUCTION run the verdict engine proved ACCOMPLISHED. Unlike `productionRun`
 * (overwritten by every terminal run, including failures), this ratchets only on
 * accomplishment — it is the durable "this exact graph is known to work" record
 * that self-heal must respect and restore can roll back to. `runId` points at
 * the accomplished run whose `graphSnapshot` holds the blessed bytes.
 */
export interface BuildLoopBlueprintStamp {
  at: string;
  runId: string;
  graphHash: string;
}

export interface BuildLoopState {
  /** Hash of the graph at the last authored/validated save. */
  graphHash?: string;
  validatedAt?: string;
  dryRun?: BuildLoopDryRunStamp;
  /** SWIFT-I: last full test-suite result. */
  suite?: BuildLoopSuiteStamp;
  debugRun?: BuildLoopRunStamp;
  /** SWIFT-F: the hardening stamp — gates passed at this hash. */
  hardened?: BuildLoopHardenedStamp;
  productionRun?: BuildLoopRunStamp;
  /** SWIFT-T: rolling production accomplishment (the health metric). */
  outcomeHealth?: BuildLoopOutcomeHealth;
  /** BRAIN-BLUEPRINT-10X: last ACCOMPLISHED production graph (bless ratchet). */
  blueprint?: BuildLoopBlueprintStamp;
}

export type LoopStage =
  | 'authored'                   // saved through the gates; not yet dry-run at this hash
  | 'dry_run_red'                // dry-run at this hash found blocking issues
  | 'dry_run_green'              // dry-run green; suite not yet run (or none defined)
  | 'suite_red'                  // test suite at this hash has failing cases
  | 'suite_green'                // suite green at this hash; no honest debug-run yet
  | 'debug_failed'               // debug-run at this hash ended FAILED
  | 'debug_completed_unverified' // debug-run COMPLETED but no verdict (no spec → unverifiable)
  | 'debug_accomplished'         // debug-run COMPLETED and the verdict engine proved it
  | 'hardened'                   // SWIFT-F gates passed at this hash — may arm triggers
  | 'production';                // a production run has completed at this hash

export interface CompassStep {
  tool: string;
  args: Record<string, unknown>;
  why: string;
}

export interface Compass {
  stage: LoopStage;
  summary: string;
  /** Ordered: the first entry is THE next call to make. */
  next: CompassStep[];
}

// ─── Graph content hash ──────────────────────────────────────────────────────

/**
 * Stable content hash over the graph's semantic surface (nodes + edges,
 * position excluded — moving a node on the canvas does not invalidate test
 * evidence; changing config/wiring does). `triggerId` is excluded too: it is
 * runtime linkage WRITTEN BY trigger deployment at activation — arming a
 * workflow must not stale the very evidence that allowed it to arm.
 */
export function graphContentHash(graph: WorkflowGraph): string {
  const nodes = [...(graph.nodes ?? [])]
    .map((n) => {
      const { triggerId: _linkage, ...config } = (n.config ?? {}) as unknown as Record<string, unknown>;
      return { id: n.id, type: n.type, config };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const edges = [...(graph.edges ?? [])]
    .map((e) => ({ id: e.id, source: e.source, target: e.target, condition: (e as { condition?: unknown }).condition ?? null }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return createHash('sha256').update(stableStringify({ nodes, edges })).digest('hex').slice(0, 16);
}

/** JSON.stringify with recursively sorted object keys (deterministic). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

// ─── Read / stamp ────────────────────────────────────────────────────────────

export function readBuildLoop(settings: unknown): BuildLoopState {
  const s = settings && typeof settings === 'object' ? (settings as Record<string, unknown>).buildLoop : undefined;
  return s && typeof s === 'object' ? (s as BuildLoopState) : {};
}

/**
 * Merge a partial stamp into `workflow.settings.buildLoop`. Best-effort — a
 * stamp failure must never fail the operation being stamped.
 */
export function stampBuildLoop(
  db: AgentisSqliteDb,
  workflowId: string,
  patch: Partial<BuildLoopState>,
): BuildLoopState | null {
  try {
    const row = db
      .select({ settings: schema.workflows.settings })
      .from(schema.workflows)
      .where(eq(schema.workflows.id, workflowId))
      .get();
    if (!row) return null;
    const settings = (row.settings as Record<string, unknown> | null) ?? {};
    const merged: BuildLoopState = { ...readBuildLoop(settings), ...patch };
    db.update(schema.workflows)
      .set({ settings: { ...settings, buildLoop: merged }, updatedAt: new Date().toISOString() })
      .where(eq(schema.workflows.id, workflowId))
      .run();
    return merged;
  } catch {
    return null;
  }
}

// ─── Stage derivation + next steps ───────────────────────────────────────────

function isCompleted(status: string): boolean {
  return status === 'COMPLETED' || status === 'COMPLETED_WITH_CONTRACT_VIOLATION';
}

/** Derive the loop stage from persisted evidence vs the CURRENT graph hash.
 *  Precedence: production > hardened > debug > suite > dry-run > authored — all
 *  evidence is hash-keyed, so any graph edit honestly demotes the stage. */
export function deriveLoopStage(state: BuildLoopState, currentHash: string): LoopStage {
  const dry = state.dryRun && state.dryRun.graphHash === currentHash ? state.dryRun : undefined;
  const suite = state.suite && state.suite.graphHash === currentHash ? state.suite : undefined;
  const debug = state.debugRun && state.debugRun.graphHash === currentHash ? state.debugRun : undefined;
  const hardened = state.hardened && state.hardened.graphHash === currentHash ? state.hardened : undefined;
  const prod = state.productionRun && state.productionRun.graphHash === currentHash ? state.productionRun : undefined;
  if (prod && isCompleted(prod.status)) return 'production';
  if (hardened) return 'hardened';
  if (debug) {
    if (!isCompleted(debug.status)) return 'debug_failed';
    if (debug.verdict === 'accomplished') return 'debug_accomplished';
    // A verdict that ran and found the run deficient sends the agent back to
    // fixing — same stage as a raw failure, with the deficiencies as the list.
    if (debug.verdict) return 'debug_failed';
    return 'debug_completed_unverified';
  }
  if (suite) return suite.ok ? 'suite_green' : 'suite_red';
  if (dry) return dry.ok ? 'dry_run_green' : 'dry_run_red';
  return 'authored';
}

// ─── SWIFT proactive guard: divergence from a PROVEN version ("warn previously") ─

/**
 * The proven baseline a current graph has been edited away from, plus the exact
 * calls to make it proven again (or roll back). See {@link detectProvenDivergence}.
 */
export interface ProvenDivergence {
  /** Which proof we diverged from — blueprint (world-accomplished) or hardened (gates). */
  source: 'blueprint' | 'hardened';
  provenHash: string;
  provenAt: string;
  /** The accomplished run whose snapshot holds the proven bytes (blueprint only). */
  provenRunId?: string;
  currentHash: string;
  /** One line, agent- and human-facing — lead any surface with this. */
  warning: string;
  /** The exact next call that makes the edited graph proven again. */
  reverify: CompassStep;
  /** The exact next call that rolls back to the proven graph. */
  restore: CompassStep;
}

/**
 * "Warn previously." A workflow whose `blueprint` (proven ACCOMPLISHED) or
 * `hardened` (gates frozen) stamp no longer matches the CURRENT graph hash has
 * been edited away from a proven version. A proven workflow only breaks when it
 * changes — so this is the exact moment to warn, at the edit/run, BEFORE the
 * unverified graph is trusted in production and self-heal has to clean up a
 * failure that never needed to happen. If SWIFT proves builds and this guard
 * warns on operator edits, self-heal becomes the rare world-drift safety net —
 * not the routine repair path.
 *
 * Returns null when the workflow was never proven, or the current graph still
 * equals the proven hash (nothing to warn about).
 */
export function detectProvenDivergence(
  state: BuildLoopState,
  currentHash: string,
  workflowId: string,
): ProvenDivergence | null {
  // Blueprint (world-accomplished) outranks hardened (gates passed): it is the
  // stronger proof, and its runId lets an operator inspect/restore exact bytes.
  const proven = state.blueprint
    ? { source: 'blueprint' as const, hash: state.blueprint.graphHash, at: state.blueprint.at, runId: state.blueprint.runId }
    : state.hardened
      ? { source: 'hardened' as const, hash: state.hardened.graphHash, at: state.hardened.at, runId: undefined }
      : null;
  if (!proven) return null;                     // never proven → no baseline to diverge from
  if (proven.hash === currentHash) return null; // still the proven graph → nothing to warn
  const short = (h: string) => h.slice(0, 12);
  const baseline =
    proven.source === 'blueprint'
      ? `the PROVEN blueprint (@${short(proven.hash)}${proven.runId ? `, accomplished by run ${proven.runId.slice(0, 8)}` : ''})`
      : `the HARDENED version (@${short(proven.hash)})`;
  return {
    source: proven.source,
    provenHash: proven.hash,
    provenAt: proven.at,
    ...(proven.runId ? { provenRunId: proven.runId } : {}),
    currentHash,
    warning: `⚠️ UNVERIFIED: this graph diverges from ${baseline}. A proven workflow only breaks when it changes — re-verify BEFORE trusting it in production (SWIFT warns now, not after a failure).`,
    reverify: {
      tool: 'agentis.workflow.deliver',
      args: { workflowId },
      why: 'Re-run the full build→verify→fix loop so the edited graph is proven ACCOMPLISHED again — not merely saved. Proving edits here is what makes self-heal unnecessary.',
    },
    restore: {
      tool: 'agentis.workflow.restore_blueprint',
      args: { workflowId },
      why: 'Roll back to the last proven graph if the edit was unintended or turns out worse than the blueprint.',
    },
  };
}

/** Drop duplicate {tool,args} steps, keeping first occurrence (stable order). */
function dedupeCompassSteps(steps: CompassStep[]): CompassStep[] {
  const seen = new Set<string>();
  const out: CompassStep[] = [];
  for (const s of steps) {
    const key = `${s.tool}:${stableStringify(s.args)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

export interface WorkflowCompassArgs {
  workflowId: string;
  appId?: string | null;
  graph: WorkflowGraph;
  settings: unknown;
  /** Optional: count of open blocking issues from the most recent gate pass. */
  openIssueCount?: number;
}

/**
 * Composition steps — how this workflow STARTS, and what runs after it.
 *
 * The build loop proves one workflow in isolation and then stopped talking. The
 * agent is told to follow the compass, so anything the compass never mentions
 * effectively does not exist: a proven workflow stayed manual and unlinked
 * because nothing ever asked "what starts this, and what depends on it?".
 *
 * Only offered once a workflow is PROVEN — arming or chaining an unverified
 * graph is the failure mode the build loop exists to prevent.
 */
function compositionSteps(args: WorkflowCompassArgs): CompassStep[] {
  const steps: CompassStep[] = [];
  const triggerNode = args.graph.nodes.find((node) => node.type === 'trigger');
  const triggerType = (triggerNode?.config as { triggerType?: string } | undefined)?.triggerType;
  if (!triggerType || triggerType === 'manual') {
    steps.push({
      tool: 'agentis.build_workflow',
      args: { workflowId: args.workflowId, description: 'set how this workflow starts', trigger: { type: 'cron', cron: '0 9 * * *' } },
      why:
        'This workflow is MANUAL — nothing starts it but a person. If it is meant to run on its own, declare the '
        + 'trigger (cron / webhook / persistent_listener). Skip only if a human really is meant to start it every time.',
    });
  }
  if (args.appId) {
    steps.push({
      tool: 'agentis.workflow.chain',
      args: { appId: args.appId },
      why:
        'Wire what runs AFTER this (or what it runs after) — dependsOn is a real join, not a display order. A link '
        + 'can also carry a condition (`when`), an error branch (chainOn:"failure"), and a delay, and hands the '
        + 'dependent this workflow\'s actual output. Skip if it genuinely stands alone.',
    });
  }
  return steps;
}

/**
 * The workflow-level compass: where this workflow stands on the Paved Road and
 * the exact next call. Attach to build/patch/dry_run/loop_status results.
 */
export function compassForWorkflow(args: WorkflowCompassArgs): Compass {
  const hash = graphContentHash(args.graph);
  const state = readBuildLoop(args.settings);
  const stage = deriveLoopStage(state, hash);
  const wf = { workflowId: args.workflowId };
  // SWIFT proactive guard ("warn previously"): when this graph diverges from a
  // PROVEN blueprint/hardened version, every compass-carrying surface leads with
  // the UNVERIFIED warning + the re-verify call — before a production failure,
  // not after one.
  const divergence = detectProvenDivergence(state, hash, args.workflowId);
  const base = ((): Compass => {
  switch (stage) {
    case 'authored':
      return {
        stage,
        summary: state.dryRun
          ? 'The graph changed since the last dry-run — its evidence is stale. Dry-run again before trusting it.'
          : 'Authored and gated, but never dry-run. Prove the data flow before any real run.',
        next: [
          {
            tool: 'agentis.workflow.dry_run',
            args: wf,
            why: 'Free, deterministic: executes pure nodes for real, mocks side-effecting ones, returns the per-node I/O trace + blocking issues. Catches empty/lost payloads before any spend.',
          },
        ],
      };
    case 'dry_run_red':
      return {
        stage,
        summary: `Last dry-run at this graph found ${state.dryRun?.issueCount ?? 'blocking'} issue(s). Fix them before running.`,
        next: [
          {
            tool: 'agentis.build_workflow',
            args: { workflowId: args.workflowId, description: 'fix the dry-run issues', patchDraft: { updateNodes: [] } },
            why: 'Apply a scoped patch to the named nodes/fields, then dry-run again. Do not run a workflow that is red — the failure is already known.',
          },
          { tool: 'agentis.workflow.dry_run', args: wf, why: 'Re-check after the fix; iterate until ok:true.' },
        ],
      };
    case 'dry_run_green':
      return {
        stage,
        summary: 'Dry-run green at this graph. Run the test suite (or a debug run if no suite/spec exists yet).',
        next: [
          {
            tool: 'agentis.workflow.test',
            args: { ...wf, action: 'run' },
            why: 'Run every pinned test case through the dry-run engine (free) — happy path AND edge cases — before spending on a real run. No cases yet? Use action:"generate" first.',
          },
          {
            tool: 'agentis.workflow.run',
            args: { ...wf, debugRun: true },
            why: 'Or go straight to ONE real debug run (self-heal OFF) when the workflow is trivial.',
          },
        ],
      };
    case 'suite_red':
      return {
        stage,
        summary: `Test suite is RED at this graph (${state.suite?.passed ?? 0}/${state.suite?.total ?? 0} passed). Fix the failing cases before any real run.`,
        next: [
          {
            tool: 'agentis.build_workflow',
            args: { workflowId: args.workflowId, description: 'fix the failing suite cases', patchDraft: { updateNodes: [] } },
            why: 'Patch the named nodes, then re-run the suite (agentis.workflow.test { action: "run" }) until green.',
          },
        ],
      };
    case 'suite_green':
      return {
        stage,
        summary: 'Suite green at this graph. Next: ONE real debug run (self-heal OFF) — its verdict must prove accomplishment, not just completion.',
        next: [
          {
            tool: 'agentis.workflow.run',
            args: { ...wf, debugRun: true },
            why: 'Real execution, raw failures, and the verdict engine probes the WORLD at the end (deployed URL, datastore, judge). Then agentis.run.await { runId } to block until it settles (event-driven, zero-token).',
          },
        ],
      };
    case 'debug_failed':
      return {
        stage,
        summary: `Debug run ${state.debugRun?.runId} ended ${state.debugRun?.status}${state.debugRun?.verdict && state.debugRun.verdict !== 'accomplished' ? ` with verdict ${state.debugRun.verdict}` : ''}. Diagnose it — the failure/deficiency is raw (self-heal was off).`,
        next: [
          {
            tool: 'agentis.run.diagnose',
            args: { runId: state.debugRun?.runId ?? '' },
            why: 'Grounded diagnosis (failed node or verdict deficiencies with evidence); then patch via agentis.build_workflow { workflowId, patchDraft } and dry-run again.',
          },
        ],
      };
    case 'debug_completed_unverified':
      return {
        stage,
        summary: 'Debug run COMPLETED — but completion is not accomplishment. No spec exists, so the verdict engine could not verify the outcome.',
        next: [
          {
            tool: 'agentis.workflow.scope',
            args: wf,
            why: 'Define how success is VERIFIED (acceptance checks: URL probe, data probe, judge). Then re-run the debug run — its verdict gates hardening.',
          },
        ],
      };
    case 'debug_accomplished':
      return {
        stage,
        summary: 'Debug run ACCOMPLISHED — the verdict engine verified the outcome against the world. Harden it to freeze the proof and unlock unattended triggers.',
        next: [
          {
            tool: 'agentis.workflow.harden',
            args: wf,
            why: 'Checks every SWIFT gate (spec reconciled, suite, accomplished debug), freezes a YAML export, writes the playbook entry, and stamps the workflow hardened.',
          },
        ],
      };
    case 'hardened':
      return {
        stage,
        summary: 'HARDENED at this graph — proof frozen. Arm its trigger for unattended runs, or run it on demand.',
        next: [
          {
            tool: 'agentis.workflow.run',
            args: wf,
            why: 'Production run (self-heal + outcome-rework ON). Scheduled/listener workflows: activate the trigger — the arming gate passes now.',
          },
          ...compositionSteps(args),
        ],
      };
    case 'production':
      return {
        stage,
        summary: 'Proven in production at this graph. Observe runs; evolve through the same loop when requirements change.',
        next: [
          {
            tool: 'agentis.run.query',
            args: { workflowId: args.workflowId, limit: 5 },
            why: 'Watch recent runs. To change the workflow, patch with agentis.build_workflow { workflowId, patchDraft } — the loop (dry-run → debug-run) restarts at the new graph hash.',
          },
          ...compositionSteps(args),
        ],
      };
  }
  })();
  // Not diverged, or never proven → the plain stage compass.
  if (!divergence) return base;
  // Diverged from proven: lead with the warning + re-verify, then the stage's
  // own granular steps (so an agent can pick deliver OR the fine-grained path).
  return {
    stage: base.stage,
    summary: `${divergence.warning} ${base.summary}`,
    next: dedupeCompassSteps([divergence.reverify, divergence.restore, ...base.next]),
  };
}

export interface RunCompassArgs {
  runId: string;
  workflowId: string;
  status: string;
  debugRun?: boolean;
  /** The run's verified outcome, when the verdict engine ran. */
  verdict?: 'accomplished' | 'partial' | 'hollow' | 'failed_checks';
}

/**
 * The run-level compass: given a run's status, the exact next call. Attach to
 * workflow.run / ephemeral.run / run.status / run.diagnose results.
 */
export function compassForRun(args: RunCompassArgs): Compass {
  const { runId, workflowId, status } = args;
  if (status === 'started' || status === 'CREATED' || status === 'RUNNING' || status === 'WAITING' || status === 'PAUSED') {
    const waiting = status === 'PAUSED' || status === 'WAITING';
    return {
      stage: args.debugRun ? 'suite_green' : 'debug_completed_unverified',
      summary: waiting
        ? `Run ${runId} is ${status} — parked (possibly on an approval). Handle it, then await again.`
        : `Run ${runId} is ${status}. WAIT for it event-driven — do not sleep + poll in a loop.`,
      next: waiting
        ? [
            {
              tool: 'agentis.approval.list',
              args: {},
              why: 'The run is parked (often on an approval). Resolve it, then agentis.run.await { runId } to block until it settles again.',
            },
          ]
        : [
            {
              tool: 'agentis.run.await',
              args: { runId },
              why: 'BLOCK until the run settles (COMPLETED/FAILED/CANCELLED or PAUSED) — event-driven, one call, ZERO tokens while waiting. Do NOT Start-Sleep + poll agentis.run.status in a loop (that re-reads state and burns tokens every cycle, and the sleep is always a guess). On timeout it returns timedOut:true — just await again. On FAILED, agentis.run.diagnose next.',
            },
          ],
    };
  }
  if (status === 'FAILED' || status === 'COMPLETED_WITH_ERRORS') {
    return {
      stage: 'debug_failed',
      summary: `Run ${runId} ended ${status}. Diagnose before patching — never guess at an invisible failure.`,
      next: [
        { tool: 'agentis.run.diagnose', args: { runId }, why: 'Grounded root cause + concrete fixes for the failed node.' },
        {
          tool: 'agentis.workflow.dry_run',
          args: { workflowId },
          why: 'After patching, re-prove the data flow at zero cost before re-running.',
        },
      ],
    };
  }
  if (isCompleted(status)) {
    // A verdict that ran and found the outcome deficient outranks COMPLETED —
    // completion is not accomplishment.
    if (args.verdict && args.verdict !== 'accomplished') {
      return {
        stage: 'debug_failed',
        summary: `Run ${runId} COMPLETED but its verdict is ${args.verdict.toUpperCase()} — the world-check failed. Read the deficiencies (with evidence) and fix the producing nodes.`,
        next: [
          { tool: 'agentis.run.diagnose', args: { runId }, why: 'The verdict deficiencies name the failing claims, the evidence, and the producing nodes to re-work.' },
        ],
      };
    }
    return args.debugRun
      ? {
          stage: args.verdict === 'accomplished' ? 'debug_accomplished' : 'debug_completed_unverified',
          summary: args.verdict === 'accomplished'
            ? `Debug run ${runId} ACCOMPLISHED — verified against the world. Harden it.`
            : `Debug run ${runId} completed. No verdict ran (no spec) — completion alone is not proof of the outcome.`,
          next: args.verdict === 'accomplished'
            ? [{ tool: 'agentis.workflow.harden', args: { workflowId }, why: 'All loop evidence is green at this graph — freeze the proof and unlock unattended triggers.' }]
            : [{ tool: 'agentis.workflow.scope', args: { workflowId }, why: 'Define verifiable acceptance so the next debug run gets a real verdict.' }],
        }
      : {
          stage: 'production',
          summary: `Run ${runId} completed${args.verdict === 'accomplished' ? ' and ACCOMPLISHED (world-verified)' : ''}.`,
          next: [
            { tool: 'agentis.workflow.loop_status', args: { workflowId }, why: 'Confirm the loop state and see what (if anything) is left.' },
          ],
        };
  }
  // CANCELLED and anything else.
  return {
    stage: 'authored',
    summary: `Run ${runId} ended ${status}.`,
    next: [
      { tool: 'agentis.workflow.loop_status', args: { workflowId }, why: 'Re-orient: where this workflow stands and the next step.' },
    ],
  };
}

/** Human/agent-readable one-line stage labels (UI + summaries). */
export const LOOP_STAGE_LABEL: Record<LoopStage, string> = {
  authored: 'Authored — not yet dry-run',
  dry_run_red: 'Dry-run RED',
  dry_run_green: 'Dry-run green — run the suite',
  suite_red: 'Test suite RED',
  suite_green: 'Suite green — needs a debug run',
  debug_failed: 'Debug run failed / deficient',
  debug_completed_unverified: 'Debug completed — outcome UNVERIFIED (scope it)',
  debug_accomplished: 'Debug ACCOMPLISHED — world-verified',
  hardened: 'HARDENED — proof frozen, triggers may arm',
  production: 'Proven in production',
};
