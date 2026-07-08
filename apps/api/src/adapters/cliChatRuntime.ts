/**
 * cliChatRuntime — the shared interactive-chat engine for CLI harness adapters
 * (Codex, Claude Code, Cursor, Hermes agent).
 *
 * Every CLI adapter drives a child process in `--json` / `stream-json` mode and
 * has to solve the SAME hard problems for an interactive turn:
 *   - spawn the binary with an abortable signal and piped stdio,
 *   - read NDJSON from stdout, line by line, and route each event to the right
 *     channel (answer text, live thinking, live activity, tool calls),
 *   - keep the turn ALIVE for as long as the agent works: a quiet stretch emits a
 *     "still working" heartbeat (never a kill); only operator cancel, process
 *     exit, or a long SILENCE ceiling (no output at all, reset by any real output)
 *     can stop it — so a capable agent finishes a big task no matter how long,
 *   - on that silence ceiling, surface whatever was produced as a *paused* answer
 *     instead of discarding the work as a hard failure,
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
import { resolveSpawnCwd, resolveSpawnTarget, withExpandedPath } from '../services/pathExpander.js';
import { extractMarkerToolCalls, isProcessNoiseLine, stripProcessNoise } from './markerToolProtocol.js';
import { linkAbortSignal } from './abort.js';
import { runtimeProgressActivity } from './runtimeProgress.js';

/** Default safety cap for one chat turn when no explicit timeout is configured. */
export const DEFAULT_CHAT_TURN_TIMEOUT_MS = 180_000;

/**
 * SILENCE ceiling (ms): the only automatic time-stop. A turn is reaped solely
 * when the harness produces NO output (stdout AND stderr) for this long —
 * continuously, since any real output resets it. Generous on purpose: a capable
 * agent at high reasoning effort can think silently for minutes on a big task and
 * must be allowed to finish. This bounds only a genuinely stuck/dead process.
 * Overridable per-adapter via env; set <= 0 to disable entirely (unlimited).
 */
const DEFAULT_CHAT_HARD_CEILING_MS = 1_800_000;

/** How often a quiet-but-alive turn emits a "still working" heartbeat to the UI. */
const HEARTBEAT_INTERVAL_MS = 15_000;

/** Human-friendly elapsed string, e.g. "45s", "4m 12s", "1h 3m". */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * Clamp an idle budget into a sane range. The floor is 1s; the ceiling is the
 * HARD ceiling, not the 180s default — so a caller that deliberately asks for a
 * longer idle window (e.g. the chat loop hands a CLI harness its 240s round
 * budget, because a harness re-spawns and is silent on stdout while its remote
 * model thinks) actually gets it, instead of being quietly cut to 180s. The hard
 * ceiling still bounds the whole turn. Only a non-finite input falls back to the
 * 180s default. Shared so every CLI adapter treats `timeoutMs` the same.
 */
