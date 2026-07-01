/**
 * AgentSessionRuntime — the thinking⇄doing loop for a persistent AgentSession.
 *
 * SMARTER-AGENTS-10X §VI–IX. The WorkflowEngine owns run orchestration; this
 * runtime owns one session's cognitive cycle:
 *
 *   WAKE → THINK (one LLM step) → PARSE → EXECUTE (tools, zero tokens) →
 *   INJECT (tool results) → SAVE → DECIDE (continue / yield / complete)
 *
 * `advance()` drives that loop until the session reaches a terminal state
 * (completed/failed/max steps) or hits a YIELD point — delegate, await_event,
 * sleep_until, request_approval. On a yield the runtime returns control to the
 * engine, which registers the wake condition and parks the session as a DB row.
 * When the engine wakes it, `injectWake()` records the awaited result and the
 * engine calls `advance()` again. Between calls the agent costs zero tokens.
 *
 * Context compaction (§IX) runs inline: when the reconstructed window crosses
 * the token threshold the oldest turns are evicted and folded into the
 * observations memory block via the injected `summarize` callback.
 */

import { randomUUID } from 'node:crypto';
import {
  CONSTANTS,
  REALTIME_EVENTS,
  REALTIME_ROOMS,
  effectiveSpecialistTools,
  TOOL_DESCRIPTIONS,
  isAgentRole,
  type AgentRole,
  type AgentTool,
  type ChatToolCall,
  type SessionAdapter,
  type ToolDefinition,
  type WorkflowGraphPatch,
} from '@agentis/core';
import type { EvolveResult } from './atomicEvolution.js';
import type { Logger } from '../logger.js';
import type { EventBus } from '../event-bus.js';
import type { ScratchpadService, BlackboardIdentity } from './scratchpad.js';
import type { AgentToolRuntime } from './agentToolRuntime.js';
import type { BridgedToolSpec } from './mcpToolBridge.js';
import {
  AgentSessionService,
  estimateTokens,
  type AgentSession,
  type MemoryBlock,
} from './agentSession.js';
import type { PlanService, TaskCompletionJudge } from './planService.js';

// ──────────────────────────────────────────────────────────────
// Outcomes
// ──────────────────────────────────────────────────────────────

export type SessionYield =
  | {
      kind: 'delegate';
      toolCallId: string;
      role: AgentRole;
      task: string;
      allowedTools?: string[];
      allowedPaths?: string[];
      maxTokens?: number;
      createIfMissing?: boolean;
      temporary?: boolean;
      name?: string;
      instructions?: string;
      leaseMinutes?: number;
    }
  | { kind: 'await_event'; toolCallId: string; event: string }
  | { kind: 'sleep_until'; toolCallId: string; untilIso: string }
  | { kind: 'request_approval'; toolCallId: string; title: string; summary: string }
  // W3 — spawn a TEAM of specialists in parallel, await all, synthesize.
  | { kind: 'delegate_team'; toolCallId: string; members: DelegateMember[] }
  // W4 — run a saved workflow as a tool (subroutine) and WAIT for its result.
  | { kind: 'run_workflow'; toolCallId: string; workflowId: string; inputs?: Record<string, unknown> }
  // W4 — author a NEW saved workflow (validated + persisted), then run it later.
  | { kind: 'build_workflow'; toolCallId: string; title: string; graph: Record<string, unknown> };

/** One member of a parallel team spawn (delegate fields without kind/toolCallId). */
export type DelegateMember = Omit<Extract<SessionYield, { kind: 'delegate' }>, 'kind' | 'toolCallId'>;

/** Max specialists one agent may spawn in a single team without approval (W6/D3). */
export const MAX_TEAM_FANOUT = 8;

export type SessionOutcome =
  | { kind: 'completed'; output: Record<string, unknown> }
  | { kind: 'failed'; error: string }
  | { kind: 'suspended'; yield: SessionYield }
  | { kind: 'max_steps'; output: Record<string, unknown> };

/**
 * A scoped delegation grant — the access-scope a parent hands a delegated
 * sub-agent (UNIVERSAL-HARNESS §8). `allowedTools` is the tool allowlist the
 * delegate may invoke; absent = unrestricted (top-level sessions). Grants
 * attenuate on re-delegation (a child can only narrow, never widen — see
 * `attenuateGrant`). Lives only for the synchronous delegation, so it rides the
 * run context rather than the persisted session row.
 */
export interface DelegationGrant {
  /** Allowlisted tool names. When set, world-affecting tools outside it are denied. */
  allowedTools?: string[];
  /** Allowlisted path prefixes. When set, file tools may only touch paths under them. */
  allowedPaths?: string[];
  /** Token budget for the delegate's whole session. When set, the session stops once exceeded. */
  maxTokens?: number;
  /** Delegation depth this grant was issued at (for diagnostics). */
  depth: number;
}

/** What a delegating agent requests for its delegate. Each dimension narrows only. */
export interface DelegationRequest {
  tools?: string[];
  paths?: string[];
  maxTokens?: number;
}

export interface SessionRunContext {
  workspaceId: string;
  userId?: string;
  runId: string;
  nodeId: string;
  agentId: string;
  workflowId: string;
  planId?: string | null;
  role?: AgentRole;
  /** Workspace / Brain / memory context injected as a system addendum each step. */
  runContextBlock?: string;
  /** Active delegation scope. Set for delegated sub-agents; absent = unrestricted. */
  grant?: DelegationGrant;
  /** Override the engine-wide step ceiling for this session. */
  maxSteps?: number;
}

/** Summarize evicted turns into a compact paragraph for the observations block. */
export type SummarizeFn = (text: string) => Promise<string>;

export interface AgentSessionRuntimeDeps {
  sessions: AgentSessionService;
  /**
   * Static session adapter (legacy env path). Optional now that the model can be
   * resolved per-workspace via {@link AgentSessionRuntimeDeps.resolveAdapter} —
   * configure a model in Settings or connect an agent and sessions just work,
   * no `.env`.
   */
  adapter?: SessionAdapter;
  /**
   * Per-workspace adapter resolver — preferred over {@link adapter}. Returns the
   * cognitive-step adapter for a workspace (Settings → env → first agent runtime),
   * or undefined when no model is configured anywhere for that workspace.
  */
  resolveAdapter?: (workspaceId: string) => SessionAdapter | undefined;
  scratchpad: ScratchpadService;
  plans?: PlanService;
  bus: EventBus;
  logger: Logger;
  agentTools?: AgentToolRuntime;
  verifyCompletion?: TaskCompletionJudge;
  /** Cheap-model summarizer for compaction; falls back to truncation when absent. */
  summarize?: SummarizeFn;
  /**
   * Resolve the cross-runtime identity for an agent so blackboard entries are
   * tagged with WHO + WHICH runtime (the operator panel renders this). Best-effort
   * (in-memory adapter lookup); absent = entries carry just the agentId.
   * (AGENT-COOPERATION-10X §Pillar 2.)
   */
  resolveRuntimeLabel?: (agentId: string) => { runtime?: string | null; label?: string | null } | undefined;
  /**
   * AGENT-PRIMARY M2 — evolve the LIVE run's graph. Backed by
   * `WorkflowEngine.evolveGraph` (the contract transaction). Absent = the run
   * cannot be self-evolved (the tool degrades to an honest "unavailable").
   */
  evolvePlan?: (args: { runId: string; patch: WorkflowGraphPatch }) => Promise<EvolveResult>;
}

