/**
 * /v1/agents — V1-SPEC §3.3 spec-named entry point.
 *
 * Composes the GET-list endpoint with the full CRUD + terminal RPC surface
 * from `agentMutations.ts`. Spec §3.3 expects a single `agents.ts` route
 * file; the implementation was previously split for review-diff hygiene
 * during V1.0/V1.1 development.
 */

import { Hono } from 'hono';
import { and, eq, inArray } from 'drizzle-orm';
import { AgentisError, CONSTANTS, type AdapterCapabilities } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { CredentialVault } from '../services/credentialVault.js';
import type { AdapterManager } from '../adapters/AdapterManager.js';
import type { Logger } from '../logger.js';
import type { ConversationStore } from '../services/conversationStore.js';
import type { EventBus } from '../event-bus.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';
import { buildAgentMutationRoutes } from './agentMutations.js';
import { PLAYBOOK_LIBRARY } from '../data/playbook-library.js';
import { listAgentInstructionFiles, resolveWritableInstructionFile, writeInstructionFile } from '../services/agentInstructionFiles.js';

export interface AgentRoutesDeps {
  db: AgentisSqliteDb;
  auth: AuthService;
  vault: CredentialVault;
  adapters: AdapterManager;
  logger: Logger;
  conversations: ConversationStore;
  bus?: EventBus;
}

