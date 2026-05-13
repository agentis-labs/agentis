/**
 * ClaudeCodeAdapter — spawn the Claude Code CLI as a child process.
 *
 * The CLI is invoked once per task with the task's prompt as stdin. We read
 * stdout line-by-line and parse JSONL events conforming to Claude Code's
 * machine-output mode. `maxTurns` caps runaway sessions.
 *
 * If the binary is missing the adapter immediately surfaces
 * task.failed via ADAPTER_UNAVAILABLE — operators get a clean message in
 * the dashboard rather than a hang.
 */

import { spawn } from 'node:child_process';
import type {
  AgentAdapter,
  AdapterHealthStatus,
  NormalizedAgentEvent,
  NormalizedTask,
} from '@agentis/core';
import { CONSTANTS } from '@agentis/core';
import type { Logger } from '../logger.js';

export interface ClaudeCodeAdapterOptions {
  agentId: string;
  /** Path to the `claude` binary. Falls back to `claude` on PATH. */
  binaryPath?: string;
  /** Working directory the CLI is spawned in. */
  cwd?: string;
  model?: string;
  maxTurns?: number;
  allowedTools?: string[];
  extraArgs?: string[];
  env?: Record<string, string>;
  timeoutSec?: number;
  logger: Logger;
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly adapterType = 'claude_code' as const;
  readonly #handlers = new Set<(e: NormalizedAgentEvent) => void>();
  readonly #inFlight = new Map<string, AbortController>();
  #sessionId: string | undefined;

  constructor(private readonly opts: ClaudeCodeAdapterOptions) {}

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {
    for (const a of this.#inFlight.values()) a.abort();
    this.#inFlight.clear();
  }

  async healthCheck(): Promise<AdapterHealthStatus> {
    return { isHealthy: true, checkedAt: new Date().toISOString() };
  }

  onEvent(handler: (e: NormalizedAgentEvent) => void): void {
    this.#handlers.add(handler);
  }

  async dispatchTask(task: NormalizedTask): Promise<void> {
    const ctrl = new AbortController();
    this.#inFlight.set(task.taskId, ctrl);
    const bin = this.opts.binaryPath ?? 'claude';
    const args = [
      '--print',
      '--output-format=stream-json',
      `--max-turns=${this.opts.maxTurns ?? CONSTANTS.AGENT_TASK_MAX_TURNS_DEFAULT ?? 24}`,
      '--dangerously-skip-permissions',
      ...(this.opts.model ? [`--model=${this.opts.model}`] : []),
      ...(this.opts.allowedTools?.length ? [`--allowedTools=${this.opts.allowedTools.join(',')}`] : []),
      ...(this.#sessionId ? ['--resume', this.#sessionId] : []),
      ...(this.opts.extraArgs ?? []),
    ];
    let child: ReturnType<typeof spawn>;
    let terminalEventEmitted = false;
    let timeout: NodeJS.Timeout | undefined;
    try {
      child = spawn(bin, args, {
        cwd: this.opts.cwd,
        env: { ...process.env, ...(this.opts.env ?? {}) },
        signal: ctrl.signal,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.#emitFailure(task, `claude_code_spawn_failed: ${(err as Error).message}`);
      this.#inFlight.delete(task.taskId);
      return;
    }

    if (this.opts.timeoutSec && this.opts.timeoutSec > 0) {
      timeout = setTimeout(() => ctrl.abort(), this.opts.timeoutSec * 1000);
      timeout.unref?.();
    }

    const at = () => new Date().toISOString();
    this.#emit({
      eventType: 'task.started',
      agentId: this.opts.agentId,
      taskId: task.taskId,
      runId: task.runId,
      workflowId: task.workflowId,
      timestamp: at(),
    });

    child.on('error', (err) => {
      if (terminalEventEmitted) return;
      terminalEventEmitted = true;
      this.#emitFailure(task, `claude_code_error: ${err.message}`);
      this.#inFlight.delete(task.taskId);
      if (timeout) clearTimeout(timeout);
    });
    child.stderr?.on('data', (d) =>
      this.opts.logger.warn('claude_code.stderr', { data: String(d).slice(0, 512) }),
    );

    let buffer = '';
    let lastOutput: Record<string, unknown> | undefined;
    let turns = 0;
    child.stdout?.on('data', (chunk) => {
      buffer += String(chunk);
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line) as { type: string; [k: string]: unknown };
          const sessionId = firstString(ev.session_id, ev.sessionId, objectOf(ev.session)?.id);
          if (sessionId) this.#sessionId = sessionId;
          if (ev.type === 'assistant' || ev.type === 'thinking') {
            turns += 1;
            this.#emit({
              eventType: 'agent.thinking',
              agentId: this.opts.agentId,
              runId: task.runId,
              workflowId: task.workflowId,
              taskId: task.taskId,
              text: String(ev.text ?? ev.content ?? ''),
              timestamp: at(),
            });
          } else if (ev.type === 'tool_use') {
            this.#emit({
              eventType: 'agent.tool_call',
              agentId: this.opts.agentId,
              runId: task.runId,
              workflowId: task.workflowId,
              taskId: task.taskId,
              tool: String(ev.name ?? ''),
              input: ev.input ?? {},
              timestamp: at(),
            });
          } else if (ev.type === 'result') {
            lastOutput = (ev.result as Record<string, unknown>) ?? { text: ev.text };
          }
        } catch {
          this.#emit({
            eventType: 'task.progress',
            agentId: this.opts.agentId,
            runId: task.runId,
            workflowId: task.workflowId,
            taskId: task.taskId,
            message: line,
            timestamp: at(),
          });
        }
      }
    });

    child.on('exit', (code) => {
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
          output: lastOutput ?? { text: '' },
          timestamp: at(),
        });
      } else {
        this.#emitFailure(task, `claude_code exited ${code}`);
      }
    });

    // Pipe the prompt to stdin then close.
    child.stdin?.end(task.description);
  }

  async cancelTask(taskId: string): Promise<void> {
    this.#inFlight.get(taskId)?.abort();
    this.#inFlight.delete(taskId);
  }

  #emit(event: NormalizedAgentEvent): void {
    for (const h of this.#handlers) {
      try {
        h(event);
      } catch (err) {
        this.opts.logger.error('claude_code.handler_threw', { err: (err as Error).message });
      }
    }
  }

  #emitFailure(task: NormalizedTask, msg: string): void {
    this.#emit({
      eventType: 'task.failed',
      agentId: this.opts.agentId,
      runId: task.runId,
      workflowId: task.workflowId,
      taskId: task.taskId,
      error: msg,
      timestamp: new Date().toISOString(),
    });
  }
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}
