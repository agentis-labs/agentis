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

import {
  CONSTANTS,
  REALTIME_EVENTS,
  REALTIME_ROOMS,
  roleTools,
  TOOL_DESCRIPTIONS,
  isAgentRole,
  type AgentRole,
  type AgentTool,
  type ChatToolCall,
  type SessionAdapter,
  type ToolDefinition,
} from '@agentis/core';
import type { Logger } from '../logger.js';
import type { EventBus } from '../event-bus.js';
import type { ScratchpadService } from './scratchpad.js';
import type { AgentToolRuntime } from './agentToolRuntime.js';
import {
  AgentSessionService,
  estimateTokens,
  type AgentSession,
  type MemoryBlock,
} from './agentSession.js';

// ──────────────────────────────────────────────────────────────
// Outcomes
// ──────────────────────────────────────────────────────────────

export type SessionYield =
  | { kind: 'delegate'; toolCallId: string; role: AgentRole; task: string; allowedTools?: string[]; allowedPaths?: string[]; maxTokens?: number }
  | { kind: 'await_event'; toolCallId: string; event: string }
  | { kind: 'sleep_until'; toolCallId: string; untilIso: string }
  | { kind: 'request_approval'; toolCallId: string; title: string; summary: string };

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
  runId: string;
  nodeId: string;
  agentId: string;
  workflowId: string;
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
  bus: EventBus;
  logger: Logger;
  agentTools?: AgentToolRuntime;
  /** Cheap-model summarizer for compaction; falls back to truncation when absent. */
  summarize?: SummarizeFn;
}

// Control-tool names — a closed set so we never branch on magic strings.
const TOOL = {
  memoryUpdate: 'memory_update',
  memorySearch: 'memory_search',
  scratchpadWrite: 'scratchpad_write',
  scratchpadRead: 'scratchpad_read',
  broadcast: 'broadcast',
  readChannel: 'read_channel',
  runInspect: 'run_inspect',
  delegateTask: 'delegate_task',
  awaitEvent: 'await_event',
  sleepUntil: 'sleep_until',
  requestApproval: 'request_approval',
  completeTask: 'complete_task',
} as const;

const YIELD_TOOLS = new Set<string>([TOOL.delegateTask, TOOL.awaitEvent, TOOL.sleepUntil, TOOL.requestApproval]);

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
    const tools = this.#toolCatalog(runCtx.role);
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
        this.deps.sessions.complete(sessionId, output);
        return { kind: 'completed', output };
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
        this.deps.sessions.appendMessages(
          sessionId,
          [{ role: 'tool', toolCallId: call.id, content: 'task completed' }],
          stepNumber,
        );
        this.deps.sessions.complete(sessionId, output);
        return { kind: 'done', outcome: { kind: 'completed', output } };
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
        const role = String(args.role ?? '');
        const task = String(args.task ?? '');
        if (!isAgentRole(role) || !task) return null;
        const strList = (v: unknown): string[] | undefined =>
          Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : undefined;
        const allowedTools = strList(args.allowed_tools);
        const allowedPaths = strList(args.allowed_paths);
        const maxTokens = typeof args.max_tokens === 'number' && args.max_tokens > 0 ? args.max_tokens : undefined;
        return {
          kind: 'delegate', toolCallId: call.id, role, task,
          ...(allowedTools && allowedTools.length > 0 ? { allowedTools } : {}),
          ...(allowedPaths && allowedPaths.length > 0 ? { allowedPaths } : {}),
          ...(maxTokens !== undefined ? { maxTokens } : {}),
        };
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
        this.deps.scratchpad.write(runCtx.runId, String(args.key ?? ''), args.value ?? null);
        return { ok: true };
      }
      case TOOL.scratchpadRead: {
        const key = args.key != null ? String(args.key) : undefined;
        return { ok: true, value: key ? this.deps.scratchpad.read(runCtx.runId, key) : this.deps.scratchpad.snapshotOf(runCtx.runId) };
      }
      case TOOL.broadcast: {
        this.deps.scratchpad.broadcast(runCtx.runId, String(args.channel ?? 'general'), runCtx.agentId, String(args.message ?? ''));
        return { ok: true };
      }
      case TOOL.readChannel: {
        return { ok: true, messages: this.deps.scratchpad.readChannel(runCtx.runId, String(args.channel ?? 'general')) };
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
      default:
        return this.#execRoleTool(name, args, runCtx);
    }
  }

  async #execRoleTool(name: string, args: Record<string, unknown>, runCtx: SessionRunContext): Promise<unknown> {
    if (!this.deps.agentTools || !runCtx.role) return { ok: false, error: `unknown tool '${name}'` };
    const granted = roleTools(runCtx.role);
    if (!granted.includes(name as AgentTool)) return { ok: false, error: `tool '${name}' not granted to role '${runCtx.role}'` };
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

  #toolCatalog(role?: AgentRole): ToolDefinition[] {
    const tools: ToolDefinition[] = [...CONTROL_TOOLS];
    if (role) {
      for (const t of roleTools(role)) {
        tools.push({
          name: t,
          description: TOOL_DESCRIPTIONS[t],
          parameters: parametersForAgentTool(t),
        });
      }
    }
    return tools;
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
    name: TOOL.runInspect,
    description: 'Inspect your own session stats (steps, token spend, delegation depth).',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: TOOL.delegateTask,
    description: 'Hand a subtask to a specialist and WAIT for its result. Use for work outside your expertise.',
    parameters: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'Specialist role (planner, researcher, coder, reviewer, analyst, writer, monitor, architect, debugger, deployer).' },
        task: { type: 'string', description: 'A self-contained description of the subtask.' },
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
    description: 'Finish the task and return your final output. Call this exactly once when done.',
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

function suspendReasonFor(y: SessionYield): 'delegate' | 'await_event' | 'sleep_until' | 'checkpoint' {
  switch (y.kind) {
    case 'delegate':
      return 'delegate';
    case 'await_event':
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
      return `delegate:${y.toolCallId}`;
    case 'await_event':
      return `event:${y.event}`;
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
