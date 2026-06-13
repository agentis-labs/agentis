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

type TriggerType = TriggerNodeConfig['triggerType'];

export interface WorkflowTriggerDeployment {
  triggerId: string;
  workflowId: string;
  triggerType: Exclude<TriggerType, 'manual'>;
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

  async publish(args: {
    workspaceId: string;
    workflowId: string;
    ambientId: string | null;
    userId: string;
  }): Promise<WorkflowTriggerDeployment> {
    const workflow = this.#loadWorkflow(args.workspaceId, args.workflowId);
    const graph = workflow.graph as WorkflowGraph;
    const triggerNode = findTriggerNode(graph, true)!;
    const authored = triggerNode.config as TriggerNodeConfig;
    if (authored.triggerType === 'manual') {
      throw new AgentisError(
        'TRIGGER_INVALID_CONFIG',
        'Manual workflows run on demand and do not need to be published.',
      );
    }

    const runtimeConfig = runtimeConfigFromNode(authored);
    this.#assertRuntimeDependencies(args.workspaceId, authored.triggerType, runtimeConfig);
    const existingRows = this.#workflowTriggers(args.workspaceId, args.workflowId);
    const existing = (authored.triggerId
      ? existingRows.find((candidate) => candidate.id === authored.triggerId)
      : undefined) ?? pickCanonicalTrigger(existingRows);

    // A graph has one entry trigger, so only one runtime resource may remain live.
    for (const row of existingRows) {
      if (row.status === 'active') await this.runtime.deactivate(row.id);
    }

    const triggerId = existing?.id ?? authored.triggerId ?? randomUUID();
    const triggerType = authored.triggerType;
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
      throw new AgentisError('RESOURCE_NOT_FOUND', 'This workflow has not been published yet.');
    }
    if (status === 'active') {
      await this.runtime.activate(toActiveTrigger({
        triggerId: row.id,
        workflowId: row.workflowId,
        workspaceId: row.workspaceId,
        ambientId: row.ambientId,
        userId: row.userId,
        triggerType: row.triggerType as Exclude<TriggerType, 'manual'>,
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
    const triggerType = row.triggerType as Exclude<TriggerType, 'manual'>;
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
    if (listener.source.kind === 'workflow_event') {
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
      ? 'Add a trigger node before publishing this workflow.'
      : 'A workflow can only publish one trigger node.',
  );
}

function runtimeConfigFromNode(config: TriggerNodeConfig): Record<string, unknown> {
  switch (config.triggerType) {
    case 'cron': {
      const expression = config.schedule?.trim();
      if (!expression) {
        throw new AgentisError('TRIGGER_INVALID_CONFIG', 'Schedule triggers require a cron expression.');
      }
      return { expression, timezone: config.timezone?.trim() || 'UTC' };
    }
    case 'webhook':
      return {};
    case 'persistent_listener': {
      const parsed = schemas.listenerConfigSchema.safeParse(config.listenerConfig);
      if (!parsed.success) {
        throw new AgentisError('LISTENER_INVALID_CONFIG', 'Complete the listener source configuration before publishing.', {
          details: { issues: parsed.error.issues },
        });
      }
      return parsed.data as ListenerConfig as unknown as Record<string, unknown>;
    }
    case 'manual':
      return {};
  }
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
        ...(authored.triggerType === 'persistent_listener'
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
  triggerType: Exclude<TriggerType, 'manual'>;
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
