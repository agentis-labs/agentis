/**
 * cliChatRuntime — the shared interactive-chat engine for CLI harness adapters
 * (Codex, Claude Code, Cursor, Hermes agent).
 *
 * Every CLI adapter drives a child process in `--json` / `stream-json` mode and
 * has to solve the SAME hard problems for an interactive turn:
 *   - spawn the binary with an abortable signal and piped stdio,
 *   - read NDJSON from stdout, line by line, and route each event to the right
 *     channel (answer text, live thinking, live activity, tool calls),
 *   - keep an IDLE-based watchdog (reset on every chunk) plus an absolute ceiling
 *     so an actively-streaming turn is never killed but a stuck one still ends,
 *   - on a stall, surface whatever was produced as a *paused* answer instead of
 *     discarding the work as a hard failure,
 *   - extract Agentis tool-call markers from the final text, and
 *   - end the turn with exactly one terminal `done` delta.
 *
 * This module owns all of that. Each adapter supplies only what is genuinely
 * adapter-specific via {@link CliChatRuntimeConfig}: the binary + args, the
 * stdin prompt, an {@link CliChatInterpreter} that classifies one parsed event,
 * and optional hooks for exit-error decoding and empty-result diagnostics.
 *
 * Before this existed, the spawn/queue/watchdog/flush/marker scaffolding was
 * copy-pasted into three adapters; Hermes had none and so could not chat at all.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ChatDelta } from '@agentis/core';
import type { Logger } from '../logger.js';
import { resolveSpawnTarget, withExpandedPath } from '../services/pathExpander.js';
import { extractMarkerToolCalls, isProcessNoiseLine, stripProcessNoise } from './markerToolProtocol.js';
import { linkAbortSignal } from './abort.js';

/** Default safety cap for one chat turn when no explicit timeout is configured. */
export const DEFAULT_CHAT_TURN_TIMEOUT_MS = 180_000;

/** Absolute ceiling for one chat turn, independent of the idle budget. */
const DEFAULT_CHAT_HARD_CEILING_MS = 600_000;

/**
 * Clamp an operator-supplied idle budget into a sane range: at least 1s, at most
 * the default turn cap. Shared so every CLI adapter treats `timeoutMs` the same.
 */
export function clampChatTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs)) return DEFAULT_CHAT_TURN_TIMEOUT_MS;
  return Math.max(1_000, Math.min(Math.floor(timeoutMs), DEFAULT_CHAT_TURN_TIMEOUT_MS));
}

/**
 * Absolute hard ceiling for one chat turn. The idle timer protects against a
 * genuinely-stuck process; this protects against one that keeps emitting noise
 * forever without finishing. Generous on purpose (real exploration runs
 * minutes); overridable per-adapter via `envVar`, never below the idle budget.
 */
export function chatHardCeilingMs(idleTimeoutMs: number, envVar?: string): number {
  const fromEnv = envVar ? Number(process.env[envVar]) : NaN;
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.max(fromEnv, idleTimeoutMs);
  return Math.max(DEFAULT_CHAT_HARD_CEILING_MS, idleTimeoutMs);
}

/** One interpreted contribution from a parsed CLI stdout event. */
export type CliChatPart =
  /** Answer text — accumulated into the transcript, marker tool-calls stripped at exit. */
  | { kind: 'text'; text: string }
  /** A fallback final answer, used only when no streamed `text` arrived. */
  | { kind: 'final'; text: string }
  /** Reasoning — streamed live into the ThinkingBubble, kept out of the answer. */
  | { kind: 'thinking'; text: string }
  /** The harness's OWN tool/shell action — surfaced live, never re-executed. */
  | { kind: 'activity'; delta: Extract<ChatDelta, { type: 'activity' }> }
  /** A native tool call the harness asked Agentis to execute. */
  | { kind: 'tool'; name: string; args: unknown }
  /** A runtime error decoded from the event stream (used for exit diagnostics). */
  | { kind: 'error'; message: string }
  /** Nothing operator-relevant (deltas, heartbeats, lifecycle events). */
  | { kind: 'ignore' };

/**
 * Classify one parsed stdout JSON event into zero or more {@link CliChatPart}s.
 * Implemented per-adapter (it knows its CLI's wire schema). May also capture
 * side state through its closure, e.g. the session id for `--resume`.
 */
export type CliChatInterpreter = (event: unknown) => CliChatPart | CliChatPart[];

