/**
 * AgentToolLoop — the agentic tool-use execution loop (WORKFLOW-10X-MASTERPLAN §2.2,
 * "the biggest remaining frontier"). Drives the role-scoped `AgentToolRuntime`.
 *
 * Rather than depend on a provider-specific function-calling API, the loop uses
 * the same OpenAI-compatible JSON-mode endpoint the rest of the platform speaks
 * (`EvaluatorRuntime.completeStructured`). Each step the model returns one JSON
 * decision — call a tool, or finish:
 *
 *   { "thought": string, "action": "tool", "tool": "<name>", "args": { ... } }
 *   { "thought": string, "action": "final", "output": <answer object or string> }
 *
 * The loop executes tool calls through the runtime (which enforces the role's tool
 * manifest + all security boundaries), appends the observation to a running
 * transcript, and re-prompts — a bounded ReAct loop. Determinism cage (Principle
 * #12): hard caps on steps and on the transcript size keep reasoning bounded.
 */

import { effectiveSpecialistTools, TOOL_DESCRIPTIONS, type AgentRole, type AgentTool } from '@agentis/core';
import type { AgentToolRuntime } from './agentToolRuntime.js';
import type { Logger } from '../logger.js';

/** Minimal LLM surface — `EvaluatorRuntime` satisfies this. */
export interface StructuredLlm {
  readonly lastError?: string | null;
  /** Token usage of the last completion (exact when metered, estimated otherwise). */
  readonly lastUsage?: { tokensIn: number; tokensOut: number } | null;
  completeStructured<T extends Record<string, unknown>>(args: {
    system: string;
    user: string;
    maxTokens?: number;
    maxAttempts?: number;
    signal?: AbortSignal;
  }): Promise<T | null>;
}

export interface AgentToolLoopDeps {
  runtime: AgentToolRuntime;
  llm: StructuredLlm;
  logger?: Logger;
}

export interface AgentToolLoopArgs {
  workspaceId: string;
  role: AgentRole;
  task: string;
  /** Role identity + workspace context + extensions, prepended to the system prompt. */
  systemPreamble?: string;
  /** Max reasoning/tool steps before forcing a final answer. Default 6, capped at 12. */
  maxSteps?: number;
  /** Scopes the Brain's workflow-memory tools to the workflow this agent runs inside. */
  workflowId?: string;
  /** The concrete agent — scopes the Brain's agent-memory tools. */
  agentId?: string;
  /** The run's operator — actor context for `agentis.*` platform tools (E2). */
  userId?: string;
  /**
   * Explicit tool manifest to grant the agent. Defaults to the role's static
   * tools; pass the specialist's effective toolbox (incl. the universal default
   * set for custom roles) to make any specialist tool-capable.
   */
  tools?: AgentTool[];
  /**
   * Dynamic, non-enum tools offered alongside the static manifest — bridged MCP
   * tools (computer-use, browser, operator-mounted servers). Their ids are
   * namespaced (`mcp__*`); the loop routes them to `runtime.executeBridged`.
   */
  extraTools?: DynamicToolSpec[];
  /**
   * Native affordances the bound runtime advertises (browser/terminal/computer-
   * use). Surfaced in the system prompt so the agent knows its real powers
   * (harness passthrough). Display-only — does not itself grant tools.
   */
  runtimeAffordances?: string[];
  /** Per-step observer — streams the agent's live reasoning/tool-use to the run. */
  onStep?: (step: AgentToolLoopStep & { index: number; phase: 'thinking' | 'tool_call' | 'tool_result' | 'final' }) => void;
  /** Run-scoped cancellation signal; stops billable model calls when the run is stopped. */
  signal?: AbortSignal;
}

/** A dynamic tool offered to the loop beyond the static `AgentTool` enum. */
export interface DynamicToolSpec {
  /** Namespaced id the model calls (e.g. `mcp__computer_use__screenshot`). */
  id: string;
  description: string;
}

export interface AgentToolLoopStep {
  thought?: string;
  tool?: AgentTool | string;
  args?: Record<string, unknown>;
  observation?: unknown;
  error?: string;
}

