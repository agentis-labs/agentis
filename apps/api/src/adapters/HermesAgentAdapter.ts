import { spawn } from 'node:child_process';
import type {
  AgentAdapter,
  AdapterHealthStatus,
  NormalizedAgentEvent,
  NormalizedTask,
} from '@agentis/core';
import { CONSTANTS } from '@agentis/core';
import type { Logger } from '../logger.js';
import { resolveSpawnTarget, withExpandedPath } from '../services/pathExpander.js';

export interface HermesAgentAdapterOptions {
  agentId: string;
  binaryPath?: string;
  cwd?: string;
  model?: string;
  maxTurns?: number;
  extraArgs?: string[];
  env?: Record<string, string>;
  timeoutSec?: number;
  graceSec?: number;
  logger: Logger;
}

export class HermesAgentAdapter implements AgentAdapter {
  readonly adapterType = 'hermes_agent' as const;
  readonly #handlers = new Set<(event: NormalizedAgentEvent) => void>();
  readonly #inFlight = new Map<string, AbortController>();
  #sessionId: string | undefined;

  constructor(private readonly opts: HermesAgentAdapterOptions) {}

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {
    for (const controller of this.#inFlight.values()) controller.abort();
    this.#inFlight.clear();
  }

  async healthCheck(): Promise<AdapterHealthStatus> {
    return { isHealthy: true, checkedAt: new Date().toISOString() };
  }

  onEvent(handler: (event: NormalizedAgentEvent) => void): void {
    this.#handlers.add(handler);
  }

  async dispatchTask(task: NormalizedTask): Promise<void> {
    const controller = new AbortController();
    this.#inFlight.set(task.taskId, controller);
    const binary = this.opts.binaryPath || 'hermes';
    const args = [
      ...(this.opts.model ? [`--model=${this.opts.model}`] : []),
      `--max-turns=${this.opts.maxTurns ?? CONSTANTS.AGENT_TASK_MAX_TURNS_DEFAULT ?? 24}`,
      ...(this.#sessionId ? ['--session', this.#sessionId] : []),
      ...(this.opts.extraArgs ?? []),
    ];
    let childProcess: ReturnType<typeof spawn>;
    let terminalEventEmitted = false;
    let timeout: NodeJS.Timeout | undefined;
    try {
      const env = withExpandedPath({ ...process.env, ...(this.opts.env ?? {}) });
      const target = resolveSpawnTarget(binary, args, this.opts.cwd ?? process.cwd(), env);
      childProcess = spawn(target.command, target.args, {
        cwd: this.opts.cwd,
        env,
        windowsHide: true,
        signal: controller.signal,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.#emitFailure(task, `hermes_agent_spawn_failed: ${(err as Error).message}`);
      this.#inFlight.delete(task.taskId);
      return;
    }

    if (this.opts.timeoutSec && this.opts.timeoutSec > 0) {
      timeout = setTimeout(() => controller.abort(), this.opts.timeoutSec * 1000);
      timeout.unref?.();
    }

    const timestamp = () => new Date().toISOString();
    this.#emit({
      eventType: 'task.started',
      agentId: this.opts.agentId,
      taskId: task.taskId,
      runId: task.runId,
      workflowId: task.workflowId,
      timestamp: timestamp(),
    });

    childProcess.on('error', (err) => {
      if (terminalEventEmitted) return;
      terminalEventEmitted = true;
      this.#emitFailure(task, `hermes_agent_error: ${err.message}`);
      this.#inFlight.delete(task.taskId);
      if (timeout) clearTimeout(timeout);
    });
    childProcess.stderr?.on('data', (data) =>
      this.opts.logger.warn('hermes_agent.stderr', { data: String(data).slice(0, 512) }),
    );

    let buffer = '';
    let transcript = '';
    let lastOutput: Record<string, unknown> | undefined;
    childProcess.stdout?.on('data', (chunk) => {
      buffer += String(chunk);
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;
        const parsed = parseJson(line);
        if (!parsed) {
          transcript += line + '\n';
          this.#emitProgress(task, line, timestamp());
          continue;
        }
        const sessionId = firstString(parsed.session_id, parsed.sessionId, objectOf(parsed.session)?.id);
        if (sessionId) this.#sessionId = sessionId;
        const text = extractText(parsed);
        if (text) {
          transcript += text;
          this.#emitProgress(task, text, timestamp());
        }
        const toolCall = extractToolCall(parsed);
        if (toolCall) {
          this.#emit({
            eventType: 'agent.tool_call',
            agentId: this.opts.agentId,
            runId: task.runId,
            workflowId: task.workflowId,
            taskId: task.taskId,
            tool: toolCall.tool,
            input: toolCall.input,
            timestamp: timestamp(),
          });
        }
        if (isCompletionEvent(parsed)) lastOutput = extractOutput(parsed, transcript);
      }
    });

