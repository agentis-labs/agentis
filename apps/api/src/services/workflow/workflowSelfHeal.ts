/**
 * WorkflowSelfHealService — autonomous, intent-preserving workflow repair
 * (AGENT-AUTONOMY-10X §W7 + W5.0).
 *
 * When a workflow node fails, this turns the agent from a script into an operator:
 * it DIAGNOSES the failure, then either coerces the node's real output onto the
 * declared contract (W5.0) or proposes a minimal STRUCTURAL graph repair — always
 * preserving the workflow's INTENT and grounded only in real evidence.
 *
 * The anti-hallucination contract is the whole point (operator non-negotiable):
 *   R1 Intent immutability — change HOW, never WHAT (goal/inputContract/output meaning).
 *   R2 Evidence-grounded   — every fix cites the real error + run data.
 *   R3 No fabrication      — never invent data or a fake output to "pass" a node.
 *   R4 Validate-before-apply — a structural patch must pass graph validation.
 *   R5 Reversible + audited — caller snapshots + audits; this returns the patch, never mutates.
 *   R6 Escalate-on-uncertainty — if a fix can't be grounded or intent certified, STOP and ask.
 *   R7 Bounded — caller enforces attempt cap + budget.
 *
 * This service is pure (no DB / no engine state): it takes evidence + a model and
 * returns a decision. The engine owns applying / approving / resuming.
 */

import type { WorkflowGraph, WorkflowNode, WorkflowRecoveryTier } from '@agentis/core';
import type { Logger } from '../../logger.js';
import type { StructuredCompleter, StructuredCompletionProgress } from '../structuredCompleter.js';
import { validateWorkflowGraph } from '../../engine/validateGraph.js';

/** The immutable contract a repair must preserve (R1). */
export interface IntentAnchor {
  /** The workflow's declared goal (title + description). */
  goal: string;
  /** The failing node's objective (its prompt/title). */
  nodeObjective: string;
  /** Output keys the node is contracted to produce. */
  declaredOutputKeys: string[];
  /** The workflow's input contract, if any (shape is not ours to change). */
  inputContract?: unknown;
}

/**
 * What the workspace can actually be repaired WITH. Grounding the planner in the
 * real, available agents/extensions is what lets a repair propose "route to a
 * connected agent" or "use this extension" instead of inventing one — the
 * difference between a smart operator and a hallucinating one.
 */
export interface RepairResourceContext {
  agents?: Array<{ id: string; role?: string; status?: string; capabilities?: string[] }>;
  extensions?: Array<{ id: string; name?: string }>;
}

/** A grounded plan from the deep planner (the orchestrator tool-loop). */
export interface DeepPlanArgs {
  graph: WorkflowGraph;
  node: WorkflowNode;
  error: string;
  diagnosis: string;
  intent: IntentAnchor;
  /** Completed upstream data the orchestrator may inspect but never fabricate. */
  upstreamOutputs?: Record<string, unknown>;
  immutableNodeIds: string[];
  resources?: RepairResourceContext;
}
export interface DeepPlanResult {
  nodes: WorkflowNode[];
  edges?: WorkflowGraph['edges'];
  resumeNodeId?: string;
  grounding?: string;
  /** The chat orchestrator explicitly attests to the immutable intent contract. */
  preservesIntent?: boolean;
  /** The chat orchestrator explicitly attests that its repair uses real evidence. */
  grounded?: boolean;
}

export interface SelfHealInput {
  workspaceId: string;
  graph: WorkflowGraph;
  node: WorkflowNode;
  /** The failure message that triggered healing. */
  error: string;
  /** The node's actual produced output (for coercion — the only legal source). */
  rawOutput: Record<string, unknown>;
  /** Upstream node outputs, for root-cause grounding (read-only). */
  upstreamOutputs?: Record<string, unknown>;
  intent: IntentAnchor;
  /** Resolved evaluator or chat-capable workspace agent. When absent, only deterministic coercion is possible. */
  completer?: StructuredCompleter | null;
  /** Model repair tier. Deterministic recovery remains in the engine. */
  tier: Extract<WorkflowRecoveryTier, 'minimal_patch' | 'rebuild'>;
  /** Completed/in-flight nodes that a rebuild is forbidden to change. */
  immutableNodeIds?: string[];
  /** Real, available repair resources (agents/extensions) the planner may use. */
  resources?: RepairResourceContext;
  /**
   * The deep planner: the orchestrator run as a real chat agent with the full
   * tool surface. It is the primary repair path whenever available and returns
   * a candidate graph; the validate → certify → resume gates below still apply.
   */
  deepPlan?: (args: DeepPlanArgs) => Promise<DeepPlanResult | null>;
  /** Ephemeral public repair liveness; never durable private reasoning. */
  onProgress?: (progress: StructuredCompletionProgress) => void;
}

