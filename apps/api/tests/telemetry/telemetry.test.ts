/**
 * Telemetry abstraction tests (D38 / Batch 8).
 *
 * Pins the contract that:
 *   - noopTelemetry returns the wrapped function's value and never throws
 *     on shutdown.
 *   - loadTelemetry(null) returns noopTelemetry.
 *   - loadTelemetry({...}) gracefully degrades to noop + warns when the
 *     OpenTelemetry SDK packages are not installed (the default install).
 *   - exceptions thrown inside `span(name, fn)` are re-thrown unchanged.
 */

import { describe, it, expect, vi } from 'vitest';
import { loadTelemetry, noopTelemetry } from '../../src/telemetry/index.js';

describe('noopTelemetry', () => {
  it('returns the wrapped function result', async () => {
    const out = await noopTelemetry.span('whatever', async () => 42);
    expect(out).toBe(42);
  });

  it('rethrows exceptions from the wrapped function', async () => {
    await expect(
      noopTelemetry.span('boom', async () => {
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
  });

  it('shutdown resolves without error', async () => {
    await expect(noopTelemetry.shutdown()).resolves.toBeUndefined();
  });
});

describe('loadTelemetry', () => {
  it('returns the no-op tracer when called with null', async () => {
    const t = await loadTelemetry(null);
    expect(t).toBe(noopTelemetry);
  });

  it('falls back to no-op + warns when the OTel SDK is not installed', async () => {
    const warn = vi.fn();
    const info = vi.fn();
    const t = await loadTelemetry({
      endpoint: 'http://localhost:4318/v1/traces',
      logger: { info, warn },
    });

    // The default Agentis install does not depend on @opentelemetry/sdk-node.
    // The loader must surface that as a warning, not a hard failure, and
    // give back a tracer that still satisfies the Telemetry interface.
    expect(warn).toHaveBeenCalledWith(
      'telemetry.otel_unavailable',
      expect.objectContaining({ err: expect.any(String) }),
    );
    const out = await t.span('engine.tick', async () => 'ok');
    expect(out).toBe('ok');
    await expect(t.shutdown()).resolves.toBeUndefined();
  });
});
