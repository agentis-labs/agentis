import { randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  AgentisError,
  schemas,
  type ActiveWorkflowSummary,
  type AppActivationResult,
  type AppDeploymentSummary,
  type AppWorkflowDeploymentRow,
  type ListenerConfig,
  type TriggerNodeConfig,
  type WorkflowGraph,
  type WorkflowNode,
} from '@agentis/core';
import { nextCronFire } from '../cronNextFire.js';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { TriggerRuntime } from '../../engine/TriggerRuntime.js';
import type { ActiveTrigger } from '../../engine/ActiveWorkflowRegistry.js';
import { hashWorkflowGraph } from '../graphHash.js';
import { normalizeExtensionManifest } from '../extensionRuntime.js';
import { preflightWorkflow } from './workflowPreflight.js';
import { deriveLoopStage, graphContentHash, readBuildLoop } from './workflowCompass.js';

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
    /** SWIFT arming-gate override — explicit + audited, never silent. */
    override?: { ack: string };
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
      // ── SWIFT arming gate (§2-T1): an UNATTENDED trigger (cron / webhook /
      // listener) only arms on a workflow whose CURRENT graph earned hardened
      // (or already proved itself with a completed production run). Operational
      // preflight above proves it CAN run; this gate proves it ACCOMPLISHES.
      // Override is explicit + audited — never silent.
      const stage = deriveLoopStage(readBuildLoop(workflow.settings), graphContentHash(graph));
      if (stage !== 'hardened' && stage !== 'production') {
        if (args.override?.ack?.trim()) {
          this.db.insert(schema.auditEntries).values({
            id: randomUUID(),
            workspaceId: args.workspaceId,
            runId: `trigger:${args.workflowId}`,
            phaseId: null,
            nodeId: null,
            agentId: null,
            action: 'trigger.armed_unhardened',
            actorType: 'user',
            actorId: args.userId,
            inputSummary: `stage=${stage}`,
            outputSummary: `override ack: ${args.override.ack.slice(0, 300)}`,
            at: new Date().toISOString(),
          }).run();
        } else {
          throw new AgentisError(
            'WORKFLOW_GRAPH_INVALID',
            `BLOCKED_LIFECYCLE_NOT_HARDENED: this workflow is at stage "${stage}" — an unattended ${effectiveType} trigger only arms once the workflow is HARDENED at the current graph (spec scoped → dry-run green → suite green → debug run ACCOMPLISHED → agentis.workflow.harden). Run agentis.workflow.loop_status for the exact next call, or pass override:{ack:"<reason>"} to arm anyway (audited).`,
          );
        }
      }
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

  // ─────────────────────────────────────────────
  // App-level always-on lifecycle
  // ─────────────────────────────────────────────
  //
  // An App is multi-workflow, so "going live" means arming every workflow that
  // authors an unattended trigger. These methods COMPOSE the per-workflow
  // `activate` / `setStatus` above (never a forked activation path) so the App
  // lifecycle stays consistent with the canvas one, SWIFT arming gate included.

  /** Composite activation state of an App across all its bound workflows. */
  getForApp(workspaceId: string, appId: string): AppDeploymentSummary {
    const workflows = this.#appWorkflows(workspaceId, appId);
    const rows: AppWorkflowDeploymentRow[] = [];
    const listeners = { connected: 0, events: 0, runs: 0, errors: 0 };
    let armable = 0;
    let armed = 0;
    for (const wf of workflows) {
      const authored = authoredTriggerType(wf.graph as WorkflowGraph);
      const effective = authored ? effectiveTriggerType(authored) : null;
      const dep = this.get(workspaceId, wf.id);
      if (!effective || effective === 'manual') {
        rows.push({ workflowId: wf.id, title: wf.title, triggerType: 'manual', status: 'manual', lastFiredAt: dep?.lastFiredAt ?? null });
        continue;
      }
      armable += 1;
      const status = dep && dep.triggerType !== 'manual' ? dep.status : 'unarmed';
      if (status === 'active') {
        armed += 1;
        const health = dep?.health as { connected?: boolean; eventCount?: number; fireCount?: number; status?: string } | null | undefined;
        if (health) {
          if (health.connected) listeners.connected += 1;
          listeners.events += Number(health.eventCount ?? 0);
          listeners.runs += Number(health.fireCount ?? 0);
          if (health.status === 'error') listeners.errors += 1;
        }
      }
      rows.push({
        workflowId: wf.id,
        title: wf.title,
        triggerType: effective,
        status,
        lastFiredAt: dep?.lastFiredAt ?? null,
        ...(effective === 'persistent_listener' ? { health: dep?.health } : {}),
      });
    }
    const status: AppDeploymentSummary['status'] =
      armable === 0 ? 'none' : armed === 0 ? 'paused' : armed === armable ? 'live' : 'partial';
    return { appId, status, armable, armed, listeners, workflows: rows };
  }

  /**
   * Every "always-on" workflow across the workspace — one whose entry trigger is
   * currently ARMED (active, non-manual). The workspace-wide source for /home's
   * Active section and any platform-wide live indicator.
   */
  listActive(workspaceId: string): ActiveWorkflowSummary[] {
    const armed = this.db
      .select()
      .from(schema.triggers)
      .where(and(eq(schema.triggers.workspaceId, workspaceId), eq(schema.triggers.status, 'active')))
      .all()
      .filter((t) => t.triggerType !== 'manual');

    const out: ActiveWorkflowSummary[] = [];
    for (const t of armed) {
      const wf = this.db
        .select({ id: schema.workflows.id, title: schema.workflows.title, appId: schema.workflows.appId })
        .from(schema.workflows)
        .where(eq(schema.workflows.id, t.workflowId))
        .get();
      if (!wf) continue;
      const app = wf.appId
        ? this.db.select({ name: schema.apps.name }).from(schema.apps).where(eq(schema.apps.id, wf.appId)).get()
        : null;
      // Recent history in one read — the newest doubles as `lastRun`.
      const recentRows = this.db
        .select({ id: schema.workflowRuns.id, status: schema.workflowRuns.status, startedAt: schema.workflowRuns.startedAt, completedAt: schema.workflowRuns.completedAt, createdAt: schema.workflowRuns.createdAt })
        .from(schema.workflowRuns)
        .where(and(eq(schema.workflowRuns.workspaceId, workspaceId), eq(schema.workflowRuns.workflowId, wf.id)))
        .orderBy(desc(schema.workflowRuns.createdAt))
        .limit(8)
        .all();
      const recentRuns = recentRows.map((r) => ({
        id: r.id,
        status: r.status,
        at: r.startedAt ?? r.createdAt,
        durationMs: r.startedAt && r.completedAt ? Math.max(0, Date.parse(r.completedAt) - Date.parse(r.startedAt)) : null,
      }));
      const lastRun = recentRuns[0] ?? null;
      // An active run can be older than the recent window (parked WAITING/PAUSED).
      const activeRun = this.db
        .select({ id: schema.workflowRuns.id, status: schema.workflowRuns.status, startedAt: schema.workflowRuns.startedAt, createdAt: schema.workflowRuns.createdAt })
        .from(schema.workflowRuns)
        .where(and(
          eq(schema.workflowRuns.workspaceId, workspaceId),
          eq(schema.workflowRuns.workflowId, wf.id),
          inArray(schema.workflowRuns.status, ['RUNNING', 'WAITING', 'PAUSED']),
        ))
        .orderBy(desc(schema.workflowRuns.createdAt))
        .limit(1)
        .get();
      const totalRuns = this.db
        .select({ n: sql<number>`count(*)` })
        .from(schema.workflowRuns)
        .where(and(eq(schema.workflowRuns.workspaceId, workspaceId), eq(schema.workflowRuns.workflowId, wf.id)))
        .get()?.n ?? 0;

      const config = objectRecord(t.config);
      const triggerType = t.triggerType as 'cron' | 'webhook' | 'persistent_listener';
      const source = objectRecord(config.source);
      const intervalMs = source.kind === 'interval' && typeof source.intervalMs === 'number' ? source.intervalMs : null;
      const nextRunAt = triggerType === 'cron' && typeof config.expression === 'string'
        ? nextCronFire(config.expression)?.toISOString() ?? null
        : intervalMs && t.lastFiredAt
          ? new Date(Date.parse(t.lastFiredAt) + intervalMs).toISOString()
          : null;
      out.push({
        workflowId: wf.id,
        title: wf.title,
        appId: wf.appId ?? null,
        appName: app?.name ?? null,
        triggerType,
        status: normalizeStatus(t.status),
        lastFiredAt: t.lastFiredAt,
        nextRunAt,
        intervalMs,
        ...(triggerType === 'persistent_listener' ? { health: this.runtime.listeners?.health(t.id) ?? null } : {}),
        lastRun: lastRun ? { id: lastRun.id, status: lastRun.status, at: lastRun.at } : null,
        activeRun: activeRun ? { id: activeRun.id, status: activeRun.status, startedAt: activeRun.startedAt ?? activeRun.createdAt } : null,
        recentRuns,
        totalRuns,
      });
    }
    // Live first, then most-recently-fired.
    return out.sort((a, b) => {
      if (!!a.activeRun !== !!b.activeRun) return a.activeRun ? -1 : 1;
      return (b.lastFiredAt ?? '').localeCompare(a.lastFiredAt ?? '');
    });
  }

  /** Arm every armable workflow in an App. Per-workflow failures are reported, not fatal. */
  async activateApp(args: {
    workspaceId: string;
    appId: string;
    userId: string;
    /** SWIFT arming-gate override — applied per workflow, audited. */
    override?: { ack: string };
  }): Promise<{ deployment: AppDeploymentSummary; results: AppActivationResult[] }> {
    const workflows = this.#appWorkflows(args.workspaceId, args.appId);
    const results: AppActivationResult[] = [];
    for (const wf of workflows) {
      const authored = authoredTriggerType(wf.graph as WorkflowGraph);
      const effective = authored ? effectiveTriggerType(authored) : null;
      if (!effective || effective === 'manual') {
        results.push({ workflowId: wf.id, title: wf.title, outcome: 'skipped', message: 'Manual trigger — run on demand.' });
        continue;
      }
      try {
        await this.activate({
          workspaceId: args.workspaceId,
          workflowId: wf.id,
          ambientId: wf.ambientId,
          userId: args.userId,
          override: args.override,
        });
        results.push({ workflowId: wf.id, title: wf.title, outcome: 'armed' });
      } catch (error) {
        const err = error as AgentisError & { message: string };
        const blocked = typeof err.message === 'string' && /BLOCKED_LIFECYCLE_NOT_HARDENED/.test(err.message);
        results.push({
          workflowId: wf.id,
          title: wf.title,
          outcome: blocked ? 'blocked' : 'error',
          message: err.message,
        });
      }
    }
    return { deployment: this.getForApp(args.workspaceId, args.appId), results };
  }

  /** Disarm (pause) every armed workflow in an App. */
  async deactivateApp(args: {
    workspaceId: string;
    appId: string;
  }): Promise<{ deployment: AppDeploymentSummary; results: AppActivationResult[] }> {
    const workflows = this.#appWorkflows(args.workspaceId, args.appId);
    const results: AppActivationResult[] = [];
    for (const wf of workflows) {
      const dep = this.get(args.workspaceId, wf.id);
      if (!dep || dep.triggerType === 'manual' || dep.status !== 'active') {
        continue;
      }
      try {
        await this.setStatus(args.workspaceId, wf.id, 'paused');
        results.push({ workflowId: wf.id, title: wf.title, outcome: 'disarmed' });
      } catch (error) {
        results.push({ workflowId: wf.id, title: wf.title, outcome: 'error', message: (error as Error).message });
      }
    }
    return { deployment: this.getForApp(args.workspaceId, args.appId), results };
  }

  #appWorkflows(workspaceId: string, appId: string) {
    return this.db
      .select({
        id: schema.workflows.id,
        title: schema.workflows.title,
        ambientId: schema.workflows.ambientId,
        graph: schema.workflows.graph,
      })
      .from(schema.workflows)
      .where(and(eq(schema.workflows.workspaceId, workspaceId), eq(schema.workflows.appId, appId)))
      .all();
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
export function effectiveTriggerType(
  t: TriggerNodeConfig['triggerType'],
): 'manual' | 'cron' | 'webhook' | 'persistent_listener' {
  if (t === 'error_trigger' || t === 'rss_feed' || t === 'email_imap') return 'persistent_listener';
  return t;
}

/** The authored trigger type of a graph's single entry trigger node, or null. */
function authoredTriggerType(graph: WorkflowGraph | null | undefined): TriggerNodeConfig['triggerType'] | null {
  const node = graph?.nodes?.find((n) => n.config?.kind === 'trigger');
  if (!node || node.config.kind !== 'trigger') return null;
  return (node.config as TriggerNodeConfig).triggerType ?? null;
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
