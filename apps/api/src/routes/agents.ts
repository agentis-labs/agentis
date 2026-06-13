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
import type { HarnessMemoryIngestionService } from '../services/harnessMemoryIngestion.js';
import type { McpHarnessSessionService } from '../services/mcpHarnessSession.js';
import { detectRuntimeState, listRuntimeModels, modelConfiguredOnAgent } from '../services/runtimeModels.js';
import { RuntimeProfileService } from '../services/runtimeProfileService.js';
import { RuntimeSessionStore } from '../services/runtimeSessionStore.js';

export interface AgentRoutesDeps {
  db: AgentisSqliteDb;
  auth: AuthService;
  vault: CredentialVault;
  adapters: AdapterManager;
  logger: Logger;
  conversations: ConversationStore;
  bus?: EventBus;
  /** Optional: distils a connected harness's own memory into the agent's Brain. */
  harnessMemoryIngestion?: HarnessMemoryIngestionService;
  mcpHarness?: McpHarnessSessionService;
}

interface AgentAbilitySummary {
  id: string;
  name: string;
  slug: string;
  domainTag: string | null;
  iconEmoji: string | null;
  compileStatus: string;
  pinnedAt: string;
}

export function buildAgentRoutes(deps: AgentRoutesDeps) {
  const app = new Hono();
  const runtimeProfiles = new RuntimeProfileService(deps.db, deps.adapters, deps.logger);
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
    const spaces = deps.db
      .select({ id: schema.spaces.id, name: schema.spaces.name, colorHex: schema.spaces.colorHex })
      .from(schema.spaces)
      .where(eq(schema.spaces.workspaceId, ws.workspaceId))
      .all();
    const spacesById = new Map(spaces.map((space) => [space.id, space]));
    const agentIds = rows.map((agent) => agent.id);
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
    const abilityRows = agentIds.length > 0
      ? deps.db
        .select({
          agentId: schema.agentAbilityPins.agentId,
          enabled: schema.agentAbilityPins.enabled,
          pinnedAt: schema.agentAbilityPins.createdAt,
          id: schema.abilities.id,
          name: schema.abilities.name,
          slug: schema.abilities.slug,
          domainTag: schema.abilities.domainTag,
          iconEmoji: schema.abilities.iconEmoji,
          compileStatus: schema.abilities.compileStatus,
        })
        .from(schema.agentAbilityPins)
        .innerJoin(schema.abilities, eq(schema.agentAbilityPins.abilityId, schema.abilities.id))
        .where(and(
          inArray(schema.agentAbilityPins.agentId, agentIds),
          eq(schema.abilities.workspaceId, ws.workspaceId),
        ))
        .all()
      : [];
    const abilitiesByAgent = groupAgentAbilities(abilityRows);
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
        const stats = statsByAgent.get(agent.id) ?? createAgentNodeStats();
        const space = agent.spaceId ? spacesById.get(agent.spaceId) : null;
        return {
          ...presentAgent(agent, deps.adapters),
          managerId: agent.reportsTo ?? null,
          domainColor: agent.colorHex ?? null,
          spaceName: space?.name ?? agent.spaceTag ?? null,
          spaceColorHex: space?.colorHex ?? null,
          abilities: abilitiesByAgent.get(agent.id) ?? [],
          canvasAngle: canvasAngleFromPosition(agent.canvasPosition),
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

  // Harness memory transition (§ harness memory ingestion).
  //
  // Preview distils the agent's harness-native memory (CLAUDE.md, AGENTS.md,
  // .cursorrules, …) into quality-gated candidates WITHOUT writing — the
  // operator reviews before anything lands in the Brain (no garbage). Commit
  // writes the accepted subset; it is idempotent, so it is safe to re-run as
  // the harness files evolve.
  app.get('/:id/memory/ingest/preview', (c) => {
    if (!deps.harnessMemoryIngestion) {
      throw new AgentisError('VALIDATION_FAILED', 'Harness memory ingestion is not available on this deployment.');
    }
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
    const minQuality = parseQuality(c.req.query('minQuality'));
    const preview = deps.harnessMemoryIngestion.preview(agent, minQuality);
    return c.json(preview);
  });

  app.post('/:id/memory/ingest', async (c) => {
    if (!deps.harnessMemoryIngestion) {
      throw new AgentisError('VALIDATION_FAILED', 'Harness memory ingestion is not available on this deployment.');
    }
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
    const body = (await c.req.json().catch(() => ({}))) as { acceptHashes?: unknown; minQuality?: unknown };
    const acceptHashes = Array.isArray(body.acceptHashes)
      ? body.acceptHashes.filter((h): h is string => typeof h === 'string')
      : undefined;
    const result = deps.harnessMemoryIngestion.commit(agent, {
      acceptHashes,
      minQuality: parseQuality(body.minQuality),
    });
    return c.json(result);
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
    const space = agent.spaceId
      ? deps.db
        .select({ id: schema.spaces.id, name: schema.spaces.name, colorHex: schema.spaces.colorHex })
        .from(schema.spaces)
        .where(and(eq(schema.spaces.id, agent.spaceId), eq(schema.spaces.workspaceId, ws.workspaceId)))
        .get()
      : null;
    return c.json({
      agent: {
        ...presentAgent(agent, deps.adapters),
        spaceName: space?.name ?? agent.spaceTag ?? null,
        spaceColorHex: space?.colorHex ?? null,
      },
    });
  });

  app.get('/:id/runtime-context', async (c) => {
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
    const registration = deps.adapters.get(id);
    if (!registration) {
      return c.json({ error: { code: 'ADAPTER_UNAVAILABLE', message: 'agent is offline or adapter is not connected' } }, 400);
    }
    const adapter = registration.adapter;
    try {
      const baseContext = adapter.getRuntimeContext
        ? await adapter.getRuntimeContext()
        : {
            provider: adapter.adapterType,
            models: [],
            currentModel: 'unknown',
            fastModeSupported: false,
          };

      const adapterType = normalizeRuntimeAdapterType(agent.adapterType);
      if (!adapterType) return c.json(baseContext);

      const catalog = await listRuntimeModels(adapterType, agent.id, deps.db);
      const detectedRuntime = detectRuntimeState(adapterType);
      const config = recordFromUnknown(agent.config);
      const detectedEffort = adapterType === 'codex'
        ? stringOf(config.modelReasoningEffort) ?? detectedRuntime.reasoningEffort ?? baseContext.currentEffort
        : undefined;
      const detectedFastMode = adapterType === 'codex'
        ? booleanOf(config.fastMode) ?? detectedRuntime.fastMode ?? baseContext.fastModeEnabled
        : undefined;
      const currentModel = modelConfiguredOnAgent(agent)
        ?? detectedRuntime.model
        ?? baseContext.currentModel
        ?? catalog.defaultModel
        ?? 'unknown';

      return c.json({
        ...baseContext,
        ...(adapterType === 'claude_code' ? { efforts: undefined, currentEffort: undefined, usage: undefined, contextWindow: undefined } : {}),
        ...(adapterType === 'codex'
          ? {
              currentEffort: detectedEffort,
              fastModeSupported: true,
              fastModeEnabled: detectedFastMode,
              usage: undefined,
              contextWindow: undefined,
            }
          : {}),
        models: mergeRuntimeContextModels(
          catalog.models.map((model) => ({
            id: model.id,
            label: model.label,
            recommended: model.recommended,
            source: model.source,
            verified: model.verified,
          })),
          currentModel,
        ),
        currentModel,
      });
    } catch (err) {
      deps.logger.error('agents.runtime_context_failed', { agentId: id, err: (err as Error).message });
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'failed to fetch runtime context' } }, 500);
    }
  });

  app.get('/:id/runtime', async (c) => {
    const ws = getWorkspace(c);
    const agent = runtimeProfiles.loadAgent(ws.workspaceId, c.req.param('id'));
    return c.json({ runtime: await runtimeProfiles.describe(agent) });
  });

  app.post('/:id/runtime/probe', async (c) => {
    const ws = getWorkspace(c);
    const agent = runtimeProfiles.loadAgent(ws.workspaceId, c.req.param('id'));
    return c.json({ runtime: await runtimeProfiles.describe(agent) });
  });

  app.get('/:id/runtime/resources', (c) => {
    const ws = getWorkspace(c);
    const agent = runtimeProfiles.loadAgent(ws.workspaceId, c.req.param('id'));
    return c.json({ resources: runtimeProfiles.listResources(agent) });
  });

  app.get('/:id/runtime/resources/:resourceId', (c) => {
    const ws = getWorkspace(c);
    const agent = runtimeProfiles.loadAgent(ws.workspaceId, c.req.param('id'));
    return c.json(runtimeProfiles.readResource(agent, decodeRouteValue(c.req.param('resourceId'))));
  });

  app.put('/:id/runtime/resources/:resourceId', async (c) => {
    const ws = getWorkspace(c);
    const body = (await c.req.json().catch(() => ({}))) as {
      content?: unknown;
      expectedChecksum?: unknown;
    };
    if (typeof body.content !== 'string') {
      throw new AgentisError('VALIDATION_FAILED', 'Runtime resource content must be a string.');
    }
    const agent = runtimeProfiles.loadAgent(ws.workspaceId, c.req.param('id'));
    return c.json(runtimeProfiles.writeResource(
      agent,
      decodeRouteValue(c.req.param('resourceId')),
      body.content,
      typeof body.expectedChecksum === 'string' ? body.expectedChecksum : undefined,
    ));
  });

  app.get('/:id/runtime/sessions', async (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('id');
    runtimeProfiles.loadAgent(ws.workspaceId, agentId);
    const adapter = deps.adapters.get(agentId)?.adapter;
    const sessions = adapter?.listRuntimeSessions
      ? await adapter.listRuntimeSessions()
      : new RuntimeSessionStore(deps.db).list(ws.workspaceId, agentId);
    return c.json({ sessions });
  });

  app.delete('/:id/runtime/sessions/:sessionKey', async (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('id');
    const sessionKey = decodeRouteValue(c.req.param('sessionKey'));
    runtimeProfiles.loadAgent(ws.workspaceId, agentId);
    const adapter = deps.adapters.get(agentId)?.adapter;
    if (adapter?.closeRuntimeSession) await adapter.closeRuntimeSession(sessionKey);
    else new RuntimeSessionStore(deps.db).remove(ws.workspaceId, agentId, sessionKey);
    return c.body(null, 204);
  });

  app.get('/:id/runtime/effective-context', (c) => {
    const ws = getWorkspace(c);
    const agent = runtimeProfiles.loadAgent(ws.workspaceId, c.req.param('id'));
    const resources = runtimeProfiles.listResources(agent)
      .filter((resource) => resource.effective && (
        resource.kind === 'generated_overlay'
        || resource.kind === 'identity'
        || resource.kind === 'instructions'
        || resource.kind === 'memory'
      ))
      .map((resource, index) => ({ precedence: index + 1, resource }));
    return c.json({
      layers: resources,
      summary: {
        role: agent.role ?? 'worker',
        space: agent.spaceTag ?? null,
        runtime: agent.adapterType,
      },
    });
  });

  // Mount the full mutation surface (POST /, PATCH /:id, DELETE /:id,
  // POST /:id/terminal/send, POST /:id/cancel-task/:taskId) at the root.
  app.route('/', buildAgentMutationRoutes(deps));

  return app;
}

function decodeRouteValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new AgentisError('VALIDATION_FAILED', 'Invalid runtime resource identifier.');
  }
}

/** Parse a 0..1 quality threshold from a query/body value; undefined when absent/invalid. */
function parseQuality(raw: unknown): number | undefined {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(1, n));
}

function groupAgentAbilities(
  rows: Array<AgentAbilitySummary & { agentId: string; enabled: boolean | number | null }>,
): Map<string, AgentAbilitySummary[]> {
  const byAgent = new Map<string, AgentAbilitySummary[]>();
  for (const row of rows) {
    if (!row.enabled) continue;
    const list = byAgent.get(row.agentId) ?? [];
    list.push({
      id: row.id,
      name: row.name,
      slug: row.slug,
      domainTag: row.domainTag,
      iconEmoji: row.iconEmoji,
      compileStatus: row.compileStatus,
      pinnedAt: row.pinnedAt,
    });
    byAgent.set(row.agentId, list);
  }
  for (const list of byAgent.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }
  return byAgent;
}

const LIVE_AGENT_STATUSES = new Set(['online', 'busy', 'active', 'running']);
const HEARTBEAT_STALE_MS = CONSTANTS.AGENT_HEARTBEAT_INTERVAL_MS * 4;

function presentAgent<T extends { id: string; status: string; lastHeartbeatAt?: string | null; isPaused?: boolean | null }>(
  agent: T,
  adapters: AdapterManager,
): T & { adapterCapabilities?: AdapterCapabilities | null } {
  const status = derivedAgentStatus(agent, adapters);
  const adapterCapabilities = adapters.capabilities(agent.id);
  return {
    ...agent,
    status,
    ...(adapterCapabilities ? { adapterCapabilities } : {}),
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

function canvasAngleFromPosition(value: unknown): number | null {
  const pos = objectRecord(value);
  const x = typeof pos.x === 'number' ? pos.x : null;
  const y = typeof pos.y === 'number' ? pos.y : null;
  if (x == null || y == null || (!x && !y)) return null;
  const angle = Math.atan2(y, x) * (180 / Math.PI);
  return Math.round((angle + 360) % 360);
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function booleanOf(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return undefined;
}

function normalizeRuntimeAdapterType(value: unknown): 'openclaw' | 'hermes_agent' | 'claude_code' | 'codex' | 'cursor' | 'http' | null {
  if (
    value === 'openclaw'
    || value === 'hermes_agent'
    || value === 'claude_code'
    || value === 'codex'
    || value === 'cursor'
    || value === 'http'
  ) {
    return value;
  }
  return null;
}

function mergeRuntimeContextModels(
  models: Array<{
    id: string;
    label: string;
    recommended?: boolean;
    legacy?: boolean;
    source?: 'runtime' | 'profile' | 'agent_config' | 'workspace_policy' | 'fallback';
    verified?: boolean;
  }>,
  currentModel: string,
) {
  if (!currentModel || models.some((model) => model.id === currentModel)) return models;
  return [
    {
      id: currentModel,
      label: currentModel,
      recommended: true,
      source: 'fallback' as const,
      verified: false,
    },
    ...models,
  ];
}
