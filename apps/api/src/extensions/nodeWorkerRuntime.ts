/**
 * `node_worker` extension runtime - V8 isolate via `isolated-vm`.
 *
 * The native sandbox is loaded dynamically so a host without `isolated-vm`
 * returns a structured EXTENSION_RUNTIME_UNAVAILABLE outcome instead of failing
 * application boot.
 */

import { CONSTANTS, AgentisError } from '@agentis/core';
import type { ExtensionExecutionOutcome, ExtensionManifest, ExtensionPermission } from '@agentis/core';
import type { Logger } from '../logger.js';
import { safeFetch } from '../services/safeFetch.js';
import { normalizeExtensionSource } from './normalizeSource.js';
import { runVmExtension } from './vmRuntime.js';

// `isolated-vm` is intentionally optional.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IvmModule = any;

let cached:
  | { kind: 'available'; ivm: IvmModule }
  | { kind: 'unavailable'; reason: string }
  | undefined;

async function loadIsolatedVm(): Promise<
  | { kind: 'available'; ivm: IvmModule }
  | { kind: 'unavailable'; reason: string }
> {
  if (cached) return cached;
  try {
    const ivm = (await import('isolated-vm' as string)) as IvmModule;
    cached = { kind: 'available', ivm };
  } catch (err) {
    cached = {
      kind: 'unavailable',
      reason: `isolated-vm not installed (${(err as Error).message}). Run \`pnpm add -w isolated-vm\` to enable node_worker extensions.`,
    };
  }
  return cached;
}

export async function isNodeWorkerAvailable(): Promise<boolean> {
  // Always available: node:vm provides a built-in fallback when isolated-vm is
  // absent (unless a hardened deployment requires a real isolate).
  if (String(process.env.AGENTIS_EXTENSION_REQUIRE_ISOLATE ?? '').toLowerCase() !== 'true') return true;
  const r = await loadIsolatedVm();
  return r.kind === 'available';
}

/** One-shot warn flag so the vm-fallback notice is logged once per process. */
let warnedVmFallback = false;

/**
 * Listener-source hooks (EXTENSIONS-AND-LISTENER-10X §1.8). When an extension
 * operation runs as a Listener source, these back `ctx.emit`, `ctx.cursor`,
 * `ctx.setCursor`, and `ctx.kv` inside the isolate. Permission enforcement
 * lives in the host functions so the isolate can never bypass it.
 */
export interface ListenerHooks {
  emit: (payload: Record<string, unknown>) => void;
  getCursor: () => unknown;
  setCursor: (value: unknown) => void;
  kvGet: (key: string) => unknown;
  kvSet: (key: string, value: unknown, ttlSeconds?: number) => void;
}