export function clampChatTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs)) return DEFAULT_CHAT_TURN_TIMEOUT_MS;
  return Math.max(1_000, Math.min(Math.floor(timeoutMs), DEFAULT_CHAT_HARD_CEILING_MS));
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
  /** Assistant text candidate. Only the latest/final candidate becomes the answer. */
  | { kind: 'text'; text: string }
  /** A fallback final answer, used only when no streamed `text` arrived. */
  | { kind: 'final'; text: string }
  /** Reasoning signal. Its raw contents are never exposed or persisted. */
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
    // Self-heal a vanished harness workdir so a present binary can't throw the
    // misleading `spawn <binary> ENOENT` (Windows reports a missing cwd that way).
    const cwd = resolveSpawnCwd(cfg.cwd, { create: true });
    const target = resolveSpawnTarget(cfg.binary, cfg.args, cwd ?? process.cwd(), env);
    child = spawn(target.command, target.args, {
      cwd,
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

  // LIVENESS model, NOT a time guillotine. A capable agent (e.g. Codex at high
  // reasoning effort) can think silently for minutes on a large task — killing it
  // mid-work is the bug we refuse to ship. So a quiet stretch no longer KILLS: it
  // emits a "still working" heartbeat (keeping the UI alive and the operator able
  // to Stop) and keeps waiting. The ONLY automatic stops are operator cancel, the
  // process exiting, and an absolute SILENCE ceiling — total quiet (no stdout AND
  // no stderr) for `hardCeilingMs`, the genuine "stuck process" signal. Real
  // output resets the silence ceiling; self-emitted heartbeats do not. Set
  // `hardCeilingMs <= 0` to disable the ceiling entirely (unlimited).
  const turnStartedAt = Date.now();
  const hardCeilingMs = cfg.hardCeilingMs;
  const heartbeatMs = Math.max(5_000, Math.min(cfg.idleTimeoutMs, HEARTBEAT_INTERVAL_MS));
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let silenceTimer: NodeJS.Timeout | undefined;
  let timedOut = false;
  let terminalHandled = false;
  // Honesty gate for the heartbeat. Until the child has emitted ANY real bytes
  // (stdout or stderr), the turn has produced nothing — the harness is still
  // spinning up or blocked waiting on its provider's first token. Claiming it
  // "is working" in that window is a lie (e.g. a hung/unreachable model sits
  // totally silent), so the heartbeat says it's still waiting instead. Flipped
  // true by the first stdout line or stderr chunk below.
  let firstOutputSeen = false;
  const armHeartbeat = () => {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      const elapsed = Date.now() - turnStartedAt;
      queue.push(runtimeProgressActivity({
        id: `${cfg.logTag}-heartbeat`,
        runtimeName: cfg.displayName,
        text: firstOutputSeen
          ? `${cfg.displayName} is working — ${formatElapsed(elapsed)} elapsed`
          : `Waiting for ${cfg.displayName} to respond — ${formatElapsed(elapsed)} so far, no output yet`,
      }));
      armHeartbeat(); // keep beating; a heartbeat is NOT real output, so silence keeps counting
    }, heartbeatMs);
    heartbeatTimer.unref?.();
  };
  const armSilenceCeiling = () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    if (hardCeilingMs <= 0) return; // unlimited — operator cancel / process exit only
    silenceTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, hardCeilingMs);
    silenceTimer.unref?.();
  };
  // Real output (stdout/stderr) is the genuine liveness signal: it resets BOTH the
  // heartbeat cadence and the silence ceiling. Heartbeats reset only themselves.
  const markAlive = () => {
    armHeartbeat();
    armSilenceCeiling();
  };
  const clearTimers = () => {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    if (silenceTimer) clearTimeout(silenceTimer);
  };
  markAlive();

  let stderrText = '';
  child.stderr?.on('data', (data) => {
    const chunk = String(data);
    stderrText = `${stderrText}${chunk}`.slice(-1024);
    firstOutputSeen = true;
    // stderr output means the harness is ALIVE and working (a CLI agent prints its
    // shell/tool output here — e.g. Codex running a test or grep). It's a real
    // liveness signal, so reset the silence ceiling: a process busy on stderr but
    // quiet on stdout is never reaped.
    markAlive();
    cfg.logger.warn(`${cfg.logTag}.stderr`, { data: chunk.slice(0, 512) });
  });

  let buffer = '';
  let transcript = '';
  let latestAssistantText = '';
  // The runtime's reported final answer, used only when no streamed text arrived
  // (so we never duplicate the answer when both a stream and a final event come).
  let lastAgentMessage = '';
  let rawFallback = '';
  let stdoutError = '';
  const pendingToolCalls: ChatDelta[] = [];

  // On a stall, surface whatever was already produced as a real (paused) answer
  // instead of throwing the work away as a hard failure.
  const flushPartialOnTimeout = (): boolean => {
    const partial = lastAgentMessage.trim() || latestAssistantText.trim() || stripProcessNoise(rawFallback);
    if (!partial) return false;
    const { cleaned } = extractMarkerToolCalls(partial);
    const body = (cleaned || partial).trim();
    if (!body) return false;
    // Only reached after `hardCeilingMs` of TOTAL silence — a genuinely stuck
    // runtime, not a working one (working turns emit output, which resets the
    // ceiling). Surface the partial answer instead of discarding it.
    const reason = `Paused — ${cfg.displayName} went quiet for ${formatElapsed(hardCeilingMs)} with no output and may be stuck. Ask me to continue.`;
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
      ? `${cfg.displayName} produced no output for ${formatElapsed(hardCeilingMs)} and appears stuck; it was stopped`
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
      // Any processed line means the harness is alive — reset the silence ceiling
      // so an actively-streaming turn is never reaped.
      firstOutputSeen = true;
      markAlive();
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
            latestAssistantText += part.text;
            queue.push(runtimeProgressActivity({
              id: `runtime-progress-${cfg.logTag.replace(/[^a-z0-9]+/gi, '-')}`,
              runtimeName: cfg.displayName,
              text: latestAssistantText,
            }));
            break;
          case 'final':
            if (part.text) lastAgentMessage = part.text;
            break;
          case 'thinking':
            if (part.text) {
              latestAssistantText = '';
              queue.push(runtimeProgressActivity({
                id: `runtime-progress-${cfg.logTag.replace(/[^a-z0-9]+/gi, '-')}`,
                runtimeName: cfg.displayName,
                text: part.text,
                reasoning: true,
              }));
            }
            break;
          case 'activity':
            latestAssistantText = '';
            queue.push(part.delta);
            break;
          case 'tool':
            latestAssistantText = '';
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
      // Many CLIs report the real failure on STDOUT as plain text (e.g. Hermes
      // prints "API call failed ... HTTP 404 ...") while their stderr tail is just
      // a non-error line like "session_id: ...". Mine that plain stdout too and
      // hand the adapter the richest signal as `stdoutError`, so the operator sees
      // the actual cause instead of boilerplate.
      const plainStdout = stripProcessNoise(lastAgentMessage || latestAssistantText || rawFallback).trim();
      const stdoutDetail = stdoutError.trim() || plainStdout;
      const detail = (cfg.formatExitError?.(code, stderrText, stdoutDetail) ?? '').trim()
        || stdoutDetail
        || stripProcessNoise(stderrText).trim();

      // A working/turn LIMIT is a SOFT, resumable stop — NEVER a hard FAILED. The
      // same is true of any non-zero exit that nonetheless produced real answer
      // text: preserve the work and let the operator say "continue", instead of a
      // red error that throws it away. Only a genuine zero-output failure (spawn
      // error, auth failure, crash) stays an error.
      // Only the STREAMED answer channels count as "work to preserve" — NOT
      // `rawFallback`, which on a non-zero exit usually holds the error text itself
      // (e.g. Hermes prints "API call failed … 404" to stdout). Counting that would
      // disguise a real failure as a resumable partial answer.
      const partial = (() => {
        const raw = lastAgentMessage.trim() || latestAssistantText.trim();
        if (!raw) return '';
        const { cleaned } = extractMarkerToolCalls(raw);
        return (cleaned || raw).trim();
      })();
      const hitLimit = /tool[-\s]?turn limit|max[\s_-]?turns|turn limit|reached .*limit/i.test(detail);
      if (hitLimit || partial) {
        if (partial) queue.push({ type: 'text', delta: partial });
        const note = hitLimit
          ? `${detail} Say "continue" to resume from here.`
          : `${cfg.displayName} ended before finishing${detail ? ` (${detail})` : ''} — your progress is above; say "continue" to resume.`;
        queue.push({ type: 'text', delta: `${partial ? '\n\n' : ''}_${note}_` });
        queue.push({ type: 'done', finishReason: 'max_turns' });
        queue.close();
        return;
      }

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

    // CLI harnesses may emit several assistant messages while working. Activity
    // and tool boundaries reset the candidate so earlier progress narration does
    // not become answer paragraphs, while token chunks in one message still join.
    // Prefer an explicit completion payload when the harness provides one.
    const source = lastAgentMessage.trim().length > 0
      ? lastAgentMessage
      : latestAssistantText.trim().length > 0
        ? latestAssistantText
        : stripProcessNoise(rawFallback);
    const markerSource = `${transcript}\n${lastAgentMessage}`.trim();
    const { calls: markerCalls } = extractMarkerToolCalls(markerSource);
    const { cleaned } = extractMarkerToolCalls(source);
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
