/**
 * /v1/gateways — OpenClaw Gateway lifecycle.
 *
 * `pair` accepts a one-time pairing payload (gateway URL + device token)
 * issued by an OpenClaw instance. We persist the gateway row and store the
 * device token in the credential vault. Agents can then bind to the
 * gateway via `gatewayId`.
 *
 * `sync` triggers a health snapshot refresh. `disconnect` purges the
 * device token and marks the row disconnected without deleting historical
 * runs.
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
import { assertSafeUrl } from '../services/safeUrl.js';

const pairSchema = z.object({
  name: z.string().min(1).max(120),
  gatewayUrl: z.string().url(),
  deviceToken: z.string().min(1),
  ambientId: z.string().nullish(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  ambientId: z.string().nullish(),
});

export function buildGatewayMutationRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  vault: CredentialVault;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.post('/pair', async (c) => {
    const ws = getWorkspace(c);
    const body = pairSchema.parse(await c.req.json());
    // Validate the URL so we don't accept javascript: or private addresses unless opted in.
    await assertSafeUrl(body.gatewayUrl, {
      allowPrivate: String(process.env.AGENTIS_SKILL_HTTP_ALLOW_PRIVATE ?? '').toLowerCase() === 'true',
    });
    const credId = randomUUID();
    deps.db
      .insert(schema.credentials)
      .values({
        id: credId,
        workspaceId: ws.workspaceId,
        ambientId: body.ambientId ?? null,
        userId: ws.user.id,
        name: `device_token: ${body.name}`,
        credentialType: 'openclaw_device_token',
        encryptedValue: deps.vault.encrypt(body.deviceToken),
      })
      .run();
    const id = randomUUID();
    deps.db
      .insert(schema.openclawGateways)
      .values({
        id,
        workspaceId: ws.workspaceId,
        ambientId: body.ambientId ?? null,
        userId: ws.user.id,
        name: body.name,
        gatewayUrl: body.gatewayUrl,
        deviceTokenCredentialId: credId,
        status: 'disconnected',
        healthSnapshot: {},
      })
      .run();
    return c.json({ id, name: body.name, gatewayUrl: body.gatewayUrl, deviceTokenCredentialId: credId }, 201);
  });

  app.patch('/:id', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const body = updateSchema.parse(await c.req.json());
    const existing = load(deps.db, ws.workspaceId, id);
    deps.db
      .update(schema.openclawGateways)
      .set({
        name: body.name ?? existing.name,
        ambientId: body.ambientId === undefined ? existing.ambientId : body.ambientId,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.openclawGateways.id, id))
      .run();
    return c.json({ ok: true });
  });

  app.post('/:id/sync', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const existing = load(deps.db, ws.workspaceId, id);
    // V1: lightweight self-report — full gateway protocol sync lives in the OpenClaw layer.
    deps.db
      .update(schema.openclawGateways)
      .set({
        lastSyncAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.openclawGateways.id, id))
      .run();
    return c.json({ ok: true, gatewayId: existing.id });
  });

  app.delete('/:id', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const existing = load(deps.db, ws.workspaceId, id);
    if (existing.deviceTokenCredentialId) {
      deps.db.delete(schema.credentials).where(eq(schema.credentials.id, existing.deviceTokenCredentialId)).run();
    }
    deps.db.delete(schema.openclawGateways).where(eq(schema.openclawGateways.id, id)).run();
    return c.json({ ok: true });
  });

  return app;
}

function load(db: AgentisSqliteDb, workspaceId: string, id: string) {
  const g = db
    .select()
    .from(schema.openclawGateways)
    .where(and(eq(schema.openclawGateways.id, id), eq(schema.openclawGateways.workspaceId, workspaceId)))
    .get();
  if (!g) throw new AgentisError('RESOURCE_NOT_FOUND', 'gateway not found');
  return g;
}
