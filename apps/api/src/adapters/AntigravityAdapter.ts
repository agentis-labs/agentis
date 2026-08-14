/**
 * AntigravityAdapter — spawn Google's Antigravity CLI (`agy`) as a child process.
 *
 * Antigravity is the terminal agent harness Google is migrating Gemini-CLI users
 * to: the `gemini` CLI's "Sign in with Google" (Code Assist for individuals) path
 * is retired, and Google points users to `agy`, which authenticates via Google
 * OAuth / a Google Cloud project (cached in the system keyring) — the path that
 * still works on paid accounts. `agy` is built on the same Gemini-CLI lineage
 * (config under `~/.gemini/antigravity-cli/`) and is a multi-vendor harness
 * (Gemini, Claude, GPT-OSS models).
 *
 * Like the Codex/Cursor adapters this is a streaming CLI adapter. Current agy
 * releases use `agy [options] --print <prompt>` with structured JSON on stdout;
 * the prompt is positional, not piped on stdin.
 *
 * ⚠️ KNOWN agy v1.0.13 LIMITATION: `--print` runs the turn and exits 0, but writes
 * the model response only to an interactive TTY renderer — it emits NOTHING to a
 * piped stdout (and `--log-file` holds only glog debug output, not the answer).
 * So spawned headlessly it currently produces no capturable output. Capturing it
 * needs a pseudo-terminal (ConPTY / node-pty) wrapper, or an upstream fix to
 * `--print`. Parsing here is schema-tolerant (handles plain text AND, forward-
 * compatibly, JSON lines) so the moment agy emits to the pipe — or a PTY is added
 * — output flows through unchanged. Args are overridable via `extraArgs`.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  AgentAdapter,
  AdapterCapabilities,
  AdapterHealthStatus,
  ChatDelta,
  ChatInvocationOptions,
  ChatMessage,
  NormalizedAgentEvent,
  NormalizedTask,
  RuntimeContext,
  RuntimeDescriptor,
  RuntimeSessionInfo,
  ToolDefinition,
} from '@agentis/core';
import type { Logger } from '../logger.js';
import { resolveSpawnCwd, resolveSpawnTarget, withExpandedPath } from '../services/pathExpander.js';
import { buildMarkerToolPrompt, extractMarkerToolCalls, formatToolManifestAwareness, stripProcessNoise } from './markerToolProtocol.js';
import { linkAbortSignal } from './abort.js';
import {
  chatHardCeilingMs,
  clampChatTimeout,
  createChatQueue,
  DEFAULT_CHAT_TURN_TIMEOUT_MS,
  type CliChatPart,
} from './cliChatRuntime.js';
import { probeCliRuntime } from './cliRuntimeProbe.js';
import { nativeRuntimeCapabilities } from './runtimeCapabilityDeclarations.js';
import type { RuntimeSessionStore } from '../services/runtime/runtimeSessionStore.js';
import { antigravityModelLabel, normalizeAntigravityModel } from './antigravityModels.js';
import { compactPublicProgress } from './publicProgress.js';

const DEFAULT_INTERACTIVE_CHAT_TIMEOUT_MS = 20_000;
const DEFAULT_STRUCTURED_CHAT_TIMEOUT_MS = 30_000;
// Windows CreateProcess rejects a command line longer than 32,767 UTF-16 code
// units. Leave generous room for the executable path and agy flags.
const MAX_AGY_POSITIONAL_PROMPT_CHARS = 22_000;

export interface AntigravityAdapterOptions {
  agentId: string;
  /** Path to the `agy` binary. Falls back to `agy` on PATH. */
  binaryPath?: string;
  cwd?: string;
  model?: string;
  /** Auto-approve all tool calls (`--yolo`). On by default — Agentis drives the
   *  CLI headlessly, so there is never a human to answer an approval prompt. */
  yolo?: boolean;
  extraArgs?: string[];
  env?: Record<string, string>;
  timeoutSec?: number;
  workspaceId?: string;
  sessionStore?: RuntimeSessionStore;
  logger: Logger;
}

export class AntigravityAdapter implements AgentAdapter {
  readonly adapterType = 'antigravity' as const;
  readonly #handlers = new Set<(event: NormalizedAgentEvent) => void>();
  readonly #inFlight = new Map<string, AbortController>();
  /** sessionKey → the stable session UUID we pass as `--session-id`. */
  readonly #sessions = new Map<string, string>();
  #version: string | null = null;

  constructor(private readonly opts: AntigravityAdapterOptions) {}

