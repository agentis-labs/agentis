/**
 * ExtensionLibraryService — Volume-backed extension source files + node_worker
 * extension authoring. (Behavioral protocol injection moved to the Abilities
 * subsystem; see ability.test.ts / abilityBundle.test.ts.)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { AgentisError } from '@agentis/core';
import { WorkspaceVolumeService } from '../../src/services/workspaceVolume.js';
import { ExtensionLibraryService } from '../../src/services/extensionLibrary.js';
import { createTestContext } from '../_helpers/createTestContext.js';

let dataDir: string;
let volume: WorkspaceVolumeService;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'agentis-ext-lib-'));
  volume = new WorkspaceVolumeService(dataDir);
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('ExtensionLibraryService', () => {
  it('creates a node_worker extension as both a Volume markdown file and an executable DB row, and lists it', async () => {
    const dbCtx = await createTestContext();
    try {
      const library = new ExtensionLibraryService(volume, dbCtx.db);
      const created = await library.createNodeWorkerExtension(
        { workspaceId: dbCtx.workspace.id, ambientId: dbCtx.ambient.id, userId: dbCtx.user.id },
        {
          name: 'Custom Scraper',
          source: 'export async function main(input) { return { ok: true, input }; }',
          capabilityTags: ['scraping'],
          allowedDomains: ['example.com'],
        },
      );

      // Volume markdown mirror.
      const md = await volume.read(dbCtx.workspace.id, created.path);
      expect(md).toMatch(/runtime: node_worker/);
      expect(md).toMatch(/export async function main/);

      // Executable DB row.
      const row = dbCtx.db.select().from(schema.extensions).where(eq(schema.extensions.id, created.id)).get();
      expect(row?.slug).toBe('custom-scraper');
      expect((row?.manifest as { source?: string } | undefined)?.source).toMatch(/main/);

      // Listed as a source file.
      const sources = await library.listSourceFiles(dbCtx.workspace.id);
      expect(sources.map((s) => s.name)).toContain('custom-scraper');
    } finally {
      dbCtx.close();
    }
  });

  it('rejects malformed executable manifests before writing or persisting them', async () => {
    const dbCtx = await createTestContext();
    try {
      const library = new ExtensionLibraryService(volume, dbCtx.db);
      await expect(library.createNodeWorkerExtension(
        { workspaceId: dbCtx.workspace.id, ambientId: dbCtx.ambient.id, userId: dbCtx.user.id },
        {
          name: 'Broken Listener',
          source: 'export async function broken() {}',
          operations: [{
            name: 'not-a-valid-export',
            inputSchema: {},
            outputSchema: {},
          }],
        },
      )).rejects.toMatchObject<Partial<AgentisError>>({
        code: 'EXTENSION_MANIFEST_INVALID',
      });

      expect(await library.listSourceFiles(dbCtx.workspace.id)).toEqual([]);
      expect(dbCtx.db.select().from(schema.extensions).all()).toEqual([]);
    } finally {
      dbCtx.close();
    }
  });

  it('rejects CommonJS source at creation so a "require is not defined" extension can never be persisted', async () => {
    const dbCtx = await createTestContext();
    try {
      const library = new ExtensionLibraryService(volume, dbCtx.db);
      await expect(library.createNodeWorkerExtension(
        { workspaceId: dbCtx.workspace.id, ambientId: dbCtx.ambient.id, userId: dbCtx.user.id },
        {
          name: 'CJS Scraper',
          source: `const crypto = require('crypto');\nexport async function execute(inputs, ctx) { return { id: crypto.randomUUID() }; }`,
          operations: [{ name: 'execute', inputSchema: {}, outputSchema: {} }],
        },
      )).rejects.toMatchObject<Partial<AgentisError>>({ code: 'VALIDATION_FAILED' });

      // Nothing was written to the volume or the database.
      expect(await library.listSourceFiles(dbCtx.workspace.id)).toEqual([]);
      expect(dbCtx.db.select().from(schema.extensions).all()).toEqual([]);
    } finally {
      dbCtx.close();
    }
  });

  it('updates a semantically identical extension instead of creating a renamed duplicate', async () => {
    const dbCtx = await createTestContext();
    try {
      const library = new ExtensionLibraryService(volume, dbCtx.db);
      const scope = { workspaceId: dbCtx.workspace.id, ambientId: dbCtx.ambient.id, userId: dbCtx.user.id };
      const original = await library.createNodeWorkerExtension(scope, {
        name: 'AI News Site Monitor',
        slug: 'ai_news_site_monitor',
        source: 'export async function fetchPosts() { return { posts: [] }; }',
        operations: [{ name: 'fetchPosts', inputSchema: {}, outputSchema: {} }],
      });
      const updated = await library.createNodeWorkerExtension(scope, {
        name: 'AI News Site Monitor',
        slug: 'ai-news-site-monitor-listener',
        source: 'export async function listen(input, ctx) { await ctx.emit(input); return {}; }',
        operations: [{
          name: 'listen',
          inputSchema: {},
          outputSchema: {},
          isListenerSource: true,
          listenerConfig: { emitsEvents: true },
        }],
        permissions: ['listener', 'listener.emit'],
      });

      expect(updated.id).toBe(original.id);
      expect(updated.created).toBe(false);
      expect(updated.matchedBy).toBe('identity');
      expect(updated.manifest.slug).toBe('ai_news_site_monitor');
      expect(dbCtx.db.select().from(schema.extensions).all()).toHaveLength(1);
    } finally {
      dbCtx.close();
    }
  });

  it('rejects listener labels that do not declare an executable listener source', async () => {
    const dbCtx = await createTestContext();
    try {
      const library = new ExtensionLibraryService(volume, dbCtx.db);
      await expect(library.createNodeWorkerExtension(
        { workspaceId: dbCtx.workspace.id, ambientId: dbCtx.ambient.id, userId: dbCtx.user.id },
        {
          name: 'Decorative Listener',
          source: 'export async function poll() { return {}; }',
          operations: [{ name: 'poll', inputSchema: {}, outputSchema: {} }],
          permissions: ['listener'],
        },
      )).rejects.toMatchObject<Partial<AgentisError>>({
        code: 'EXTENSION_MANIFEST_INVALID',
      });
    } finally {
      dbCtx.close();
    }
  });
});