export function buildAgentRoutes(deps: AgentRoutesDeps) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const role = c.req.query('role');
    const rows = deps.db
      .select()
      .from(schema.agents)
      .where(role
        ? and(eq(schema.agents.workspaceId, ws.workspaceId), eq(schema.agents.role, role))
        : eq(schema.agents.workspaceId, ws.workspaceId))
      .all();
    const agentIds = rows.map((agent) => agent.id);
    const spaces = deps.db
      .select({ id: schema.spaces.id, name: schema.spaces.name, color: schema.spaces.color })
      .from(schema.spaces)
      .where(eq(schema.spaces.workspaceId, ws.workspaceId))
      .all();
    const tasks = agentIds.length > 0
      ? deps.db
        .select({
          id: schema.tasks.id,
          executorRef: schema.tasks.executorRef,
          workflowId: schema.tasks.workflowId,
          runId: schema.tasks.runId,
          createdAt: schema.tasks.createdAt,
        })
        .from(schema.tasks)
        .where(and(
          eq(schema.tasks.workspaceId, ws.workspaceId),
          eq(schema.tasks.executorType, 'agent'),
          inArray(schema.tasks.executorRef, agentIds),
        ))
        .all()
      : [];
    const taskIds = tasks.map((task) => task.id);
    const runIds = [...new Set(tasks.map((task) => task.runId).filter((runId): runId is string => typeof runId === 'string' && runId.length > 0))];
    const runs = runIds.length > 0
      ? deps.db
        .select({ id: schema.workflowRuns.id, runState: schema.workflowRuns.runState })
        .from(schema.workflowRuns)
        .where(and(eq(schema.workflowRuns.workspaceId, ws.workspaceId), inArray(schema.workflowRuns.id, runIds)))
        .all()
      : [];
    const approvals = taskIds.length > 0
      ? deps.db
        .select({ taskId: schema.approvalRequests.taskId })
        .from(schema.approvalRequests)
        .where(and(
          eq(schema.approvalRequests.workspaceId, ws.workspaceId),
          eq(schema.approvalRequests.status, 'pending'),
          inArray(schema.approvalRequests.taskId, taskIds),
        ))
        .all()
      : [];
    const workflows = deps.db
      .select({ id: schema.workflows.id, graph: schema.workflows.graph })
      .from(schema.workflows)
      .where(eq(schema.workflows.workspaceId, ws.workspaceId))
      .all();
    const spacesById = new Map(spaces.map((space) => [space.id, space]));
    const runsById = new Map(runs.map((run) => [run.id, run]));
    const statsByAgent = new Map(rows.map((agent) => [agent.id, createAgentNodeStats()]));
    const taskAgentById = new Map(tasks.map((task) => [task.id, task.executorRef]));
    const todayStartMs = startOfUtcDayMs();

    for (const task of tasks) {
      const stats = statsByAgent.get(task.executorRef);
      if (!stats) continue;
      stats.workflowIds.add(task.workflowId);
      const createdAtMs = Date.parse(task.createdAt);
      if (!Number.isFinite(createdAtMs) || createdAtMs < todayStartMs) continue;
      stats.runsToday += 1;
      if (task.runId) stats.todayRunIds.add(task.runId);
    }

    for (const approval of approvals) {
      if (!approval.taskId) continue;
      const agentId = taskAgentById.get(approval.taskId);
      if (!agentId) continue;
      const stats = statsByAgent.get(agentId);
      if (stats) stats.pendingApprovals += 1;
    }

    for (const workflow of workflows) {
      for (const agent of rows) {
        if (workflowUsesAgent(workflow.graph, agent.id)) {
          statsByAgent.get(agent.id)?.workflowIds.add(workflow.id);
        }
      }
    }

    for (const [agentId, stats] of statsByAgent.entries()) {
      let spendTodayCents = 0;
      for (const runId of stats.todayRunIds) {
        const run = runsById.get(runId);
        if (run) spendTodayCents += runCostCents(run);
      }
      stats.spendTodayCents = spendTodayCents;
    }

    return c.json({
      agents: rows.map((agent) => {
        const space = agent.spaceId ? spacesById.get(agent.spaceId) : undefined;
        const stats = statsByAgent.get(agent.id) ?? createAgentNodeStats();
        return {
          ...presentAgent(agent, deps.adapters),
          spaceName: space?.name,
          spaceColorHex: space?.color,
          runsToday: stats.runsToday,
          spendTodayCents: stats.spendTodayCents,
          pendingApprovals: stats.pendingApprovals,
          connectionCounts: {
            workflows: stats.workflowIds.size,
          },
        };
      }),
    });
  });

  app.get('/:id/connections', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const agent = deps.db
      .select({ id: schema.agents.id, workspaceId: schema.agents.workspaceId })
      .from(schema.agents)
      .where(and(eq(schema.agents.id, id), eq(schema.agents.workspaceId, ws.workspaceId)))
      .get();
    if (!agent) {
      return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'agent not found' } }, 404);
    }
    const tasks = deps.db
      .select({ id: schema.tasks.id, title: schema.tasks.title, workflowId: schema.tasks.workflowId, status: schema.tasks.status })
      .from(schema.tasks)
      .where(and(eq(schema.tasks.workspaceId, ws.workspaceId), eq(schema.tasks.executorType, 'agent'), eq(schema.tasks.executorRef, id)))
      .limit(20)
      .all();
    const workflows = deps.db
      .select({ id: schema.workflows.id, title: schema.workflows.title, graph: schema.workflows.graph })
      .from(schema.workflows)
      .where(eq(schema.workflows.workspaceId, ws.workspaceId))
      .all()
      .filter((workflow) => workflowUsesAgent(workflow.graph, id))
      .slice(0, 20)
      .map(({ graph: _graph, ...workflow }) => workflow);
    return c.json({
      workflows,
      tasks,
    });
  });

  app.get('/playbook-library', (c) => {
    return c.json({ entries: PLAYBOOK_LIBRARY });
  });

  app.get('/:id/instructions', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const agent = deps.db
      .select()
      .from(schema.agents)
      .where(and(eq(schema.agents.id, id), eq(schema.agents.workspaceId, ws.workspaceId)))
      .get();
    if (!agent) {
      return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'agent not found' } }, 404);
    }
    return c.json({ files: listAgentInstructionFiles(agent) });
  });

  app.put('/:id/instructions/:key', async (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const key = decodeURIComponent(c.req.param('key'));
    const body = (await c.req.json().catch(() => ({}))) as { content?: unknown };
    if (typeof body.content !== 'string') {
      throw new AgentisError('VALIDATION_FAILED', 'Instruction content must be a string.');
    }
    const agent = deps.db
      .select()
      .from(schema.agents)
      .where(and(eq(schema.agents.id, id), eq(schema.agents.workspaceId, ws.workspaceId)))
      .get();
    if (!agent) {
      return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'agent not found' } }, 404);
    }

    const target = resolveWritableInstructionFile(agent, key);
    if (!target) {
      throw new AgentisError('VALIDATION_FAILED', 'Instruction file is not writable from Agentis.');
    }
    if (target.kind === 'platform') {
      deps.db
        .update(schema.agents)
        .set({ instructions: body.content, updatedAt: new Date().toISOString() })
        .where(eq(schema.agents.id, id))
        .run();
    } else {
      writeInstructionFile(target, body.content);
    }
    return c.json({ ok: true });
  });

  app.get('/:id', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const agent = deps.db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.id, id))
      .get();
    if (!agent || agent.workspaceId !== ws.workspaceId) {
      return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'agent not found' } }, 404);
    }
    return c.json({ agent: presentAgent(agent, deps.adapters) });
  });

  // Mount the full mutation surface (POST /, PATCH /:id, DELETE /:id,
  // POST /:id/terminal/send, POST /:id/cancel-task/:taskId) at the root.
  app.route('/', buildAgentMutationRoutes(deps));

  return app;
}