  getWorkdir(): string | undefined { return this.opts.cwd; }

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {
    for (const controller of this.#inFlight.values()) controller.abort();
    this.#inFlight.clear();
  }

  async healthCheck(): Promise<AdapterHealthStatus> {
    const result = await probeCliRuntime({
      binary: this.opts.binaryPath || 'agy',
      cwd: this.opts.cwd,
      env: this.opts.env,
      logger: this.opts.logger,
      logTag: 'antigravity',
    });
    this.#version = result.version;
    return result.health;
  }

  capabilities(): AdapterCapabilities {
    return {
      interactiveChat: true,
      toolCalling: true,
      toolForwarding: 'marker_protocol',
      execution: {
        longRunning: true,
        pausable: false,
        sandbox: 'process',
        maxConcurrent: 1,
      },
      affordances: {
        fileSystem: true,
        terminal: true,
      },
      memory: {
        ingestible: true,
        injectable: true,
      },
      capabilityManifest: nativeRuntimeCapabilities([
        'interaction.chat',
        'interaction.tool-calling',
        'execution.file-system',
        'execution.terminal',
        'execution.long-running',
        'memory.inject',
        'memory.ingest',
      ], {
        limits: { 'execution.long-running': { maxConcurrent: 1 } },
      }),
    };
  }

  async getRuntimeContext(): Promise<RuntimeContext> {
    const configuredModel = normalizeAntigravityModel(this.opts.model);
    return {
      provider: 'Google Antigravity',
      models: configuredModel
        ? [{ id: configuredModel, label: antigravityModelLabel(configuredModel) ?? configuredModel, source: 'agent_config', verified: false }]
        : [],
      currentModel: configuredModel ?? 'unknown',
      currentModelSource: configuredModel ? 'agent_config' : 'fallback',
      currentModelVerified: false,
      fastModeSupported: false,
    };
  }

  async describeRuntime(): Promise<Partial<RuntimeDescriptor>> {
    const observedAt = new Date().toISOString();
    return {
      version: this.#version
        ? { value: this.#version, source: 'runtime', observedAt, verified: true }
        : null,
      process: {
        warm: false,
        activeSessions: this.#sessions.size,
      },
    };
  }

  async listRuntimeSessions(): Promise<RuntimeSessionInfo[]> {
    if (this.opts.sessionStore && this.opts.workspaceId) {
      return this.opts.sessionStore.list(this.opts.workspaceId, this.opts.agentId);
    }
    const now = new Date().toISOString();
    return [...this.#sessions.entries()].map(([sessionKey, runtimeSessionId]) => ({
      id: `${this.opts.agentId}:${sessionKey}`,
      sessionKey,
      runtimeSessionId,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
    }));
  }

  async closeRuntimeSession(sessionKey: string): Promise<void> {
    this.#sessions.delete(sessionKey);
    if (this.opts.sessionStore && this.opts.workspaceId) {
      this.opts.sessionStore.remove(this.opts.workspaceId, this.opts.agentId, sessionKey);
    }
  }

  onEvent(handler: (event: NormalizedAgentEvent) => void): void {
    this.#handlers.add(handler);
  }

