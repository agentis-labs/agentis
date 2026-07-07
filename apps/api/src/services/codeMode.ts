/**
 * CodeModeService — code-mode as the primary build interface (Agent-Native §3.7 / H3).
 *
 * Anthropic ("Code execution with MCP") and Cloudflare ("Code Mode") both showed the
 * same thing: agents compose far better when they WRITE CODE against a typed API than
 * when they chain dozens of discrete tool calls (150k→2k tokens in Anthropic's case).
 * LLMs are fluent in TypeScript; they are not fluent in 70-tool JSON choreography.
 *
 * This exposes the whole Agentis tool registry as one `agentis.*` object an agent
 * writes async code against, executed in a locked-down `node:vm` context. Composition
 * — loops, conditionals, find-or-create-then-wire — happens in code, where the model
 * is strongest; the discrete MCP tools remain underneath as what the SDK calls.
 *
 * Threat model (honest — see LIMITS): OSS single-tenant, the operator's OWN trusted
 * agent. `node:vm` is NOT a hard security boundary against adversarial code; it is a
 * capability surface + resource governor (call cap, wall-clock timeout, no ambient
 * globals) — which is exactly what R2's mapping calls sufficient here.
 */

import vm from 'node:vm';
import { AgentisError } from '@agentis/core';
import type { AgentisToolContext } from '@agentis/core';
import type { AgentisToolRegistry } from './agentisToolRegistry.js';

export interface CodeModeCall { tool: string; ok: boolean; code?: string }
export interface CodeModeResult {
  ok: boolean;
  result?: unknown;
  logs: string[];
  calls: CodeModeCall[];
  error?: { code: string; message: string; tool?: string; remediation?: string };
}

export interface CodeModeOptions {
  maxCalls?: number;
  timeoutMs?: number;
  maxLogs?: number;
  maxCodeChars?: number;
  maxResultChars?: number;
}

const DEFAULTS = { maxCalls: 30, timeoutMs: 20_000, maxLogs: 200, maxCodeChars: 100_000, maxResultChars: 40_000 };

/** A tool call that failed inside agent code — carries the directive so it stays legible. */
class CodeModeToolError extends Error {
  constructor(readonly tool: string, readonly code: string, message: string, readonly remediation?: string) {
    super(message);
    this.name = 'CodeModeToolError';
  }
}

export class CodeModeService {
  constructor(
    private readonly registry: AgentisToolRegistry,
    private readonly opts: CodeModeOptions = {},
  ) {}

