/**
 * `node_worker` skill runtime — V8 isolate via `isolated-vm`.
 *
 * `isolated-vm` is a native module that doesn't always compile cleanly on
 * every host. We import it dynamically so a missing or broken native binary
 * degrades gracefully to `SKILL_RUNTIME_UNAVAILABLE` instead of crashing
 * boot. Operators who want this tier install the native module themselves;
 * Agentis does not depend on it.
 *
 * Inside the isolate we expose:
 *  - `console.log/info/warn/error` (forwarded to the host logger)
 *  - `fetch` proxy that enforces the manifest's `allowedDomains`
 *  - `crypto.randomUUID`, `crypto.subtle.digest`, `crypto.subtle.generateKey`
 *  - the `input` and `scratchpad` parameters
 *
 * `process`, `require`, `import`, `__dirname`, env vars are NOT exposed.
 */

import { CONSTANTS, AgentisError } from '@agentis/core';
import type { SkillManifest, SkillExecutionOutcome } from '@agentis/core';
import type { Logger } from '../logger.js';
import { assertSafeUrl } from '../services/safeUrl.js';

// `isolated-vm` is loaded dynamically; we type it as `any` here because the
// module is intentionally NOT a declared dependency.
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
    // dynamic import — module not declared as a hard dep in package.json
    const ivm = (await import('isolated-vm' as string)) as IvmModule;
    cached = { kind: 'available', ivm };
  } catch (err) {
    cached = {
      kind: 'unavailable',
      reason: `isolated-vm not installed (${(err as Error).message}). Run \`pnpm add -w isolated-vm\` to enable node_worker skills.`,
    };
  }
  return cached;
}

export async function isNodeWorkerAvailable(): Promise<boolean> {
  const r = await loadIsolatedVm();
  return r.kind === 'available';
}

export async function runNodeWorkerSkill(args: {
  manifest: SkillManifest;
  source: string;
  input: Record<string, unknown>;
  scratchpad: Record<string, unknown>;
  allowedDomains: string[];
  allowPrivateNetwork: boolean;
  timeoutMs: number;
  logger: Logger;
}): Promise<SkillExecutionOutcome> {
  const start = Date.now();
  const loaded = await loadIsolatedVm();
  if (loaded.kind === 'unavailable') {
    return {
      ok: false,
      errorCode: 'SKILL_RUNTIME_UNAVAILABLE',
      message: loaded.reason,
      durationMs: Date.now() - start,
    };
  }
  const { ivm } = loaded;
  const isolate = new ivm.Isolate({ memoryLimit: CONSTANTS.SKILL_ISOLATE_HEAP_MB });
  try {
    const context = await isolate.createContext();
    const jail = context.global;
    await jail.set('global', jail.derefInto());
    // Expose a controlled console.
    await jail.set(
      '_log',
      new ivm.Reference((level: string, msg: string) => {
        args.logger.info('skill.node_worker.console', { level, msg, skill: args.manifest.slug });
      }),
    );
    // Expose fetch proxy. Calls back into host via Reference.
    await jail.set(
      '_fetchProxy',
      new ivm.Reference(async (url: string, init: { method?: string; body?: string } = {}) => {
        const safe = await assertSafeUrl(url, {
          allowPrivate: args.allowPrivateNetwork,
          allowedDomains: args.allowedDomains,
        });
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), args.timeoutMs).unref?.();
        try {
          const res = await fetch(safe.toString(), {
            method: init.method ?? 'GET',
            body: init.body,
            signal: controller.signal,
          });
          const text = await res.text();
          return JSON.stringify({ status: res.status, ok: res.ok, body: text });
        } finally {
          if (t) clearTimeout(t);
        }
      }),
    );
    // Bootstrap shim that builds the safe surface from the references above.
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
  return JSON.parse(raw);
};
`,
      { timeout: 1000 },
    );
    // Marshal input + scratchpad as JSON strings to avoid object-identity issues.
    const wrapped = `
(async function(input, scratchpad) {
${args.source}
return await main(input, scratchpad);
})(${JSON.stringify(args.input)}, ${JSON.stringify(args.scratchpad)})
`;
    const script = await isolate.compileScript(wrapped);
    const result: unknown = await script.run(context, { timeout: args.timeoutMs, promise: true });
    const output = typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : { value: result };
    return { ok: true, output, durationMs: Date.now() - start };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof AgentisError) {
      return {
        ok: false,
        errorCode: err.code === 'SKILL_SSRF_BLOCKED' || err.code === 'SKILL_NETWORK_VIOLATION' ? err.code : 'SKILL_INTERNAL',
        message,
        durationMs: Date.now() - start,
      };
    }
    if (message.includes('Script execution timed out')) {
      return { ok: false, errorCode: 'SKILL_TIMEOUT', message, durationMs: Date.now() - start };
    }
    return { ok: false, errorCode: 'SKILL_INTERNAL', message, durationMs: Date.now() - start };
  } finally {
    isolate.dispose();
  }
}