  async dispatchTask(task: NormalizedTask): Promise<void> {
    const controller = new AbortController();
    const unlinkAbort = linkAbortSignal(task.signal, controller);
    this.#inFlight.set(task.taskId, controller);
    const timestamp = () => new Date().toISOString();
    this.#emit({
      eventType: 'task.started',
      agentId: this.opts.agentId,
      taskId: task.taskId,
      runId: task.runId,
      workflowId: task.workflowId,
      timestamp: timestamp(),
    });
    // A workflow task is a fresh, single-shot conversation — the prompt carries
    // everything it needs, so no `--conversation` resume id.
    const args = buildAntigravityArgs(this.opts, task.preferredModel);
    const result = await this.#runAgy({
      args,
      prompt: buildAntigravityPrompt(task),
      cwd: task.workdir ?? this.opts.cwd,
      env: task.abilityEnv,
      signal: controller.signal,
      timeoutMs: this.opts.timeoutSec && this.opts.timeoutSec > 0 ? this.opts.timeoutSec * 1000 : undefined,
    });
    unlinkAbort();
    this.#inFlight.delete(task.taskId);
    if (result.error) {
      this.#emitFailure(task, result.error);
      return;
    }
    this.#emit({
      eventType: 'task.completed',
      agentId: this.opts.agentId,
      runId: task.runId,
      workflowId: task.workflowId,
      taskId: task.taskId,
      output: { text: result.text },
      timestamp: timestamp(),
    });
  }

  /**
   * Run one `agy --print` turn and return its answer. Current agy emits
   * not emit the response to a piped stdout, the answer is read back from the
   * conversation transcript agy writes under its brain dir
   * (`<brain>/<conversation-id>/.system_generated/logs/transcript_full.jsonl`) —
   * the last `source: "MODEL"` content. A forward-compatible stdout answer (if a
   * future agy emits one) takes precedence. This is the only way to capture agy
   * output today without a PTY; it tolerates the file being flushed slightly
   * after exit by retrying briefly. Current agy 1.1 structured stdout is the
   * only authoritative answer; shared transcript files are never used.
   */
  async #runAgy(input: {
    args: string[];
    prompt: string;
    cwd?: string;
    env?: Record<string, string>;
    signal?: AbortSignal;
    timeoutMs?: number;
    onTextDelta?: (text: string) => void;
    /** Safe, model-authored progress retained by agy's transcript. */
    onCommentary?: (commentary: { id: string; text: string }) => void;
    onActivity?: (delta: Extract<ChatDelta, { type: 'activity' }>) => void;
    /**
     * Live-stream callbacks. agy emits nothing to stdout, but it writes its
     * conversation transcript progressively while it works (verified: rows appear
     * mid-run). When these are set we tail that file and surface per-step model
     * reasoning + tool actions as they happen — the same live trace Codex gives —
     * instead of only revealing the final answer after exit.
     */
  }): Promise<{ text: string; error?: string }> {
    const binary = this.opts.binaryPath || 'agy';
    const env = withExpandedPath({ ...process.env, ...(this.opts.env ?? {}), ...(input.env ?? {}) });
    const controller = new AbortController();
    const unlink = linkAbortSignal(input.signal, controller);
    let timer: NodeJS.Timeout | undefined;
    let transcriptTimer: NodeJS.Timeout | undefined;
    let timedOut = false;
    // `agy --print` writes its actual model turn to this transcript progressively.
    // Its stdout supplies tool lifecycle events, but not the model's pre-tool
    // sentence, which is precisely the useful live update the operator expects.
    const brainDir = agyBrainDir(this.opts.env, input.env);
    const priorConversations = listConversationDirs(brainDir);
    let transcriptConversation: string | null = null;
    const seenTranscriptRows = new Set<string>();
    const tailTranscript = () => {
      transcriptConversation ??= newestNewConversation(brainDir, priorConversations);
      if (!transcriptConversation) return;
      const conversationDir = join(brainDir, transcriptConversation);
      for (const row of readTranscriptRows(conversationDir)) {
        const step = typeof row.step_index === 'number' ? row.step_index : -1;
        const source = String(row.source ?? '').toUpperCase();
        const status = String(row.status ?? '').toUpperCase();
        const content = firstString(row.content, row.text, row.message) ?? '';
        const key = `${step}:${source}:${status}:${content}`;
        if (seenTranscriptRows.has(key)) continue;
        seenTranscriptRows.add(key);
        const activity = transcriptRowActivity(row, step);
        if (activity) input.onActivity?.(activity);
        // Never expose transcript `thinking`: it is private chain-of-thought.
        // MODEL content, on the other hand, is the operator-facing message that
        // precedes an Agentis tool marker and is safe after transport cleanup.
        // Agy has used both DONE and in-progress status values for a model row
        // across releases. The row's source is the authority here; emit the
        // operator-facing content as soon as it exists, while never reading its
        // separate private `thinking` field.
        if (source !== 'MODEL' || !content) continue;
        const { cleaned } = extractMarkerToolCalls(content);
        const text = cleaned.replace(/\s+/g, ' ').trim();
        if (text) input.onCommentary?.({ id: `antigravity-commentary-${step}`, text: clipText(text, 1_200) });
      }
    };
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: { text: string; error?: string }) => {
        if (settled) return;
        settled = true;
        unlink();
        if (timer) clearTimeout(timer);
        if (transcriptTimer) clearInterval(transcriptTimer);
        resolve(result);
      };
      let child: ReturnType<typeof spawn>;
      try {
        const cwd = resolveSpawnCwd(input.cwd, { create: true });
        // `agy --print` consumes a positional prompt. It does not read stdin;
        // writing there made the CLI/model answer its own launch flags instead.
        const prompt = compactAgyPositionalPrompt(input.prompt);
        if (prompt.length !== input.prompt.length) {
          this.opts.logger.warn('antigravity.prompt_compacted', {
            originalChars: input.prompt.length,
            retainedChars: prompt.length,
          });
        }
        const target = resolveSpawnTarget(binary, [...input.args, prompt], cwd ?? process.cwd(), env);
        child = spawn(target.command, target.args, {
          cwd, env, windowsHide: true, signal: controller.signal, stdio: ['ignore', 'pipe', 'pipe'],
        });
        // Read immediately and then frequently enough to feel live without
        // turning the local transcript into a polling hotspot.
        tailTranscript();
        transcriptTimer = setInterval(tailTranscript, 250);
        transcriptTimer.unref?.();
      } catch (err) {
        finish({ text: '', error: `antigravity_spawn_failed: ${(err as Error).message}` });
        return;
      }
      if (input.timeoutMs && input.timeoutMs > 0) {
        timer = setTimeout(() => { timedOut = true; controller.abort(); }, input.timeoutMs);
        timer.unref?.();
      }
      let stderrText = '';
      let stdoutText = '';
      let stdoutRemainder = '';
      const consumeStdout = (chunk: string) => {
        stdoutRemainder += chunk;
        const lines = stdoutRemainder.split('\n');
        stdoutRemainder = lines.pop() ?? '';
        for (const line of lines) {
          const parsed = parseAntigravityStdoutLine(line);
          if (parsed.delta) input.onTextDelta?.(parsed.delta);
          if (parsed.activity) input.onActivity?.(parsed.activity);
        }
      };
      child.stderr?.on('data', (d) => {
        const chunk = String(d);
        stderrText = `${stderrText}${chunk}`.slice(-4096);
        this.opts.logger.warn('antigravity.stderr', { data: chunk.slice(0, 256) });
      });
      child.stdout?.on('data', (d) => {
        const chunk = String(d);
        stdoutText = `${stdoutText}${chunk}`.slice(-65536);
        consumeStdout(chunk);
      });
      child.on('error', (err) => {
        finish({ text: '', error: timedOut ? `Antigravity (agy) timed out` : `antigravity_error: ${err.message}` });
      });
      child.on('exit', (code) => {
        // Capture a final transcript row written in the same tick as process
        // shutdown; the interval may not get another chance before `finish`.
        tailTranscript();
        if (stdoutRemainder.trim()) {
          const parsedLine = parseAntigravityStdoutLine(stdoutRemainder);
          if (parsedLine.delta) input.onTextDelta?.(parsedLine.delta);
          if (parsedLine.activity) input.onActivity?.(parsedLine.activity);
        }
        // Read stdout synchronously (it's fully delivered by exit time).
        const parsed = extractStdoutAnswer(stdoutText);
        if (code !== 0) {
          finish({ text: '', error: formatAntigravityExitError(code, stderrText, parsed.error ?? '') });
          return;
        }
        // Forward-compat: if a future agy prints the answer to stdout, use it.
        if (parsed.error) { finish({ text: '', error: parsed.error }); return; }
        if (parsed.text) { finish({ text: parsed.text }); return; }
        finish({ text: '', error: 'RUNTIME_PROTOCOL_VIOLATION: Antigravity completed without a structured response. Verify agy 1.1+ is installed and retry.' });
      });
    });
  }

  async cancelTask(taskId: string): Promise<void> {
    this.#inFlight.get(taskId)?.abort();
    this.#inFlight.delete(taskId);
  }

  async *chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: ChatInvocationOptions,
  ): AsyncIterable<ChatDelta> {
    // agy emits response deltas and real tool-step lifecycle events on stdout;
    // stream per-step reasoning + tool actions as the run unfolds — the same live
    // trace Codex gives, instead of a silent "waiting for agent output" until the
    // very end. Hidden reasoning and shared transcript files are not exposed.
    const configuredTimeoutMs = this.opts.timeoutSec && this.opts.timeoutSec > 0
      ? this.opts.timeoutSec * 1000
      : options?.latencyClass === 'interactive'
        ? DEFAULT_INTERACTIVE_CHAT_TIMEOUT_MS
        : options?.latencyClass === 'structured'
          ? DEFAULT_STRUCTURED_CHAT_TIMEOUT_MS
          : DEFAULT_CHAT_TURN_TIMEOUT_MS;
    const timeoutMs = clampChatTimeout(options?.timeoutMs ?? configuredTimeoutMs);
    const hardCeilingMs = chatHardCeilingMs(timeoutMs, 'AGENTIS_ANTIGRAVITY_CHAT_HARD_CEILING_MS');
    const queue = createChatQueue();

    void (async () => {
      try {
        let streamedText = '';
        let streamedOperatorText = '';
        let streamSuppressed = false;
        const result = await this.#runAgy({
          args: buildAntigravityArgs(this.opts, options?.preferredModel),
          prompt: buildAntigravityChatPrompt(messages, tools),
          cwd: this.opts.cwd,
          signal: options?.signal,
          timeoutMs: hardCeilingMs > 0 ? hardCeilingMs : timeoutMs,
          onTextDelta: (delta) => {
            streamedText += delta;
            // Stream the operator-facing sentence immediately, but stop exactly
            // at the marker boundary. Holding a possible partial marker suffix
            // prevents `AGENTIS_TOOL_...` from flashing in the chat between chunks.
            if (/--dangerously-skip-permissions/i.test(streamedText)) streamSuppressed = true;
            if (streamSuppressed) return;
            const visible = antigravityOperatorPrefix(streamedText);
            if (visible.length > streamedOperatorText.length) {
              const addition = visible.slice(streamedOperatorText.length);
              streamedOperatorText = visible;
              if (addition) queue.push({ type: 'text', delta: addition });
            }
          },
          onCommentary: (commentary) => queue.push({
            type: 'commentary',
            id: commentary.id,
            text: compactPublicProgress(commentary.text),
            source: 'assistant_preamble',
            createdAt: new Date().toISOString(),
          }),
          onActivity: (delta) => queue.push(delta),
        });

        if (result.error) {
          queue.push({ type: 'tool_result', id: 'adapter', name: 'adapter.chat', result: null, error: result.error });
          queue.push({ type: 'done', finishReason: 'error' });
          return;
        }
        const protocolError = invalidAntigravityResponse(result.text);
        if (protocolError) {
          this.opts.logger.warn('antigravity.chat.protocol_violation', { reason: protocolError });
          queue.push({ type: 'tool_result', id: 'adapter', name: 'adapter.chat', result: null, error: protocolError });
          queue.push({ type: 'done', finishReason: 'error' });
          return;
        }
        // The agent may have answered with Agentis tool-call markers — split them
        // out so the platform executes them, exactly like the other CLI adapters.
        const { cleaned, calls } = extractMarkerToolCalls(result.text);
        const body = (cleaned || result.text).trim();
        if (body && !streamedOperatorText.trim()) {
          queue.push({ type: 'text', delta: body });
        } else if (body && body.startsWith(streamedOperatorText.trim())) {
          const remainder = body.slice(streamedOperatorText.trim().length);
          if (remainder) queue.push({ type: 'text', delta: remainder });
        }
        for (const call of calls) {
          queue.push({ type: 'tool_call', id: randomUUID(), name: call.name, args: call.args });
        }
        if (!body && calls.length === 0) {
          this.opts.logger.warn('antigravity.chat.empty_answer', {});
        }
        queue.push({ type: 'done', finishReason: calls.length > 0 ? 'tool_calls' : 'stop' });
      } catch (err) {
        queue.push({ type: 'tool_result', id: 'adapter', name: 'adapter.chat', result: null, error: `antigravity_chat_failed: ${(err as Error).message}` });
        queue.push({ type: 'done', finishReason: 'error' });
      } finally {
        queue.close();
      }
    })();

    yield* queue.iterate();
  }

  #emit(event: NormalizedAgentEvent): void {
    for (const handler of this.#handlers) {
      try {
        handler(event);
      } catch (err) {
        this.opts.logger.error('antigravity.handler_threw', { err: (err as Error).message });
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

type AntigravityJsonEvent = {
  event?: unknown;
  type?: unknown;
  role?: unknown;
  content?: unknown;
  text?: unknown;
  message?: unknown;
  delta?: unknown;
  severity?: unknown;
  status?: unknown;
  error?: unknown;
  output?: unknown;
  tool_name?: unknown;
  tool_id?: unknown;
  parameters?: unknown;
  arguments?: unknown;
  input?: unknown;
  name?: unknown;
  session_id?: unknown;
  sessionId?: unknown;
  model?: unknown;
  result?: unknown;
  step_update?: unknown;
};

/**
 * Build the headless `agy` argv. Verified against agy v1.0.13 (`agy --help`):
 * `--print` runs a single prompt non-interactively (the prompt is read from
 * stdin), `--dangerously-skip-permissions` auto-approves tools (there is no human
 * to answer prompts), `--model` selects the model, and `--conversation <id>`
 * resumes a prior conversation. There is NO `--output-format` flag — agy v1.0.13
 * emits plain text (and, per the known non-TTY limitation, only to a terminal —
 * see the file header). All flags are overridable via `extraArgs`.
 */
function buildAntigravityArgs(
  opts: AntigravityAdapterOptions,
  preferredModel?: string | null,
  options: { conversationId?: string } = {},
): string[] {
  const model = normalizeAntigravityModel(preferredModel || opts.model);
  const skipPermissions = opts.yolo !== false; // default ON — no human is present to approve
  return [
    ...(skipPermissions ? ['--dangerously-skip-permissions'] : []),
    ...(model ? ['--model', model] : []),
    ...(options.conversationId ? ['--conversation', options.conversationId] : []),
    ...(opts.timeoutSec && opts.timeoutSec > 0 ? ['--print-timeout', `${opts.timeoutSec}s`] : []),
    '--output-format', 'stream-json',
    ...(opts.extraArgs ?? []),
    '--print',
  ];
}

/**
 * agy can occasionally return its launcher/help persona instead of answering
 * the supplied conversation. Do not pass that text to an operator as an answer.
 */
function invalidAntigravityResponse(text: string): string | null {
  const compact = text.replace(/\s+/g, ' ').trim();
  const leakedHarnessFlag = /--dangerously-skip-permissions/i.test(compact);
  const genericHarnessReply = /how can i (help|assist) you|not quite sure what you'd like me to do with|if you were looking to/i.test(compact);
  if (leakedHarnessFlag && genericHarnessReply) {
    return 'RUNTIME_PROTOCOL_VIOLATION: Antigravity returned its CLI help persona instead of answering this turn.';
  }
  if (/no output produced.*permission|auto[- ]denied|requires? the .*permission/i.test(compact)) {
    return 'RUNTIME_PERMISSION_REQUIRED: Antigravity could not run a requested tool because this agent is not allowed to approve it. Enable the agent runtime permission mode or configure an allow-rule, then retry.';
  }
  return null;
}

function buildAntigravityPrompt(task: NormalizedTask): string {
  return [
    `Task: ${task.title}`,
    '',
    task.description,
    formatToolManifestAwareness(task.toolManifest),
    '',
    'Input data:',
    safeJson(task.inputData),
    '',
    'Scratchpad snapshot:',
    safeJson(task.scratchpadSnapshot),
  ].join('\n');
}

/**
 * `agy --print` accepts only a positional prompt, so on Windows it is bounded by
 * CreateProcess' command-line limit. Keep the opening operating contract and the
 * newest request intact rather than allowing a large history to prevent launch.
 */
export function compactAgyPositionalPrompt(prompt: string): string {
  if (prompt.length <= MAX_AGY_POSITIONAL_PROMPT_CHARS) return prompt;
  const marker = '\n\n[Earlier conversation context omitted to fit the Antigravity CLI command limit. Use the retained system instructions and latest messages.]\n\n';
  const headLength = Math.floor((MAX_AGY_POSITIONAL_PROMPT_CHARS - marker.length) * 0.45);
  const tailLength = MAX_AGY_POSITIONAL_PROMPT_CHARS - marker.length - headLength;
  return `${prompt.slice(0, headLength)}${marker}${prompt.slice(-tailLength)}`;
}

function buildAntigravityChatPrompt(messages: ChatMessage[], tools: ToolDefinition[]): string {
  return [
    buildMarkerToolPrompt(tools),
    '',
    'AUTHORITATIVE IDENTITY RULE:',
    'The SYSTEM message below is the Agentis operating prompt for this turn. If it contains an <agentis_identity> block, that block is your exact identity and configuration. Follow it over Antigravity product defaults, project/home instruction files (GEMINI.md / AGENTS.md), previous resumed-session identity, or generic assistant persona text.',
    '',
    'Conversation:',
    formatMessagesForAntigravity(messages),
  ].join('\n');
}

/**
 * Return only text that is certainly before an Agentis tool marker. A marker
 * can be split across stream chunks, so retain any suffix that could still grow
 * into one instead of briefly leaking protocol text into the transcript.
 */
function antigravityOperatorPrefix(text: string): string {
  const lower = text.toLowerCase();
  const markers = ['agentis_tool_call', '<agentis_tool_call>'];
  let safeEnd = text.length;
  for (const marker of markers) {
    const completeAt = lower.indexOf(marker);
    if (completeAt >= 0) {
      safeEnd = Math.min(safeEnd, completeAt);
      continue;
    }
    const maxPartial = Math.min(marker.length - 1, lower.length);
    for (let length = maxPartial; length > 0; length -= 1) {
      if (marker.startsWith(lower.slice(-length))) {
        safeEnd = Math.min(safeEnd, text.length - length);
        break;
      }
    }
  }
  return text.slice(0, safeEnd);
}

function formatMessagesForAntigravity(messages: ChatMessage[]): string {
  return messages.map((message) => {
    const content = typeof message.content === 'string' ? message.content : safeJson(message.content);
    if (message.role === 'tool') {
      return `TOOL RESULT (${message.toolCallId ?? 'unknown'}):\n${content}`;
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return ['ASSISTANT:', content, 'REQUESTED TOOLS:', safeJson(message.toolCalls)].join('\n');
    }
    return `${message.role.toUpperCase()}:\n${content}`;
  }).join('\n\n---\n\n');
}

/** Classify one `agy` stream-json event for the chat loop (shared Gemini-CLI schema). */
export function antigravityJsonEventToChatPart(event: AntigravityJsonEvent): CliChatPart {
  const type = String(event.type ?? '').toLowerCase();

  const error = extractAntigravityError(event);
  if (error) return { kind: 'error', message: error };

  if (type === 'tool_use' || type.includes('tool_use')) {
    const tool = firstString(event.tool_name, event.name) ?? 'tool';
    return { kind: 'activity', delta: antigravityToolActivity(event, prettyToolName(tool), false) };
  }
  if (type === 'tool_result' || type.includes('tool_result')) {
    const tool = firstString(event.tool_name, event.name) ?? 'tool';
    return { kind: 'activity', delta: antigravityToolActivity(event, prettyToolName(tool), true) };
  }
  if (type === 'message' || type.includes('message')) {
    const role = String(event.role ?? '').toLowerCase();
    if (role && role !== 'assistant' && role !== 'model') return { kind: 'ignore' };
    const text = extractAssistantText(event);
    return text ? { kind: 'text', text } : { kind: 'ignore' };
  }
  return { kind: 'ignore' };
}

function extractAssistantText(event: AntigravityJsonEvent): string {
  const type = String(event.type ?? '').toLowerCase();
  if (!type.includes('message')) return '';
  const role = String(event.role ?? '').toLowerCase();
  if (role && role !== 'assistant' && role !== 'model') return '';
  const message = objectOf(event.message);
  return firstString(event.content, event.text, event.delta, message?.content, message?.text) ?? '';
}

type ParsedAntigravityStdoutLine = {
  delta?: string;
  final?: string;
  error?: string;
  activity?: Extract<ChatDelta, { type: 'activity' }>;
};

function parseAntigravityStdoutLine(line: string): ParsedAntigravityStdoutLine {
  const trimmed = line.trim();
  if (!trimmed) return {};
  try {
    const event = JSON.parse(trimmed) as AntigravityJsonEvent;
    const parsed: ParsedAntigravityStdoutLine = { error: extractAntigravityError(event) ?? undefined };
    const eventName = String(event.event ?? '').toLowerCase();
    if (eventName === 'step_update') {
      const update = objectOf(event.step_update);
      const stepType = String(update?.step_type ?? '').toLowerCase();
      if (stepType === 'agent_response') {
        parsed.delta = firstString(update?.text_delta, update?.text, update?.content);
      } else if (String(update?.state ?? '').trim()) {
        const step = typeof update?.step_index === 'number' ? String(update.step_index) : 'runtime';
        const state = String(update?.state ?? '').toLowerCase();
        if (/user_input|checkpoint/.test(stepType)) return parsed;
        // A lifecycle state without a concrete operation is not useful chat
        // narration. Surface only actual tool/command/browser steps.
        if (!/tool|command|browser|exec|run|function/.test(stepType)) return parsed;
        const label = prettyToolName(firstString(update?.tool_name, update?.name, update?.title) ?? stepType);
        const completed = /done|success|complete/.test(state);
        parsed.activity = {
          type: 'activity',
          id: `antigravity-step-${step}`,
          phase: 'tool',
          status: completed ? 'success' : 'running',
          label: `${completed ? 'Used' : 'Using'} ${label}`,
          ...(completed ? { completedAt: new Date().toISOString() } : { startedAt: new Date().toISOString() }),
        };
      }
    } else if (eventName === 'result') {
      const result = objectOf(event.result);
      const status = String(result?.status ?? '').toLowerCase();
      if (status && status !== 'success') {
        parsed.error = firstString(objectOf(result?.error)?.message, result?.error, result?.message)
          ?? `Antigravity reported ${status}.`;
      }
      parsed.final = firstString(result?.response, result?.text, result?.content);
    } else {
      const part = antigravityJsonEventToChatPart(event);
      if (part.kind === 'text') parsed.delta = part.text;
      else if (part.kind === 'activity') parsed.activity = part.delta;
      else if (part.kind === 'error') parsed.error = part.message;
    }
    return parsed;
  } catch {
    const text = stripProcessNoise(trimmed).trim();
    return text ? { delta: text } : {};
  }
}

function extractStdoutAnswer(stdout: string): { text: string; error?: string } {
  let streamedText = '';
  let finalText = '';
  let error: string | undefined;
  for (const line of stdout.split('\n')) {
    const parsed = parseAntigravityStdoutLine(line);
    if (parsed.error) error = parsed.error;
    if (parsed.delta) streamedText += `${parsed.delta}`;
    if (parsed.final) finalText = parsed.final;
  }
  return { text: (finalText || streamedText).trim(), error };
}

const AGY_CONVERSATION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Antigravity CLI brain root (`<home>/brain`), respecting ANTIGRAVITY_HOME. */
function agyBrainDir(optsEnv?: Record<string, string>, callEnv?: Record<string, string>): string {
  const read = (key: string) => callEnv?.[key]?.trim() || optsEnv?.[key]?.trim() || process.env[key]?.trim();
  const home = read('ANTIGRAVITY_HOME')
    || join(read('GEMINI_HOME') || join(homedir(), '.gemini'), 'antigravity-cli');
  return join(home, 'brain');
}

function listConversationDirs(brainDir: string): Set<string> {
  const out = new Set<string>();
  try {
    for (const name of readdirSync(brainDir)) {
      if (AGY_CONVERSATION_RE.test(name)) out.add(name);
    }
  } catch { /* brain dir may not exist yet */ }
  return out;
}

/** The newest conversation dir that did not exist before this turn started. */
function newestNewConversation(brainDir: string, before: Set<string>): string | null {
  let best: { id: string; mtime: number } | null = null;
  try {
    for (const name of readdirSync(brainDir)) {
      if (!AGY_CONVERSATION_RE.test(name) || before.has(name)) continue;
      let mtime = 0;
      try { mtime = statSync(join(brainDir, name)).mtimeMs; } catch { continue; }
      if (!best || mtime > best.mtime) best = { id: name, mtime };
    }
  } catch { /* ignore */ }
  return best?.id ?? null;
}

/** Parse every JSONL row of a conversation's full transcript (best-effort). */
function readTranscriptRows(convDir: string): Array<Record<string, unknown>> {
  const file = join(convDir, '.system_generated', 'logs', 'transcript_full.jsonl');
  let raw: string;
  try { raw = readFileSync(file, 'utf8'); } catch { return []; }
  const rows: Array<Record<string, unknown>> = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) rows.push(parsed as Record<string, unknown>);
    } catch {
      // A half-written final line during a live tail — skip; we re-read next tick.
    }
  }
  return rows;
}

