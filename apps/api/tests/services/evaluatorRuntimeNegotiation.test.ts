/**
 * EvaluatorRuntime capability negotiation.
 *
 * The runtime must be reachable by ANY model. When an endpoint rejects a
 * request parameter as unsupported, the runtime drops/adapts it and retries —
 * reacting to the server's own error, never branching on a model family.
 */
import { describe, expect, it, vi } from 'vitest';
import { EvaluatorRuntime } from '../../src/services/evaluatorRuntime.js';
import type { Logger } from '../../src/logger.js';

const logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

function resp(status: number, text: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return text; },
    async json() { return JSON.parse(text); },
  } as unknown as Response;
}

const okBody = JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] });

describe('EvaluatorRuntime — generic param negotiation', () => {
  it('drops an unsupported temperature and renames max_tokens, then succeeds', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      seen.push(body);
      if ('temperature' in body) return resp(400, "Unsupported value: 'temperature' does not support 0 with this model.");
      if ('max_tokens' in body) return resp(400, "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead.");
      return resp(200, okBody);
    }) as unknown as typeof fetch;

    const runtime = new EvaluatorRuntime({ baseUrl: 'https://x/v1', model: 'any-model', logger, fetchImpl });
    const out = await runtime.completeStructured<{ ok: boolean }>({ system: 's', user: 'u' });

    expect(out).toEqual({ ok: true });
    // 1) temperature rejected, 2) max_tokens rejected, 3) max_completion_tokens accepted
    expect(seen).toHaveLength(3);
    expect('temperature' in seen[2]!).toBe(false);
    expect('max_tokens' in seen[2]!).toBe(false);
    expect('max_completion_tokens' in seen[2]!).toBe(true);
    expect(runtime.lastError).toBeNull();
  });

  it('exposes the backend error when it is not a negotiable parameter', async () => {
    const fetchImpl = vi.fn(async () => resp(401, 'invalid api key')) as unknown as typeof fetch;
    const runtime = new EvaluatorRuntime({ baseUrl: 'https://x/v1', model: 'any-model', logger, fetchImpl });
    const out = await runtime.completeStructured({ system: 's', user: 'u', maxAttempts: 1 });
    expect(out).toBeNull();
    expect(runtime.lastError).toContain('401');
  });
});