export interface CliChatRuntimeConfig {
  /** Resolved binary (or command on PATH). */
  binary: string;
  /** Fully-built CLI arguments for this turn. */
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Prompt piped to the child's stdin; stdin is closed immediately after. */
  stdin: string;
  /** Operator-facing runtime name for messages, e.g. "Codex", "Hermes". */
  displayName: string;
  /** Log namespace, e.g. "codex.chat". */
  logTag: string;
  logger: Logger;
  /** The caller's turn-cancellation signal. */
  signal?: AbortSignal;
  /** Max gap between events before the turn is treated as idle/stalled. */
  idleTimeoutMs: number;
  /** Absolute ceiling regardless of streaming activity. */
  hardCeilingMs: number;
  /** Classify one parsed stdout event. */
  interpret: CliChatInterpreter;
  /**
   * Decode a runtime-specific detail for a non-zero exit (e.g. map a known CLI
   * error to a friendly cause). Returns the detail string, or undefined for none.
   * Receives the captured stderr tail and any error text the interpreter surfaced.
   */
  formatExitError?: (code: number | null, stderr: string, stdoutError: string) => string | undefined;
  /** Invoked on a clean exit that yielded no usable text or tool calls (diagnostics). */
  onEmptyResult?: () => void;
}

/**
 * Run one interactive chat turn against a CLI harness, yielding {@link ChatDelta}s.
 * Always terminates with exactly one `done` delta (stop / tool_calls / max_turns /
 * error), so the caller's turn loop never hangs.
 */