/**
 * Surface a non-reasoning transcript row (agy's own tool / command / action) as a
 * live activity step, or null when the row is plain model narration (reasoning is
 * streamed separately as a thought). Tolerant of agy's evolving row vocabulary.
 */
function transcriptRowActivity(
  row: Record<string, unknown>,
  step: number,
): Extract<ChatDelta, { type: 'activity' }> | null {
  const type = String(row.type ?? '').toUpperCase();
  const isToolish = /TOOL|ACTION|COMMAND|EXEC|FUNCTION/.test(type);
  if (!isToolish) return null;
  const name = prettyToolName(firstString(row.tool_name, row.name, row.tool) ?? humanizeAgyRowType(type));
  const done = String(row.status ?? '').toUpperCase() === 'DONE';
  return {
    type: 'activity',
    id: `antigravity-step-${step}`,
    phase: 'tool',
    status: done ? 'success' : 'running',
    label: `${done ? 'Used' : 'Using'} ${name}`,
    ...(done ? { completedAt: new Date().toISOString() } : { startedAt: new Date().toISOString() }),
  };
}

function humanizeAgyRowType(type: string): string {
  const lower = type.toLowerCase();
  if (lower.includes('command') || lower.includes('exec')) return 'a command';
  if (lower.includes('tool') || lower.includes('function')) return 'a tool';
  return 'an action';
}