// Control-tool names — a closed set so we never branch on magic strings.
const TOOL = {
  memoryUpdate: 'memory_update',
  memorySearch: 'memory_search',
  scratchpadWrite: 'scratchpad_write',
  scratchpadRead: 'scratchpad_read',
  broadcast: 'broadcast',
  readChannel: 'read_channel',
  claim: 'claim',
  convergeSignal: 'converge_signal',
  runInspect: 'run_inspect',
  flagDeviation: 'flag_deviation',
  recordDecision: 'record_decision',
  delegateTask: 'delegate_task',
  spawnTeam: 'spawn_team',
  runWorkflow: 'run_workflow',
  buildWorkflow: 'build_workflow',
  evolvePlan: 'evolve_plan',
  awaitEvent: 'await_event',
  sleepUntil: 'sleep_until',
  requestApproval: 'request_approval',
  completeTask: 'complete_task',
} as const;

const YIELD_TOOLS = new Set<string>([TOOL.delegateTask, TOOL.spawnTeam, TOOL.runWorkflow, TOOL.buildWorkflow, TOOL.awaitEvent, TOOL.sleepUntil, TOOL.requestApproval]);

/**
 * Tools a delegation grant never restricts: terminal, session-local, and
 * read-only introspection. They cannot affect the run or the world beyond this
 * session, so an `allowedTools` allowlist only governs the rest (scratchpad
 * writes, broadcasts, re-delegation, and any agent-capability tools).
 */
const GRANT_EXEMPT_TOOLS = new Set<string>([
  TOOL.completeTask, TOOL.memoryUpdate, TOOL.memorySearch, TOOL.scratchpadRead, TOOL.readChannel, TOOL.runInspect,
]);

/** True when `tool` may run under `grant`. No grant or no allowlist = unrestricted. */
export function isToolPermitted(tool: string, grant: DelegationGrant | undefined): boolean {
  if (!grant?.allowedTools) return true;
  if (GRANT_EXEMPT_TOOLS.has(tool)) return true;
  return grant.allowedTools.includes(tool);
}

/** A path is permitted when it sits under one of the granted prefixes (or no path scope is set). */
export function isPathPermitted(p: string, grant: DelegationGrant | undefined): boolean {
  if (!grant?.allowedPaths || grant.allowedPaths.length === 0) return true;
  const norm = p.replace(/^\.?\/+/, '');
  return grant.allowedPaths.some((prefix) => {
    const base = prefix.replace(/^\.?\/+/, '').replace(/\/+$/, '');
    return norm === base || norm.startsWith(`${base}/`);
  });
}

