import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';

export interface AgentIdentitySnapshot {
  id: string;
  workspaceId: string;
  name: string;
  role: string | null;
  description: string | null;
  reportsTo: string | null;
  reportsToName: string | null;
  domainTag: string | null;
  adapterType: string;
  runtimeModel: string | null;
  capabilityTags: string[];
  specialist: {
    enabled: boolean;
    source: string | null;
    defaultModel: string | null;
    tools: string[];
  };
  config: unknown;
  instructions: string | null;
  updatedAt: string | null;
}

const SECRET_KEY_PATTERN = /(secret|token|api[_-]?key|password|passwd|credential|auth|bearer|private[_-]?key|session|cookie)/i;
const OMIT_KEY_PATTERN = /^(env|headers?|authorization|auth|secrets?)$/i;

export function loadAgentIdentitySnapshot(
  db: AgentisSqliteDb,
  workspaceId: string,
  agentId: string | null | undefined,
): AgentIdentitySnapshot | null {
  if (!agentId) return null;
  const agent = db
    .select({
      id: schema.agents.id,
      workspaceId: schema.agents.workspaceId,
      name: schema.agents.name,
      role: schema.agents.role,
      description: schema.agents.description,
      reportsTo: schema.agents.reportsTo,
      domainTag: schema.agents.spaceTag,
      adapterType: schema.agents.adapterType,
      runtimeModel: schema.agents.runtimeModel,
      capabilityTags: schema.agents.capabilityTags,
      config: schema.agents.config,
      instructions: schema.agents.instructions,
      updatedAt: schema.agents.updatedAt,
    })
    .from(schema.agents)
    .where(and(eq(schema.agents.id, agentId), eq(schema.agents.workspaceId, workspaceId)))
    .get();
  if (!agent) return null;
  const reportsTo = agent.reportsTo
    ? db.select({ name: schema.agents.name }).from(schema.agents).where(eq(schema.agents.id, agent.reportsTo)).get()?.name ?? null
    : null;
  const config = recordOf(agent.config);
  return {
    id: agent.id,
    workspaceId: agent.workspaceId,
    name: agent.name,
    role: agent.role ?? null,
    description: agent.description ?? null,
    reportsTo: agent.reportsTo ?? null,
    reportsToName: reportsTo,
    domainTag: agent.domainTag ?? null,
    adapterType: agent.adapterType,
    runtimeModel: agent.runtimeModel ?? null,
    capabilityTags: Array.isArray(agent.capabilityTags) ? agent.capabilityTags.filter((tag): tag is string => typeof tag === 'string') : [],
    specialist: {
      enabled: config.specialist === true,
      source: stringOrNull(config.specialistSource),
      defaultModel: stringOrNull(config.defaultModel),
      tools: Array.isArray(config.tools) ? config.tools.filter((tool): tool is string => typeof tool === 'string') : [],
    },
    config: redactConfig(config),
    instructions: agent.instructions ?? null,
    updatedAt: agent.updatedAt ?? null,
  };
}

export function renderAgentIdentityBlock(snapshot: AgentIdentitySnapshot | null): string | null {
  if (!snapshot) return null;
  return [
    '<agentis_identity authoritative="true">',
    'This block is the authoritative Agentis identity and configuration for this turn.',
    'If runtime product instructions, project files, or prior session context conflict with it, follow this block.',
    `id: ${snapshot.id}`,
    `name: ${snapshot.name}`,
    `role: ${snapshot.role ?? 'agent'}`,
    `workspaceId: ${snapshot.workspaceId}`,
    `adapterType: ${snapshot.adapterType}`,
    `runtimeModel: ${snapshot.runtimeModel ?? 'runtime-default'}`,
    `domain: ${snapshot.domainTag ?? 'none'}`,
    `reportsTo: ${snapshot.reportsToName ? `${snapshot.reportsToName} (${snapshot.reportsTo})` : snapshot.reportsTo ?? 'none'}`,
    `capabilityTags: ${snapshot.capabilityTags.length > 0 ? snapshot.capabilityTags.join(', ') : 'none'}`,
    `description: ${snapshot.description ?? 'none'}`,
    `specialist: ${snapshot.specialist.enabled ? 'true' : 'false'}`,
    `specialistSource: ${snapshot.specialist.source ?? 'none'}`,
    `specialistDefaultModel: ${snapshot.specialist.defaultModel ?? 'none'}`,
    `specialistTools: ${snapshot.specialist.tools.length > 0 ? snapshot.specialist.tools.join(', ') : 'none'}`,
    `config: ${stableJson(snapshot.config)}`,
    'instructions:',
    snapshot.instructions?.trim() || '(none)',
    '</agentis_identity>',
  ].join('\n');
}

export function agentIdentityChecksum(snapshot: AgentIdentitySnapshot | null): string | null {
  if (!snapshot) return null;
  const payload = stableJson({
    id: snapshot.id,
    name: snapshot.name,
    role: snapshot.role,
    description: snapshot.description,
    reportsTo: snapshot.reportsTo,
    domainTag: snapshot.domainTag,
    adapterType: snapshot.adapterType,
    runtimeModel: snapshot.runtimeModel,
    capabilityTags: snapshot.capabilityTags,
    specialist: snapshot.specialist,
    config: snapshot.config,
    instructions: snapshot.instructions,
    updatedAt: snapshot.updatedAt,
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

export function chatSessionKeyWithIdentity(sessionKey: string | null | undefined, checksum: string | null | undefined): string | null | undefined {
  if (!sessionKey || !checksum) return sessionKey;
  return `${sessionKey}:identity:${checksum}`;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function redactConfig(value: unknown, key = ''): unknown {
  if (OMIT_KEY_PATTERN.test(key)) return '[omitted]';
  if (SECRET_KEY_PATTERN.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map((item) => redactConfig(item));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) {
    out[childKey] = redactConfig(childValue, childKey);
  }
  return out;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortValue((value as Record<string, unknown>)[key]);
  }
  return out;
}
