/**
 * Builtin extension executors.
 *
 * Builtins are trusted, in-process extensions shipped with Agentis. They are still
 * represented as extension rows so workflow graphs always bind a real extension id or
 * slug instead of hiding deterministic work inside agent prompts.
 */

import { CONSTANTS } from '@agentis/core';
import type { ExtensionExecutionOutcome, ExtensionManifest } from '@agentis/core';
import { safeFetch } from './safeFetch.js';

type Executor = (
  input: Record<string, unknown>,
  scratchpad: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

const ALLOW_PRIVATE =
  String(process.env.AGENTIS_EXTENSION_HTTP_ALLOW_PRIVATE ?? '').toLowerCase() === 'true';

const BUILTIN_REGISTRY: Record<string, Executor> = {
  echo: async (input) => ({ ...input }),
  http_fetch: async (input) => {
    const url = String(input.url ?? '');
    const method = String(input.method ?? 'GET').toUpperCase();
    const headers = (input.headers as Record<string, string>) ?? {};
    const body = input.body !== undefined ? JSON.stringify(input.body) : undefined;

    if (!url) throw new Error('http_fetch requires `url`');
    // safeFetch pins the connection to the IP validated at check time and
    // re-validates redirects before following them.
    const res = await safeFetch(
      url,
      {
        method,
        headers: {
          'user-agent': 'Agentis/1.0 (builtin http_fetch extension)',
          ...headers,
        },
        body,
        timeoutMs: Math.min(15_000, CONSTANTS.EXTENSION_EXECUTION_TIMEOUT_MS),
      },
      { allowPrivate: ALLOW_PRIVATE },
    );
    const text = await res.text();
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(text);
    } catch {
      parsedBody = text;
    }
    return {
      status: res.status,
      ok: res.ok,
      body: parsedBody,
      headers: Object.fromEntries(res.headers.entries()),
    };
  },
};

/**
 * Entrypoints that need a larger execution budget than the default 30s.
 * Empty for now, but kept as a stable hook for boot-time reconciliation.
 */
export const BUILTIN_LONG_RUNNING_TIMEOUTS: Record<string, number> = {};

export async function runBuiltin(
  manifest: ExtensionManifest,
  operationName: string,
  input: Record<string, unknown>,
  scratchpad: Record<string, unknown>,
): Promise<ExtensionExecutionOutcome> {
  const start = Date.now();
  const executor = BUILTIN_REGISTRY[manifest.entrypoint ?? operationName] ?? BUILTIN_REGISTRY[operationName];
  if (!executor) {
    return {
      ok: false,
      errorCode: 'EXTENSION_INTERNAL',
      message: `Unknown builtin extension operation: ${operationName}`,
      durationMs: Date.now() - start,
      operationName,
    };
  }
  try {
    const output = await executor(input, scratchpad);
    return { ok: true, output, durationMs: Date.now() - start, operationName };
  } catch (err) {
    return {
      ok: false,
      errorCode: 'EXTENSION_INTERNAL',
      message: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
      operationName,
    };
  }
}

export const BUILTIN_EXTENSION_ENTRYPOINTS = Object.keys(BUILTIN_REGISTRY);