export type SelfHealResult =
  /** The declared keys were recovered from the node's OWN output — safe to resume. */
  | { outcome: 'output_fixed'; output: Record<string, unknown>; diagnosis: string }
  /** A validated, intent-preserving plan; shared policy decides its execution path. */
  | { outcome: 'graph_repair'; patchedGraph: WorkflowGraph; diagnosis: string; grounding: string; tier: Extract<WorkflowRecoveryTier, 'minimal_patch' | 'rebuild'>; resumeNodeId: string }
  /** Couldn't ground a fix or certify intent — hand back to the operator honestly (R6). */
  | { outcome: 'escalate'; reason: string; diagnosis: string };

export class WorkflowSelfHealService {
  constructor(private readonly logger: Logger) {}

  async heal(input: SelfHealInput): Promise<SelfHealResult> {
    const missing = missingDeclaredKeys(input.rawOutput, input.intent.declaredOutputKeys);
    const diagnosis = `Node '${input.node.id}' failed: ${clip(input.error, 300)}`;

    // ── W5.0 cheap extraction — ONLY when there's no orchestrator to do it better.
    //    Deterministic alias/nested lookup already ran in the engine; this is the
    //    LLM extraction fast-win when keys are merely mis-shaped. With a deep
    //    planner wired we skip straight to it — the orchestrator can recover output
    //    AND rearrange, and we want to reach it fast, not burn a slow single-shot.
    if (!input.deepPlan && missing.length > 0) {
      const recovered = await this.#recoverOutputKeys(input, missing);
      if (recovered) {
        this.logger.info('selfheal.output_fixed', { workspaceId: input.workspaceId, nodeId: input.node.id, keys: missing });
        return { outcome: 'output_fixed', output: recovered, diagnosis: `Recovered declared key(s) ${missing.join(', ')} from the node's own output.` };
      }
    }

    if (!input.completer && !input.deepPlan) {
      return { outcome: 'escalate', reason: 'No evaluator or chat-capable workspace agent runtime available to ground a repair.', diagnosis };
    }

    // ── PRIMARY repair: the orchestrator as a real tool-loop (full power — fix the
    //    failed node OR rearrange the whole workflow, intent preserved, creating
    //    agents/extensions/abilities if needed). The single-shot structured patch
    //    is only a fallback when no orchestrator is wired. Both flow through the
    //    SAME finalize → validate → certify gates, so agency never costs safety.
    let proposal: {
      patchedGraph: WorkflowGraph;
      grounding: string;
      resumeNodeId: string;
      source: 'chat_orchestrator' | 'structured_fallback';
      preservesIntent?: boolean;
      grounded?: boolean;
    } | null = null;
    let resolvedTier: Extract<WorkflowRecoveryTier, 'minimal_patch' | 'rebuild'> = input.tier;
    if (input.deepPlan) {
      this.logger.info('selfheal.deep_plan_invoked', { workspaceId: input.workspaceId, nodeId: input.node.id });
      try {
        const deep = await input.deepPlan({
          graph: input.graph,
          node: input.node,
          error: input.error,
          diagnosis,
          intent: input.intent,
          upstreamOutputs: input.upstreamOutputs,
          immutableNodeIds: input.immutableNodeIds ?? [],
          resources: input.resources,
        });
        if (deep && Array.isArray(deep.nodes) && deep.nodes.length > 0) {
          const finalized = this.#finalizeProposal(input, { nodes: deep.nodes, edges: deep.edges, resumeNodeId: deep.resumeNodeId, grounding: deep.grounding }, diagnosis, { allowStructural: true });
          if (finalized) {
            proposal = {
              ...finalized,
              source: 'chat_orchestrator',
              preservesIntent: deep.preservesIntent,
              grounded: deep.grounded,
            };
            resolvedTier = 'rebuild';
          }
        }
      } catch (err) {
        this.logger.warn('selfheal.deep_plan_failed', { workspaceId: input.workspaceId, nodeId: input.node.id, error: (err as Error).message });
      }
    }
    if (!proposal && input.completer) {
      const finalized = await this.#proposePatch(input, diagnosis);
      proposal = finalized ? { ...finalized, source: 'structured_fallback' } : null;
    }

    if (!proposal) {
      return { outcome: 'escalate', reason: 'Could not derive a grounded repair for this failure.', diagnosis };
    }

    // R4 — never apply an unvalidated graph.
    const validation = this.#validate(proposal.patchedGraph);
    if (!validation.ok) {
      return { outcome: 'escalate', reason: `Proposed repair did not pass validation: ${validation.reason}`, diagnosis };
    }

    // R1 — the intent judge certifies the patch preserves the workflow's goal,
    // input contract, and the MEANING of declared outputs (it changes HOW, not
    // WHAT). This is the anti-hallucination gate that keeps an AUTONOMOUS repair
    // safe to apply without a human: a graph can be valid yet still do the wrong
    // thing. Cheap (one short verification call) and only on a structural repair,
    // which is the rare tail of the ladder.
    const certified = proposal.source === 'chat_orchestrator'
      ? this.#certifyChatOrchestratorIntent(input, proposal)
      : await this.#certifyIntent(input, proposal.patchedGraph, proposal.grounding);
    if (!certified.ok) {
      return { outcome: 'escalate', reason: `Intent not certified: ${certified.reason}`, diagnosis };
    }

    this.logger.info('selfheal.graph_repair_planned', { workspaceId: input.workspaceId, nodeId: input.node.id, tier: resolvedTier });
    return {
      outcome: 'graph_repair',
      patchedGraph: proposal.patchedGraph,
      diagnosis,
      grounding: proposal.grounding,
      tier: resolvedTier,
      resumeNodeId: proposal.resumeNodeId,
    };
  }

