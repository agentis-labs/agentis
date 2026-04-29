/**
 * Builtin skill executors.
 *
 * The set is intentionally tiny in V1: `echo` for testing the engine end-to-end
 * and `http_fetch` for letting workflows touch the outside world without
 * building a custom skill. Both run in-process; no network sandboxing applies
 * because builtin tier is fully trusted.
 *
 * Adding new builtin skills:
 *  1. Add an executor function below.
 *  2. Register it in BUILTIN_REGISTRY.
 *  3. Add the corresponding row to seed.ts so `Skill.entrypoint` matches.
 */

import { CONSTANTS } from '@agentis/core';
import type { SkillExecutionOutcome, SkillManifest } from '@agentis/core';
import { assertSafeUrl } from './safeUrl.js';

type Executor = (
  input: Record<string, unknown>,
  scratchpad: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

const ALLOW_PRIVATE =
  String(process.env.AGENTIS_SKILL_HTTP_ALLOW_PRIVATE ?? '').toLowerCase() === 'true';

const BUILTIN_REGISTRY: Record<string, Executor> = {
  echo: async (input) => ({ ...input }),
  http_fetch: async (input) => {
    const url = String(input.url ?? '');
    const method = String(input.method ?? 'GET').toUpperCase();
    const headers = (input.headers as Record<string, string>) ?? {};
    const body = input.body !== undefined ? JSON.stringify(input.body) : undefined;

    if (!url) throw new Error('http_fetch requires `url`');
    // SSRF guard: protocol allowlist + RFC1918/loopback/link-local block.
    // Operator can opt-in to private addressing with AGENTIS_SKILL_HTTP_ALLOW_PRIVATE=true.
    const safe = await assertSafeUrl(url, { allowPrivate: ALLOW_PRIVATE });

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.min(15_000, CONSTANTS.SKILL_EXECUTION_TIMEOUT_MS),
    );
    try {
      const res = await fetch(safe.toString(), {
        method,
        headers: {
          'user-agent': 'Agentis/1.0 (builtin http_fetch)',
          ...headers,
        },
        body,
        signal: controller.signal,
      });
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
    } finally {
      clearTimeout(timeout);
    }
  },
};

export async function runBuiltin(
  manifest: SkillManifest,
  input: Record<string, unknown>,
  scratchpad: Record<string, unknown>,
): Promise<SkillExecutionOutcome> {
  const start = Date.now();
  const executor = BUILTIN_REGISTRY[manifest.entrypoint];
  if (!executor) {
    return {
      ok: false,
      errorCode: 'SKILL_INTERNAL',
      message: `Unknown builtin skill entrypoint: ${manifest.entrypoint}`,
      durationMs: Date.now() - start,
    };
  }
  try {
    const output = await executor(input, scratchpad);
    return { ok: true, output, durationMs: Date.now() - start };
  } catch (err) {
    return {
      ok: false,
      errorCode: 'SKILL_INTERNAL',
      message: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  }
}

export const BUILTIN_SKILL_ENTRYPOINTS = Object.keys(BUILTIN_REGISTRY);
