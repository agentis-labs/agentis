/**
 * Workflow readiness — "what does this workflow need before it can actually run?"
 *
 * Agentis is a domain-agnostic automation platform: a workflow should never
 * silently "complete" by emitting a JSON payload while the real action (send a
 * message, call an API, post to a service) never happened for lack of setup.
 * This analyzer inspects ANY graph and reports, in plain language, the setup a
 * human still owes — connecting an account, supplying credentials — so the chat
 * can ask intelligently up front instead of the operator discovering a dead run.
 *
 * Connector-agnostic by construction: it reads the integration manifests
 * (auth requirements) and the workspace's stored credentials. No service is
 * special-cased. An integration is considered satisfied when ANY of:
 *   - the node already references a credential (`credentialId`), or
 *   - the workspace holds a credential of that integration's type, or
 *   - a conventional environment fallback is present (`<SLUG>_API_KEY`).
 */

import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import {
  affordanceLabel,
  configuredAffordances,
  normalizeAgentRequirements,
  potentialAffordances,
  requiredAffordanceKeys,
  schemas,
  type AgentAffordance,
  type WorkflowGraph,
} from '@agentis/core';
import { listIntegrationManifests } from './integrationRegistry.js';

const HAL_AGENT_NODE_KINDS = new Set(['agent_task', 'agent_session', 'agent_swarm', 'dynamic_swarm']);

export interface SetupRequirement {
  nodeId: string;
  nodeTitle: string;
  kind: 'credential' | 'config';
  /** Integration slug when applicable. */
  integration?: string;
  /** Plain-language, actionable sentence the chat can show verbatim. */
  message: string;
}

export interface WorkflowReadiness {
  ready: boolean;
  requirements: SetupRequirement[];
  /** One-line, plain-language summary suitable for chat. */
  summary: string;
}