  // ── Recover declared keys strictly from the node's own output (W5.0, R3). ──
  async #recoverOutputKeys(input: SelfHealInput, missing: string[]): Promise<Record<string, unknown> | null> {
    // Deterministic first: alias / nested lookups already attempted by the engine,
    // so here we only escalate to the model — and only to EXTRACT, never invent.
    if (!input.completer) return null;
    const parsed = await input.completer.completeStructured<{ values?: Record<string, unknown>; missing?: string[] }>({
      system:
        'You recover declared output fields from an agent node\'s ACTUAL output. ' +
        'CRITICAL: extract ONLY values that are literally present/derivable from the provided output. ' +
        'If a field is not present, put its name in "missing" and DO NOT invent a value. Never fabricate. Return strict JSON.',
      user:
        `DECLARED FIELDS TO RECOVER: ${missing.join(', ')}\n\n` +
        `NODE OUTPUT (the only legal source):\n${clip(JSON.stringify(input.rawOutput), 6000)}\n\n` +
        'Return {"values":{"<field>":<value>}, "missing":["<field not present>"]}.',
      maxTokens: 600,
      maxAttempts: 2,
    });
    if (!parsed || !parsed.values) return null;
    const out: Record<string, unknown> = { ...input.rawOutput };
    for (const key of missing) {
      const v = parsed.values[key];
      if (!isPresent(v)) return null; // any unrecovered key → no fabrication, bail to diagnosis
      out[key] = v;
    }
    return out;
  }

  async #diagnose(input: SelfHealInput): Promise<string> {
    if (!input.completer) {
      return `Node '${input.node.id}' failed: ${clip(input.error, 300)} (no evaluator or chat-capable agent runtime available to root-cause).`;
    }
    const parsed = await input.completer.completeStructured<{ rootCause?: string }>({
      system:
        'You are a workflow failure diagnostician. State the ROOT CAUSE in one or two sentences, grounded ONLY in the ' +
        'provided error and upstream data. If the cause is bad upstream input, say so explicitly. Do not speculate beyond the evidence.',
      user:
        `WORKFLOW GOAL: ${clip(input.intent.goal, 500)}\n` +
        `FAILING NODE: ${input.node.id} — ${clip(input.intent.nodeObjective, 400)}\n` +
        `ERROR: ${clip(input.error, 600)}\n` +
        `UPSTREAM OUTPUTS: ${clip(JSON.stringify(input.upstreamOutputs ?? {}), 3000)}\n\n` +
        'Return {"rootCause":"..."}.',
      maxTokens: 400,
      maxAttempts: 1,
    });
    return parsed?.rootCause?.trim() || `Node '${input.node.id}' failed: ${clip(input.error, 300)}`;
  }

  async #proposePatch(input: SelfHealInput, diagnosis: string): Promise<{ patchedGraph: WorkflowGraph; grounding: string; resumeNodeId: string } | null> {
    const completer = input.completer;
    if (!completer) return null;
    const parsed = await completer.completeStructured<{ nodes?: WorkflowNode[]; edges?: WorkflowGraph['edges']; resumeNodeId?: string; grounding?: string; cannotRepair?: boolean }>({
      system:
        'You repair a workflow graph to overcome a real failure WITHOUT changing its intent (R1: change HOW, never WHAT — ' +
        'never alter the goal, the input contract, or the MEANING of declared outputs). Make the MINIMAL change that fixes ' +
        'the diagnosed cause (adjust the failing node, an upstream node, or re-route). Ground every change in the error/data ' +
        '(R2). Never fabricate data (R3). If you cannot repair without changing intent or inventing data, set cannotRepair=true. ' +
        (input.tier === 'rebuild'
          ? 'You may replace only unresolved nodes and edges. Never alter completed or active nodes. Return full nodes, full edges, and a resumeNodeId.'
          : 'Do not add/remove/rename nodes or alter edges. Return full updated nodes and the failing node as resumeNodeId.') +
        ' Return a one-line grounding citing the evidence. Strict JSON.',
      user:
        `WORKFLOW GOAL (immutable): ${clip(input.intent.goal, 500)}\n` +
        `INPUT CONTRACT (immutable): ${clip(JSON.stringify(input.intent.inputContract ?? null), 1500)}\n` +
        `DIAGNOSIS: ${clip(diagnosis, 500)}\n` +
        `FAILING NODE: ${input.node.id}\n` +
        `REPAIR TIER: ${input.tier}\n` +
        `IMMUTABLE NODE IDS: ${(input.immutableNodeIds ?? []).join(', ')}\n` +
        resourcesBlock(input.resources) +
        `CURRENT NODES:\n${clip(JSON.stringify(input.graph.nodes), 9000)}\n` +
        `CURRENT EDGES:\n${clip(JSON.stringify(input.graph.edges), 5000)}\n\n` +
        'Return {"nodes":[...full updated nodes...],"edges":[...full edges...],"resumeNodeId":"...","grounding":"...","cannotRepair":false}.',
      maxTokens: 2400,
      maxAttempts: 1,
      onProgress: input.onProgress,
    });
    if (!parsed || parsed.cannotRepair || !Array.isArray(parsed.nodes) || parsed.nodes.length === 0) return null;
    return this.#finalizeProposal(input, parsed, diagnosis);
  }

  /**
   * Apply the deterministic safety guards to a proposed graph, whatever produced
   * it (the cheap structured planner OR the deep orchestrator tool-loop). Keeping
   * this in one place means agency and economy share the SAME contract:
   *   - minimal_patch may not change the node set or edges (shape is intent);
   *   - completed/active (immutable) nodes may never be altered (no wasted rework);
   *   - a real resume target inside the patched graph is mandatory.
   */
  #finalizeProposal(
    input: SelfHealInput,
    parsed: { nodes?: WorkflowNode[]; edges?: WorkflowGraph['edges']; resumeNodeId?: string; grounding?: string },
    diagnosis: string,
    opts: { allowStructural?: boolean } = {},
  ): { patchedGraph: WorkflowGraph; grounding: string; resumeNodeId: string } | null {
    if (!Array.isArray(parsed.nodes) || parsed.nodes.length === 0) return null;
    const edges = Array.isArray(parsed.edges) ? parsed.edges : input.graph.edges;
    const before = new Set(input.graph.nodes.map((n) => n.id));
    const after = new Set(parsed.nodes.map((n) => n.id));
    // The orchestrator (deep plan) may rearrange freely; only the cheap minimal
    // patch is held to "no shape change". Completed/active nodes are protected by
    // the immutable guard below in BOTH cases.
    if (!opts.allowStructural && input.tier === 'minimal_patch' && (before.size !== after.size || [...before].some((id) => !after.has(id) || JSON.stringify(edges) !== JSON.stringify(input.graph.edges)))) return null;
    const immutable = new Set(input.immutableNodeIds ?? []);
    for (const id of immutable) {
      const oldNode = input.graph.nodes.find((node) => node.id === id);
      const nextNode = parsed.nodes.find((node) => node.id === id);
      if (!oldNode || !nextNode || JSON.stringify(oldNode) !== JSON.stringify(nextNode)) return null;
    }
    const resumeNodeId = typeof parsed.resumeNodeId === 'string' && parsed.nodes.some((node) => node.id === parsed.resumeNodeId)
      ? parsed.resumeNodeId
      : parsed.nodes.some((node) => node.id === input.node.id) ? input.node.id : '';
    if (!resumeNodeId) return null;
    return { patchedGraph: { ...input.graph, nodes: parsed.nodes, edges }, grounding: parsed.grounding?.trim() || diagnosis, resumeNodeId };
  }

  /** The anti-hallucination gate: certify the patch preserves intent + is grounded (R1/R2). */
  async #certifyIntent(input: SelfHealInput, patched: WorkflowGraph, grounding: string): Promise<{ ok: boolean; reason: string }> {
    const completer = input.completer;
    if (!completer) return { ok: false, reason: 'no model to certify intent' };
    const parsed = await completer.completeStructured<{ preservesIntent?: boolean; grounded?: boolean; reason?: string }>({
      system:
        'You are the intent-preservation judge. Approve a workflow repair ONLY if BOTH hold: (1) it preserves the workflow\'s ' +
        'goal, input contract, and the meaning of declared outputs (it changes HOW, not WHAT); (2) it is grounded in the stated ' +
        'evidence and invents no data. Be strict — when in doubt, reject. Return strict JSON.',
      user:
        `GOAL (must be preserved): ${clip(input.intent.goal, 500)}\n` +
        `DECLARED OUTPUTS (meaning must be preserved): ${input.intent.declaredOutputKeys.join(', ')}\n` +
        `GROUNDING CLAIMED: ${clip(grounding, 400)}\n` +
        `PATCHED NODES:\n${clip(JSON.stringify(patched.nodes), 8000)}\n\n` +
        'Return {"preservesIntent":bool,"grounded":bool,"reason":"..."}.',
      maxTokens: 400,
      maxAttempts: 1,
    });
    if (!parsed) return { ok: false, reason: 'judge unavailable' };
    if (parsed.preservesIntent === true && parsed.grounded === true) return { ok: true, reason: parsed.reason?.trim() || 'certified' };
    return { ok: false, reason: parsed.reason?.trim() || 'judge declined to certify' };
  }

  /**
   * The default evaluator is the same workspace orchestrator that just produced
   * this chat repair. Do not strand a viable run behind a second cold model call.
   * Its explicit attestation is accepted only after the engine's deterministic
   * invariants have already held: immutable nodes, graph validation, original
   * workflow-level contracts, and a non-empty evidence claim.
   */
  #certifyChatOrchestratorIntent(
    input: SelfHealInput,
    proposal: {
      patchedGraph: WorkflowGraph;
      grounding: string;
      preservesIntent?: boolean;
      grounded?: boolean;
    },
  ): { ok: boolean; reason: string } {
    if (proposal.preservesIntent !== true || proposal.grounded !== true) {
      return { ok: false, reason: 'orchestrator did not attest that the repair preserves intent and is grounded' };
    }
    if (!proposal.grounding.trim()) return { ok: false, reason: 'orchestrator provided no grounding evidence' };
    if (JSON.stringify(input.graph.inputContract ?? null) !== JSON.stringify(proposal.patchedGraph.inputContract ?? null)) {
      return { ok: false, reason: 'repair changed the immutable workflow input contract' };
    }
    if (JSON.stringify(input.graph.outputContract ?? null) !== JSON.stringify(proposal.patchedGraph.outputContract ?? null)) {
      return { ok: false, reason: 'repair changed the immutable workflow output contract' };
    }
    return { ok: true, reason: 'certified by the repairing orchestrator and deterministic invariants' };
  }

  #validate(graph: WorkflowGraph): { ok: boolean; reason: string } {
    // strict:true throws on real structural problems (cycles, dangling refs, bad
    // node shapes) — those block an auto-applied repair (R4). Soft draft warnings
    // (e.g. an unassigned agent on an unrelated node) must NOT block a valid fix.
    try {
      validateWorkflowGraph(graph, { strict: true });
      return { ok: true, reason: 'valid' };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  }
}

// ── helpers ──────────────────────────────────────────────────
function missingDeclaredKeys(output: Record<string, unknown>, keys: string[]): string[] {
  return keys.filter((k) => !isPresent(output[k]));
}
function isPresent(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return true;
  return true;
}
function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
/** Ground the planner in the workspace's REAL repair resources, or say none. */
function resourcesBlock(resources?: RepairResourceContext): string {
  if (!resources) return '';
  const agents = (resources.agents ?? [])
    .map((a) => `- ${a.id}${a.role ? ` (${a.role})` : ''}${a.status ? ` [${a.status}]` : ''}${a.capabilities?.length ? ` caps: ${a.capabilities.join(',')}` : ''}`)
    .join('\n');
  const extensions = (resources.extensions ?? []).map((e) => `- ${e.id}${e.name ? ` (${e.name})` : ''}`).join('\n');
  if (!agents && !extensions) return '';
  return (
    'AVAILABLE RESOURCES (use only these REAL ones; never invent an agent or extension):\n' +
    (agents ? `AGENTS:\n${clip(agents, 2000)}\n` : '') +
    (extensions ? `EXTENSIONS:\n${clip(extensions, 1500)}\n` : '')
  );
}