/** The final model answer from a conversation's full transcript. */
function readTranscriptFinalModelText(convDir: string): string {
  const file = join(convDir, '.system_generated', 'logs', 'transcript_full.jsonl');
  let raw: string;
  try { raw = readFileSync(file, 'utf8'); } catch { return ''; }
  let answer = '';
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(trimmed) as Record<string, unknown>; } catch { continue; }
    if (String(event.source ?? '').toUpperCase() !== 'MODEL') continue;
    const status = String(event.status ?? '').toUpperCase();
    if (status && status !== 'DONE') continue;
    const content = firstString(event.content, event.text, event.message);
    if (content) answer = content; // the last completed MODEL message is the answer
  }
  return answer.trim();
}

/**
 * Read the answer agy wrote to the conversation transcript for the turn we just
 * ran. agy flushes the transcript slightly after exit, so retry briefly.
 */
async function readNewConversationAnswer(brainDir: string, before: Set<string>): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const convId = newestNewConversation(brainDir, before);
    if (convId) {
      const text = readTranscriptFinalModelText(join(brainDir, convId));
      if (text) return text;
    }
    await delay(250);
  }
  return '';
}

function antigravityToolActivity(
  event: AntigravityJsonEvent,
  tool: string,
  completed: boolean,
): Extract<ChatDelta, { type: 'activity' }> {
  const id = `antigravity-${firstString(event.tool_id) ?? tool}`;
  const status = String(event.status ?? '').toLowerCase();
  const failed = status === 'error' || Boolean(objectOf(event.error));
  if (!completed) {
    return { type: 'activity', id, phase: 'tool', status: 'running', label: `Using ${tool}`, startedAt: new Date().toISOString() };
  }
  const out = firstString(event.output);
  const detail = out ? clipText(stripProcessNoise(out).trim(), 240) : undefined;
  return {
    type: 'activity', id, phase: 'tool',
    status: failed ? 'error' : 'success',
    label: failed ? `Failed ${tool}` : `Used ${tool}`,
    ...(detail ? { detail } : {}),
    completedAt: new Date().toISOString(),
  };
}

