import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  AgentisError,
  schemas,
  type ListenerConfig,
  type TriggerNodeConfig,
  type WorkflowGraph,
  type WorkflowNode,
} from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { TriggerRuntime } from '../engine/TriggerRuntime.js';
import type { ActiveTrigger } from '../engine/ActiveWorkflowRegistry.js';
import { hashWorkflowGraph } from './graphHash.js';
import { normalizeExtensionManifest } from './extensionRuntime.js';
import { preflightWorkflow } from './workflowPreflight.js';

type TriggerType = TriggerNodeConfig['triggerType'];

export interface WorkflowTriggerDeployment {
  triggerId: string;
  workflowId: string;
  triggerType: TriggerType;
  status: 'active' | 'paused' | 'error';
  updatedAt: string;
  lastFiredAt: string | null;
  webhookUrl?: string;
  webhookSecret?: string;
  config: Record<string, unknown>;
  health?: unknown;
}

export class WorkflowTriggerDeploymentService {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly runtime: TriggerRuntime,
  ) {}

  get(workspaceId: string, workflowId: string): WorkflowTriggerDeployment | null {
    const workflow = this.#loadWorkflow(workspaceId, workflowId);
    const graph = workflow.graph as WorkflowGraph;
    const triggerNode = findTriggerNode(graph, false);
    const triggerId = triggerNode?.config.kind === 'trigger' ? triggerNode.config.triggerId : undefined;
    const rows = this.#workflowTriggers(workspaceId, workflowId);
    const row = (triggerId ? rows.find((candidate) => candidate.id === triggerId) : undefined)
      ?? pickCanonicalTrigger(rows);
    return row ? this.#present(row) : null;
  }

  async activate(args: {
    workspaceId: string;
    workflowId: string;
    ambientId: string | null;
    userId: string;
  }): Promise<WorkflowTriggerDeployment> {
    const workflow = this.#loadWorkflow(args.workspaceId, args.workflowId);
    const graph = workflow.graph as WorkflowGraph;
    const health = preflightWorkflow({
      db: this.db,
      workspaceId: args.workspaceId,
      workflowId: args.workflowId,
      graph,
    });
    if (health.status === 'blocked') {
      const first = health.issues.find((issue) => issue.severity === 'error');
      throw new AgentisError(
        'WORKFLOW_GRAPH_INVALID',
        `Workflow cannot be activated until preflight passes${first ? `: ${first.message}` : ''}`,
      );
    }
    const triggerNode = findTriggerNode(graph, true)!;
    const authored = triggerNode.config as TriggerNodeConfig;

    const runtimeConfig = runtimeConfigFromNode(authored);
    const effectiveType = effectiveTriggerType(authored.triggerType);
    if (effectiveType !== 'manual') {
      this.#assertRuntimeDependencies(args.workspaceId, effectiveType, runtimeConfig);
    }
    const existingRows = this.#workflowTriggers(args.workspaceId, args.workflowId);
    const existing = (authored.triggerId
      ? existingRows.find((candidate) => candidate.id === authored.triggerId)
      : undefined) ?? pickCanonicalTrigger(existingRows);

    // A graph has one entry trigger, so only one runtime resource may remain live.
    for (const row of existingRows) {
      if (row.status === 'active') await this.runtime.deactivate(row.id);
    }

    const triggerId = existing?.id ?? authored.triggerId ?? randomUUID();
    const triggerType = effectiveType;
    const now = new Date().toISOString();
    const needsWebhookSecret = triggerType === 'webhook'
      && (!existing?.webhookSecret || existing.triggerType !== 'webhook');
    const webhookSecret = triggerType === 'webhook'
      ? existing?.triggerType === 'webhook' && existing.webhookSecret
        ? existing.webhookSecret
        : randomBytes(32).toString('base64url')
      : null;

    if (existing) {
      this.db
        .update(schema.triggers)
        .set({
          ambientId: args.ambientId,
          userId: args.userId,
          triggerType,
          config: runtimeConfig,
          status: 'paused',
          webhookSecret,
          updatedAt: now,
        })
        .where(eq(schema.triggers.id, triggerId))
        .run();
    } else {
      this.db
        .insert(schema.triggers)
        .values({
          id: triggerId,
          workspaceId: args.workspaceId,
          ambientId: args.ambientId,
          workflowId: args.workflowId,
          userId: args.userId,
          triggerType,
          config: runtimeConfig,
          status: 'paused',
          webhookSecret,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    const nextGraph = linkTriggerNode(graph, triggerNode.id, triggerId, authored, runtimeConfig);
    this.db
      .update(schema.workflows)
      .set({ graph: nextGraph, contentHash: hashWorkflowGraph(nextGraph), updatedAt: now })
      .where(eq(schema.workflows.id, args.workflowId))
      .run();

    if (triggerType === 'manual') {
      this.db
        .update(schema.triggers)
        .set({ status: 'active', updatedAt: new Date().toISOString() })
        .where(eq(schema.triggers.id, triggerId))
        .run();
    } else {
      const active = toActiveTrigger({
        triggerId,
        workflowId: args.workflowId,
        workspaceId: args.workspaceId,
        ambientId: args.ambientId,
        userId: args.userId,
        triggerType,
        config: runtimeConfig,
      });
      try {
        await this.runtime.activate(active);
      } catch (error) {
        this.db
          .update(schema.triggers)
          .set({ status: 'error', updatedAt: new Date().toISOString() })
          .where(eq(schema.triggers.id, triggerId))
          .run();
        throw error;
      }
    }

    const row = this.db.select().from(schema.triggers).where(eq(schema.triggers.id, triggerId)).get()!;
    return this.#present(row, needsWebhookSecret ? webhookSecret ?? undefined : undefined);
  }

  async setStatus(
    workspaceId: string,
    workflowId: string,
    status: 'active' | 'paused',
  ): Promise<WorkflowTriggerDeployment> {
    this.#loadWorkflow(workspaceId, workflowId);
    const row = pickCanonicalTrigger(this.#workflowTriggers(workspaceId, workflowId));
    if (!row) {
      throw new AgentisError('RESOURCE_NOT_FOUND', 'This workflow has not been activated yet.');
    }
    if (row.triggerType === 'manual') {
      this.db.update(schema.triggers).set({ status, updatedAt: new Date().toISOString() }).where(eq(schema.triggers.id, row.id)).run();
    } else if (status === 'active') {
      await this.runtime.activate(toActiveTrigger({
        triggerId: row.id,
        workflowId: row.workflowId,
        workspaceId: row.workspaceId,
        ambientId: row.ambientId,
        userId: row.userId,
        triggerType: row.triggerType as ActiveTrigger['triggerType'],
        config: objectRecord(row.config),
      }));
    } else {
      await this.runtime.deactivate(row.id);
    }
    const fresh = this.db.select().from(schema.triggers).where(eq(schema.triggers.id, row.id)).get()!;
    return this.#present(fresh);
  }

  #loadWorkflow(workspaceId: string, workflowId: string) {
    const workflow = this.db
      .select()
      .from(schema.workflows)
      .where(and(eq(schema.workflows.id, workflowId), eq(schema.workflows.workspaceId, workspaceId)))
      .get();
    if (!workflow) throw new AgentisError('RESOURCE_NOT_FOUND', `workflow ${workflowId} not found`);
    return workflow;
  }

  #workflowTriggers(workspaceId: string, workflowId: string) {
    return this.db
      .select()
      .from(schema.triggers)
      .where(and(eq(schema.triggers.workspaceId, workspaceId), eq(schema.triggers.workflowId, workflowId)))
      .all();
  }

  #present(
    row: typeof schema.triggers.$inferSelect,
    webhookSecret?: string,
  ): WorkflowTriggerDeployment {
    const triggerType = row.triggerType as TriggerType;
    return {
      triggerId: row.id,
      workflowId: row.workflowId,
      triggerType,
      status: normalizeStatus(row.status),
      updatedAt: row.updatedAt,
      lastFiredAt: row.lastFiredAt,
      config: objectRecord(row.config),
      ...(triggerType === 'webhook' ? { webhookUrl: `/v1/webhooks/trigger/${row.id}` } : {}),
      ...(webhookSecret ? { webhookSecret } : {}),
      ...(triggerType === 'persistent_listener'
        ? { health: this.runtime.listeners?.health(row.id) ?? null }
        : {}),
    };
  }

  #assertRuntimeDependencies(
    workspaceId: string,
    triggerType: Exclude<TriggerType, 'manual'>,
    config: Record<string, unknown>,
  ): void {
    if (triggerType !== 'persistent_listener') return;
    const listener = config as unknown as ListenerConfig;
    if (listener.source.kind === 'extension') {
      const source = listener.source;
      const extension = source.extensionId
        ? this.db.select().from(schema.extensions).where(eq(schema.extensions.id, source.extensionId)).get()
        : this.db
            .select()
            .from(schema.extensions)
            .where(and(
              eq(schema.extensions.workspaceId, workspaceId),
              eq(schema.extensions.slug, source.extensionSlug ?? ''),
            ))
            .get();
      if (!extension || extension.workspaceId !== workspaceId) {
        throw new AgentisError('EXTENSION_NOT_FOUND', 'Choose an installed listener-source extension.');
      }
      const manifest = normalizeExtensionManifest(extension.manifest, extension);
      const operation = manifest.operations.find((candidate) => candidate.name === source.operationName);
      if (
        manifest.runtime !== 'node_worker'
        || !(manifest.permissions ?? []).includes('listener')
        || !(manifest.permissions ?? []).includes('listener.emit')
        || !operation
        || !(operation.isListenerSource || (manifest.listenerOperations ?? []).includes(operation.name))
      ) {
        throw new AgentisError(
          'EXTENSION_PERMISSION_INVALID',
          `${extension.name} does not expose "${source.operationName}" as a listener source.`,
        );
      }
    }
    if (listener.source.kind === 'agent_event') {
      const agent = this.db.select().from(schema.agents).where(eq(schema.agents.id, listener.source.agentId)).get();
      if (!agent || agent.workspaceId !== workspaceId) {
        throw new AgentisError('RESOURCE_NOT_FOUND', 'Choose an agent from this workspace for the listener source.');
      }
    }
    if (listener.source.kind === 'workflow_event' && listener.source.workflowId !== '*') {
      // `'*'` is the error_trigger "any workflow in this workspace" scope — no
      // specific target to verify.
      const workflow = this.db.select().from(schema.workflows).where(eq(schema.workflows.id, listener.source.workflowId)).get();
      if (!workflow || workflow.workspaceId !== workspaceId) {
        throw new AgentisError('RESOURCE_NOT_FOUND', 'Choose a workflow from this workspace for the listener source.');
      }
    }
  }
}

