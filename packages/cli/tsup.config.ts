import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: false,
  shims: false,
  treeshake: true,
  banner: { js: '#!/usr/bin/env node' },
  // Native bindings + heavy runtime deps stay external; npm installs them
  // alongside the published tarball via "dependencies" in package.json.
  external: [
    'better-sqlite3',
    'socket.io',
    'hono',
    '@hono/node-server',
    '@hono/node-server/serve-static',
    '@hono/zod-openapi',
    '@scalar/hono-api-reference',
    'bcryptjs',
    'drizzle-orm',
    'drizzle-orm/sqlite-core',
    'drizzle-orm/better-sqlite3',
    'drizzle-orm/pg-core',
    'drizzle-orm/postgres-js',
    'jose',
    'zod',
    'postgres',
  ],
  noExternal: [
    '@agentis/core',
    '@agentis/api',
    '@agentis/db',
  ],
});
