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
 *   { "thought": string, "action": "final", "output": "<answer>" }
 *
 * The loop executes tool calls through the runtime (which enforces the role's tool
 * manifest + all security boundaries), appends the observation to a running
 * transcript, and re-prompts — a bounded ReAct loop. Determinism cage (Principle
 * #12): hard caps on steps and on the transcript size keep reasoning bounded.
 */

import { ROLE_TOOLS, TOOL_DESCRIPTIONS, type AgentRole, type AgentTool } from '@agentis/core';
import type { AgentToolRuntime } from './agentToolRuntime.js';
import type { Logger } from '../logger.js';

/** Minimal LLM surface — `EvaluatorRuntime` satisfies this. */
export interface StructuredLlm {
  completeStructured<T extends Record<string, unknown>>(args: {
    system: string;
    user: string;
    maxTokens?: number;
    maxAttempts?: number;
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
  /** Role identity + workspace context + skills, prepended to the system prompt. */
  systemPreamble?: string;
  /** Max reasoning/tool steps before forcing a final answer. Default 6, capped at 12. */
  maxSteps?: number;
  /** Scopes the Brain's workflow-memory tools to the workflow this agent runs inside. */
  workflowId?: string;
  /** The concrete agent — scopes the Brain's agent-memory tools. */
  agentId?: string;
}

export interface AgentToolLoopStep {
  thought?: string;
  tool?: AgentTool;
  args?: Record<string, unknown>;
  observation?: unknown;
  error?: string;
}

export interface AgentToolLoopResult {
  output: string;
  steps: AgentToolLoopStep[];
  stoppedReason: 'final' | 'max_steps' | 'no_decision';
  toolCalls: number;
}

interface StepDecision extends Record<string, unknown> {
  thought?: string;
  action?: string;
  tool?: string;
  args?: Record<string, unknown>;
  output?: string;
}

const OBSERVATION_CLIP = 4_000;

export class AgentToolLoop {
  constructor(private readonly deps: AgentToolLoopDeps) {}

  async run(args: AgentToolLoopArgs): Promise<AgentToolLoopResult> {
    const maxSteps = Math.max(1, Math.min(args.maxSteps ?? 6, 12));
    const tools = ROLE_TOOLS[args.role] ?? [];
    const steps: AgentToolLoopStep[] = [];
    const transcript: string[] = [];
    let toolCalls = 0;

    const system = this.#systemPrompt(args.role, tools, args.systemPreamble);

    for (let i = 0; i < maxSteps; i += 1) {
      const remaining = maxSteps - i;
      const user = this.#userPrompt(args.task, transcript, remaining);
      const decision = await this.deps.llm.completeStructured<StepDecision>({ system, user, maxTokens: 900 });

      if (!decision) {
        this.deps.logger?.warn('agent_tool_loop.no_decision', { role: args.role, step: i });
        return { output: lastObservationText(steps) ?? '', steps, stoppedReason: 'no_decision', toolCalls };
      }

      const thought = typeof decision.thought === 'string' ? decision.thought : undefined;

      if (decision.action === 'final' || (decision.action !== 'tool' && typeof decision.output === 'string')) {
        const output = typeof decision.output === 'string' ? decision.output : '';
        steps.push({ thought });
        return { output, steps, stoppedReason: 'final', toolCalls };
      }

      const tool = decision.tool as AgentTool | undefined;
      if (!tool || !tools.includes(tool)) {
        const error = `requested tool '${String(tool)}' is not available to role '${args.role}'`;
        steps.push({ thought, error });
        transcript.push(`STEP ${i + 1}: requested invalid tool '${String(tool)}'. Available: ${tools.join(', ')}.`);
        continue;
      }

      const toolArgs = (decision.args && typeof decision.args === 'object') ? decision.args : {};
      toolCalls += 1;
      const res = await this.deps.runtime.execute(args.workspaceId, tool, toolArgs, args.role, { workflowId: args.workflowId, agentId: args.agentId });
      const observation = res.ok ? res.result : undefined;
      const error = res.ok ? undefined : res.error;
      steps.push({ thought, tool, args: toolArgs, observation, error });
      transcript.push(
        `STEP ${i + 1}: ${tool}(${clip(JSON.stringify(toolArgs), 300)}) -> ${
          res.ok ? clip(stringify(observation), OBSERVATION_CLIP) : `ERROR: ${error}`
        }`,
      );
    }

    // Out of steps — make one final synthesis call so the loop always produces an answer.
    const finalUser = this.#userPrompt(args.task, transcript, 0);
    const final = await this.deps.llm.completeStructured<StepDecision>({
      system: `${system}\n\nYou are OUT OF STEPS. Respond now with action "final" and your best answer.`,
      user: finalUser,
      maxTokens: 900,
    });
    const output = typeof final?.output === 'string' ? final.output : (lastObservationText(steps) ?? '');
    return { output, steps, stoppedReason: 'max_steps', toolCalls };
  }

  #systemPrompt(role: AgentRole, tools: AgentTool[], preamble?: string): string {
    const toolList = tools.length > 0
      ? tools.map((t) => `- ${t}: ${TOOL_DESCRIPTIONS[t]}`).join('\n')
      : '(no tools available — answer from reasoning alone)';
    return [
      preamble?.trim(),
      'You operate as an autonomous agent in a bounded tool-use loop.',
      'AVAILABLE TOOLS:',
      toolList,
      '',
      'On every turn respond with ONE JSON object and nothing else:',
      '  to use a tool:  { "thought": string, "action": "tool", "tool": "<name>", "args": { ... } }',
      '  to finish:      { "thought": string, "action": "final", "output": "<your answer>" }',
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
