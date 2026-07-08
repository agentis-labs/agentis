/**
 * /v1/credentials — operator-managed encrypted secrets.
 *
 * Reads NEVER expose the plaintext value. Writes encrypt at the boundary.
 * `credentialType` is a free-form string (e.g. `openclaw_device_token`,
 * `http_adapter_secret`, `oauth_refresh_token`) the consumer interprets.
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AgentisError } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { CredentialVault } from '../services/credentialVault.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

const createSchema = z.object({
  name: z.string().min(1).max(120),
  credentialType: z.string().min(1).max(80),
  value: z.string().min(1).max(8192),
  ambientId: z.string().nullish(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  value: z.string().min(1).max(8192).optional(),
});

export function buildCredentialRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  vault: CredentialVault;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const rows = deps.db
      .select()
      .from(schema.credentials)
      .where(eq(schema.credentials.workspaceId, ws.workspaceId))
      .all();
    return c.json({
      credentials: rows.map((r) => ({
        id: r.id,
        name: r.name,
        credentialType: r.credentialType,
        ambientId: r.ambientId,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    });
  });

  app.post('/', async (c) => {
    const ws = getWorkspace(c);
    const body = createSchema.parse(await c.req.json());
    const id = randomUUID();
    deps.db
      .insert(schema.credentials)
      .values({
        id,
        workspaceId: ws.workspaceId,
        ambientId: body.ambientId ?? null,
        userId: ws.user.id,
        name: body.name,
        credentialType: body.credentialType,
        encryptedValue: deps.vault.encrypt(body.value),
      })
      .run();
    return c.json({ id, name: body.name, credentialType: body.credentialType }, 201);
  });

  app.patch('/:id', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const body = updateSchema.parse(await c.req.json());
    const existing = deps.db
      .select()
      .from(schema.credentials)
      .where(and(eq(schema.credentials.id, id), eq(schema.credentials.workspaceId, ws.workspaceId)))
      .get();
    if (!existing) throw new AgentisError('RESOURCE_NOT_FOUND', 'credential not found');
    deps.db
      .update(schema.credentials)
      .set({
        name: body.name ?? existing.name,
        encryptedValue: body.value ? deps.vault.encrypt(body.value) : existing.encryptedValue,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.credentials.id, id))
      .run();
    return c.json({ ok: true });
  });

  app.delete('/:id', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const result = deps.db
      .delete(schema.credentials)
      .where(and(eq(schema.credentials.id, id), eq(schema.credentials.workspaceId, ws.workspaceId)))
      .run();
    if (result.changes === 0) throw new AgentisError('RESOURCE_NOT_FOUND', 'credential not found');
    return c.json({ ok: true });
  });

  return app;
}
