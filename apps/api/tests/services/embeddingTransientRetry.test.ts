/**
 * Model-load retry classification.
 *
 * The failure this guards against: `getaddrinfo ENOTFOUND huggingface.co` logged
 * at boot while `curl` and a standalone `node fetch` reach the same host fine.
 * DNS runs on the libuv threadpool; boot work saturates it, so the lookup starves
 * and surfaces a spurious ENOTFOUND. That single blip must be RETRIED, not treated
 * as a permanent outage that trips the 30-minute breaker.
 *
 * The inverse is just as important: a genuinely missing model (404 / "could not
 * locate file"), or an offline install with no cached weights, has nothing to wait
 * for and must NOT be retried — it should fail straight through with the remedy.
 *
 * These tests pin `isTransientLoadError`, the classifier that draws that line.
 */
import { describe, it, expect } from 'vitest';
import { isTransientLoadError } from '../../src/services/embedding/embeddingProvider.js';

/** Build an Error carrying a Node `code`, as `getaddrinfo`/undici errors do. */
function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('isTransientLoadError', () => {
  it('treats a bare ENOTFOUND as transient (the starved-DNS case)', () => {
    expect(isTransientLoadError(coded('getaddrinfo ENOTFOUND huggingface.co', 'ENOTFOUND'))).toBe(true);
  });

  it('unwraps the cause chain — fetch buries the code under "fetch failed"', () => {
    // Exactly how Node's global fetch rejects: a bare TypeError wrapping the real
    // errno in `.cause`.
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: coded('getaddrinfo ENOTFOUND huggingface.co', 'ENOTFOUND'),
    });
    expect(isTransientLoadError(err)).toBe(true);
  });

  it('matches transient DNS/socket codes regardless of message', () => {
    for (const code of ['EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT']) {
      expect(isTransientLoadError(coded('some network wobble', code))).toBe(true);
    }
  });

  it('treats a bare "fetch failed" (no code) as transient', () => {
    expect(isTransientLoadError(new TypeError('fetch failed'))).toBe(true);
  });

  it('does NOT retry a missing model (404 / could not locate file)', () => {
    expect(isTransientLoadError(new Error('Could not locate file: "onnx/model.onnx".'))).toBe(false);
    expect(isTransientLoadError(coded('Request failed with status 404', 'ERR_HTTP'))).toBe(false);
  });

  it('does NOT retry a plain unexpected error', () => {
    expect(isTransientLoadError(new Error('unexpected token in config'))).toBe(false);
    expect(isTransientLoadError(null)).toBe(false);
    expect(isTransientLoadError(undefined)).toBe(false);
  });

  it('stops walking a self-referential cause chain without hanging', () => {
    const err = new Error('boom') as Error & { cause?: unknown };
    err.cause = err; // pathological, but must terminate
    expect(isTransientLoadError(err)).toBe(false);
  });
});
