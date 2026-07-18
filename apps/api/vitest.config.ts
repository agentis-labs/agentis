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
    // NOTE (memory, the analogue of the timeout note above): under the full
    // suite the Chromium browser-node test can die with "Fatal JavaScript out of
    // memory: MemoryChunk allocation failed during deserialization" — green in
    // isolation, so it reads as a broken test rather than a resource limit.
    //
    // Do NOT "fix" this with `poolOptions.forks.execArgv:
    // ['--max-old-space-size=4096']`. That was measured and made things
    // decisively WORSE: the forks pool runs many workers in parallel, so a 4GB
    // per-fork heap oversubscribes the machine and the run degrades from 1
    // failure to 10 failures / 25 failed files with cascading
    // "[vitest-worker]: Timeout calling onTaskUpdate" errors. If this needs
    // solving, cap parallelism (`poolOptions.forks.maxForks`) or isolate the
    // browser test into its own project — do not raise per-worker heap.
  },
});