export interface AgentToolLoopResult {
  output: unknown;
  steps: AgentToolLoopStep[];
  stoppedReason: 'final' | 'max_steps' | 'no_decision' | 'cancelled';
  toolCalls: number;
  /** Total model token consumption across every step of the loop. */
  tokensIn: number;
  tokensOut: number;
  error?: string;
}

interface StepDecision extends Record<string, unknown> {
  thought?: string;
  action?: string;
  tool?: string;
  args?: Record<string, unknown>;
  output?: unknown;
}

const OBSERVATION_CLIP = 4_000;

export class AgentToolLoop {
  constructor(private readonly deps: AgentToolLoopDeps) {}

  async run(args: AgentToolLoopArgs): Promise<AgentToolLoopResult> {
    const maxSteps = Math.max(1, Math.min(args.maxSteps ?? 6, 12));
    // §specialist-removal — built-in role manifests are gone; a specialist with
    // no explicit toolbox gets the universal floor, never an empty set.
    const tools = args.tools && args.tools.length > 0 ? args.tools : effectiveSpecialistTools({ role: args.role });
    const extraTools = args.extraTools ?? [];
    const extraIds = new Set(extraTools.map((t) => t.id));
    const steps: AgentToolLoopStep[] = [];
    const transcript: string[] = [];
    let toolCalls = 0;
    // Accumulate token consumption across every model call so the engine can
    // attribute the node's real (or estimated) spend. Captured after each call.
    const usage = { tokensIn: 0, tokensOut: 0 };
    const captureUsage = () => {
      const u = this.deps.llm.lastUsage;
      if (u) { usage.tokensIn += u.tokensIn; usage.tokensOut += u.tokensOut; }
    };

    const system = this.#systemPrompt(args.role, tools, extraTools, args.runtimeAffordances ?? [], args.systemPreamble);

    for (let i = 0; i < maxSteps; i += 1) {
      if (args.signal?.aborted) {
        return { output: '', steps, stoppedReason: 'cancelled', toolCalls, ...usage, error: 'Run cancelled' };
      }
      const remaining = maxSteps - i;
      const user = this.#userPrompt(args.task, transcript, remaining);
      const decision = await this.deps.llm.completeStructured<StepDecision>({
        system,
        user,
        maxTokens: 900,
        ...(args.signal ? { signal: args.signal } : {}),
      });
      captureUsage();

      if (!decision) {
        const error = this.deps.llm.lastError ?? 'model returned no structured decision';
        this.deps.logger?.warn('agent_tool_loop.no_decision', { role: args.role, step: i, error });
        return { output: lastObservationText(steps) ?? '', steps, stoppedReason: 'no_decision', toolCalls, ...usage, error };
      }

      const thought = typeof decision.thought === 'string' ? decision.thought : undefined;
      if (thought) args.onStep?.({ index: i, phase: 'thinking', thought });

      if (decision.action === 'final' || (decision.action !== 'tool' && Object.prototype.hasOwnProperty.call(decision, 'output'))) {
        const output = Object.prototype.hasOwnProperty.call(decision, 'output') ? decision.output : '';
        steps.push({ thought });
        args.onStep?.({ index: i, phase: 'final', thought, observation: output });
        return { output, steps, stoppedReason: 'final', toolCalls, ...usage };
      }

      const tool = typeof decision.tool === 'string' ? decision.tool : undefined;
      const isStatic = Boolean(tool && tools.includes(tool as AgentTool));
      const isBridged = Boolean(tool && extraIds.has(tool));
      if (!tool || (!isStatic && !isBridged)) {
        const available = [...tools, ...extraTools.map((t) => t.id)].join(', ');
        const error = `requested tool '${String(tool)}' is not available to role '${args.role}'`;
        steps.push({ thought, error });
        transcript.push(`STEP ${i + 1}: requested invalid tool '${String(tool)}'. Available: ${available}.`);
        continue;
      }

      const toolArgs = (decision.args && typeof decision.args === 'object') ? decision.args : {};
      toolCalls += 1;
      args.onStep?.({ index: i, phase: 'tool_call', thought, tool, args: toolArgs });
      const res = isBridged
        ? await this.deps.runtime.executeBridged(args.workspaceId, tool, toolArgs, {
            userId: args.userId,
            agentId: args.agentId,
            workflowId: args.workflowId,
          })
        : await this.deps.runtime.execute(args.workspaceId, tool as AgentTool, toolArgs, args.role, {
            workflowId: args.workflowId,
            agentId: args.agentId,
            grantedTools: tools,
          });
      const observation = res.ok ? res.result : undefined;
      const error = res.ok ? undefined : res.error;
      steps.push({ thought, tool, args: toolArgs, observation, error });
      args.onStep?.({ index: i, phase: 'tool_result', tool, args: toolArgs, observation, error });
      transcript.push(
        `STEP ${i + 1}: ${tool}(${clip(JSON.stringify(toolArgs), 300)}) -> ${
          res.ok ? clip(stringify(observation), OBSERVATION_CLIP) : `ERROR: ${error}`
        }`,
      );
    }

    // Out of steps — make one final synthesis call so the loop always produces an answer.
    if (args.signal?.aborted) {
      return { output: '', steps, stoppedReason: 'cancelled', toolCalls, ...usage, error: 'Run cancelled' };
    }
    const finalUser = this.#userPrompt(args.task, transcript, 0);
    const final = await this.deps.llm.completeStructured<StepDecision>({
      system: `${system}\n\nYou are OUT OF STEPS. Respond now with action "final" and your best answer.`,
      user: finalUser,
      maxTokens: 900,
      ...(args.signal ? { signal: args.signal } : {}),
    });
    captureUsage();
    const output = final && Object.prototype.hasOwnProperty.call(final, 'output')
      ? final.output
      : (lastObservationText(steps) ?? '');
    return {
      output,
      steps,
      stoppedReason: 'max_steps',
      toolCalls,
      ...usage,
      ...(isPresentOutput(output) ? {} : { error: this.deps.llm.lastError ?? 'agent exhausted the tool loop without output' }),
    };
  }

