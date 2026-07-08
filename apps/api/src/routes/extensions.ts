/**
 * /v1/extensions - workspace-scoped deterministic runtime capabilities.
 */

import { Hono, type Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AgentisError, CONSTANTS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { ExtensionLibraryService } from '../services/extensionLibrary.js';
import type { ExtensionKvStore } from '../extensions/kv.js';
import { ExtensionRuntime, normalizeExtensionManifest, validateExtensionManifest } from '../services/extensionRuntime.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

const operationSchema = z.object({
  name: z.string().min(1),
  description: z.string().max(2_000).optional(),
  inputSchema: z.record(z.unknown()).default({}),
  outputSchema: z.record(z.unknown()).default({}),
  isListenerSource: z.boolean().optional(),
  listenerConfig: z
    .object({
      emitsEvents: z.boolean().optional(),
      cursorSupported: z.boolean().optional(),
      description: z.string().max(2_000).optional(),
    })
    .optional(),
});

const installLocalExtensionSchema = z.object({
  manifest: z.object({
    name: z.string().min(1),
    slug: z.string().min(1),
    version: z.string().min(1),
    description: z.string().max(2_000).optional(),
    author: z.string().max(200).optional(),
    homepage: z.string().max(2_000).optional(),
    icon: z.string().max(4_000).optional(),
    runtime: z.literal('node_worker'),
    entrypoint: z.string().min(1).optional(),
    source: z.string().min(1).max(1_000_000),
    operations: z.array(operationSchema).min(1).optional(),
    listenerOperations: z.array(z.string()).optional(),
    permissions: z.array(z.string()).default([]),
    credentialKeys: z.array(z.union([
      z.string(),
      z.object({ key: z.string().min(1), label: z.string().optional(), required: z.boolean().optional() }),
    ])).optional(),
    categories: z.array(z.string()).optional(),
    capabilityTags: z.array(z.string()).default([]),
    inputSchema: z.record(z.unknown()).default({}),
    outputSchema: z.record(z.unknown()).default({}),
    allowedDomains: z.array(z.string()).default([]),
    timeoutMs: z.number().int().positive().max(CONSTANTS.EXTENSION_EXECUTION_MAX_TIMEOUT_MS).optional(),
  }),
  permissionsAcknowledged: z.array(z.string()).default([]),
});

export function buildExtensionRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  extensionLibrary?: ExtensionLibraryService;
  runtime?: ExtensionRuntime;
  kv?: ExtensionKvStore;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    return c.json({
      extensions: deps.db
        .select()
        .from(schema.extensions)
        .where(eq(schema.extensions.workspaceId, ws.workspaceId))
        .all(),
    });
  });

  // Discovery: extensions whose operations are valid Listener sources.
  // (Static path declared before /:id so Hono does not treat it as an id.)
  app.get('/listener-sources', (c) => {
    const ws = getWorkspace(c);
    const rows = deps.db.select().from(schema.extensions).where(eq(schema.extensions.workspaceId, ws.workspaceId)).all();
    const sources = rows
      .map((row) => {
        const manifest = normalizeExtensionManifest(row.manifest, row);
        const operations = manifest.operations.filter(
          (op) => op.isListenerSource || (manifest.listenerOperations ?? []).includes(op.name),
        );
        const permissions = manifest.permissions ?? [];
        if (
          operations.length === 0
          || !permissions.includes('listener')
          || !permissions.includes('listener.emit')
        ) return null;
        return {
          id: row.id,
          slug: row.slug,
          name: row.name,
          runtime: row.runtime,
          operations: operations.map((op) => ({
            name: op.name,
            description: op.description,
            inputSchema: op.inputSchema,
            listenerConfig: op.listenerConfig,
            cursorSupported: op.listenerConfig?.cursorSupported ?? false,
          })),
        };
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);
    return c.json({ sources });
  });

  app.post('/install-local', async (c) => {
    const ws = getWorkspace(c);
    const body = installLocalExtensionSchema.parse(await c.req.json());
    const manifest = normalizeExtensionManifest(body.manifest);
    validateExtensionManifest(manifest, { install: true });
    assertPermissionsAcknowledged(manifest.permissions ?? [], body.permissionsAcknowledged);

    if (!deps.extensionLibrary) {
      throw new AgentisError(
        'EXTENSION_RUNTIME_UNAVAILABLE',
        'Extension install requires the extension library so duplicate capabilities are resolved consistently.',
      );
    }
    const created = await deps.extensionLibrary.createNodeWorkerExtension(
      { workspaceId: ws.workspaceId, ambientId: ws.ambientId, userId: ws.user.id },
      {
        name: manifest.name,
        slug: manifest.slug,
        version: manifest.version,
        description: manifest.description,
        source: manifest.source ?? '',
        operations: manifest.operations,
        permissions: manifest.permissions ?? [],
        credentialKeys: manifest.credentialKeys,
        categories: manifest.categories,
        capabilityTags: manifest.capabilityTags,
        allowedDomains: manifest.allowedDomains,
        timeoutMs: manifest.timeoutMs,
      },
    );
    return c.json({
      extension: {
        id: created.id,
        slug: created.manifest.slug,
        name: created.manifest.name,
        runtime: created.manifest.runtime,
        path: created.path,
        created: created.created,
        matchedBy: created.matchedBy,
      },
    }, created.created ? 201 : 200);
  });

  app.get('/:id', (c) => {
    const ws = getWorkspace(c);
    const row = deps.db
      .select()
      .from(schema.extensions)
      .where(and(eq(schema.extensions.id, c.req.param('id')), eq(schema.extensions.workspaceId, ws.workspaceId)))
      .get();
    if (!row) throw new AgentisError('EXTENSION_NOT_FOUND', 'extension not found');
    return c.json({ extension: row });
  });

  app.post('/:id/test', async (c) => {
    if (!deps.runtime) throw new AgentisError('EXTENSION_RUNTIME_UNAVAILABLE', 'Extension runtime is not wired');
    const ws = getWorkspace(c);
    const body = z.object({
      operationName: z.string().min(1),
      input: z.record(z.unknown()).default({}),
      scratchpadSnapshot: z.record(z.unknown()).default({}),
    }).parse(await c.req.json());
    const result = await deps.runtime.execute({
      workspaceId: ws.workspaceId,
      extensionId: c.req.param('id'),
      operationName: body.operationName,
      input: body.input,
      scratchpadSnapshot: body.scratchpadSnapshot,
    });
    return c.json({ result });
  });

  app.delete('/:id', (c) => {
    const ws = getWorkspace(c);
    const result = deps.db
      .delete(schema.extensions)
      .where(and(eq(schema.extensions.id, c.req.param('id')), eq(schema.extensions.workspaceId, ws.workspaceId)))
      .run();
    if (result.changes === 0) throw new AgentisError('EXTENSION_NOT_FOUND', 'extension not found');
    return c.json({ ok: true });
  });

  // Operation-level execution history (§6.2).
  app.get('/:id/executions', (c) => {
    const ws = getWorkspace(c);
    const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200);
    const rows = deps.db
      .select()
      .from(schema.extensionExecutions)
      .where(and(eq(schema.extensionExecutions.extensionId, c.req.param('id')), eq(schema.extensionExecutions.workspaceId, ws.workspaceId)))
      .all();
    const sorted = rows.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? '')).slice(0, limit);
    return c.json({ executions: sorted });
  });

  // ── Extension KV store (§6.2) ──────────────────────────────────────────────
  const requireKv = () => {
    if (!deps.kv) throw new AgentisError('EXTENSION_RUNTIME_UNAVAILABLE', 'Extension KV store is not wired');
    return deps.kv;
  };
  const ownExtension = (c: Context, id: string) => {
    const ws = getWorkspace(c);
    const row = deps.db
      .select()
      .from(schema.extensions)
      .where(and(eq(schema.extensions.id, id), eq(schema.extensions.workspaceId, ws.workspaceId)))
      .get();
    if (!row) throw new AgentisError('EXTENSION_NOT_FOUND', 'extension not found');
    return { ws, row };
  };

  app.get('/:id/kv', (c) => {
    const kv = requireKv();
    const { ws } = ownExtension(c, c.req.param('id'));
    return c.json({ entries: kv.list(ws.workspaceId, c.req.param('id')) });
  });

  app.get('/:id/kv/:key', (c) => {
    const kv = requireKv();
    const { ws } = ownExtension(c, c.req.param('id'));
    const value = kv.get(ws.workspaceId, c.req.param('id'), c.req.param('key'));
    if (value === undefined) throw new AgentisError('RESOURCE_NOT_FOUND', 'kv key not found');
    return c.json({ key: c.req.param('key'), value });
  });

  app.put('/:id/kv/:key', async (c) => {
    const kv = requireKv();
    const { ws } = ownExtension(c, c.req.param('id'));
    const body = z.object({ value: z.unknown(), ttlSeconds: z.number().int().positive().optional() }).parse(await c.req.json());
    kv.set(ws.workspaceId, c.req.param('id'), c.req.param('key'), body.value, body.ttlSeconds);
    return c.json({ ok: true });
  });

  app.delete('/:id/kv/:key', (c) => {
    const kv = requireKv();
    const { ws } = ownExtension(c, c.req.param('id'));
    return c.json({ ok: kv.delete(ws.workspaceId, c.req.param('id'), c.req.param('key')) });
  });

  app.delete('/:id/kv', (c) => {
    const kv = requireKv();
    const { ws } = ownExtension(c, c.req.param('id'));
    kv.clear(ws.workspaceId, c.req.param('id'));
    return c.json({ ok: true });
  });

  return app;
}

function assertPermissionsAcknowledged(permissions: string[], acknowledged: string[]) {
  const expected = [...new Set(permissions)].sort();
  const actual = [...new Set(acknowledged)].sort();
  if (expected.length !== actual.length || expected.some((permission, index) => permission !== actual[index])) {
    throw new AgentisError(
      'EXTENSION_PERMISSIONS_NOT_ACKNOWLEDGED',
      'Extension permissions must be acknowledged before install',
      { details: { expected, actual } },
    );
  }
}
