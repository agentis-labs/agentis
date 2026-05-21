import { randomUUID } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import { AgentisError, CONSTANTS, REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { CredentialVault } from './credentialVault.js';
import type { AdapterManager } from '../adapters/AdapterManager.js';
import type { Logger } from '../logger.js';
import type { EventBus } from '../event-bus.js';
import { OpenClawAdapter } from '../adapters/OpenClawAdapter.js';
import { HttpAdapter } from '../adapters/HttpAdapter.js';
import { ClaudeCodeAdapter } from '../adapters/ClaudeCodeAdapter.js';
import { CodexAdapter } from '../adapters/CodexAdapter.js';
import { CursorAdapter } from '../adapters/CursorAdapter.js';
import { HermesAgentAdapter } from '../adapters/HermesAgentAdapter.js';
import { assertSafeUrl } from './safeUrl.js';
import { joinUrl, testHarnessConfig, type V1HarnessAdapterType } from './harnessProbe.js';
import { repairCliHarnessConfig } from './harnessConfigRepair.js';

export interface RegisterAdapterOptions {
  skipConfigRepair?: boolean;
  skipCliAvailabilityCheck?: boolean;
}

export interface AgentCommissionDeps {
  db: AgentisSqliteDb;
  vault: CredentialVault;
  adapters: AdapterManager;
  logger: Logger;
  bus?: EventBus;
}

export interface CommissionAgentInput {
  workspaceId: string;
  userId: string;
  ambientId?: string | null;
  gatewayId?: string | null;
  spaceId?: string | null;
  name: string;
  description?: string | null;
  adapterType: V1HarnessAdapterType;
  capabilityTags?: string[];
  config?: Record<string, unknown>;
  instructions?: string | null;
  avatarGlyph?: string | null;
  avatarUrl?: string | null;
  runtimeModel?: string | null;
  role?: string | null;
  reportsTo?: string | null;
  isPaused?: boolean;
  monthlyBudgetCents?: number | null;
  canvasPosition?: { x: number; y: number } | null;
  colorHex?: string | null;
}

export interface CommissionAgentResult {
  id: string;
  name: string;
  adapterType: V1HarnessAdapterType;
  colorHex: string;
  agent: { id: string; name: string; adapterType: V1HarnessAdapterType; colorHex: string; role?: string | null; reportsTo?: string | null };
}

export async function commissionAgent(deps: AgentCommissionDeps, input: CommissionAgentInput): Promise<CommissionAgentResult> {
  ensureSingleOrchestrator(deps.db, input.workspaceId, input.role ?? null);
  if (input.reportsTo) ensureReportsToTarget(deps.db, input.workspaceId, input.reportsTo);

  const id = randomUUID();
  const colorHex = input.colorHex
    ?? CONSTANTS.AGENT_COLOR_PALETTE[Math.floor(Math.random() * CONSTANTS.AGENT_COLOR_PALETTE.length)]
    ?? '#6366f1';
  const repaired = await repairCliHarnessConfig(input.adapterType, input.config ?? {});
  const config = repaired.config;
  const isPaused = input.isPaused ?? false;
  const insertedStatus = isPaused ? 'paused' : 'offline';

  deps.db
    .insert(schema.agents)
    .values({
      id,
      workspaceId: input.workspaceId,
      ambientId: input.ambientId ?? null,
      userId: input.userId,
      gatewayId: input.gatewayId ?? null,
      packageId: null,
      name: input.name,
      description: input.description ?? null,
      spaceId: input.spaceId ?? null,
      adapterType: input.adapterType,
      capabilityTags: input.capabilityTags ?? [],
      config,
      status: insertedStatus,
      colorHex,
      instructions: input.instructions ?? null,
      avatarGlyph: input.avatarGlyph ?? null,
      avatarUrl: input.avatarUrl ?? null,
      runtimeModel: input.runtimeModel ?? runtimeModelFromConfig(input.adapterType, config),
      role: input.role ?? null,
      reportsTo: input.reportsTo ?? null,
      isPaused,
      monthlyBudgetCents: input.monthlyBudgetCents ?? null,
      canvasPosition: input.canvasPosition ?? null,
    })
    .run();

  if (!isPaused) {
    try {
      await registerAdapter(deps, input.workspaceId, id, input.adapterType, config);
      deps.db
        .update(schema.agents)
        .set({ status: 'online', updatedAt: new Date().toISOString() })
        .where(eq(schema.agents.id, id))
        .run();
    } catch (err) {
      deps.logger.warn('agents.register_failed', { id, err: (err as Error).message });
    }
  }

  const agentPayload = {
    id,
    name: input.name,
    adapterType: input.adapterType,
    colorHex,
    role: input.role ?? null,
    reportsTo: input.reportsTo ?? null,
  };

  deps.bus?.publish(REALTIME_ROOMS.workspace(input.workspaceId), REALTIME_EVENTS.AGENT_CREATED, { agent: agentPayload });
  deps.bus?.publish(REALTIME_ROOMS.workspace(input.workspaceId), REALTIME_EVENTS.CANVAS_NODE_PLACED, {
    agentId: id,
    nodeLabel: input.name,
    role: input.role ?? null,
    reportsTo: input.reportsTo ?? null,
  });

  return {
    id,
    name: input.name,
    adapterType: input.adapterType,
    colorHex,
    agent: agentPayload,
  };
}

export function ensureSingleOrchestrator(db: AgentisSqliteDb, workspaceId: string, role: string | null | undefined, currentAgentId?: string) {
  if (role !== 'orchestrator') return;
  const predicates = [
    eq(schema.agents.workspaceId, workspaceId),
    eq(schema.agents.role, 'orchestrator'),
  ];
  if (currentAgentId) predicates.push(ne(schema.agents.id, currentAgentId));
  const existing = db
    .select({ id: schema.agents.id, name: schema.agents.name })
    .from(schema.agents)
    .where(and(...predicates))
    .get();
  if (!existing) return;
  throw new AgentisError('WORKSPACE_ORCHESTRATOR_EXISTS', `Workspace already has an orchestrator: ${existing.name}`, {
    details: { id: existing.id, name: existing.name },
  });
}

export function ensureReportsToTarget(db: AgentisSqliteDb, workspaceId: string, reportsTo: string, currentAgentId?: string) {
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

export async function registerAdapter(
  deps: AgentCommissionDeps,
  workspaceId: string,
  agentId: string,
  adapterType: V1HarnessAdapterType,
  config: Record<string, unknown>,
  options: RegisterAdapterOptions = {},
) {
  config = options.skipConfigRepair ? config : (await repairCliHarnessConfig(adapterType, config)).config;
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
    if (!options.skipCliAvailabilityCheck) await ensureCliHarnessAvailable(adapterType, config);
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
    if (!options.skipCliAvailabilityCheck) await ensureCliHarnessAvailable(adapterType, config);
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
    if (!options.skipCliAvailabilityCheck) await ensureCliHarnessAvailable(adapterType, config);
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
  if (!options.skipCliAvailabilityCheck) await ensureCliHarnessAvailable(adapterType, config);
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

export function runtimeModelFromConfig(adapterType: V1HarnessAdapterType, config: Record<string, unknown>): string | null {
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