export async function* runCliChatTurn(cfg: CliChatRuntimeConfig): AsyncIterable<ChatDelta> {
  const controller = new AbortController();
  const unlinkAbort = linkAbortSignal(cfg.signal, controller);
  const queue = createChatQueue();
  let child: ReturnType<typeof spawn>;
  try {
    const env = withExpandedPath({ ...process.env, ...(cfg.env ?? {}) });
    const target = resolveSpawnTarget(cfg.binary, cfg.args, cfg.cwd ?? process.cwd(), env);
    child = spawn(target.command, target.args, {
      cwd: cfg.cwd,
      env,
      windowsHide: true,
      signal: controller.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    const message = `${cfg.displayName} adapter failed to start: ${(err as Error).message}`;
    cfg.logger.warn(`${cfg.logTag}.spawn_failed`, { err: message });
    unlinkAbort();
    yield { type: 'tool_result', id: 'adapter', name: 'adapter.chat', result: null, error: message };
    yield { type: 'done', finishReason: 'error' };
    return;
  }

  // A single interactive turn must be bounded even when no timeout is configured,
  // or a CLI that wanders off can hang the conversation forever (no spinner end).
  const idleTimeoutMs = cfg.idleTimeoutMs;
  const hardCeilingMs = Math.max(cfg.hardCeilingMs, idleTimeoutMs);
  let timeout: NodeJS.Timeout | undefined;
  let timedOut = false;
  let hitHardCeiling = false;
  let terminalHandled = false;
  const hardTimer = setTimeout(() => {
    hitHardCeiling = true;
    timedOut = true;
    controller.abort();
  }, hardCeilingMs);
  hardTimer.unref?.();
  const armIdle = () => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, idleTimeoutMs);
    timeout.unref?.();
  };
  const clearTimers = () => {
    if (timeout) clearTimeout(timeout);
    clearTimeout(hardTimer);
  };
  armIdle();

  let stderrText = '';
  child.stderr?.on('data', (data) => {
    const chunk = String(data);
    stderrText = `${stderrText}${chunk}`.slice(-1024);
    cfg.logger.warn(`${cfg.logTag}.stderr`, { data: chunk.slice(0, 512) });
  });

  let buffer = '';
  let transcript = '';
  // The runtime's reported final answer, used only when no streamed text arrived
  // (so we never duplicate the answer when both a stream and a final event come).
  let lastAgentMessage = '';
  let rawFallback = '';
  let stdoutError = '';
  const pendingToolCalls: ChatDelta[] = [];

  // On a stall, surface whatever was already produced as a real (paused) answer
  // instead of throwing the work away as a hard failure.
  const flushPartialOnTimeout = (): boolean => {
    const partial = transcript.trim() || lastAgentMessage.trim() || stripProcessNoise(rawFallback);
    if (!partial) return false;
    const { cleaned } = extractMarkerToolCalls(partial);
    const body = (cleaned || partial).trim();
    if (!body) return false;
    const reason = hitHardCeiling
      ? `Paused after ${Math.round(hardCeilingMs / 1000)}s — the runtime ran long without finishing. Ask me to continue.`
      : `Paused after ${Math.round(idleTimeoutMs / 1000)}s with no new output — the runtime may have more to do. Ask me to continue.`;
    queue.push({ type: 'text', delta: body });
    queue.push({ type: 'text', delta: `\n\n_${reason}_` });
    queue.push({ type: 'done', finishReason: 'max_turns' });
    return true;
  };

  child.on('error', (err) => {
    if (terminalHandled) return;
    terminalHandled = true;
    unlinkAbort();
    clearTimers();
    if (timedOut && flushPartialOnTimeout()) {
      queue.close();
      return;
    }
    const error = timedOut
      ? hitHardCeiling
        ? `${cfg.displayName} ran past the ${Math.round(hardCeilingMs / 1000)}s ceiling without finishing and was stopped`
        : `${cfg.displayName} went ${Math.round(idleTimeoutMs / 1000)}s without output and was stopped`
      : cfg.signal?.aborted
        ? `${cfg.displayName} request was canceled`
        : `${cfg.displayName} process error: ${err.message}`;
    queue.push({ type: 'tool_result', id: 'adapter', name: 'adapter.chat', result: null, error });
    queue.push({ type: 'done', finishReason: 'error' });
    queue.close();
  });

  child.stdout?.on('data', (chunk) => {
    buffer += String(chunk);
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;
      // Any processed line means the harness is alive — reset the idle clock so an
      // actively-streaming turn is never killed.
      armIdle();
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        // These CLIs run in JSON mode, so non-JSON lines are environment noise
        // (e.g. Windows taskkill chatter). Never surface them as assistant text;
        // retain a filtered copy only as a last-resort fallback.
        if (!isProcessNoiseLine(line)) rawFallback += `${line}\n`;
        continue;
      }
      const interpreted = cfg.interpret(event);
      const parts = Array.isArray(interpreted) ? interpreted : [interpreted];
      for (const part of parts) {
        switch (part.kind) {
          case 'text':
            transcript += part.text;
            break;
          case 'final':
            if (part.text) lastAgentMessage = part.text;
            break;
          case 'thinking':
            if (part.text) queue.push({ type: 'thinking', delta: part.text });
            break;
          case 'activity':
            queue.push(part.delta);
            break;
          case 'tool':
            pendingToolCalls.push({ type: 'tool_call', id: randomUUID(), name: part.name, args: part.args });
            break;
          case 'error':
            if (part.message) stdoutError = part.message;
            break;
          case 'ignore':
            break;
        }
      }
    }
  });

  child.on('exit', (code) => {
    if (terminalHandled) return;
    terminalHandled = true;
    unlinkAbort();
    clearTimers();
    if (timedOut && flushPartialOnTimeout()) {
      queue.close();
      return;
    }
    if (code !== 0) {
      const detail = (cfg.formatExitError?.(code, stderrText, stdoutError) ?? stdoutError.trim() ?? '').trim()
        || stderrText.trim();
      queue.push({
        type: 'tool_result',
        id: 'adapter',
        name: 'adapter.chat',
        result: null,
        error: detail ? `${cfg.displayName} exited ${code}: ${detail}` : `${cfg.displayName} exited ${code}`,
      });
      queue.push({ type: 'done', finishReason: 'error' });
      queue.close();
      return;
    }

    // Prefer streamed assistant text; fall back to the runtime's final message;
    // only then to any non-JSON noise. This keeps mcp_native turns (which do their
    // work over MCP and stream little text) from coming back empty.
    const source = transcript.trim().length > 0
      ? transcript
      : lastAgentMessage.trim().length > 0
        ? lastAgentMessage
        : stripProcessNoise(rawFallback);
    const { calls: markerCalls, cleaned } = extractMarkerToolCalls(source);
    if (cleaned) queue.push({ type: 'text', delta: cleaned });
    const allToolCalls: ChatDelta[] = [
      ...pendingToolCalls,
      ...markerCalls.map((call) => ({ type: 'tool_call' as const, id: randomUUID(), name: call.name, args: call.args })),
    ];
    for (const call of allToolCalls) queue.push(call);
    if (!cleaned && allToolCalls.length === 0) cfg.onEmptyResult?.();
    queue.push({ type: 'done', finishReason: allToolCalls.length > 0 ? 'tool_calls' : 'stop' });
    queue.close();
  });

  child.stdin?.end(cfg.stdin);

  try {
    yield* queue.iterate();
  } finally {
    clearTimers();
    unlinkAbort();
    controller.abort();
  }
}

/**
 * A tiny async queue bridging the child process's event callbacks to the
 * `async function*` the chat loop consumes. `push` is non-blocking; `iterate`
 * suspends until the next delta or close.
 */
export function createChatQueue() {
  const pending: ChatDelta[] = [];
  const waiters: Array<() => void> = [];
  let closed = false;
  return {
    push(delta: ChatDelta) {
      if (closed) return;
      pending.push(delta);
      waiters.shift()?.();
    },
    close() {
      closed = true;
      while (waiters.length > 0) waiters.shift()?.();
    },
    async *iterate(): AsyncIterable<ChatDelta> {
      while (!closed || pending.length > 0) {
        const next = pending.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
  };
}
