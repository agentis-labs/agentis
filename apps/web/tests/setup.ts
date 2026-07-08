/**
 * Per-test setup. Imports jest-dom matchers and resets the global fetch
 * stub between tests so component specs don't bleed network state.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

beforeEach(() => {
  // Default fetch stub — individual tests override via vi.spyOn(global, 'fetch').
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
  // jsdom storage is shared across tests by default.
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
