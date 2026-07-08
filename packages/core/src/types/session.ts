/**
 * Agent session step contract — SMARTER-AGENTS-10X §VI/§VII.
 *
 * An AgentSession runs as a loop owned by the WorkflowEngine: WAKE → THINK →
 * PARSE → EXECUTE → INJECT → SAVE → DECIDE. The single point where the engine
 * needs an LLM is THINK — one inference per step. A `SessionAdapter` exposes
 * exactly that: `executeStep(input)` runs one inference and returns the model's
 * text plus any tool calls. The adapter is stateless; all durable state lives in
 * the session row, so the engine can suspend between steps for free.
 *
 * This is deliberately narrower than the interactive `AgentAdapter.chat()`
 * streaming contract: the engine accumulates deltas itself and persists a single
 * normalized result, which keeps suspend/resume trivial.
 */

import type { ChatMessage, ChatToolCall, ToolDefinition } from './chat.js';

export interface SessionTokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export type StepFinishReason = 'stop' | 'tool_calls' | 'length' | 'error';

export interface SessionStepInput {
  /** Fully reconstructed context window (system + episodic messages). */
  messages: ChatMessage[];
  /** Tools the agent may call this step. Empty means "respond only". */
  tools: ToolDefinition[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Abort the inference if it outruns this budget. */
  timeoutMs?: number;
}

export interface SessionStepResult {
  /** Assistant free-text for this step (may be empty when only tools are called). */
  text: string;
  /** Tool invocations the model requested, in order. */
  toolCalls: ChatToolCall[];
  finishReason: StepFinishReason;
  usage?: SessionTokenUsage;
}

/**
 * A runtime capable of advancing an agent session by one cognitive step.
 * Implementations wrap an LLM endpoint; they hold no per-session state.
 */
export interface SessionAdapter {
  readonly id: string;
  executeStep(input: SessionStepInput): Promise<SessionStepResult>;
}