export async function runNodeWorkerExtension(args: {
  manifest: ExtensionManifest;
  operationName: string;
  source: string;
  input: Record<string, unknown>;
  scratchpad: Record<string, unknown>;
  allowedDomains: string[];
  permissions: ExtensionPermission[];
  allowPrivateNetwork: boolean;
  timeoutMs: number;
  logger: Logger;
  /** When present, the operation runs with the Listener source contract. */
  listenerHooks?: ListenerHooks;
  /** Run-scoped cancellation: aborting disposes the isolate (hard stop). */
  signal?: AbortSignal;
}): Promise<ExtensionExecutionOutcome> {
  const start = Date.now();
  const loaded = await loadIsolatedVm();
  if (loaded.kind === 'unavailable') {
    // isolated-vm is a hardening upgrade, not a prerequisite. Fall back to the
    // built-in node:vm runtime so operators get value out of the box — unless a
    // hardened deployment explicitly requires a real isolate.
    const requireIsolate = String(process.env.AGENTIS_EXTENSION_REQUIRE_ISOLATE ?? '').toLowerCase() === 'true';
    if (requireIsolate) {
      return {
        ok: false,
        errorCode: 'EXTENSION_RUNTIME_UNAVAILABLE',
        message: `${loaded.reason} (AGENTIS_EXTENSION_REQUIRE_ISOLATE is set, so the node:vm fallback is disabled)`,
        durationMs: Date.now() - start,
        operationName: args.operationName,
      };
    }
    if (!warnedVmFallback) {
      warnedVmFallback = true;
      args.logger.warn('extension.runtime.vm_fallback', {
        reason: 'isolated-vm not installed — using node:vm fallback. Install isolated-vm for hardened isolation.',
      });
    }
    return runVmExtension(args);
  }

  const { ivm } = loaded;
  const isolate = new ivm.Isolate({ memoryLimit: CONSTANTS.EXTENSION_ISOLATE_HEAP_MB });
  // Run-scoped cancellation: disposing the isolate hard-stops the script
  // mid-execution (the run() promise rejects immediately) — a cancelled run
  // never waits for the extension timeout.
  const onAbort = () => { try { isolate.dispose(); } catch { /* already disposed */ } };
  args.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const context = await isolate.createContext();
    const jail = context.global;
    await jail.set('global', jail.derefInto());

    await jail.set(
      '_log',
      new ivm.Reference((level: string, msg: string) => {
        args.logger.info('extension.node_worker.console', { level, msg, extension: args.manifest.slug });
      }),
    );

    await jail.set(
      '_fetchProxy',
      new ivm.Reference(async (url: string, init: { method?: string; body?: string } = {}) => {
        if (!args.permissions.includes('network') && !args.permissions.includes('network.unrestricted')) {
          throw new AgentisError('EXTENSION_PERMISSION_DENIED', 'Extension manifest does not grant network access');
        }
        // safeFetch pins the connection to the IP validated at check time
        // (defeats DNS rebinding) and re-validates each redirect hop.
        const res = await safeFetch(
          url,
          { method: init.method ?? 'GET', body: init.body, timeoutMs: args.timeoutMs },
          {
            allowPrivate: args.allowPrivateNetwork,
            allowedDomains: args.permissions.includes('network.unrestricted') ? [] : args.allowedDomains,
          },
        );
        const text = await res.text();
        return JSON.stringify({
          status: res.status,
          statusText: res.statusText,
          ok: res.ok,
          redirected: res.redirected,
          type: res.type,
          url: res.url,
          headers: [...res.headers.entries()],
          body: text,
        });
      }),
    );

    const hasPerm = (p: ExtensionPermission) => args.permissions.includes(p);
    if (args.listenerHooks) {
      const hooks = args.listenerHooks;
      await jail.set(
        '_emit',
        new ivm.Reference((raw: string) => {
          if (!hasPerm('listener.emit')) {
            throw new AgentisError('EXTENSION_PERMISSION_DENIED', 'ctx.emit requires the `listener.emit` permission');
          }
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            payload = { value: raw };
          }
          hooks.emit(payload);
        }),
      );
      await jail.set(
        '_cursorGet',
        new ivm.Reference(() => {
          if (!hasPerm('listener.cursor')) return JSON.stringify({ ok: false, denied: true });
          return JSON.stringify({ ok: true, value: hooks.getCursor() ?? null });
        }),
      );
      await jail.set(
        '_cursorSet',
        new ivm.Reference((raw: string) => {
          if (!hasPerm('listener.cursor')) {
            throw new AgentisError('EXTENSION_PERMISSION_DENIED', 'ctx.setCursor requires the `listener.cursor` permission');
          }
          hooks.setCursor(JSON.parse(raw));
        }),
      );
      await jail.set(
        '_kvGet',
        new ivm.Reference((key: string) => {
          if (!hasPerm('kv.read')) {
            throw new AgentisError('EXTENSION_PERMISSION_DENIED', 'ctx.kv.get requires the `kv.read` permission');
          }
          return JSON.stringify({ value: hooks.kvGet(key) ?? null });
        }),
      );
      await jail.set(
        '_kvSet',
        new ivm.Reference((key: string, raw: string, ttl?: number) => {
          if (!hasPerm('kv.write')) {
            throw new AgentisError('EXTENSION_PERMISSION_DENIED', 'ctx.kv.set requires the `kv.write` permission');
          }
          hooks.kvSet(key, JSON.parse(raw), ttl);
        }),
      );
    }

    await context.eval(
      `
const console = {
  log: (...a) => _log.applySync(undefined, ['log', a.map(String).join(' ')]),
  info: (...a) => _log.applySync(undefined, ['info', a.map(String).join(' ')]),
  warn: (...a) => _log.applySync(undefined, ['warn', a.map(String).join(' ')]),
  error: (...a) => _log.applySync(undefined, ['error', a.map(String).join(' ')]),
};
const fetch = async (url, init) => {
  const raw = await _fetchProxy.apply(undefined, [url, init || {}], { result: { promise: true } });
  const response = JSON.parse(raw);
  const headerEntries = response.headers || [];
  return {
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    redirected: response.redirected,
    type: response.type,
    url: response.url,
    headers: {
      get: (name) => {
        const target = String(name).toLowerCase();
        const match = headerEntries.find(([key]) => String(key).toLowerCase() === target);
        return match ? match[1] : null;
      },
      has: (name) => {
        const target = String(name).toLowerCase();
        return headerEntries.some(([key]) => String(key).toLowerCase() === target);
      },
      entries: () => headerEntries[Symbol.iterator](),
      keys: () => headerEntries.map(([name]) => name)[Symbol.iterator](),
      values: () => headerEntries.map(([, value]) => value)[Symbol.iterator](),
      forEach: (callback) => headerEntries.forEach(([name, value]) => callback(value, name)),
      [Symbol.iterator]: () => headerEntries[Symbol.iterator](),
    },
    body: response.body,
    text: async () => response.body,
    json: async () => JSON.parse(response.body),
    arrayBuffer: async () => new TextEncoder().encode(response.body).buffer,
  };
};
// Listener-source contract (ctx.emit / ctx.cursor / ctx.setCursor / ctx.kv).
// Bindings resolve to undefined when the operation is not running as a source.
const emit = (typeof _emit !== 'undefined') ? ((p) => _emit.applySync(undefined, [JSON.stringify(p ?? {})])) : undefined;
const setCursor = (typeof _cursorSet !== 'undefined') ? ((v) => _cursorSet.applySync(undefined, [JSON.stringify(v ?? null)])) : undefined;
const __readCursor = () => {
  if (typeof _cursorGet === 'undefined') return undefined;
  const r = JSON.parse(_cursorGet.applySync(undefined, []));
  return r.ok ? r.value : undefined;
};
const kv = (typeof _kvGet !== 'undefined') ? {
  get: (k) => JSON.parse(_kvGet.applySync(undefined, [String(k)])).value,
  set: (k, v, ttl) => _kvSet.applySync(undefined, [String(k), JSON.stringify(v ?? null), ttl]),
} : undefined;
`,
      { timeout: 1000 },
    );

    const runtimeCtx = {
      inputs: args.input,
      scratchpadSnapshot: args.scratchpad,
      meta: {
        extension: {
          name: args.manifest.name,
          slug: args.manifest.slug,
          version: args.manifest.version,
          runtime: args.manifest.runtime,
          operationName: args.operationName,
        },
      },
    };
    const operationRegistry = args.manifest.operations
      .filter((operation) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(operation.name))
      .map((operation) => `${JSON.stringify(operation.name)}: typeof ${operation.name} === 'function' ? ${operation.name} : undefined`)
      .join(',\n');
    const wrapped = `
(async function(ctx) {
${normalizeExtensionSource(args.source)}
const __operations = {
${operationRegistry}
};
const __entrypoint = __operations[ctx.meta.extension.operationName]
  || (typeof execute === 'function' ? execute : null)
  || (typeof main === 'function' ? ((runtimeCtx) => main(runtimeCtx.inputs, runtimeCtx.scratchpadSnapshot)) : null);
if (!__entrypoint) throw new Error('EXTENSION_ENTRYPOINT_MISSING: export async function ' + ctx.meta.extension.operationName + '(inputs, ctx)');
ctx.http = { fetch };
if (emit) ctx.emit = emit;
if (setCursor) ctx.setCursor = setCursor;
if (kv) ctx.kv = kv;
ctx.cursor = __readCursor();
return await (__entrypoint.length >= 2 ? __entrypoint(ctx.inputs, ctx) : __entrypoint(ctx));
})(${JSON.stringify(runtimeCtx)})
`;
    const script = await isolate.compileScript(wrapped);
    const result: unknown = await script.run(context, { timeout: args.timeoutMs, promise: true });
    const output = typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : { value: result };
    return { ok: true, output, durationMs: Date.now() - start, operationName: args.operationName };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof AgentisError) {
      return {
        ok: false,
        errorCode: err.code === 'EXTENSION_SSRF_BLOCKED' || err.code === 'EXTENSION_NETWORK_VIOLATION' || err.code === 'EXTENSION_PERMISSION_DENIED'
          ? err.code
          : 'EXTENSION_INTERNAL',
        message,
        durationMs: Date.now() - start,
        operationName: args.operationName,
      };
    }
    if (message.includes('Script execution timed out')) {
      return { ok: false, errorCode: 'EXTENSION_TIMEOUT', message, durationMs: Date.now() - start, operationName: args.operationName };
    }
    return {
      ok: false,
      errorCode: message.includes('EXTENSION_ENTRYPOINT_MISSING') ? 'EXTENSION_ENTRYPOINT_MISSING' : 'EXTENSION_INTERNAL',
      message,
      durationMs: Date.now() - start,
      operationName: args.operationName,
    };
  } finally {
    args.signal?.removeEventListener('abort', onAbort);
    try { isolate.dispose(); } catch { /* disposed by abort */ }
  }
}