  /** Execute agent-written code against the `agentis.*` SDK. Never throws — returns a structured result. */
  async execute(input: { code: string; ctx: AgentisToolContext } & CodeModeOptions): Promise<CodeModeResult> {
    const o = { ...DEFAULTS, ...this.opts, ...pruneUndefined(input) };
    const logs: string[] = [];
    const calls: CodeModeCall[] = [];

    if (typeof input.code !== 'string' || !input.code.trim()) {
      return { ok: false, logs, calls, error: { code: 'CODE_MODE_ERROR', message: 'code must be a non-empty string' } };
    }
    if (input.code.length > o.maxCodeChars) {
      return { ok: false, logs, calls, error: { code: 'CODE_MODE_LIMIT', message: `code exceeds ${o.maxCodeChars} chars` } };
    }

    let callCount = 0;
    const sandbox = this.#buildSandbox(input.ctx, {
      beforeCall: () => { if (++callCount > o.maxCalls) throw new AgentisError('CODE_MODE_LIMIT', `exceeded the ${o.maxCalls}-tool-call budget for one code execution`); },
      afterCall: (c) => calls.push(c),
      log: (line) => { if (logs.length < o.maxLogs) logs.push(line); },
    });

    const context = vm.createContext(sandbox, { name: 'agentis-code-mode' });
    // Wrap in an async IIFE so `await` works and the agent can `return` a value.
    const wrapped = `'use strict';\n(async () => {\n${input.code}\n})()`;

    let running: unknown;
    try {
      // The sync `timeout` guards a synchronous infinite loop (a body with no awaits);
      // the async path below guards long-running awaited work.
      running = vm.runInContext(wrapped, context, { timeout: o.timeoutMs, filename: 'agent-code.js' });
    } catch (err) {
      return { ok: false, logs, calls, error: describeError(err) };
    }

    try {
      const result = await withTimeout(Promise.resolve(running), o.timeoutMs);
      return { ok: true, result: safeSerialize(result, o.maxResultChars), logs, calls };
    } catch (err) {
      return { ok: false, logs, calls, error: describeError(err) };
    }
  }

  /** The SDK surface an agent can call — for discovery (agentis.code.api). */
  describeApi(): { count: number; groups: Record<string, Array<{ call: string; description: string; input: unknown }>> } {
    const groups: Record<string, Array<{ call: string; description: string; input: unknown }>> = {};
    let count = 0;
    for (const def of this.registry.catalog({ mcpOnly: true }).tools) {
      count += 1;
      const ns = def.id.includes('.') ? def.id.split('.').slice(0, -1).join('.') : '(top-level)';
      (groups[ns] ??= []).push({ call: `${def.id}(args)`, description: def.description, input: def.inputSchema });
    }
    return { count, groups };
  }

  // ── internals ──────────────────────────────────────────────────────────

  #buildSandbox(
    ctx: AgentisToolContext,
    hooks: { beforeCall: () => void; afterCall: (c: CodeModeCall) => void; log: (line: string) => void },
  ): Record<string, unknown> {
    // A null-prototype root so the sandbox carries no inherited Object methods.
    const root: Record<string, unknown> = Object.create(null);
    for (const def of this.registry.catalog({ mcpOnly: true }).tools) {
      const fn = async (args: unknown = {}) => {
        hooks.beforeCall();
        const res = await this.registry.execute(
          { id: '', toolId: def.id, arguments: (args && typeof args === 'object' ? args : {}) as Record<string, unknown> },
          ctx,
        );
        hooks.afterCall({ tool: def.id, ok: res.ok, ...(res.errorCode ? { code: res.errorCode } : {}) });
        if (!res.ok) throw new CodeModeToolError(def.id, res.errorCode ?? 'TOOL_ERROR', res.errorMessage ?? 'tool failed', res.remediation);
        return res.output;
      };
      assignPath(root, def.id, fn);
    }
    // Captured console only — no ambient globals (no require/process/fetch/fs/etc).
    root.console = {
      log: (...a: unknown[]) => hooks.log(a.map(fmt).join(' ')),
      info: (...a: unknown[]) => hooks.log(a.map(fmt).join(' ')),
      warn: (...a: unknown[]) => hooks.log(a.map(fmt).join(' ')),
      error: (...a: unknown[]) => hooks.log(a.map(fmt).join(' ')),
    };
    return root;
  }
}

/** Nest a dotted tool id (agentis.channel.send) into the API object; flat ids stay top-level. */
function assignPath(root: Record<string, unknown>, id: string, fn: unknown): void {
  const parts = id.split('.');
  let node = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = Object.create(null);
    node = node[key] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]!] = fn;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AgentisError('CODE_MODE_LIMIT', `code execution exceeded the ${ms}ms time budget`)), ms);
  });
  return Promise.race([p.finally(() => clearTimeout(timer)), timeout]);
}

function describeError(err: unknown): { code: string; message: string; tool?: string; remediation?: string } {
  if (err instanceof CodeModeToolError) {
    return { code: err.code, message: `${err.tool} failed: ${err.message}`, tool: err.tool, ...(err.remediation ? { remediation: err.remediation } : {}) };
  }
  if (err instanceof AgentisError) {
    return { code: err.code, message: err.message, ...(err.remediation ? { remediation: err.remediation } : {}) };
  }
  const message = err instanceof Error ? err.message : String(err);
  // A vm sync-timeout surfaces as a generic Error with this message.
  const code = /Script execution timed out/i.test(message) ? 'CODE_MODE_LIMIT' : 'CODE_MODE_ERROR';
  return { code, message };
}

function fmt(v: unknown): string {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

/** JSON-safe serialization with a size cap (never let a huge blob back into the model). */
function safeSerialize(value: unknown, maxChars: number): unknown {
  const seen = new WeakSet<object>();
  const walk = (v: unknown, depth: number): unknown => {
    if (v === undefined) return null;
    if (v === null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
    if (typeof v === 'function') return '[function]';
    if (typeof v === 'bigint') return v.toString();
    if (depth > 8) return '[max depth]';
    if (typeof v === 'object') {
      if (seen.has(v as object)) return '[circular]';
      seen.add(v as object);
      if (Array.isArray(v)) return v.slice(0, 500).map((x) => walk(x, depth + 1));
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val, depth + 1);
      return out;
    }
    return String(v);
  };
  const serialized = walk(value, 0);
  const asText = JSON.stringify(serialized);
  if (asText && asText.length > maxChars) {
    return { truncated: true, note: `result exceeded ${maxChars} chars`, preview: asText.slice(0, maxChars) };
  }
  return serialized;
}

function pruneUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && k !== 'code' && k !== 'ctx') (out as Record<string, unknown>)[k] = v;
  return out;
}
