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
  // Native addons cannot be inlined by esbuild — their JS glue resolves the
  // `.node` binary at runtime and breaks when bundled (observed: onnxruntime's
  // `listSupportedBackends is not a function`, which crashed `agentis up` the
  // moment a chat turn tried to embed). Keep them external so `npm install -g`
  // installs each alongside the bundle with its native binding intact, exactly
  // like better-sqlite3. `@huggingface/transformers` is external too so esbuild
  // doesn't drag onnxruntime-node back into the bundle through it.
  external: [
    'better-sqlite3',
    'onnxruntime-node',
    '@huggingface/transformers',
  ],
  noExternal: [
    '@agentis/core',
    '@agentis/api',
    '@agentis/db',
    '@agentis/sdk',
  ],
});