const LIVE_AGENT_STATUSES = new Set(['online', 'busy', 'active', 'running']);
const HEARTBEAT_STALE_MS = CONSTANTS.AGENT_HEARTBEAT_INTERVAL_MS * 4;

function presentAgent<T extends { id: string; status: string; lastHeartbeatAt?: string | null; isPaused?: boolean | null }>(
  agent: T,
  adapters: AdapterManager,
): T & { adapterCapabilities?: AdapterCapabilities | null } {
  const status = derivedAgentStatus(agent, adapters);
  const registration = adapters.get(agent.id);
  return {
    ...agent,
    status,
    ...(registration ? { adapterCapabilities: registration.adapter.capabilities?.() ?? null } : {}),
    ...(status === 'offline' ? { currentTaskId: null } : {}),
  } as T & { adapterCapabilities?: AdapterCapabilities | null };
}

function derivedAgentStatus(
  agent: { id: string; status: string; lastHeartbeatAt?: string | null; isPaused?: boolean | null },
  adapters: AdapterManager,
) {
  if (agent.isPaused || agent.status === 'paused' || agent.status === 'setting_up' || agent.status === 'error') {
    return agent.status;
  }
  if (!LIVE_AGENT_STATUSES.has(agent.status)) return agent.status;
  if (adapters.get(agent.id)) return agent.status;
  const heartbeatAt = agent.lastHeartbeatAt ? Date.parse(agent.lastHeartbeatAt) : Number.NaN;
  const heartbeatIsFresh = Number.isFinite(heartbeatAt) && Date.now() - heartbeatAt <= HEARTBEAT_STALE_MS;
  return heartbeatIsFresh ? agent.status : 'offline';
}

function workflowUsesAgent(graph: unknown, agentId: string): boolean {
  const text = JSON.stringify(graph ?? {});
  return text.includes(agentId);
}

function createAgentNodeStats() {
  return {
    runsToday: 0,
    spendTodayCents: 0,
    pendingApprovals: 0,
    workflowIds: new Set<string>(),
    todayRunIds: new Set<string>(),
  };
}

function startOfUtcDayMs() {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function runCostCents(run: { runState: unknown } & Record<string, unknown>) {
  const direct = typeof run.costMicros === 'number' ? run.costMicros : null;
  if (direct != null && Number.isFinite(direct)) return Math.max(0, Math.round(direct / 10_000));
  const state = objectRecord(run.runState);
  const observability = objectRecord(state.observability);
  const nested = observability.costMicros;
  return typeof nested === 'number' && Number.isFinite(nested) ? Math.max(0, Math.round(nested / 10_000)) : 0;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}
