import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    passWithNoTests: false,
    // Several engine integration tests drive a real run to a terminal event with
    // their OWN 15s internal deadline (event-driven `run()` helpers). The outer
    // vitest budget must exceed that, otherwise under full-suite CPU saturation
    // (forks pool + per-test RSA keygen + esbuild transforms) vitest aborts a
    // slow-but-correct run at 10s and the trailing assertions fail spuriously —
    // the cause of the "flaky in the full suite, green in isolation" failures.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
