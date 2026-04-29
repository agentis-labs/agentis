/**
 * /v1/agents — full CRUD plus terminal RPC.
 *
 * V1 ships three adapter types: openclaw, claude_code, http. Creating an
 * agent registers the corresponding adapter in AdapterManager. The route
 * never sees the decrypted device token — it asks the AdapterFactory to
 * resolve credentials by id.
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AgentisError, CONSTANTS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { CredentialVault } from '../services/credentialVault.js';
import type { AdapterManager } from '../adapters/AdapterManager.js';
import type { Logger } from '../logger.js';
import type { ConversationStore } from '../services/conversationStore.js';
import { OpenClawAdapter } from '../adapters/OpenClawAdapter.js';
import { HttpAdapter } from '../adapters/HttpAdapter.js';
import { ClaudeCodeAdapter } from '../adapters/ClaudeCodeAdapter.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

const adapterTypeSchema = z.enum(['openclaw', 'claude_code', 'http']);

const createSchema = z.object({
  name: z.string().min(1).max(120),
  adapterType: adapterTypeSchema,
  ambientId: z.string().nullish(),
  gatewayId: z.string().nullish(),
  capabilityTags: z.array(z.string()).default([]),
  config: z.record(z.unknown()).default({}),
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  capabilityTags: z.array(z.string()).optional(),
  config: z.record(z.unknown()).optional(),
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

const terminalSendSchema = z.object({
  body: z.string().min(1).max(CONSTANTS.CONVERSATION_MESSAGE_MAX_LENGTH),
});

export interface AgentRouteDeps {
  db: AgentisSqliteDb;
  auth: AuthService;
  vault: CredentialVault;
  adapters: AdapterManager;
  logger: Logger;
  conversations: ConversationStore;
}

export function buildAgentMutationRoutes(deps: AgentRouteDeps) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.post('/', async (c) => {
    const ws = getWorkspace(c);
    const body = createSchema.parse(await c.req.json());
    const id = randomUUID();
    const colorHex = body.colorHex ?? CONSTANTS.AGENT_COLOR_PALETTE[Math.floor(Math.random() * CONSTANTS.AGENT_COLOR_PALETTE.length)];
    deps.db
      .insert(schema.agents)
      .values({
        id,
        workspaceId: ws.workspaceId,
        ambientId: body.ambientId ?? null,
        userId: ws.user.id,
        gatewayId: body.gatewayId ?? null,
        packageId: null,
        name: body.name,
        adapterType: body.adapterType,
        capabilityTags: body.capabilityTags,
        config: body.config,
        status: 'offline',
        colorHex,
      })
      .run();

    // Register adapter immediately if we have enough config.
    try {
      await registerAdapter(deps, id, body.adapterType, body.config);
      deps.db
        .update(schema.agents)
        .set({ status: 'online', updatedAt: new Date().toISOString() })
        .where(eq(schema.agents.id, id))
        .run();
    } catch (err) {
      deps.logger.warn('agents.register_failed', { id, err: (err as Error).message });
    }
    return c.json({ id, name: body.name, adapterType: body.adapterType, colorHex }, 201);
  });

  app.patch('/:id', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const body = updateSchema.parse(await c.req.json());
    const existing = loadAgent(deps.db, ws.workspaceId, id);
    deps.db
      .update(schema.agents)
      .set({
        name: body.name ?? existing.name,
        capabilityTags: body.capabilityTags ?? (existing.capabilityTags as string[]),
        config: body.config ?? (existing.config as Record<string, unknown>),
        colorHex: body.colorHex ?? existing.colorHex,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.agents.id, id))
      .run();
    return c.json({ ok: true });
  });

  app.delete('/:id', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const existing = loadAgent(deps.db, ws.workspaceId, id);
    await deps.adapters.unregister(existing.id);
    deps.db.delete(schema.agents).where(eq(schema.agents.id, id)).run();
    return c.json({ ok: true });
  });

  // POST /v1/agents/:id/terminal/send — direct operator → agent message.
  app.post('/:id/terminal/send', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const agent = loadAgent(deps.db, ws.workspaceId, id);
    const body = terminalSendSchema.parse(await c.req.json());

    const conversation = deps.conversations.getOrCreateByAgent({
      workspaceId: agent.workspaceId,
      ambientId: agent.ambientId,
      userId: ws.user.id,
      agentId: agent.id,
      mirroredSessionId: null,
    });
    const message = deps.conversations.appendOutbound({
      workspaceId: agent.workspaceId,
      conversationId: conversation.id,
      operatorId: ws.user.id,
      body: body.body,
      deliveryStatus: 'sent',
    });
    // Best-effort dispatch through the adapter.
    const reg = deps.adapters.get(agent.id);
    if (reg && reg.adapter instanceof OpenClawAdapter) {
      try {
        await reg.adapter.sendSessionMessage({
          sessionId: conversation.mirroredSessionId ?? undefined,
          body: body.body,
        });
      } catch (err) {
        deps.logger.warn('agents.terminal_send_failed', { id, err: (err as Error).message });
      }
    }
    return c.json({ message });
  });

  // POST /v1/agents/:id/cancel-task/:taskId
  app.post('/:id/cancel-task/:taskId', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const taskId = c.req.param('taskId');
    loadAgent(deps.db, ws.workspaceId, id);
    await deps.adapters.cancelTask(id, taskId);
    return c.json({ ok: true });
  });

  return app;
}

function loadAgent(db: AgentisSqliteDb, workspaceId: string, id: string) {
  const a = db.select().from(schema.agents).where(and(eq(schema.agents.id, id), eq(schema.agents.workspaceId, workspaceId))).get();
  if (!a) throw new AgentisError('RESOURCE_NOT_FOUND', `agent ${id} not found`);
  return a;
}

async function registerAdapter(
  deps: AgentRouteDeps,
  agentId: string,
  adapterType: 'openclaw' | 'claude_code' | 'http',
  config: Record<string, unknown>,
) {
  if (adapterType === 'openclaw') {
    const gatewayUrl = String(config.gatewayUrl ?? '');
    const credentialId = String(config.deviceTokenCredentialId ?? '');
    if (!gatewayUrl || !credentialId) {
      throw new AgentisError('VALIDATION_FAILED', 'openclaw requires gatewayUrl and deviceTokenCredentialId');
    }
    const cred = deps.db.select().from(schema.credentials).where(eq(schema.credentials.id, credentialId)).get();
    if (!cred) throw new AgentisError('RESOURCE_NOT_FOUND', `credential ${credentialId} not found`);
    const deviceToken = deps.vault.decrypt(cred.encryptedValue);
    const adapter = new OpenClawAdapter({
      agentId,
      gatewayUrl,
      deviceToken,
      logger: deps.logger,
    });
    await adapter.connect();
    deps.adapters.register(agentId, adapter);
    return;
  }
  if (adapterType === 'http') {
    const dispatchUrl = String(config.dispatchUrl ?? '');
    const credentialId = String(config.sharedSecretCredentialId ?? '');
    if (!dispatchUrl || !credentialId) {
      throw new AgentisError('VALIDATION_FAILED', 'http requires dispatchUrl and sharedSecretCredentialId');
    }
    const cred = deps.db.select().from(schema.credentials).where(eq(schema.credentials.id, credentialId)).get();
    if (!cred) throw new AgentisError('RESOURCE_NOT_FOUND', `credential ${credentialId} not found`);
    const sharedSecret = deps.vault.decrypt(cred.encryptedValue);
    const adapter = new HttpAdapter({
      agentId,
      dispatchUrl,
      sharedSecret,
      logger: deps.logger,
    });
    await adapter.connect();
    deps.adapters.register(agentId, adapter);
    return;
  }
  // claude_code
  const adapter = new ClaudeCodeAdapter({
    agentId,
    binaryPath: typeof config.binaryPath === 'string' ? config.binaryPath : undefined,
    cwd: typeof config.cwd === 'string' ? config.cwd : undefined,
    maxTurns: typeof config.maxTurns === 'number' ? config.maxTurns : undefined,
    logger: deps.logger,
  });
  await adapter.connect();
  deps.adapters.register(agentId, adapter);
}
