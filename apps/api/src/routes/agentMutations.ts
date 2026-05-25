/**
 * /v1/agents — full CRUD plus terminal RPC.
 *
 * V1 ships six harness adapter types. Creating an
 * agent registers the corresponding adapter in AdapterManager. The route
 * decrypts credential references only when constructing the adapter instance.
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq, ne } from 'drizzle-orm';
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
import { defaultInstructionsForRole, isDefaultRoleInstructions } from '../data/playbook-library.js';
import { joinUrl, normalizeOpenClawGatewayUrl, testHarnessConfig, type V1HarnessAdapterType } from '../services/harnessProbe.js';
import { repairCliHarnessConfig } from '../services/harnessConfigRepair.js';

const adapterTypeSchema = z.enum(['openclaw', 'hermes_agent', 'claude_code', 'codex', 'cursor', 'http']);
const agentStatusSchema = z.enum(['online', 'busy', 'offline', 'error', 'paused', 'setting_up']);

const createSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(240).nullish(),
  adapterType: adapterTypeSchema,
  ambientId: z.string().nullish(),
  gatewayId: z.string().nullish(),
  spaceId: z.string().nullish(),
  capabilityTags: z.array(z.string()).default([]),
  config: z.record(z.unknown()).default({}),
  instructions: z.string().nullish(),
  avatarGlyph: z.string().max(8).nullish(),
  avatarUrl: z.string().max(2_000_000).nullish(),
  runtimeModel: z.string().nullish(),
  role: z.string().max(120).nullish(),
  reportsTo: z.string().nullish(),
  isPaused: z.boolean().optional(),
  monthlyBudgetCents: z.number().int().nonnegative().nullish(),
  canvasPosition: z.object({ x: z.number(), y: z.number() }).nullish(),
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  status: agentStatusSchema.optional(),
  replaceExistingOrchestrator: z.boolean().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(240).nullish().optional(),
  spaceId: z.string().nullish().optional(),
  capabilityTags: z.array(z.string()).optional(),
  config: z.record(z.unknown()).optional(),
  instructions: z.string().nullish().optional(),
  avatarGlyph: z.string().max(8).nullish().optional(),
  avatarUrl: z.string().max(2_000_000).nullish().optional(),
  runtimeModel: z.string().nullish().optional(),
  role: z.string().max(120).nullish().optional(),
  reportsTo: z.string().nullish().optional(),
  isPaused: z.boolean().optional(),
  monthlyBudgetCents: z.number().int().nonnegative().nullish().optional(),
  canvasPosition: z.object({ x: z.number(), y: z.number() }).nullish().optional(),
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  status: agentStatusSchema.optional(),
  replaceExistingOrchestrator: z.boolean().optional(),
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
    if (body.reportsTo) ensureReportsToTarget(deps.db, ws.workspaceId, body.reportsTo);
    const id = randomUUID();
    ensureOrEstablishSingleOrchestrator(deps.db, ws.workspaceId, body.role ?? null, id, body.replaceExistingOrchestrator === true);
    const colorHex = body.colorHex ?? CONSTANTS.AGENT_COLOR_PALETTE[Math.floor(Math.random() * CONSTANTS.AGENT_COLOR_PALETTE.length)];
    const repaired = await repairCliHarnessConfig(body.adapterType, body.config);
    const config = repaired.config;
    const isPaused = body.isPaused ?? false;
    let status = body.status === 'setting_up' ? 'setting_up' : isPaused ? 'paused' : 'offline';
    deps.db.transaction(() => {
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
          description: body.description ?? null,
          spaceId: body.spaceId ?? null,
          adapterType: body.adapterType,
          capabilityTags: body.capabilityTags,
          config,
          status,
          colorHex,
          instructions: body.instructions ?? null,
          avatarGlyph: body.avatarGlyph ?? null,
          avatarUrl: body.avatarUrl ?? null,
          runtimeModel: body.runtimeModel ?? runtimeModelFromConfig(body.adapterType, config),
          role: body.role ?? null,
          reportsTo: body.reportsTo ?? null,
          isPaused,
          monthlyBudgetCents: body.monthlyBudgetCents ?? null,
          canvasPosition: body.canvasPosition ?? null,
        })
        .run();
      if (body.role === 'orchestrator' && body.replaceExistingOrchestrator === true) {
        pointManagersAtOrchestrator(deps.db, ws.workspaceId, id);
      }
    });

    // Register adapter immediately if we have enough config.
    if (status !== 'setting_up' && !isPaused) {
      try {
        await registerAdapter(deps, ws.workspaceId, id, body.adapterType, config);
        status = 'online';
        deps.db
          .update(schema.agents)
          .set({ status, lastHeartbeatAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
          .where(eq(schema.agents.id, id))
          .run();
      } catch (err) {
        deps.logger.warn('agents.register_failed', { id, err: (err as Error).message });
        status = 'error';
        deps.db
          .update(schema.agents)
          .set({ status, updatedAt: new Date().toISOString() })
          .where(eq(schema.agents.id, id))
          .run();
      }
    }
    return c.json({
      id,
      name: body.name,
      adapterType: body.adapterType,
      colorHex,
      status,
      agent: { id, name: body.name, adapterType: body.adapterType, colorHex, status },
    }, 201);
  });

  app.patch('/:id', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const body = updateSchema.parse(await c.req.json());
    const existing = loadAgent(deps.db, ws.workspaceId, id);
    const existingIsPaused = Boolean(existing.isPaused);
    const nextIsPaused = body.isPaused === undefined ? existingIsPaused : body.isPaused;
    const pauseChanged = body.isPaused !== undefined && body.isPaused !== existingIsPaused;
    const configChanged = body.config !== undefined;
    const nextStatus = body.status === undefined
      ? nextIsPaused ? 'paused' : existing.status
      : body.status;
    const nextRole = body.role === undefined ? existing.role : body.role;
    const nextName = body.name ?? existing.name;
    // Regenerate the platform `agentis.md` when the role changes — but only when
    // the operator hasn't customized it (current text is an unedited playbook
    // default). Works for every role; never clobbers hand-written instructions.
    let nextInstructions = body.instructions === undefined ? existing.instructions : body.instructions;
    if (
      body.instructions === undefined &&
      nextRole !== existing.role &&
      isDefaultRoleInstructions(existing.instructions, existing.name)
    ) {
      const regenerated = defaultInstructionsForRole(nextRole, nextName);
      if (regenerated) nextInstructions = regenerated;
    }
    if (body.reportsTo) ensureReportsToTarget(deps.db, ws.workspaceId, body.reportsTo, id);
    const rawNextConfig = body.config ?? (existing.config as Record<string, unknown>);
    const repairedConfig = await repairCliHarnessConfig(existing.adapterType as V1HarnessAdapterType, rawNextConfig);
    const nextConfig = repairedConfig.config;
    ensureOrEstablishSingleOrchestrator(deps.db, ws.workspaceId, nextRole, id, body.replaceExistingOrchestrator === true);
    deps.db.transaction(() => {
      deps.db
        .update(schema.agents)
        .set({
          name: body.name ?? existing.name,
          description: body.description === undefined ? existing.description : body.description,
          spaceId: body.spaceId === undefined ? existing.spaceId : body.spaceId,
          capabilityTags: body.capabilityTags ?? (existing.capabilityTags as string[]),
          config: nextConfig,
          instructions: nextInstructions,
          avatarGlyph: body.avatarGlyph === undefined ? existing.avatarGlyph : body.avatarGlyph,
          runtimeModel: body.runtimeModel === undefined ? existing.runtimeModel : body.runtimeModel,
          role: nextRole,
          reportsTo: body.reportsTo === undefined ? existing.reportsTo : body.reportsTo,
          isPaused: nextIsPaused,
          monthlyBudgetCents: body.monthlyBudgetCents === undefined ? existing.monthlyBudgetCents : body.monthlyBudgetCents,
          canvasPosition: body.canvasPosition === undefined ? existing.canvasPosition : body.canvasPosition,
          colorHex: body.colorHex ?? existing.colorHex,
          avatarUrl: body.avatarUrl === undefined ? existing.avatarUrl : body.avatarUrl,
          status: nextStatus,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.agents.id, id))
        .run();
      if (nextRole === 'orchestrator' && body.replaceExistingOrchestrator === true) {
        pointManagersAtOrchestrator(deps.db, ws.workspaceId, id);
      }
    });
    if (body.status !== 'setting_up') {
      if (nextIsPaused) {
        await deps.adapters.unregister(id);
        deps.db
          .update(schema.agents)
          .set({ status: 'paused', updatedAt: new Date().toISOString() })
          .where(eq(schema.agents.id, id))
          .run();
      } else if (configChanged || pauseChanged) {
        try {
          await registerAdapter(deps, ws.workspaceId, id, existing.adapterType as V1HarnessAdapterType, nextConfig);
          deps.db
            .update(schema.agents)
            .set({ status: 'online', lastHeartbeatAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
            .where(eq(schema.agents.id, id))
            .run();
        } catch (err) {
          deps.logger.warn('agents.reregister_failed', { id, err: (err as Error).message });
          deps.db
            .update(schema.agents)
            .set({ status: 'error', updatedAt: new Date().toISOString() })
            .where(eq(schema.agents.id, id))
            .run();
        }
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
    const repaired = await repairCliHarnessConfig(parsed.data, (agent.config ?? {}) as Record<string, unknown>);
    if (repaired.changed) {
      deps.db.update(schema.agents).set({ config: repaired.config, updatedAt: new Date().toISOString() }).where(eq(schema.agents.id, id)).run();
    }
    const result = await testHarnessConfig(parsed.data, repaired.config, { deep: true });
    return c.json(result);
  });

  return app;
}

function loadAgent(db: AgentisSqliteDb, workspaceId: string, id: string) {
  const a = db.select().from(schema.agents).where(and(eq(schema.agents.id, id), eq(schema.agents.workspaceId, workspaceId))).get();
  if (!a) throw new AgentisError('RESOURCE_NOT_FOUND', `agent ${id} not found`);
  return a;
}

function ensureOrEstablishSingleOrchestrator(db: AgentisSqliteDb, workspaceId: string, role: string | null | undefined, currentAgentId: string, replaceExisting: boolean) {
  if (role !== 'orchestrator') return;
  const predicates = [
    eq(schema.agents.workspaceId, workspaceId),
    eq(schema.agents.role, 'orchestrator'),
  ];
  predicates.push(ne(schema.agents.id, currentAgentId));
  const existing = db
    .select({ id: schema.agents.id, name: schema.agents.name })
    .from(schema.agents)
    .where(and(...predicates))
    .get();
  if (!existing) return;
  if (!replaceExisting) {
    throw new AgentisError('WORKSPACE_ORCHESTRATOR_EXISTS', `Workspace already has an orchestrator: ${existing.name}`, {
      details: { id: existing.id, name: existing.name },
    });
  }
  db
    .update(schema.agents)
    .set({ role: 'manager', reportsTo: currentAgentId, updatedAt: new Date().toISOString() })
    .where(and(...predicates))
    .run();
}

function pointManagersAtOrchestrator(db: AgentisSqliteDb, workspaceId: string, orchestratorId: string) {
  db
    .update(schema.agents)
    .set({ reportsTo: orchestratorId, updatedAt: new Date().toISOString() })
    .where(and(
      eq(schema.agents.workspaceId, workspaceId),
      eq(schema.agents.role, 'manager'),
      ne(schema.agents.id, orchestratorId),
    ))
    .run();
}

function ensureReportsToTarget(db: AgentisSqliteDb, workspaceId: string, reportsTo: string, currentAgentId?: string) {
  if (reportsTo === currentAgentId) {
    throw new AgentisError('VALIDATION_FAILED', 'agent cannot report to itself');
  }
  const target = db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(and(eq(schema.agents.id, reportsTo), eq(schema.agents.workspaceId, workspaceId)))
    .get();
  if (!target) throw new AgentisError('RESOURCE_NOT_FOUND', `reportsTo agent ${reportsTo} not found`);
}

async function registerAdapter(
  deps: AgentRouteDeps,
  workspaceId: string,
  agentId: string,
  adapterType: V1HarnessAdapterType,
  config: Record<string, unknown>,
) {
  config = (await repairCliHarnessConfig(adapterType, config)).config;
  await deps.adapters.unregister(agentId);
  if (adapterType === 'openclaw') {
    const gatewayUrl = normalizeOpenClawGatewayUrl(String(config.gatewayUrl ?? '')) ?? '';
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
      chatUrl: httpUrlFromConfig(config, 'chatPath', 'chatUrl') ?? undefined,
      supportsTools: booleanOf(config.supportsTools) === true,
      model: stringOf(config.model) ?? undefined,
      method: httpMethodOf(config.method),
      headers: recordStringOf(config.headers),
      payloadTemplate: recordObjectOf(config.payloadTemplate),
      dispatchTimeoutMs: numberOf(config.dispatchTimeoutMs),
      chatTimeoutMs: numberOf(config.chatTimeoutMs),
      sharedSecret: sharedSecretCredentialId ? deps.vault.decrypt(loadCredential(deps.db, workspaceId, sharedSecretCredentialId).encryptedValue) : undefined,
      authToken: authCredentialId ? deps.vault.decrypt(loadCredential(deps.db, workspaceId, authCredentialId).encryptedValue) : undefined,
      logger: deps.logger,
    });
    await adapter.connect();
    deps.adapters.register(agentId, adapter);
    return;
  }
  if (adapterType === 'codex') {
    await ensureCliHarnessAvailable(adapterType, config);
    const adapter = new CodexAdapter({
      agentId,
      binaryPath: cliCommandFromConfig(config) ?? undefined,
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
    await ensureCliHarnessAvailable(adapterType, config);
    const adapter = new CursorAdapter({
      agentId,
      binaryPath: cliCommandFromConfig(config) ?? undefined,
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
    await ensureCliHarnessAvailable(adapterType, config);
    const adapter = new HermesAgentAdapter({
      agentId,
      binaryPath: cliCommandFromConfig(config) ?? undefined,
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
  await ensureCliHarnessAvailable(adapterType, config);
  const adapter = new ClaudeCodeAdapter({
    agentId,
    binaryPath: cliCommandFromConfig(config) ?? undefined,
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

async function ensureCliHarnessAvailable(adapterType: Extract<V1HarnessAdapterType, 'claude_code' | 'codex' | 'cursor' | 'hermes_agent'>, config: Record<string, unknown>) {
  const result = await testHarnessConfig(adapterType, config);
  if (result.status !== 'fail') return;
  const firstError = result.checks.find((check) => check.level === 'error') ?? result.checks[0];
  throw new AgentisError('VALIDATION_FAILED', firstError?.detail ? `${firstError.message} - ${firstError.detail}` : firstError?.message ?? 'Harness binary not found');
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

function cliCommandFromConfig(config: Record<string, unknown>): string | null {
  return stringOf(config.command) ?? stringOf(config.binaryPath);
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