/** Pull the path-like arg (path/dir/file) from a tool call, if any. */
export function pathArgOf(args: Record<string, unknown>): string | null {
  for (const key of ['path', 'dir', 'file', 'filePath']) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

/**
 * Attenuate a parent grant against a delegate's request. Every dimension
 * narrows only — tools/paths intersect with the parent's (or inherit when the
 * parent is unrestricted), and the token budget is the min of the two. A child
 * can never widen past its delegator. Returns `undefined` when fully unrestricted.
 */
export function attenuateGrant(
  parent: DelegationGrant | undefined,
  requested: DelegationRequest | undefined,
  depth: number,
): DelegationGrant | undefined {
  const narrowExact = (parentList: string[] | undefined, requestedList: string[] | undefined): string[] | undefined => {
    if (parentList && requestedList) return requestedList.filter((x) => parentList.includes(x));
    return requestedList ?? parentList;
  };
  // Paths narrow by containment: a requested prefix is kept only if it sits
  // under one the parent already allows (so a child can scope to a sub-tree).
  const narrowPaths = (parentList: string[] | undefined, requestedList: string[] | undefined): string[] | undefined => {
    if (parentList && requestedList) {
      return requestedList.filter((req) => parentList.some((p) => isPathPermitted(req, { allowedPaths: [p], depth: 0 })));
    }
    return requestedList ?? parentList;
  };
  const allowedTools = narrowExact(parent?.allowedTools, requested?.tools);
  const allowedPaths = narrowPaths(parent?.allowedPaths, requested?.paths);
  const budgets = [parent?.maxTokens, requested?.maxTokens].filter((n): n is number => typeof n === 'number' && n > 0);
  const maxTokens = budgets.length > 0 ? Math.min(...budgets) : undefined;
  if (!allowedTools && !allowedPaths && maxTokens === undefined) return undefined;
  return {
    depth,
    ...(allowedTools ? { allowedTools } : {}),
    ...(allowedPaths ? { allowedPaths } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
}

export class AgentSessionRuntime {
  constructor(private readonly deps: AgentSessionRuntimeDeps) {}

  /** The cognitive-step adapter for a workspace (resolver preferred over static). */
  #adapterFor(workspaceId: string): SessionAdapter | undefined {
    return this.deps.resolveAdapter?.(workspaceId) ?? this.deps.adapter;
  }

  /**
   * Whether a session can actually run for this workspace — i.e. a model is
   * resolvable. The engine consults this before upgrading an `agent_task` to a
   * full session, so a workspace with no model configured degrades cleanly to the
   * tool loop / single-shot dispatch instead of failing at dispatch.
   */
  canRun(workspaceId: string): boolean {
    return Boolean(this.#adapterFor(workspaceId));
  }

  /**
   * Advance the session until it yields or terminates. The engine is
   * responsible for what happens next (wake registration, node completion).
   */
  async advance(sessionId: string, runCtx: SessionRunContext): Promise<SessionOutcome> {
    const maxSteps = Math.max(1, Math.min(runCtx.maxSteps ?? CONSTANTS.SESSION_MAX_STEPS, CONSTANTS.SESSION_MAX_STEPS));
    // Phase 2/3A — a persistent session gets the same external MCP reach as the
    // in-process loop: operator-mounted servers + the built-in computer-use
    // server are offered as `mcp__*` tools alongside the role manifest.
    const bridgedTools = await this.#bridgedTools(runCtx.workspaceId);
    const tools = this.#toolCatalog(runCtx.role, bridgedTools);
    const adapter = this.#adapterFor(runCtx.workspaceId);
    if (!adapter) {
      return { kind: 'failed', error: 'no session model is configured for this workspace — connect an agent runtime or set an evaluation model in Settings' };
    }

    for (let i = 0; i < maxSteps; i += 1) {
      const session = this.deps.sessions.get(sessionId);
      if (!session) return { kind: 'failed', error: `session ${sessionId} vanished mid-run` };
      if (session.status === 'completed') return { kind: 'completed', output: session.output ?? {} };
      if (session.status === 'failed') return { kind: 'failed', error: session.error ?? 'session failed' };
      // Delegation token budget (§8): stop gracefully once a scoped delegate has
      // spent its grant — partial output is returned like a step-ceiling stop.
      const budget = runCtx.grant?.maxTokens;
      if (budget !== undefined && session.totalTokensIn + session.totalTokensOut >= budget) {
        return { kind: 'max_steps', output: { task: session.taskBlock, plan: session.planBlock, observations: session.observationsBlock, stoppedFor: 'token_budget' } };
      }

      await this.#maybeCompact(session);

      const messages = this.deps.sessions.reconstructContext(this.deps.sessions.get(sessionId)!, {
        runContext: runCtx.runContextBlock,
      });

      let result;
      try {
        result = await adapter.executeStep({ messages, tools });
      } catch (err) {
        const error = (err as Error).message;
        this.deps.logger.warn('session.step.failed', { sessionId, step: session.totalSteps, error });
        return { kind: 'failed', error };
      }

      const stepNumber = session.totalSteps + 1;
      this.deps.sessions.incrementStats(sessionId, {
        steps: 1,
        tokensIn: result.usage?.promptTokens ?? estimateTokens(messages.map((m) => stringifyContent(m.content)).join('\n')),
        tokensOut: result.usage?.completionTokens ?? estimateTokens(result.text),
      });

      // Persist the assistant turn (text + any requested tool calls).
      this.deps.sessions.appendMessages(
        sessionId,
        [{ role: 'assistant', content: result.text, toolCalls: result.toolCalls.length > 0 ? result.toolCalls : undefined }],
        stepNumber,
      );
      this.#emitStep(runCtx, sessionId, result.text, result.toolCalls);

      // No tools requested → the model's free text is its final answer.
      if (result.toolCalls.length === 0) {
        const output = { result: result.text };
        const completion = await this.#completeWithVerification(sessionId, runCtx, output);
        if (completion.ok) return { kind: 'completed', output };
        this.deps.sessions.fail(sessionId, completion.error);
        return { kind: 'failed', error: completion.error };
      }

      const dispatch = await this.#runToolCalls(sessionId, stepNumber, runCtx, result.toolCalls);
      if (dispatch.kind !== 'continue') return dispatch.outcome;
    }

    // Step ceiling hit — force a clean completion from the latest observations.
    const final = this.deps.sessions.get(sessionId);
    const output = { result: final?.observationsBlock || 'session reached step ceiling without an explicit answer' };
    this.deps.sessions.complete(sessionId, output);
    return { kind: 'max_steps', output };
  }

  /**
   * Inject the result the session was waiting on (a delegate's output, an
   * event payload, an approval decision) as the tool result for the open yield
   * call, then mark the session active so `advance()` can resume.
   */
  injectWake(sessionId: string, toolCallId: string, payload: unknown): void {
    const session = this.deps.sessions.get(sessionId);
    if (!session) return;
    this.deps.sessions.appendMessages(
      sessionId,
      [{ role: 'tool', toolCallId, content: stringify(payload) }],
      session.totalSteps,
    );
    this.deps.sessions.wake(sessionId);
  }

  // ────────────────────────────────────────────────────────────
  // Tool dispatch
  // ────────────────────────────────────────────────────────────

  async #runToolCalls(
    sessionId: string,
    stepNumber: number,
    runCtx: SessionRunContext,
    calls: ChatToolCall[],
  ): Promise<{ kind: 'continue' } | { kind: 'done'; outcome: SessionOutcome }> {
    let pendingYield: SessionYield | null = null;

    for (const call of calls) {
      const args = asRecord(call.arguments);

      // Once a yield is pending, every remaining call is deferred — its result
      // is recorded so the transcript stays well-formed, but it does not run.
      if (pendingYield) {
        this.deps.sessions.appendMessages(
          sessionId,
          [{ role: 'tool', toolCallId: call.id, content: 'deferred: superseded by a yield earlier in this step' }],
          stepNumber,
        );
        continue;
      }

      // Delegation scope (§8): a delegated sub-agent can only invoke the tools
      // its parent granted, and only touch the paths it granted. Denials surface
      // as a tool observation so the model can adapt rather than crash. Enforced
      // before yield/exec dispatch so it also blocks unauthorized re-delegation.
      if (!isToolPermitted(call.name, runCtx.grant)) {
        this.deps.sessions.appendMessages(
          sessionId,
          [{ role: 'tool', toolCallId: call.id, content: `denied: tool '${call.name}' is outside your delegation scope (allowed: ${runCtx.grant?.allowedTools?.join(', ') || 'none'})` }],
          stepNumber,
        );
        continue;
      }
      const pathArg = pathArgOf(args);
      if (pathArg !== null && !isPathPermitted(pathArg, runCtx.grant)) {
        this.deps.sessions.appendMessages(
          sessionId,
          [{ role: 'tool', toolCallId: call.id, content: `denied: path '${pathArg}' is outside your delegation scope (allowed: ${runCtx.grant?.allowedPaths?.join(', ') || 'none'})` }],
          stepNumber,
        );
        continue;
      }

      // Terminal.
      if (call.name === TOOL.completeTask) {
        const output = normalizeOutput(args.output ?? args);
        const completion = await this.#completeWithVerification(sessionId, runCtx, output);
        this.deps.sessions.appendMessages(
          sessionId,
          [{ role: 'tool', toolCallId: call.id, content: completion.ok ? 'task completed' : completion.error }],
          stepNumber,
        );
        if (completion.ok) return { kind: 'done', outcome: { kind: 'completed', output } };
        continue;
      }

      // Yield points — record intent, suspend, hand the engine the wake spec.
      if (YIELD_TOOLS.has(call.name)) {
        pendingYield = this.#buildYield(call, args);
        if (!pendingYield) {
          // Malformed yield args — surface an error result and let the loop continue.
          this.deps.sessions.appendMessages(
            sessionId,
            [{ role: 'tool', toolCallId: call.id, content: `error: invalid arguments for ${call.name}` }],
            stepNumber,
          );
        }
        continue;
      }

      // Synchronous tools — execute and inject the observation immediately.
      const observation = await this.#execTool(sessionId, call.name, args, runCtx);
      this.deps.sessions.appendMessages(
        sessionId,
        [{ role: 'tool', toolCallId: call.id, content: stringify(observation) }],
        stepNumber,
      );
    }

    if (pendingYield) {
      this.deps.sessions.suspend(sessionId, suspendReasonFor(pendingYield), wakeConditionFor(pendingYield), {
        toolCallId: pendingYield.toolCallId,
      });
      return { kind: 'done', outcome: { kind: 'suspended', yield: pendingYield } };
    }
    return { kind: 'continue' };
  }

  #buildYield(call: ChatToolCall, args: Record<string, unknown>): SessionYield | null {
    switch (call.name) {
      case TOOL.delegateTask: {
        const member = parseDelegateMember(args);
        return member ? { kind: 'delegate', toolCallId: call.id, ...member } : null;
      }
      case TOOL.spawnTeam: {
        const rawTasks = Array.isArray(args.tasks) ? args.tasks : [];
        const members: DelegateMember[] = [];
        for (const raw of rawTasks) {
          const m = parseDelegateMember(asRecord(raw));
          if (m) members.push(m);
        }
        if (members.length === 0) return null;
        // W6/D3 — bound fan-out; surplus members are dropped (the agent can spawn
        // a second wave). Future: approval gate beyond the cap.
        return { kind: 'delegate_team', toolCallId: call.id, members: members.slice(0, MAX_TEAM_FANOUT) };
      }
      case TOOL.runWorkflow: {
        const workflowId = String(args.workflow_id ?? args.workflowId ?? '');
        if (!workflowId) return null;
        const inputs = args.inputs && typeof args.inputs === 'object' && !Array.isArray(args.inputs)
          ? (args.inputs as Record<string, unknown>) : undefined;
        return { kind: 'run_workflow', toolCallId: call.id, workflowId, ...(inputs ? { inputs } : {}) };
      }
      case TOOL.buildWorkflow: {
        const title = String(args.title ?? '').trim();
        const graph = args.graph;
        if (!title || !graph || typeof graph !== 'object' || Array.isArray(graph)) return null;
        return { kind: 'build_workflow', toolCallId: call.id, title, graph: graph as Record<string, unknown> };
      }
      case TOOL.awaitEvent: {
        const event = String(args.event ?? '');
        if (!event) return null;
        return { kind: 'await_event', toolCallId: call.id, event };
      }
      case TOOL.sleepUntil: {
        const untilIso = String(args.until_iso ?? args.until ?? '');
        if (!untilIso || Number.isNaN(Date.parse(untilIso))) return null;
        return { kind: 'sleep_until', toolCallId: call.id, untilIso };
      }
      case TOOL.requestApproval: {
        const title = String(args.title ?? 'Approval required');
        const summary = String(args.summary ?? '');
        return { kind: 'request_approval', toolCallId: call.id, title, summary };
      }
      default:
        return null;
    }
  }

  async #execTool(sessionId: string, name: string, args: Record<string, unknown>, runCtx: SessionRunContext): Promise<unknown> {
    switch (name) {
      case TOOL.memoryUpdate: {
        const block = args.block as MemoryBlock;
        if (block !== 'task' && block !== 'plan' && block !== 'observations') {
          return { ok: false, error: 'block must be one of task | plan | observations' };
        }
        this.deps.sessions.updateMemoryBlock(sessionId, block, String(args.content ?? ''));
        return { ok: true };
      }
      case TOOL.memorySearch: {
        const hits = this.deps.sessions.searchMessages(sessionId, String(args.query ?? ''));
        return { ok: true, matches: hits.map((h) => ({ step: h.stepNumber, role: h.role, content: clip(h.content, 600) })) };
      }
      case TOOL.scratchpadWrite: {
        this.deps.scratchpad.write(runCtx.runId, String(args.key ?? ''), args.value ?? null, {
          identity: this.#identityFor(runCtx),
        });
        return { ok: true };
      }
      case TOOL.scratchpadRead: {
        const key = args.key != null ? String(args.key) : undefined;
        return { ok: true, value: key ? this.deps.scratchpad.read(runCtx.runId, key) : this.deps.scratchpad.snapshotOf(runCtx.runId) };
      }
      case TOOL.broadcast: {
        this.deps.scratchpad.broadcast(runCtx.runId, String(args.channel ?? 'general'), runCtx.agentId, String(args.message ?? ''), {
          identity: this.#identityFor(runCtx),
        });
        return { ok: true };
      }
      case TOOL.readChannel: {
        return { ok: true, messages: this.deps.scratchpad.readChannel(runCtx.runId, String(args.channel ?? 'general')) };
      }
      case TOOL.claim: {
        // A structured assertion with confidence — the operator sees disagreement
        // when one runtime supersedes another's claim. (AGENT-COOPERATION-10X §Pillar 4.)
        const statement = String(args.statement ?? '').slice(0, 2000);
        const confidence = typeof args.confidence === 'number' ? Math.max(0, Math.min(1, args.confidence)) : undefined;
        const supersedes = typeof args.supersedes === 'string' && args.supersedes.trim() ? args.supersedes.trim() : undefined;
        const id = this.deps.scratchpad.claim(runCtx.runId, statement, {
          identity: this.#identityFor(runCtx),
          confidence,
          supersedes,
          key: typeof args.key === 'string' ? args.key : undefined,
        });
        return { ok: true, claimId: id };
      }
      case TOOL.convergeSignal: {
        // Let a cohort agent declare the convergence goal met — the `signal`
        // continuation source for a `converge` loop. (§Pillar 1 + §Pillar 4.)
        const channel = String(args.channel ?? 'converge');
        const reason = String(args.reason ?? 'goal met').slice(0, 1000);
        this.deps.scratchpad.broadcast(runCtx.runId, channel, runCtx.agentId, `done: ${reason}`, {
          identity: this.#identityFor(runCtx),
        });
        return { ok: true, signalled: true };
      }
      case TOOL.runInspect: {
        const session = this.deps.sessions.get(sessionId);
        return {
          ok: true,
          runId: runCtx.runId,
          steps: session?.totalSteps ?? 0,
          tokensIn: session?.totalTokensIn ?? 0,
          tokensOut: session?.totalTokensOut ?? 0,
          delegationDepth: session?.delegationDepth ?? 0,
          delegationScope: runCtx.grant
            ? { tools: runCtx.grant.allowedTools ?? null, paths: runCtx.grant.allowedPaths ?? null, maxTokens: runCtx.grant.maxTokens ?? null }
            : null,
        };
      }
      case TOOL.flagDeviation: {
        // W5.1 — a first-class, visible verdict: the agent says the planned work
        // doesn't fit reality (bad input / wrong scope / blocked) BEFORE failing.
        // Recorded + broadcast so the operator sees it; the agent then completes
        // with a grounded partial, escalates, or re-scopes within budget.
        const kind = ['reject_input', 'rescope', 'blocked'].includes(String(args.kind)) ? String(args.kind) : 'rescope';
        const reason = String(args.reason ?? '').slice(0, 1000);
        const proposed = typeof args.proposed === 'string' && args.proposed.trim() ? args.proposed.trim().slice(0, 1000) : undefined;
        const planId = await this.#resolvePlanId(sessionId, runCtx);
        if (planId && this.deps.plans) {
          this.deps.plans.recordDeviation(runCtx.workspaceId, runCtx.userId ?? runCtx.agentId, planId, {
            kind: kind as 'reject_input' | 'rescope' | 'blocked',
            reason,
            ...(proposed ? { proposed } : {}),
            actorId: runCtx.agentId,
            runId: runCtx.runId,
            sessionId,
            nodeId: runCtx.nodeId,
          });
        }
        this.deps.scratchpad.write(runCtx.runId, `deviation:${runCtx.nodeId ?? runCtx.agentId}`, { kind, reason, proposed, at: new Date().toISOString() });
        this.deps.scratchpad.broadcast(runCtx.runId, 'deviations', runCtx.agentId, `[${kind}] ${reason}`);
        this.deps.bus.publish(REALTIME_ROOMS.run(runCtx.runId), REALTIME_EVENTS.AGENT_WORK_STEP, {
          runId: runCtx.runId, nodeId: runCtx.nodeId, agentId: runCtx.agentId,
          text: `Deviation flagged (${kind}): ${clip(reason, 200)}`, toolCalls: ['flag_deviation'],
        });
        return {
          ok: true,
          acknowledged: true,
          guidance: 'Deviation recorded and visible to the operator. If the input is unusable, complete with a grounded partial plus this note, request_approval to escalate, or re-scope your plan and proceed within budget. Never fabricate to satisfy a contract.',
        };
      }
      case TOOL.recordDecision: {
        const summary = String(args.summary ?? '').slice(0, 1000);
        const rationale = typeof args.rationale === 'string' && args.rationale.trim()
          ? args.rationale.trim().slice(0, 1000)
          : undefined;
        const planId = await this.#resolvePlanId(sessionId, runCtx);
        if (planId && this.deps.plans) {
          this.deps.plans.recordDecision(runCtx.workspaceId, runCtx.userId ?? runCtx.agentId, planId, {
            summary,
            ...(rationale ? { rationale } : {}),
            actorId: runCtx.agentId,
            runId: runCtx.runId,
            sessionId,
            nodeId: runCtx.nodeId,
          });
        } else {
          this.deps.scratchpad.write(runCtx.runId, `decision:${runCtx.nodeId ?? runCtx.agentId}:${Date.now()}`, {
            summary,
            rationale,
            at: new Date().toISOString(),
          });
        }
        return { ok: true, recorded: true };
      }
      case TOOL.evolvePlan:
        return this.#execEvolvePlan(args, runCtx);
      default:
        if (name.startsWith('mcp__')) return this.#execBridgedTool(name, args, runCtx);
        return this.#execRoleTool(name, args, runCtx);
    }
  }

  /**
   * AGENT-PRIMARY M2 — the agent extends the plan it is running in. The engine
   * runs the contract transaction (green ratchet + authority) and either commits
   * or returns named regressions. A rejection is a typed instruction, not a dead
   * end: the agent fixes what it would break and re-proposes.
   */
  async #execEvolvePlan(args: Record<string, unknown>, runCtx: SessionRunContext): Promise<unknown> {
    if (!this.deps.evolvePlan) {
      return { ok: false, error: 'graph evolution is not available for this run.' };
    }
    const nodes = (v: unknown) => (Array.isArray(v) ? (v as WorkflowGraphPatch['addNodes']) : []);
    const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    const patch: WorkflowGraphPatch = {
      patchId: randomUUID(),
      reason: 'agent_evolve',
      baseGraphRevision: 0, // the engine stamps the real revision
      addNodes: nodes(args.addNodes),
      updateNodes: nodes(args.updateNodes),
      removeNodeIds: ids(args.removeNodeIds),
      addEdges: (Array.isArray(args.addEdges) ? (args.addEdges as WorkflowGraphPatch['addEdges']) : []),
      removeEdgeIds: ids(args.removeEdgeIds),
    };
    if (patch.addNodes.length === 0 && patch.updateNodes.length === 0 && patch.removeNodeIds.length === 0
      && patch.addEdges.length === 0 && patch.removeEdgeIds.length === 0) {
      return { ok: false, error: 'evolve_plan needs at least one of addNodes / addEdges / updateNodes / removeNodeIds / removeEdgeIds.' };
    }
    const res = await this.deps.evolvePlan({ runId: runCtx.runId, patch });
    if (res.committed) {
      return {
        ok: true, committed: true, newRevision: res.newRevision, contractSummary: res.contractSummary,
        ...(res.warnings.length ? { warnings: res.warnings } : {}),
        guidance: 'Plan extended. The new steps are part of your run and execute after this node. Continue toward the objective.',
      };
    }
    return {
      ok: false, committed: false, rejected: res.rejected, regressions: res.regressions,
      guidance:
        'The engine rejected this evolution to keep the workflow correct — fix the NAMED regressions and re-propose: '
        + 'read only data paths an upstream provably produces, never force an approval to true, and never remove a node that is already running or done. '
        + 'Never fabricate or gut a step to get past this.',
    };
  }

  /**
   * Execute a bridged MCP tool (`mcp__*`). The delegation-scope gate already ran
   * in `#runToolCalls`, so a scoped delegate only reaches here for a tool its
   * grant allows; bridged tools sit outside the static role manifest.
   */
  async #execBridgedTool(name: string, args: Record<string, unknown>, runCtx: SessionRunContext): Promise<unknown> {
    if (!this.deps.agentTools) return { ok: false, error: `unknown tool '${name}'` };
    const toolArgs = args.args && typeof args.args === 'object' && !Array.isArray(args.args)
      ? args.args as Record<string, unknown>
      : args;
    const res = await this.deps.agentTools.executeBridged(runCtx.workspaceId, name, toolArgs);
    return res.ok ? { ok: true, result: res.result } : { ok: false, error: res.error };
  }

  async #completeWithVerification(
    sessionId: string,
    runCtx: SessionRunContext,
    output: Record<string, unknown>,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const planId = await this.#resolvePlanId(sessionId, runCtx);
    if (!planId || !this.deps.plans) {
      this.deps.sessions.complete(sessionId, output);
      return { ok: true };
    }
    const result = await this.deps.plans.verifyCompletion(runCtx.workspaceId, runCtx.userId ?? runCtx.agentId, planId, {
      output,
      judge: this.deps.verifyCompletion,
      evidence: [{ label: 'Agent completion output', runId: runCtx.runId, sessionId, nodeId: runCtx.nodeId }],
    });
    if (result.passed) {
      this.deps.sessions.complete(sessionId, output);
      return { ok: true };
    }
    const failed = result.verification.criteria
      .filter((criterion) => !criterion.passed)
      .map((criterion) => `- ${criterion.criterion}: ${criterion.reason}`)
      .join('\n');
    return {
      ok: false,
      error: `completion verification failed; revise the work or flag a grounded deviation before trying again.\n${failed}`,
    };
  }

  async #resolvePlanId(sessionId: string, runCtx: SessionRunContext): Promise<string | null> {
    if (runCtx.planId) return runCtx.planId;
    if (!this.deps.plans) return null;
    const bySession = this.deps.plans.findBySession(runCtx.workspaceId, sessionId);
    if (bySession) return bySession.id;
    const byRun = this.deps.plans.findByRun(runCtx.workspaceId, runCtx.runId);
    return byRun?.id ?? null;
  }

  async #execRoleTool(name: string, args: Record<string, unknown>, runCtx: SessionRunContext): Promise<unknown> {
    if (!this.deps.agentTools || !runCtx.role) return { ok: false, error: `unknown tool '${name}'` };
    // §specialist-removal — built-in role manifests are gone; a specialist gets
    // the universal floor. A scoped delegate is ALSO restricted by its grant, so
    // role tools (not just orchestration tools) honor the delegation allowlist.
    const roleManifest = effectiveSpecialistTools({ role: runCtx.role });
    if (!roleManifest.includes(name as AgentTool) || !isToolPermitted(name, runCtx.grant)) {
      return { ok: false, error: `tool '${name}' not granted to role '${runCtx.role}'` };
    }
    const toolArgs = args.args && typeof args.args === 'object' && !Array.isArray(args.args)
      ? args.args as Record<string, unknown>
      : args;
    const res = await this.deps.agentTools.execute(runCtx.workspaceId, name as AgentTool, toolArgs, runCtx.role, {
      workflowId: runCtx.workflowId,
      agentId: runCtx.agentId,
    });
    return res.ok ? { ok: true, result: res.result } : { ok: false, error: res.error };
  }

  // ────────────────────────────────────────────────────────────
  // Compaction (§IX)
  // ────────────────────────────────────────────────────────────

  async #maybeCompact(session: AgentSession): Promise<void> {
    const budget = CONSTANTS.SESSION_CONTEXT_TOKEN_BUDGET;
    const threshold = budget * CONSTANTS.SESSION_COMPACTION_THRESHOLD;
    const inContext = this.deps.sessions.contextMessages(session.id);
    const used =
      estimateTokens([session.personaBlock, session.taskBlock, session.planBlock, session.observationsBlock].join('\n')) +
      inContext.reduce((sum, m) => sum + (m.tokenCount ?? estimateTokens(m.content)), 0);
    if (used < threshold) return;

    const victims = this.deps.sessions.evictOldest(session.id, CONSTANTS.SESSION_COMPACTION_EVICT_FRACTION);
    if (victims.length === 0) return;

    const transcript = victims.map((v) => `[${v.role}] ${v.content}`).join('\n');
    let summary: string;
    try {
      summary = this.deps.summarize ? await this.deps.summarize(transcript) : truncateSummary(transcript);
    } catch {
      summary = truncateSummary(transcript);
    }
    const merged = session.observationsBlock
      ? `${session.observationsBlock}\n\n## Compacted (${new Date().toISOString()})\n${summary}`
      : `## Compacted (${new Date().toISOString()})\n${summary}`;
    this.deps.sessions.updateMemoryBlock(session.id, 'observations', merged);
    this.deps.logger.info('session.compacted', { sessionId: session.id, evicted: victims.length });
  }

  // ────────────────────────────────────────────────────────────
  // Tool catalog + realtime
  // ────────────────────────────────────────────────────────────

  #toolCatalog(role?: AgentRole, bridged: BridgedToolSpec[] = []): ToolDefinition[] {
    const tools: ToolDefinition[] = [...CONTROL_TOOLS];
    if (role) {
      // §specialist-removal — offer the role's effective toolbox (the universal
      // floor when it has no explicit manifest), not the retired built-in map.
      for (const t of effectiveSpecialistTools({ role })) {
        tools.push({
          name: t,
          description: TOOL_DESCRIPTIONS[t],
          parameters: parametersForAgentTool(t),
        });
      }
    }
    // Bridged MCP tools (computer-use, browser, operator-mounted servers).
    for (const spec of bridged) {
      tools.push({
        name: spec.id,
        description: spec.provides ? `${spec.description} [grants ${spec.provides}]` : spec.description,
        parameters: (spec.inputSchema as ToolDefinition['parameters']) ?? { type: 'object', properties: {} },
      });
    }
    return tools;
  }

  /** External MCP tools available to this workspace, or [] when no bridge/servers. */
  async #bridgedTools(workspaceId: string): Promise<BridgedToolSpec[]> {
    if (!this.deps.agentTools) return [];
    return this.deps.agentTools.listBridgedTools(workspaceId);
  }

  /** Cross-runtime authoring identity for a blackboard write (who + which runtime). */
  #identityFor(runCtx: SessionRunContext): BlackboardIdentity {
    const resolved = this.deps.resolveRuntimeLabel?.(runCtx.agentId);
    return {
      agentId: runCtx.agentId,
      runtime: resolved?.runtime ?? runCtx.role ?? null,
      label: resolved?.label ?? runCtx.agentId,
    };
  }

  #emitStep(runCtx: SessionRunContext, sessionId: string, text: string, calls: ChatToolCall[]): void {
    this.deps.bus.publish(REALTIME_ROOMS.run(runCtx.runId), REALTIME_EVENTS.AGENT_WORK_STEP, {
      runId: runCtx.runId,
      nodeId: runCtx.nodeId,
      agentId: runCtx.agentId,
      sessionId,
      text: clip(text, 400),
      toolCalls: calls.map((c) => c.name),
    });
  }
}

