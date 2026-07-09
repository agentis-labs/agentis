import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['cjs'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: false,
  shims: false,
  treeshake: true,
  outExtension: () => ({ js: '.cjs' }),
  banner: { js: '#!/usr/bin/env node' },
  // better-sqlite3 ships native bindings, so npm installs it alongside the
  // bundled CLI instead of trying to inline it into the executable.
  external: [
    'better-sqlite3',
  ],
  noExternal: [
    '@agentis/core',
    '@agentis/api',
    '@agentis/db',
    '@agentis/sdk',
  ],
});