    childProcess.on('exit', (code) => {
      this.#inFlight.delete(task.taskId);
      if (timeout) clearTimeout(timeout);
      if (terminalEventEmitted) return;
      terminalEventEmitted = true;
      if (code === 0) {
        this.#emit({
          eventType: 'task.completed',
          agentId: this.opts.agentId,
          runId: task.runId,
          workflowId: task.workflowId,
          taskId: task.taskId,
          output: lastOutput ?? { text: transcript.trim() },
          timestamp: timestamp(),
        });
      } else {
        this.#emitFailure(task, `hermes_agent exited ${code}`);
      }
    });

    childProcess.stdin?.end(buildPrompt(task));
  }

  async cancelTask(taskId: string): Promise<void> {
    this.#inFlight.get(taskId)?.abort();
    this.#inFlight.delete(taskId);
  }

  #emitProgress(task: NormalizedTask, message: string, timestamp: string): void {
    this.#emit({
      eventType: 'task.progress',
      agentId: this.opts.agentId,
      runId: task.runId,
      workflowId: task.workflowId,
      taskId: task.taskId,
      message,
      timestamp,
    });
  }

  #emit(event: NormalizedAgentEvent): void {
    for (const handler of this.#handlers) {
      try {
        handler(event);
      } catch (err) {
        this.opts.logger.error('hermes_agent.handler_threw', { err: (err as Error).message });
      }
    }
  }

  #emitFailure(task: NormalizedTask, message: string): void {
    this.#emit({
      eventType: 'task.failed',
      agentId: this.opts.agentId,
      runId: task.runId,
      workflowId: task.workflowId,
      taskId: task.taskId,
      error: message,
      timestamp: new Date().toISOString(),
    });
  }
}

type HermesJsonEvent = {
  type?: unknown;
  text?: unknown;
  content?: unknown;
  message?: unknown;
  delta?: unknown;
  item?: unknown;
  result?: unknown;
  output?: unknown;
  name?: unknown;
  tool?: unknown;
  input?: unknown;
  arguments?: unknown;
  session?: unknown;
  session_id?: unknown;
  sessionId?: unknown;
};

function buildPrompt(task: NormalizedTask): string {
  return [
    `Task: ${task.title}`,
    '',
    task.description,
    '',
    'Input data:',
    safeJson(task.inputData),
    '',
    'Scratchpad snapshot:',
    safeJson(task.scratchpadSnapshot),
  ].join('\n');
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[unserializable]';
  }
}

function parseJson(line: string): HermesJsonEvent | null {
  try {
    return JSON.parse(line) as HermesJsonEvent;
  } catch {
    return null;
  }
}

function extractText(event: HermesJsonEvent): string {
  const direct = firstString(event.text, event.content, event.delta);
  if (direct) return direct;
  const message = objectOf(event.message);
  const messageText = firstString(message?.text, message?.content);
  if (messageText) return messageText;
  const item = objectOf(event.item);
  return firstString(item?.text, item?.content) ?? '';
}

function extractToolCall(event: HermesJsonEvent): { tool: string; input: unknown } | null {
  const type = String(event.type ?? '').toLowerCase();
  if (!type.includes('tool') && !type.includes('function')) return null;
  const item = objectOf(event.item);
  const tool = firstString(event.name, event.tool, item?.name, item?.tool) ?? 'tool';
  return { tool, input: event.input ?? event.arguments ?? item?.input ?? item?.arguments ?? {} };
}

function isCompletionEvent(event: HermesJsonEvent): boolean {
  const type = String(event.type ?? '').toLowerCase();
  return type === 'result' || type === 'done' || type.includes('completed') || type.includes('finished');
}

function extractOutput(event: HermesJsonEvent, transcript: string): Record<string, unknown> {
  const result = objectOf(event.result) ?? objectOf(event.output);
  if (result) return result;
  const text = firstString(event.text, event.content) ?? transcript.trim();
  return { text };
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
    if (Array.isArray(value)) {
      const joined = value.map((item) => {
        if (typeof item === 'string') return item;
        const object = objectOf(item);
        return firstString(object?.text, object?.content) ?? '';
      }).join('');
      if (joined) return joined;
    }
  }
  return undefined;
}