function findTriggerNode(graph: WorkflowGraph, required: boolean): WorkflowNode | null {
  const triggers = graph.nodes.filter((node) => node.config.kind === 'trigger');
  if (triggers.length === 1) return triggers[0]!;
  if (!required && triggers.length === 0) return null;
  throw new AgentisError(
    'TRIGGER_INVALID_CONFIG',
    triggers.length === 0
      ? 'Add a trigger node before activating this workflow.'
      : 'A workflow can only activate one trigger node.',
  );
}

/**
 * The 3 canvas trigger types added by WORKFLOW-UPDATE (error_trigger, rss_feed,
 * email_imap) are runtime-equivalent to `persistent_listener` — they each
 * synthesize a ListenerConfig and run through the ListenerRuntime. Everything
 * else maps to itself. This keeps the DB trigger taxonomy + ActiveTrigger union
 * unchanged while exposing the new types first-class on the canvas.
 */
function effectiveTriggerType(
  t: TriggerNodeConfig['triggerType'],
): 'manual' | 'cron' | 'webhook' | 'persistent_listener' {
  if (t === 'error_trigger' || t === 'rss_feed' || t === 'email_imap') return 'persistent_listener';
  return t;
}

function runtimeConfigFromNode(config: TriggerNodeConfig): Record<string, unknown> {
  switch (config.triggerType) {
    case 'cron': {
      // Prefer the first non-empty scheduleRule, else the single `schedule`.
      const expression = config.scheduleRules?.find((r) => r.expression?.trim())?.expression?.trim()
        ?? config.schedule?.trim();
      if (!expression) {
        throw new AgentisError('TRIGGER_INVALID_CONFIG', 'Schedule triggers require a cron expression.');
      }
      const out: Record<string, unknown> = { expression, timezone: config.timezone?.trim() || 'UTC' };
      if (config.scheduleRules && config.scheduleRules.length > 0) {
        out.scheduleRules = config.scheduleRules
          .filter((r) => r.expression?.trim())
          .map((r) => ({ expression: r.expression.trim(), timezone: (r.timezone ?? config.timezone)?.trim() || 'UTC', label: r.label }));
      }
      return out;
    }
    case 'webhook':
      return {};
    case 'persistent_listener': {
      const parsed = schemas.listenerConfigSchema.safeParse(config.listenerConfig);
      if (!parsed.success) {
        throw new AgentisError('LISTENER_INVALID_CONFIG', 'Complete the listener source configuration before activating.', {
          details: { issues: parsed.error.issues },
        });
      }
      return parsed.data as ListenerConfig as unknown as Record<string, unknown>;
    }
    case 'error_trigger': {
      const et = config.errorTrigger;
      const onStatus = et?.onStatus && et.onStatus.length > 0 ? et.onStatus : (['FAILED'] as const);
      const listener: ListenerConfig = {
        source: { kind: 'workflow_event', workflowId: et?.targetWorkflowId ?? '*', onStatus: [...onStatus] },
        firePolicy: { mode: 'immediate' },
      };
      return validateSynthesizedListener(listener);
    }
    case 'rss_feed': {
      const rss = config.rssFeed;
      if (!rss?.feedUrl?.trim()) {
        throw new AgentisError('TRIGGER_INVALID_CONFIG', 'RSS triggers require a feed URL.');
      }
      const listener: ListenerConfig = {
        source: { kind: 'rss', feedUrl: rss.feedUrl.trim(), intervalMs: Math.max(5_000, rss.pollIntervalMs ?? 300_000) },
        firePolicy: { mode: 'immediate' },
      };
      return validateSynthesizedListener(listener);
    }
    case 'email_imap': {
      const im = config.emailImap;
      if (!im?.host?.trim()) {
        throw new AgentisError('TRIGGER_INVALID_CONFIG', 'IMAP triggers require a host.');
      }
      const listener: ListenerConfig = {
        source: {
          kind: 'email_imap',
          host: im.host.trim(),
          port: im.port,
          secure: im.secure,
          credentialId: im.credentialId,
          mailbox: im.mailbox,
          search: im.search,
          pollIntervalMs: Math.max(5_000, im.pollIntervalMs ?? 60_000),
        },
        firePolicy: { mode: 'immediate' },
      };
      return validateSynthesizedListener(listener);
    }
    case 'manual':
      return {};
  }
}

