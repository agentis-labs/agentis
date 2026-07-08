/**
 * `node:vm` fallback runtime for node_worker extensions.
 *
 * `isolated-vm` is a HARDENING upgrade, not a prerequisite. When it is not
 * installed, operator extensions still run here — in a restricted `node:vm`
 * context with no `require`, no `process`, and only the explicitly injected
 * `console`, `fetch` (permission + SSRF checked), and the listener `ctx`
 * surface. Synchronous runaway is bounded by the vm `timeout`; async work is
 * bounded by the caller's Promise.race timeout.
 *
 * Security posture: `node:vm` is NOT a true security boundary (a determined
 * script can reach host globals via the constructor chain). It is appropriate
 * for an operator's OWN trusted code in their OWN workspace — which is the
 * default value path. For untrusted / registry extensions, install
 * `isolated-vm` (auto-detected) or set `AGENTIS_EXTENSION_REQUIRE_ISOLATE=true`
 * to refuse execution without a hardened isolate.
 */

import vm from 'node:vm';
import { AgentisError } from '@agentis/core';
import type { ExtensionExecutionOutcome, ExtensionManifest, ExtensionPermission } from '@agentis/core';
import type { Logger } from '../logger.js';
import { safeFetch } from '../services/safeFetch.js';
import { normalizeExtensionSource } from './normalizeSource.js';
import type { ListenerHooks } from './nodeWorkerRuntime.js';

export async function runVmExtension(args: {
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
  listenerHooks?: ListenerHooks;
}): Promise<ExtensionExecutionOutcome> {
  const start = Date.now();
  const hasPerm = (p: ExtensionPermission) => args.permissions.includes(p);

  const fetchProxy = async (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
    if (!hasPerm('network') && !hasPerm('network.unrestricted')) {
      throw new AgentisError('EXTENSION_PERMISSION_DENIED', 'Extension manifest does not grant network access');
    }
    // safeFetch pins the connection to the IP validated at check time (defeats
    // DNS rebinding) and re-validates every redirect hop.
    {
      const res = await safeFetch(
        url,
        { method: init.method ?? 'GET', body: init.body, headers: init.headers, timeoutMs: args.timeoutMs },
        {
          allowPrivate: args.allowPrivateNetwork,
          allowedDomains: hasPerm('network.unrestricted') ? [] : args.allowedDomains,
        },
      );
      const bytes = await res.arrayBuffer();
      const text = new TextDecoder().decode(bytes);
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* keep text */
      }
      const headerEntries = [...res.headers.entries()];
      const headers = {
        get: (name: string) => res.headers.get(name),
        has: (name: string) => res.headers.has(name),
        entries: () => headerEntries[Symbol.iterator](),
        keys: () => headerEntries.map(([name]) => name)[Symbol.iterator](),
        values: () => headerEntries.map(([, value]) => value)[Symbol.iterator](),
        forEach: (callback: (value: string, name: string) => void) => {
          for (const [name, value] of headerEntries) callback(value, name);
        },
        [Symbol.iterator]: () => headerEntries[Symbol.iterator](),
      };
      return {
        status: res.status,
        statusText: res.statusText,
        ok: res.ok,
        redirected: res.redirected,
        type: res.type,
        url: res.url,
        headers,
        // Keep the legacy fields while exposing the standard response methods
        // generated extensions naturally expect.
        body,
        text: async () => text,
        json: async () => JSON.parse(text) as unknown,
        arrayBuffer: async () => bytes.slice(0),
      };
    }
  };

  const consoleProxy = {
    log: (...a: unknown[]) => args.logger.info('extension.vm.console', { level: 'log', msg: a.map(String).join(' '), extension: args.manifest.slug }),
    info: (...a: unknown[]) => args.logger.info('extension.vm.console', { level: 'info', msg: a.map(String).join(' '), extension: args.manifest.slug }),
    warn: (...a: unknown[]) => args.logger.info('extension.vm.console', { level: 'warn', msg: a.map(String).join(' '), extension: args.manifest.slug }),
    error: (...a: unknown[]) => args.logger.info('extension.vm.console', { level: 'error', msg: a.map(String).join(' '), extension: args.manifest.slug }),
  };

  const ctx: Record<string, unknown> = {
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
    http: { fetch: fetchProxy },
  };

  if (args.listenerHooks) {
    const hooks = args.listenerHooks;
    ctx.emit = (payload: Record<string, unknown>) => {
      if (!hasPerm('listener.emit')) throw new AgentisError('EXTENSION_PERMISSION_DENIED', 'ctx.emit requires the `listener.emit` permission');
      hooks.emit(payload ?? {});
    };
    ctx.setCursor = (value: unknown) => {
      if (!hasPerm('listener.cursor')) throw new AgentisError('EXTENSION_PERMISSION_DENIED', 'ctx.setCursor requires the `listener.cursor` permission');
      hooks.setCursor(value);
    };
    ctx.cursor = hasPerm('listener.cursor') ? hooks.getCursor() : undefined;
    ctx.kv = {
      get: (key: string) => {
        if (!hasPerm('kv.read')) throw new AgentisError('EXTENSION_PERMISSION_DENIED', 'ctx.kv.get requires the `kv.read` permission');
        return hooks.kvGet(key);
      },
      set: (key: string, value: unknown, ttlSeconds?: number) => {
        if (!hasPerm('kv.write')) throw new AgentisError('EXTENSION_PERMISSION_DENIED', 'ctx.kv.set requires the `kv.write` permission');
        hooks.kvSet(key, value, ttlSeconds);
      },
    };
  }

  const operationRegistry = args.manifest.operations
    .filter((operation) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(operation.name))
    .map((operation) => `${JSON.stringify(operation.name)}: typeof ${operation.name} === 'function' ? ${operation.name} : undefined`)
    .join(',\n');

  const wrapped = `(async function(){
${normalizeExtensionSource(args.source)}
const __operations = {
${operationRegistry}
};
const __entrypoint = __operations[__ctx.meta.extension.operationName]
  || (typeof execute === 'function' ? execute : null)
  || (typeof main === 'function' ? ((c) => main(c.inputs, c.scratchpadSnapshot)) : null);
if (!__entrypoint) throw new Error('EXTENSION_ENTRYPOINT_MISSING: export async function ' + __ctx.meta.extension.operationName + '(inputs, ctx)');
return await (__entrypoint.length >= 2 ? __entrypoint(__ctx.inputs, __ctx) : __entrypoint(__ctx));
})()`;

  const sandbox: Record<string, unknown> = {
    console: consoleProxy,
    fetch: fetchProxy,
    __ctx: ctx,
    // Common globals operator code expects; deliberately NO require/process/global.
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Math,
    Date,
    JSON,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, Math.min(ms, args.timeoutMs)),
  };
  const context = vm.createContext(sandbox, { name: `ext:${args.manifest.slug}` });

  try {
    const script = new vm.Script(wrapped, { filename: `${args.manifest.slug}.js` });
    const resultPromise = script.runInContext(context, { timeout: args.timeoutMs }) as Promise<unknown>;
    const result = await resultPromise;
    const output = typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : { value: result };
    return { ok: true, output, durationMs: Date.now() - start, operationName: args.operationName };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof AgentisError) {
      return { ok: false, errorCode: err.code === 'EXTENSION_PERMISSION_DENIED' ? 'EXTENSION_PERMISSION_DENIED' : 'EXTENSION_INTERNAL', message, durationMs: Date.now() - start, operationName: args.operationName };
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
  }
}
