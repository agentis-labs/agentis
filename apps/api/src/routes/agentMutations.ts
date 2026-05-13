/**
 * /v1/agents — full CRUD plus terminal RPC.
 *
 * V1 ships six harness adapter types. Creating an
 * agent registers the corresponding adapter in AdapterManager. The route
 * decrypts credential references only when constructing the adapter instance.
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
import { CodexAdapter } from '../adapters/CodexAdapter.js';
import { CursorAdapter } from '../adapters/CursorAdapter.js';
import { HermesAgentAdapter } from '../adapters/HermesAgentAdapter.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';
import { assertSafeUrl } from '../services/safeUrl.js';
import { joinUrl, testHarnessConfig, type V1HarnessAdapterType } from '../services/harnessProbe.js';

const adapterTypeSchema = z.enum(['openclaw', 'hermes_agent', 'claude_code', 'codex', 'cursor', 'http']);

const createSchema = z.object({
  name: z.string().min(1).max(120),
  adapterType: adapterTypeSchema,
  ambientId: z.string().nullish(),
  gatewayId: z.string().nullish(),
  capabilityTags: z.array(z.string()).default([]),
  config: z.record(z.unknown()).default({}),
  instructions: z.string().nullish(),
  avatarGlyph: z.string().max(8).nullish(),
  runtimeModel: z.string().nullish(),
  role: z.string().max(120).nullish(),
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  capabilityTags: z.array(z.string()).optional(),
  config: z.record(z.unknown()).optional(),
  instructions: z.string().nullish().optional(),
  avatarGlyph: z.string().max(8).nullish().optional(),
  runtimeModel: z.string().nullish().optional(),
  role: z.string().max(120).nullish().optional(),
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
        instructions: body.instructions ?? null,
        avatarGlyph: body.avatarGlyph ?? null,
        runtimeModel: body.runtimeModel ?? runtimeModelFromConfig(body.adapterType, body.config),
        role: body.role ?? null,
      })
      .run();

    // Register adapter immediately if we have enough config.
    try {
      await registerAdapter(deps, ws.workspaceId, id, body.adapterType, body.config);
      deps.db
        .update(schema.agents)
        .set({ status: 'online', updatedAt: new Date().toISOString() })
        .where(eq(schema.agents.id, id))
        .run();
    } catch (err) {
      deps.logger.warn('agents.register_failed', { id, err: (err as Error).message });
    }
    return c.json({
      id,
      name: body.name,
      adapterType: body.adapterType,
      colorHex,
      agent: { id, name: body.name, adapterType: body.adapterType, colorHex },
    }, 201);
  });

  app.patch('/:id', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const body = updateSchema.parse(await c.req.json());
    const existing = loadAgent(deps.db, ws.workspaceId, id);
    const nextConfig = body.config ?? (existing.config as Record<string, unknown>);
    deps.db
      .update(schema.agents)
      .set({
        name: body.name ?? existing.name,
        capabilityTags: body.capabilityTags ?? (existing.capabilityTags as string[]),
        config: nextConfig,
        instructions: body.instructions === undefined ? existing.instructions : body.instructions,
        avatarGlyph: body.avatarGlyph === undefined ? existing.avatarGlyph : body.avatarGlyph,
        runtimeModel: body.runtimeModel === undefined ? existing.runtimeModel : body.runtimeModel,
        role: body.role === undefined ? existing.role : body.role,
        colorHex: body.colorHex ?? existing.colorHex,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.agents.id, id))
      .run();
    if (body.config) {
      try {
        await registerAdapter(deps, ws.workspaceId, id, existing.adapterType as V1HarnessAdapterType, nextConfig);
        deps.db.update(schema.agents).set({ status: 'online', updatedAt: new Date().toISOString() }).where(eq(schema.agents.id, id)).run();
      } catch (err) {
        deps.logger.warn('agents.reregister_failed', { id, err: (err as Error).message });
        deps.db.update(schema.agents).set({ status: 'offline', updatedAt: new Date().toISOString() }).where(eq(schema.agents.id, id)).run();
      }
    }
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

  app.post('/:id/test-harness', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const agent = loadAgent(deps.db, ws.workspaceId, id);
    const parsed = adapterTypeSchema.safeParse(agent.adapterType);
    if (!parsed.success) {
      throw new AgentisError('VALIDATION_FAILED', `agent ${id} uses unsupported adapter ${agent.adapterType}`);
    }
    const result = await testHarnessConfig(parsed.data, (agent.config ?? {}) as Record<string, unknown>);
    return c.json(result);
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
  workspaceId: string,
  agentId: string,
  adapterType: V1HarnessAdapterType,
  config: Record<string, unknown>,
) {
  await deps.adapters.unregister(agentId);
  if (adapterType === 'openclaw') {
    const gatewayUrl = String(config.gatewayUrl ?? '');
    const credentialId = stringOf(config.deviceTokenCredentialId) ?? stringOf(config.authCredentialId);
    if (!gatewayUrl) {
      throw new AgentisError('VALIDATION_FAILED', 'openclaw requires gatewayUrl');
    }
    await assertSafeGatewayUrl(gatewayUrl);
    const deviceToken = credentialId ? deps.vault.decrypt(loadCredential(deps.db, workspaceId, credentialId).encryptedValue) : stringOf(config.authToken);
    const adapter = new OpenClawAdapter({
      agentId,
      gatewayUrl,
      deviceToken: deviceToken ?? undefined,
      headers: recordStringOf(config.headers),
      password: stringOf(config.password) ?? undefined,
      agentName: stringOf(config.agentName) ?? undefined,
      sessionKeyStrategy: sessionKeyStrategyOf(config.sessionKeyStrategy),
      sessionKey: stringOf(config.sessionKey) ?? undefined,
      disableDeviceAuth: booleanOf(config.disableDeviceAuth),
      timeoutSec: numberOf(config.timeoutSec),
      payloadTemplate: recordObjectOf(config.payloadTemplate),
      logger: deps.logger,
    });
    await adapter.connect();
    deps.adapters.register(agentId, adapter);
    return;
  }
  if (adapterType === 'http') {
    const dispatchUrl = httpUrlFromConfig(config, 'dispatchPath', 'dispatchUrl');
    if (!dispatchUrl) {
      throw new AgentisError('VALIDATION_FAILED', 'http requires baseUrl + dispatchPath or dispatchUrl');
    }
    const sharedSecretCredentialId = stringOf(config.sharedSecretCredentialId);
    const authCredentialId = stringOf(config.authCredentialId);
    const adapter = new HttpAdapter({
      agentId,
      dispatchUrl,
      cancelUrl: httpUrlFromConfig(config, 'cancelPath', 'cancelUrl') ?? undefined,
      healthUrl: httpUrlFromConfig(config, 'healthPath', 'healthUrl') ?? undefined,
      method: httpMethodOf(config.method),
      headers: recordStringOf(config.headers),
      payloadTemplate: recordObjectOf(config.payloadTemplate),
      dispatchTimeoutMs: numberOf(config.dispatchTimeoutMs),
      sharedSecret: sharedSecretCredentialId ? deps.vault.decrypt(loadCredential(deps.db, workspaceId, sharedSecretCredentialId).encryptedValue) : undefined,
      authToken: authCredentialId ? deps.vault.decrypt(loadCredential(deps.db, workspaceId, authCredentialId).encryptedValue) : undefined,
      logger: deps.logger,
    });
    await adapter.connect();
    deps.adapters.register(agentId, adapter);
    return;
  }
  if (adapterType === 'codex') {
    const adapter = new CodexAdapter({
      agentId,
      binaryPath: stringOf(config.binaryPath) ?? undefined,
      cwd: stringOf(config.cwd) ?? undefined,
      model: stringOf(config.model) ?? undefined,
      maxTurns: numberOf(config.maxTurns),
      modelReasoningEffort: reasoningEffortOf(config.modelReasoningEffort),
      fastMode: booleanOf(config.fastMode),
      dangerouslyBypassApprovalsAndSandbox: config.dangerouslyBypassApprovalsAndSandbox === undefined ? undefined : booleanOf(config.dangerouslyBypassApprovalsAndSandbox),
      extraArgs: stringArrayOf(config.extraArgs),
      env: recordStringOf(config.env),
      timeoutSec: numberOf(config.timeoutSec),
      logger: deps.logger,
    });
    await adapter.connect();
    deps.adapters.register(agentId, adapter);
    return;
  }
  if (adapterType === 'cursor') {
    const adapter = new CursorAdapter({
      agentId,
      binaryPath: stringOf(config.binaryPath) ?? undefined,
      cwd: stringOf(config.cwd) ?? undefined,
      model: stringOf(config.model) ?? undefined,
      extraArgs: stringArrayOf(config.extraArgs),
      env: recordStringOf(config.env),
      timeoutSec: numberOf(config.timeoutSec),
      logger: deps.logger,
    });
    await adapter.connect();
    deps.adapters.register(agentId, adapter);
    return;
  }
  if (adapterType === 'hermes_agent') {
    const adapter = new HermesAgentAdapter({
      agentId,
      binaryPath: stringOf(config.binaryPath) ?? undefined,
      cwd: stringOf(config.cwd) ?? undefined,
      model: stringOf(config.model) ?? undefined,
      maxTurns: numberOf(config.maxTurns),
      extraArgs: stringArrayOf(config.extraArgs),
      env: recordStringOf(config.env),
      timeoutSec: numberOf(config.timeoutSec),
      graceSec: numberOf(config.graceSec),
      logger: deps.logger,
    });
    await adapter.connect();
    deps.adapters.register(agentId, adapter);
    return;
  }
  const adapter = new ClaudeCodeAdapter({
    agentId,
    binaryPath: stringOf(config.binaryPath) ?? undefined,
    cwd: stringOf(config.cwd) ?? undefined,
    model: stringOf(config.model) ?? undefined,
    maxTurns: numberOf(config.maxTurns),
    allowedTools: stringArrayOf(config.allowedTools),
    extraArgs: stringArrayOf(config.extraArgs),
    env: recordStringOf(config.env),
    timeoutSec: numberOf(config.timeoutSec),
    logger: deps.logger,
  });
  await adapter.connect();
  deps.adapters.register(agentId, adapter);
}

function runtimeModelFromConfig(adapterType: V1HarnessAdapterType, config: Record<string, unknown>): string | null {
  if (adapterType === 'openclaw' || adapterType === 'http') return null;
  return stringOf(config.model);
}

function httpUrlFromConfig(config: Record<string, unknown>, pathKey: string, urlKey: string): string | null {
  const direct = stringOf(config[urlKey]);
  if (direct) return direct;
  const baseUrl = stringOf(config.baseUrl);
  const path = stringOf(config[pathKey]);
  if (!baseUrl || !path) return null;
  return joinUrl(baseUrl, path);
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberOf(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function stringArrayOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
  return entries.length > 0 ? entries : undefined;
}

function recordStringOf(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function recordObjectOf(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function booleanOf(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return undefined;
}

function httpMethodOf(value: unknown): 'POST' | 'GET' | 'PUT' | 'PATCH' | undefined {
  const method = stringOf(value)?.toUpperCase();
  return method === 'POST' || method === 'GET' || method === 'PUT' || method === 'PATCH' ? method : undefined;
}

function reasoningEffortOf(value: unknown): 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | undefined {
  const effort = stringOf(value);
  return effort === 'minimal' || effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh' ? effort : undefined;
}

function sessionKeyStrategyOf(value: unknown): 'issue' | 'fixed' | 'run' | undefined {
  const strategy = stringOf(value);
  return strategy === 'issue' || strategy === 'fixed' || strategy === 'run' ? strategy : undefined;
}

function loadCredential(db: AgentisSqliteDb, workspaceId: string, id: string) {
  const cred = db
    .select()
    .from(schema.credentials)
    .where(and(eq(schema.credentials.id, id), eq(schema.credentials.workspaceId, workspaceId)))
    .get();
  if (!cred) throw new AgentisError('RESOURCE_NOT_FOUND', `credential ${id} not found`);
  return cred;
}

async function assertSafeGatewayUrl(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new AgentisError('VALIDATION_FAILED', 'openclaw gatewayUrl must be a valid URL');
  }
  if (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') {
    parsed.protocol = parsed.protocol === 'ws:' ? 'http:' : 'https:';
  }
  await assertSafeUrl(parsed.toString(), {
    allowPrivate: String(process.env.AGENTIS_GATEWAY_ALLOW_PRIVATE ?? process.env.AGENTIS_SKILL_HTTP_ALLOW_PRIVATE ?? '').toLowerCase() === 'true',
  });
}
