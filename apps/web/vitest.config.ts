/**
 * Vitest config for @agentis/web — jsdom environment for React component
 * tests. Lives next to vite.config.ts because vitest reuses Vite's loader.
 */
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    css: false,
    // userEvent-heavy flows run ~4s alone but multiply under full-suite
    // parallel load; 10s flaked on slower machines.
    testTimeout: 20_000,
  },
});
