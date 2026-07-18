import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'tsup';

/**
 * Copy the MCP stdio bridge next to the bundle. It is SPAWNED (`node <path>`),
 * never imported, so esbuild cannot inline it — it has to be a real file on disk.
 * This runs on EVERY build (not just `npm pack`) because `clean: true` wipes
 * `dist/`, and a hand-run `tsup` that omitted the bridge produced a bundle whose
 * Codex sessions silently mounted zero `agentis.*` tools.
 */
function copyMcpBridge(): void {
  const repoRoot = resolve(__dirname, '..', '..');
  const src = resolve(repoRoot, 'scripts', 'agentis-mcp-stdio-bridge.mjs');
  if (!existsSync(src)) throw new Error(`[tsup] missing MCP stdio bridge at ${src}`);
  const outDir = resolve(__dirname, 'dist', 'scripts');
  mkdirSync(outDir, { recursive: true });
  cpSync(src, resolve(outDir, 'agentis-mcp-stdio-bridge.mjs'));
}

export default defineConfig({
  onSuccess: async () => copyMcpBridge(),
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
    // `sharp` (pulled in by baileys for WhatsApp media) is a native addon too.
    // Inlining its glue left 43 bare `require("@img/sharp-*")` calls in the bundle
    // for platform packages npm never installs → MODULE_NOT_FOUND the first time a
    // user sent/received an image. Same failure class as the MCP stdio bridge.
    // Every entry here MUST also be a real `dependencies` entry — see
    // scripts/check-bundle-deps.mjs, which fails the build if that drifts.
    'sharp',
  ],
  noExternal: [
    '@agentis/core',
    '@agentis/api',
    '@agentis/db',
    '@agentis/sdk',
  ],
});