function extractAntigravityError(event: AntigravityJsonEvent): string | null {
  const type = String(event.type ?? '').toLowerCase();
  if (type === 'error' || type.includes('error')) {
    if (String(event.severity ?? '').toLowerCase() === 'warning') return null;
    return firstString(objectOf(event.error)?.message, event.error, event.message) ?? null;
  }
  if (type === 'result' && String(event.status ?? '').toLowerCase() === 'error') {
    return firstString(objectOf(event.error)?.message, event.error, event.message) ?? 'Antigravity reported an error.';
  }
  return null;
}

function formatAntigravityExitError(code: number | null, stderrText: string, stdoutError: string): string {
  const stderr = stripProcessNoise(stderrText).trim();
  const detail = (stdoutError || '').trim() || stderr;
  if (/\b402\b|requires more credits|add more credits|insufficient(?:[_\s]+\w+)?[_\s]+credits?|out of credits?|no credits?|insufficient[_\s]?(?:quota|funds|balance)|quota exceeded|billing|payment required/i.test(detail)) {
    return `${detail || 'The provider rejected this request'} — the selected model account is out of credits or quota. Add credits, or choose another model, then retry.`;
  }
  // Not signed in / no cached session: point at the one-time `agy` sign-in.
  if (/not (signed|logged) in|authenticate|unauthorized|no active session|sign in/i.test(detail)) {
    return 'Antigravity CLI is not signed in on this machine. Run `agy` once and complete the Google sign-in (use a Google Cloud project for paid accounts); the session is cached in the system keyring, then retry.';
  }
  const exit = code === null ? 'signal' : `code ${code}`;
  if (detail) return `Antigravity (agy) exited with ${exit}: ${detail}`;
  return `Antigravity (agy) exited with ${exit}`;
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

function prettyToolName(raw: string): string {
  return raw.replace(/^mcp__[^_]+__/, '').replace(/[_-]?tool$/i, '').replace(/[._-]/g, ' ').trim() || 'tool';
}

function clipText(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[unserializable]';
  }
}