// ──────────────────────────────────────────────────────────────
// Static tool definitions
// ──────────────────────────────────────────────────────────────

const CONTROL_TOOLS: ToolDefinition[] = [
  {
    name: TOOL.memoryUpdate,
    description: 'Rewrite one of your working-memory blocks. Use it to keep your task/plan/observations current.',
    parameters: {
      type: 'object',
      properties: {
        block: { type: 'string', enum: ['task', 'plan', 'observations'] },
        content: { type: 'string', description: 'The full new content for the block.' },
      },
      required: ['block', 'content'],
    },
  },
  {
    name: TOOL.memorySearch,
    description: 'Search your own archived (evicted) messages for something you discussed earlier.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: TOOL.scratchpadWrite,
    description: 'Write a value to the shared run scratchpad so other nodes/agents can read it.',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string' }, value: { description: 'Any JSON value.' } },
      required: ['key', 'value'],
    },
  },
  {
    name: TOOL.scratchpadRead,
    description: 'Read a key from the run scratchpad, or omit key to read the whole snapshot.',
    parameters: { type: 'object', properties: { key: { type: 'string' } } },
  },
  {
    name: TOOL.broadcast,
    description: 'Post a message to a run-scoped channel that peer agents in this run can read.',
    parameters: {
      type: 'object',
      properties: { channel: { type: 'string', default: 'general' }, message: { type: 'string' } },
      required: ['message'],
    },
  },
  {
    name: TOOL.readChannel,
    description: 'Read recent messages from a run-scoped channel.',
    parameters: { type: 'object', properties: { channel: { type: 'string', default: 'general' } } },
  },
  {
    name: TOOL.claim,
    description:
      'Post a structured claim to the blackboard — an assertion the operator and peer agents can see, with confidence. ' +
      'Use to assert a finding/result (e.g. "bug #3 fixed"). Pass `supersedes` with a prior claimId to revise or dispute it; ' +
      'disagreement between runtimes is rendered explicitly.',
    parameters: {
      type: 'object',
      properties: {
        statement: { type: 'string', description: 'The assertion, grounded in evidence.' },
        confidence: { type: 'number', description: '0..1 confidence in the claim.' },
        supersedes: { type: 'string', description: 'Optional claimId this revises/disputes.' },
        key: { type: 'string', description: 'Optional stable key to group claims about the same subject.' },
      },
      required: ['statement'],
    },
  },
  {
    name: TOOL.convergeSignal,
    description:
      'Declare the convergence goal met for a cooperative loop you are running inside. Stops the surrounding `converge` ' +
      'loop when it uses signal-based continuation. Only call when the objective is genuinely satisfied.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why the goal is met, grounded in the result.' },
        channel: { type: 'string', default: 'converge', description: 'Loop signal channel (default "converge").' },
      },
      required: ['reason'],
    },
  },
  {
    name: TOOL.runInspect,
    description: 'Inspect your own session stats (steps, token spend, delegation depth).',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: TOOL.flagDeviation,
    description:
      'Flag that the planned work does not fit reality — BEFORE failing. Use when the input you received is unusable, ' +
      'the scope is wrong, or you are blocked. Records a visible verdict for the operator; you then complete with a ' +
      'grounded partial + this note, request_approval to escalate, or re-scope and proceed within budget. Never fabricate.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['reject_input', 'rescope', 'blocked'], description: 'reject_input = upstream gave unusable data; rescope = the objective needs adjusting; blocked = cannot proceed.' },
        reason: { type: 'string', description: 'Grounded explanation citing the actual input/error. No speculation.' },
        proposed: { type: 'string', description: 'Optional: what you propose to do instead (the better path).' },
      },
      required: ['kind', 'reason'],
    },
  },
  {
    name: TOOL.recordDecision,
    description:
      'Record an important decision made while executing the task spine. Use for durable choices that affect scope, approach, verification, or operator-visible tradeoffs.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Concise decision statement.' },
        rationale: { type: 'string', description: 'Why this decision was made, grounded in observed evidence.' },
      },
      required: ['summary'],
    },
  },
  {
    name: TOOL.delegateTask,
    description: 'Hand a subtask to a specialist and WAIT for its result. Use for work outside your expertise.',
    parameters: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'Specialist role slug, for example frontend_architect, tax_analyst, or launch_operator.' },
        task: { type: 'string', description: 'A self-contained description of the subtask.' },
        create_if_missing: {
          type: 'boolean',
          description: 'Create a durable specialist for this role when none exists. Default false.',
        },
        temporary: {
          type: 'boolean',
          description: 'Create or reuse a temporary ephemeral specialist instance for this delegation. Implies create_if_missing.',
        },
        name: {
          type: 'string',
          description: 'Optional display name when creating the specialist.',
        },
        instructions: {
          type: 'string',
          description: 'Optional system instructions when creating the specialist. Defaults to the task brief.',
        },
        lease_minutes: {
          type: 'number',
          description: 'Optional lease for temporary specialists, capped at 24 hours. Default 60.',
        },
        allowed_tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional least-privilege scope: the only world-affecting tools the delegate may use (e.g. ["knowledge_search"]). Narrows your own scope further; cannot widen it. Omit to pass on your current scope.',
        },
        allowed_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional path allowlist: file tools may only touch paths under these prefixes (e.g. ["src/"]). Narrows only.',
        },
        max_tokens: {
          type: 'number',
          description: 'Optional token budget for the delegate\'s whole session. It stops once exceeded. Narrows only (min with your own budget).',
        },
      },
      required: ['role', 'task'],
    },
  },
  {
    name: TOOL.spawnTeam,
    description:
      `Spawn a TEAM of specialists to work in PARALLEL and WAIT for all results. Use when a goal splits into ` +
      `independent subtasks you can run at once (e.g. research three markets, draft + review + fact-check). Each ` +
      `member runs concurrently; you get an array of results to synthesize. Up to ${MAX_TEAM_FANOUT} members per call.`,
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: 'The team members to spawn in parallel. Each is a delegation: { role, task, create_if_missing?, temporary?, allowed_tools?, max_tokens?, … }.',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string', description: 'Specialist role slug.' },
              task: { type: 'string', description: 'A self-contained description of this member\'s subtask.' },
              create_if_missing: { type: 'boolean', description: 'Create a durable specialist for this role when none exists.' },
              temporary: { type: 'boolean', description: 'Create/reuse a temporary ephemeral specialist for this delegation.' },
              allowed_tools: { type: 'array', items: { type: 'string' }, description: 'Optional least-privilege tool scope (narrows only).' },
              max_tokens: { type: 'number', description: 'Optional per-member token budget (narrows only).' },
            },
            required: ['role', 'task'],
          },
        },
      },
      required: ['tasks'],
    },
  },
  {
    name: TOOL.runWorkflow,
    description:
      'Run a saved workflow as a TOOL (subroutine) and WAIT for its result. Use when a repeatable, multi-step ' +
      'process is already captured as a workflow — reach for it instead of redoing the steps yourself. Returns the ' +
      'workflow\'s final output, which you then use to continue.',
    parameters: {
      type: 'object',
      properties: {
        workflow_id: { type: 'string', description: 'The id of the saved workflow to run.' },
        inputs: { type: 'object', description: 'Optional input object passed to the workflow trigger.' },
      },
      required: ['workflow_id'],
    },
  },
  {
    name: TOOL.buildWorkflow,
    description:
      'Author a NEW saved workflow and persist it (validated). Use when you discover a repeatable process worth ' +
      'capturing as a reusable tool — build it once, then run it with run_workflow now and in future runs. Returns the ' +
      'new workflowId.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'A short, descriptive name for the workflow.' },
        graph: { type: 'object', description: 'An Agentis WorkflowGraph JSON (version, nodes, edges, viewport).' },
      },
      required: ['title', 'graph'],
    },
  },
  {
    name: TOOL.evolvePlan,
    description:
      'Extend the plan you are running in. When you DISCOVER the current graph cannot reach the objective — a stage is '
      + 'missing, the data is richer than assumed, an external surface changed — add the steps here instead of forcing a '
      + 'bad fit or failing. Pass full WorkflowNode objects in addNodes and WorkflowEdge objects in addEdges to wire them '
      + 'in AFTER the node you are in. The engine validates against the same contracts as authoring: if you read a data '
      + 'path no upstream produces, force an approval true, or touch a node already running/done, it is REJECTED with the '
      + 'exact reason — fix that and re-propose. This is authorship, not repair; never gut a step to get past a rejection.',
    parameters: {
      type: 'object',
      properties: {
        addNodes: { type: 'array', description: 'New WorkflowNode objects (id, type, title, position, config).', items: { type: 'object' } },
        addEdges: { type: 'array', description: 'New WorkflowEdge objects (id, source, target) wiring the new nodes in.', items: { type: 'object' } },
        updateNodes: { type: 'array', description: 'Full WorkflowNode objects replacing existing nodes by id (not yet running).', items: { type: 'object' } },
        removeNodeIds: { type: 'array', description: 'Ids of not-yet-run nodes to remove.', items: { type: 'string' } },
        removeEdgeIds: { type: 'array', description: 'Ids of edges to remove.', items: { type: 'string' } },
        reason: { type: 'string', description: 'Why the plan needs this — grounded in what you discovered.' },
      },
    },
  },
  {
    name: TOOL.awaitEvent,
    description: 'Suspend until a named event fires on this run. You spend no tokens while waiting.',
    parameters: { type: 'object', properties: { event: { type: 'string' } }, required: ['event'] },
  },
  {
    name: TOOL.sleepUntil,
    description: 'Suspend until an absolute time (ISO-8601). You spend no tokens while sleeping.',
    parameters: { type: 'object', properties: { until_iso: { type: 'string', description: 'ISO-8601 timestamp.' } }, required: ['until_iso'] },
  },
  {
    name: TOOL.requestApproval,
    description: 'Pause and ask a human operator to approve before continuing. Resumes with their decision.',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string' }, summary: { type: 'string' } },
      required: ['title', 'summary'],
    },
  },
  {
    name: TOOL.completeTask,
    description: 'Finish the task and return your final output. If the task declares output keys, output must be an object with those exact top-level keys. Call this exactly once when done.',
    parameters: {
      type: 'object',
      properties: { output: { description: 'Your final result — an object or a string.' } },
      required: ['output'],
    },
  },
];