function envFallbackPresent(slug: string): boolean {
  const key = `${slug.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
  return Boolean(process.env[key]?.trim());
}

/**
 * Analyze a graph for setup the operator still owes before a real run. Pure read
 * (no mutation). Advisory: it never blocks authoring — it informs.
 */
export function analyzeWorkflowReadiness(
  db: AgentisSqliteDb,
  workspaceId: string,
  graph: WorkflowGraph,
): WorkflowReadiness {
  const manifests = new Map(
    listIntegrationManifests(db, workspaceId).map((m) => [m.service.toLowerCase(), m]),
  );
  const credentialTypes = new Set(
    db
      .select({ type: schema.credentials.credentialType })
      .from(schema.credentials)
      .where(eq(schema.credentials.workspaceId, workspaceId))
      .all()
      .map((row) => String(row.type).toLowerCase()),
  );

  // HAL supply view: what each workspace agent's runtime can provide by config
  // (and could provide if enabled) — derived from the agent row, no live adapter
  // needed. Lets us flag a node whose HAL `requires` no runtime can satisfy
  // BEFORE the run dies, with an actionable remediation.
  const halAgents = db
    .select({ name: schema.agents.name, adapterType: schema.agents.adapterType, config: schema.agents.config })
    .from(schema.agents)
    .where(eq(schema.agents.workspaceId, workspaceId))
    .all()
    .map((row) => ({
      name: row.name,
      configured: configuredAffordances(row.adapterType, objectRecord(row.config)),
      potential: potentialAffordances(row.adapterType),
    }));

  const requirements: SetupRequirement[] = [];

  for (const node of graph.nodes) {
    const cfg = node.config as Record<string, unknown> & { kind?: string };
    const title = node.title || node.id;

    if (cfg.kind === 'trigger') {
      const triggerType = String(cfg.triggerType ?? 'manual');
      if (triggerType === 'cron' && !String(cfg.schedule ?? '').trim()) {
        requirements.push({
          nodeId: node.id,
          nodeTitle: title,
          kind: 'config',
          message: `Set a cron expression on the "${title}" trigger.`,
        });
      }
      if (triggerType === 'persistent_listener') {
        const parsed = schemas.listenerConfigSchema.safeParse(cfg.listenerConfig);
        if (!parsed.success) {
          requirements.push({
            nodeId: node.id,
            nodeTitle: title,
            kind: 'config',
            message: `Configure the source, predicate, and fire policy on the "${title}" listener.`,
          });
        }
      }
    } else if (cfg.kind === 'integration') {
      const slug = String(cfg.integrationId ?? '').toLowerCase();
      if (!slug) continue;
      const manifest = manifests.get(slug);
      // Operation sanity: flag an operationId the connector doesn't support, so
      // the run doesn't dead-end at "operation 'X' is not supported by Y".
      const op = String(cfg.operationId ?? '');
      if (manifest && op && manifest.operations.length > 0 && !manifest.operations.includes(op)) {
        requirements.push({
          nodeId: node.id,
          nodeTitle: title,
          kind: 'config',
          integration: slug,
          message: `The “${title}” step uses operation “${op}”, which ${manifest.name} doesn’t support. Use one of: ${manifest.operations.join(', ')}.`,
        });
      }
      // Unknown integration → assume it needs auth (safer to ask than to fail).
      const missingInput = firstMissingContractInput(
        objectRecord(cfg.inputs),
        op ? manifest?.operationContracts?.[op] : undefined,
      );
      if (missingInput) {
        requirements.push({
          nodeId: node.id,
          nodeTitle: title,
          kind: 'config',
          integration: slug,
          message: `Configure "${missingInput}" on the "${title}" step.`,
        });
      }
      const authType = manifest?.auth?.type ?? 'api_key';
      if (authType === 'none') continue;
      const satisfied = Boolean(cfg.credentialId)
        || credentialTypes.has(slug)
        || credentialTypes.has(`integration_${slug}`)
        || credentialTypes.has(`oauth_${slug}`)
        || envFallbackPresent(slug);
      if (!satisfied) {
        const label = manifest?.name ?? slug;
        requirements.push({
          nodeId: node.id,
          nodeTitle: title,
          kind: 'credential',
          integration: slug,
          message: `Connect your ${label} account so the “${title}” step can run.`,
        });
      }
    } else if (cfg.kind === 'http_request') {
      const auth = cfg.auth as { type?: string; credentialId?: string } | undefined;
      if (auth?.type && auth.type !== 'none' && !auth.credentialId) {
        requirements.push({
          nodeId: node.id,
          nodeTitle: title,
          kind: 'credential',
          message: `Add the credential for the “${title}” HTTP step (it uses ${auth.type} auth).`,
        });
      }
    } else if (HAL_AGENT_NODE_KINDS.has(String(cfg.kind ?? ''))) {
      // `fileSystem` is covered by the platform tool loop itself; every other HAL
      // affordance needs a real connected runtime that advertises it.
      const required = requiredAffordanceKeys(normalizeAgentRequirements(cfg.requires))
        .filter((key): key is AgentAffordance => key !== 'fileSystem');
      if (required.length === 0) continue;
      const labels = required.map(affordanceLabel).join(', ');
      const satisfiable = halAgents.some((agent) => required.every((key) => agent.configured[key] === true));
      if (satisfiable) continue;
      const enablable = halAgents.find((agent) => required.every((key) => agent.potential[key] === true));
      requirements.push({
        nodeId: node.id,
        nodeTitle: title,
        kind: 'config',
        message: enablable
          ? `The “${title}” step needs ${labels}. Enable it on “${enablable.name}” (its runtime supports it) or connect an OpenClaw agent — or replace this step with a Browser node.`
          : `No connected runtime can provide ${labels} for the “${title}” step. Connect an OpenClaw agent or enable native browser on a Codex agent — or use a Browser node instead.`,
      });
    }
  }

  const summary = requirements.length === 0
    ? 'This workflow is ready to run.'
    : `Before this can run for real, you’ll need to: ${requirements.map((r) => r.message).join(' ')}`;

  return { ready: requirements.length === 0, requirements, summary };
}

function firstMissingContractInput(
  inputs: Record<string, unknown>,
  contract: {
    required?: readonly string[];
    requiredAny?: ReadonlyArray<readonly string[]>;
    aliases?: Record<string, readonly string[]>;
  } | undefined,
): string | null {
  if (!contract) return null;
  for (const field of contract.required ?? []) {
    if (!hasContractValue(inputs, field, contract.aliases?.[field] ?? [])) return field;
  }
  for (const group of contract.requiredAny ?? []) {
    if (!group.some((field) => hasContractValue(inputs, field, contract.aliases?.[field] ?? []))) {
      return group.join(' or ');
    }
  }
  return null;
}

function hasContractValue(inputs: Record<string, unknown>, field: string, aliases: readonly string[]): boolean {
  for (const key of [field, ...aliases]) {
    const value = inputs[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    return true;
  }
  return false;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
