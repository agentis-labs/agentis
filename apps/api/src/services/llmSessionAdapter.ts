/**
 * LlmSessionAdapter — one cognitive step against an OpenAI-compatible endpoint.
 *
 * SMARTER-AGENTS-10X §VII. Implements the `SessionAdapter` contract: given a
 * reconstructed context window and a tool catalog, it runs a single
 * `/chat/completions` call with native function-calling and normalizes the
 * response into a `SessionStepResult` (assistant text + requested tool calls).
 *
 * The adapter is stateless. The WorkflowEngine owns the loop, persistence, and
 * suspend/wake — this class only knows how to think once.
 */

import { AgentisError } from '@agentis/core';
import type {
  ChatMessage,
  ChatToolCall,
  SessionAdapter,
  SessionStepInput,
  SessionStepResult,
  StepFinishReason,
  ToolDefinition,
} from '@agentis/core';
import type { Logger } from '../logger.js';

export interface LlmSessionAdapterOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
  /** Default per-step timeout (default 120s — agent steps can be long). */
  timeoutMs?: number;
  /** Default sampling temperature for agentic reasoning. */
  temperature?: number;
}

interface OpenAiToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiChoice {
  message?: { content?: string | null; tool_calls?: OpenAiToolCall[] };
  finish_reason?: string;
}

interface OpenAiResponse {
  choices?: OpenAiChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class LlmSessionAdapter implements SessionAdapter {
  readonly id: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #temperature: number;

  constructor(private readonly opts: LlmSessionAdapterOptions) {
    this.id = `llm:${opts.model}`;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#timeoutMs = opts.timeoutMs ?? 120_000;
    this.#temperature = opts.temperature ?? 0.4;
  }

  async executeStep(input: SessionStepInput): Promise<SessionStepResult> {
    const url = this.opts.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.opts.apiKey) headers['authorization'] = `Bearer ${this.opts.apiKey}`;

    const body: Record<string, unknown> = {
      model: input.model ?? this.opts.model,
      temperature: input.temperature ?? this.#temperature,
      max_tokens: input.maxTokens ?? 2048,
      messages: input.messages.map(toOpenAiMessage),
    };
    if (input.tools.length > 0) {
      body.tools = input.tools.map(toOpenAiTool);
      body.tool_choice = 'auto';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? this.#timeoutMs);
    try {
      const res = await this.#fetch(url, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new AgentisError(
          'INTEGRATION_OPERATION_FAILED',
          `session backend returned ${res.status}: ${text.slice(0, 300)}`,
        );
      }
      const parsed = (await res.json()) as OpenAiResponse;
      return normalizeResponse(parsed);
    } catch (err) {
      if (err instanceof AgentisError) throw err;
      const message = (err as Error)?.name === 'AbortError' ? 'session step timed out' : (err as Error).message;
      throw new AgentisError('INTEGRATION_OPERATION_FAILED', `session step failed: ${message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

function toOpenAiMessage(m: ChatMessage): Record<string, unknown> {
  const content = typeof m.content === 'string' ? m.content : flattenBlocks(m.content);
  const out: Record<string, unknown> = { role: m.role, content };
  if (m.role === 'tool' && m.toolCallId) out.tool_call_id = m.toolCallId;
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    out.tool_calls = m.toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: {
        name: tc.name,
        arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
      },
    }));
    // OpenAI requires content to be a string (possibly empty) on tool-call turns.
    if (typeof out.content !== 'string') out.content = '';
  }
  return out;
}

function flattenBlocks(blocks: Exclude<ChatMessage['content'], string>): string {
  return blocks
    .map((b) => b.text ?? b.content ?? '')
    .filter(Boolean)
    .join('\n');
}

function toOpenAiTool(t: ToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  };
}

function normalizeResponse(res: OpenAiResponse): SessionStepResult {
  const choice = res.choices?.[0];
  const message = choice?.message;
  const text = typeof message?.content === 'string' ? message.content : '';
  const toolCalls: ChatToolCall[] = (message?.tool_calls ?? [])
    .filter((tc) => typeof tc.function?.name === 'string')
    .map((tc, idx) => ({
      id: tc.id ?? `call_${idx}`,
      name: tc.function!.name as string,
      arguments: parseArguments(tc.function?.arguments),
    }));

  return {
    text,
    toolCalls,
    finishReason: mapFinishReason(choice?.finish_reason, toolCalls.length > 0),
    usage: res.usage
      ? {
          promptTokens: res.usage.prompt_tokens ?? 0,
          completionTokens: res.usage.completion_tokens ?? 0,
        }
      : undefined,
  };
}

function parseArguments(raw: string | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

function mapFinishReason(reason: string | undefined, hasToolCalls: boolean): StepFinishReason {
  if (hasToolCalls || reason === 'tool_calls') return 'tool_calls';
  if (reason === 'length') return 'length';
  if (reason === 'stop' || reason === undefined) return 'stop';
  return 'stop';
}