// ──────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────

/** Parse one delegate/team-member spec from tool args (shared by delegate + spawn_team). */
function parseDelegateMember(args: Record<string, unknown>): DelegateMember | null {
  const role = String(args.role ?? '');
  const task = String(args.task ?? '');
  if (!isAgentRole(role) || !task) return null;
  const strList = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : undefined;
  const allowedTools = strList(args.allowed_tools);
  const allowedPaths = strList(args.allowed_paths);
  const maxTokens = typeof args.max_tokens === 'number' && args.max_tokens > 0 ? args.max_tokens : undefined;
  const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : undefined;
  const instructions = typeof args.instructions === 'string' && args.instructions.trim() ? args.instructions.trim() : undefined;
  const leaseMinutes = typeof args.lease_minutes === 'number' && args.lease_minutes > 0
    ? Math.min(Math.floor(args.lease_minutes), 24 * 60)
    : undefined;
  return {
    role, task,
    ...(allowedTools && allowedTools.length > 0 ? { allowedTools } : {}),
    ...(allowedPaths && allowedPaths.length > 0 ? { allowedPaths } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(args.create_if_missing === true ? { createIfMissing: true } : {}),
    ...(args.temporary === true ? { temporary: true } : {}),
    ...(name ? { name } : {}),
    ...(instructions ? { instructions } : {}),
    ...(leaseMinutes !== undefined ? { leaseMinutes } : {}),
  };
}

function suspendReasonFor(y: SessionYield): 'delegate' | 'await_event' | 'sleep_until' | 'checkpoint' {
  switch (y.kind) {
    case 'delegate':
    case 'delegate_team':
      return 'delegate';
    case 'await_event':
    case 'run_workflow':
    case 'build_workflow':
      return 'await_event';
    case 'sleep_until':
      return 'sleep_until';
    case 'request_approval':
      return 'checkpoint';
  }
}

/**
 * The canonical wake-condition string the engine matches against. Delegation
 * and approval resolve via the engine's own bookkeeping (they carry no public
 * condition), so they get a session-unique sentinel.
 */
function wakeConditionFor(y: SessionYield): string {
  switch (y.kind) {
    case 'delegate':
    case 'delegate_team':
      return `delegate:${y.toolCallId}`;
    case 'await_event':
      return `event:${y.event}`;
    case 'run_workflow':
      return `workflow:${y.toolCallId}`;
    case 'build_workflow':
      return `build:${y.toolCallId}`;
    case 'sleep_until':
      return `time:${y.untilIso}`;
    case 'request_approval':
      return `approval:${y.toolCallId}`;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function normalizeOutput(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return { result: value };
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content;
  return stringify(content);
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function truncateSummary(transcript: string): string {
  return clip(transcript, 1500);
}

function parametersForAgentTool(tool: AgentTool): ToolDefinition['parameters'] {
  switch (tool) {
    case 'read_file':
      return { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
    case 'write_file':
      return { type: 'object', properties: { path: { type: 'string' }, content: {} }, required: ['path', 'content'] };
    case 'search_code':
      return { type: 'object', properties: { query: { type: 'string' }, dir: { type: 'string' } }, required: ['query'] };
    case 'run_code':
      return { type: 'object', properties: { expression: { type: 'string' }, code: { type: 'string' }, input: {} } };
    case 'knowledge_search':
      return { type: 'object', properties: { query: { type: 'string' }, topK: { type: 'number' } }, required: ['query'] };
    case 'memory_append':
      return {
        type: 'object',
        properties: {
          section: { type: 'string' },
          entry: { type: 'string' },
          scope: { type: 'string', enum: ['workspace', 'agent'] },
        },
        required: ['section', 'entry'],
      };
    case 'agent_memory_search':
      return { type: 'object', properties: { query: { type: 'string' }, topK: { type: 'number' } }, required: ['query'] };
    case 'workflow_memory_read':
      return { type: 'object', properties: { key: { type: 'string' } } };
    case 'workflow_memory_write':
      return { type: 'object', properties: { key: { type: 'string' }, value: {} }, required: ['key', 'value'] };
    case 'read_url':
      return { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] };
    case 'call_workflow':
      return { type: 'object', properties: { workflowId: { type: 'string' }, inputs: { type: 'object' } }, required: ['workflowId'] };
    case 'web_search':
      return { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] };
    default:
      return { type: 'object', properties: {} };
  }
}