function validateSynthesizedListener(listener: ListenerConfig): Record<string, unknown> {
  const parsed = schemas.listenerConfigSchema.safeParse(listener);
  if (!parsed.success) {
    throw new AgentisError('LISTENER_INVALID_CONFIG', 'Synthesized listener config is invalid.', {
      details: { issues: parsed.error.issues },
    });
  }
  return parsed.data as ListenerConfig as unknown as Record<string, unknown>;
}

function linkTriggerNode(
  graph: WorkflowGraph,
  nodeId: string,
  triggerId: string,
  authored: TriggerNodeConfig,
  runtimeConfig: Record<string, unknown>,
): WorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      if (node.id !== nodeId || node.config.kind !== 'trigger') return node;
      const nextConfig: TriggerNodeConfig = {
        ...authored,
        triggerId,
        ...(authored.triggerType === 'cron'
          ? {
              schedule: String(runtimeConfig.expression),
              timezone: String(runtimeConfig.timezone ?? 'UTC'),
            }
          : {}),
        ...(effectiveTriggerType(authored.triggerType) === 'persistent_listener'
          ? { listenerConfig: runtimeConfig as unknown as ListenerConfig }
          : {}),
      };
      return { ...node, config: nextConfig };
    }),
  };
}

function pickCanonicalTrigger(
  rows: Array<typeof schema.triggers.$inferSelect>,
): typeof schema.triggers.$inferSelect | undefined {
  return [...rows].sort((left, right) => {
    if (left.status === 'active' && right.status !== 'active') return -1;
    if (right.status === 'active' && left.status !== 'active') return 1;
    return right.updatedAt.localeCompare(left.updatedAt);
  })[0];
}

function toActiveTrigger(args: {
  triggerId: string;
  workflowId: string;
  workspaceId: string;
  ambientId: string | null;
  userId: string;
  triggerType: ActiveTrigger['triggerType'];
  config: Record<string, unknown>;
}): ActiveTrigger {
  return args;
}

function normalizeStatus(value: string): 'active' | 'paused' | 'error' {
  return value === 'active' || value === 'error' ? value : 'paused';
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