  #systemPrompt(role: AgentRole, tools: AgentTool[], extraTools: DynamicToolSpec[], affordances: string[], preamble?: string): string {
    const staticList = tools.map((t) => `- ${t}: ${TOOL_DESCRIPTIONS[t]}`);
    const bridgedList = extraTools.map((t) => `- ${t.id}: ${t.description}`);
    const allLines = [...staticList, ...bridgedList];
    const toolList = allLines.length > 0
      ? allLines.join('\n')
      : '(no tools available — answer from reasoning alone)';
    const affordanceLine = affordances.length > 0
      ? `Your bound runtime natively supports: ${affordances.join(', ')}. Prefer the matching tools above (e.g. computer-use / browser tools) to act directly instead of describing what you would do.`
      : undefined;
    return [
      preamble?.trim(),
      'You operate as an autonomous agent in a bounded tool-use loop.',
      affordanceLine,
      'AVAILABLE TOOLS:',
      toolList,
      '',
      'On every turn respond with ONE JSON object and nothing else:',
      '  to use a tool:  { "thought": string, "action": "tool", "tool": "<name>", "args": { ... } }',
      '  to finish:      { "thought": string, "action": "final", "output": <your final object or string> }',
      'Call a tool only when it materially advances the task. Finish as soon as you can answer.',
    ].filter(Boolean).join('\n');
  }

  #userPrompt(task: string, transcript: string[], remainingSteps: number): string {
    const history = transcript.length > 0 ? `\n\nWORK SO FAR:\n${transcript.join('\n')}` : '';
    const budget = remainingSteps > 0 ? `\n\nSteps remaining: ${remainingSteps}.` : '';
    return `TASK:\n${task}${history}${budget}`;
  }
}

function lastObservationText(steps: AgentToolLoopStep[]): string | null {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const obs = steps[i]?.observation;
    if (obs != null) return stringify(obs);
  }
  return null;
}

function isPresentOutput(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
