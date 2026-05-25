/**
 * /v1/workspaces — list/get/create/update + ambients sub-resource.
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { and, eq } from 'drizzle-orm';
import { AgentisError, REALTIME_EVENTS, REALTIME_ROOMS, schemas } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { BusMessage, EventBus } from '../event-bus.js';
import { requireAuth, getUser } from '../middleware/auth.js';

export function buildWorkspaceRoutes(deps: { db: AgentisSqliteDb; auth: AuthService; bus: EventBus }) {
  const app = new Hono();
  app.use('*', requireAuth(deps));

  app.get('/', (c) => {
    const user = getUser(c);
    const rows = deps.db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.userId, user.id))
      .all();
    return c.json({ workspaces: rows });
  });

  app.post('/', async (c) => {
    const user = getUser(c);
    const body = schemas.createWorkspaceSchema.parse(await c.req.json());
    const id = randomUUID();
    deps.db
      .insert(schema.workspaces)
      .values({ id, userId: user.id, name: body.name, slug: body.slug })
      .run();
    return c.json({ workspace: { id, userId: user.id, name: body.name, slug: body.slug } }, 201);
  });

  app.get('/:id/canvas/stream', (c) => {
    const user = getUser(c);
    const workspaceId = c.req.param('id');
    const ws = deps.db
      .select()
      .from(schema.workspaces)
      .where(and(eq(schema.workspaces.id, workspaceId), eq(schema.workspaces.userId, user.id)))
      .get();
    if (!ws) throw new AgentisError('RESOURCE_NOT_FOUND', 'Workspace not found');

    return streamSSE(c, async (stream) => {
      let closed = false;
      let unsubscribe: () => void = () => {};
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
      };
      const write = async (event: string, data: unknown) => {
        if (closed) return;
        try {
          await stream.writeSSE({ event, data: JSON.stringify(data) });
        } catch {
          close();
        }
      };
      unsubscribe = deps.bus.subscribe((message) => {
        if (!messageBelongsToWorkspace(message, workspaceId)) return;
        for (const event of mapCanvasBusMessage(message)) {
          void write(event.event, event.data);
        }
      });
      heartbeat = setInterval(() => {
        void write('heartbeat', { type: 'HEARTBEAT', at: new Date().toISOString() });
      }, 15_000);
      if (typeof heartbeat === 'object' && 'unref' in heartbeat) heartbeat.unref();

      c.req.raw.signal.addEventListener('abort', close, { once: true });
      await write('snapshot', buildCanvasSnapshot(deps.db, workspaceId));
      await new Promise<void>((resolve) => {
        c.req.raw.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      close();
    });
  });

  app.get('/:id', (c) => {
    const user = getUser(c);
    const id = c.req.param('id');
    const ws = deps.db
      .select()
      .from(schema.workspaces)
      .where(and(eq(schema.workspaces.id, id), eq(schema.workspaces.userId, user.id)))
      .get();
    if (!ws) throw new AgentisError('RESOURCE_NOT_FOUND', 'Workspace not found');
    const ambients = deps.db
      .select()
      .from(schema.ambients)
      .where(eq(schema.ambients.workspaceId, ws.id))
      .all();
    return c.json({ workspace: ws, ambients });
  });

  app.post('/:id/ambients', async (c) => {
    const user = getUser(c);
    const id = c.req.param('id');
    const ws = deps.db
      .select()
      .from(schema.workspaces)
      .where(and(eq(schema.workspaces.id, id), eq(schema.workspaces.userId, user.id)))
      .get();
    if (!ws) throw new AgentisError('RESOURCE_NOT_FOUND', 'Workspace not found');
    const body = schemas.createAmbientSchema.parse({ ...(await c.req.json()), workspaceId: id });
    const ambientId = randomUUID();
    deps.db
      .insert(schema.ambients)
      .values({
        id: ambientId,
        workspaceId: ws.id,
        userId: user.id,
        name: body.name,
        kind: body.kind,
        settings: body.settings,
      })
      .run();
    return c.json({ ambient: { id: ambientId, ...body } }, 201);
  });

  // POST /v1/workspaces/:id/select — record the active workspace and emit
  // the realtime event so other tabs/sessions can react.
  app.post('/:id/select', (c) => {
    const user = getUser(c);
    const id = c.req.param('id');
    const ws = deps.db
      .select()
      .from(schema.workspaces)
      .where(and(eq(schema.workspaces.id, id), eq(schema.workspaces.userId, user.id)))
      .get();
    if (!ws) throw new AgentisError('RESOURCE_NOT_FOUND', 'Workspace not found');
    deps.bus.publish(
      REALTIME_ROOMS.user(user.id),
      REALTIME_EVENTS.WORKSPACE_SELECTED,
      { workspaceId: ws.id, name: ws.name, slug: ws.slug },
    );
    return c.json({ workspace: { id: ws.id, name: ws.name, slug: ws.slug, defaultAmbientId: ws.defaultAmbientId } });
  });

  // POST /v1/workspaces/:id/ambients/:ambientId/select — record the active
  // ambient inside the workspace and emit the realtime event. The dashboard
  // sends `x-agentis-ambient` on subsequent requests; the spec requires the
  // explicit endpoint for parity with the workspace selector.
  app.post('/:id/ambients/:ambientId/select', (c) => {
    const user = getUser(c);
    const id = c.req.param('id');
    const ambientId = c.req.param('ambientId');
    const ws = deps.db
      .select()
      .from(schema.workspaces)
      .where(and(eq(schema.workspaces.id, id), eq(schema.workspaces.userId, user.id)))
      .get();
    if (!ws) throw new AgentisError('RESOURCE_NOT_FOUND', 'Workspace not found');
    const amb = deps.db
      .select()
      .from(schema.ambients)
      .where(and(eq(schema.ambients.id, ambientId), eq(schema.ambients.workspaceId, ws.id)))
      .get();
    if (!amb) throw new AgentisError('RESOURCE_NOT_FOUND', 'Ambient not found in workspace');
    deps.db
      .update(schema.workspaces)
      .set({ defaultAmbientId: amb.id, updatedAt: new Date().toISOString() })
      .where(eq(schema.workspaces.id, ws.id))
      .run();
    deps.bus.publish(
      REALTIME_ROOMS.workspace(ws.id),
      REALTIME_EVENTS.AMBIENT_SELECTED,
      { workspaceId: ws.id, ambientId: amb.id, name: amb.name, kind: amb.kind },
    );
    return c.json({ ambient: { id: amb.id, name: amb.name, kind: amb.kind } });
  });

  return app;
}

function buildCanvasSnapshot(db: AgentisSqliteDb, workspaceId: string) {
  const agents = db
    .select({
      id: schema.agents.id,
      name: schema.agents.name,
      status: schema.agents.status,
      role: schema.agents.role,
      managerId: schema.agents.reportsTo,
      currentTaskId: schema.agents.currentTaskId,
      lastHeartbeatAt: schema.agents.lastHeartbeatAt,
      domainColor: schema.agents.colorHex,
      canvasPosition: schema.agents.canvasPosition,
    })
    .from(schema.agents)
    .where(eq(schema.agents.workspaceId, workspaceId))
    .all();
  const runs = db
    .select({
      id: schema.workflowRuns.id,
      workflowId: schema.workflowRuns.workflowId,
      status: schema.workflowRuns.status,
      startedAt: schema.workflowRuns.startedAt,
      createdAt: schema.workflowRuns.createdAt,
    })
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.workspaceId, workspaceId))
    .all()
    .filter((run) => run.status === 'RUNNING' || run.status === 'CREATED' || run.status === 'WAITING')
    .slice(0, 50);
  const approvals = db
    .select({
      id: schema.approvalRequests.id,
      runId: schema.approvalRequests.runId,
      taskId: schema.approvalRequests.taskId,
      source: schema.approvalRequests.source,
      title: schema.approvalRequests.title,
      summary: schema.approvalRequests.summary,
      createdAt: schema.approvalRequests.createdAt,
    })
    .from(schema.approvalRequests)
    .where(and(eq(schema.approvalRequests.workspaceId, workspaceId), eq(schema.approvalRequests.status, 'pending')))
    .all();
  const artifacts = db
    .select({
      id: schema.artifacts.id,
      agentId: schema.artifacts.agentId,
      workflowId: schema.artifacts.workflowId,
      type: schema.artifacts.type,
      title: schema.artifacts.title,
      createdAt: schema.artifacts.createdAt,
      metadata: schema.artifacts.metadata,
    })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.workspaceId, workspaceId))
    .all()
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, 50);

  return {
    type: 'SNAPSHOT',
    workspaceId,
    agents,
    runs,
    approvals,
    artifacts,
    at: new Date().toISOString(),
  };
}

function messageBelongsToWorkspace(message: BusMessage, workspaceId: string): boolean {
  if (message.room === REALTIME_ROOMS.workspace(workspaceId)) return true;
  const payload = asRecord(message.envelope.payload);
  return payload.workspaceId === workspaceId;
}

function mapCanvasBusMessage(message: BusMessage): Array<{ event: string; data: unknown }> {
  const payload = asRecord(message.envelope.payload);
  const emittedAt = message.envelope.emittedAt;
  switch (message.envelope.event) {
    case REALTIME_EVENTS.AGENT_WORK_STEP:
      return mapAgentWorkStep(payload, emittedAt);
    case REALTIME_EVENTS.AGENT_TERMINAL_TOOL_CALL:
      return [{
        event: 'agent_state',
        data: {
          type: 'TOOL_CALL',
          agentId: stringField(payload, 'agentId'),
          runId: stringField(payload, 'runId'),
          workflowId: stringField(payload, 'workflowId'),
          tool: stringField(payload, 'tool') ?? 'tool',
          input: payload.input ?? payload.args ?? null,
          at: emittedAt,
        },
      }];
    case REALTIME_EVENTS.AGENT_TERMINAL_MESSAGE:
      return [{
        event: 'agent_state',
        data: {
          type: 'OUTPUT_TOKEN',
          agentId: stringField(payload, 'agentId'),
          runId: stringField(payload, 'runId'),
          workflowId: stringField(payload, 'workflowId'),
          token: stringField(payload, 'message') ?? stringField(payload, 'text') ?? '',
          at: emittedAt,
        },
      }];
    case REALTIME_EVENTS.RUN_CREATED:
    case REALTIME_EVENTS.RUN_RUNNING:
      return [{
        event: 'workflow_progress',
        data: {
          type: 'RUN_START',
          runId: stringField(payload, 'runId') ?? stringField(payload, 'id'),
          workflowId: stringField(payload, 'workflowId'),
          at: emittedAt,
        },
      }];
    case REALTIME_EVENTS.RUN_COMPLETED:
      return [{
        event: 'workflow_progress',
        data: {
          type: 'RUN_COMPLETE',
          runId: stringField(payload, 'runId') ?? stringField(payload, 'id'),
          workflowId: stringField(payload, 'workflowId'),
          at: emittedAt,
        },
      }];
    case REALTIME_EVENTS.RUN_FAILED:
      return [
        {
          event: 'workflow_progress',
          data: {
            type: 'RUN_FAILED',
            runId: stringField(payload, 'runId') ?? stringField(payload, 'id'),
            workflowId: stringField(payload, 'workflowId'),
            error: stringField(payload, 'error') ?? 'Workflow failed',
            at: emittedAt,
          },
        },
        {
          event: 'attention_event',
          data: {
            type: 'EXECUTION_FAILED',
            itemId: stringField(payload, 'runId') ?? stringField(payload, 'id'),
            runId: stringField(payload, 'runId') ?? stringField(payload, 'id'),
            workflowId: stringField(payload, 'workflowId'),
            error: stringField(payload, 'error') ?? 'Workflow failed',
            at: emittedAt,
          },
        },
      ];
    case REALTIME_EVENTS.ARTIFACT_CREATED:
      return [{
        event: 'artifact_event',
        data: {
          type: 'CREATED',
          artifact: payload.artifact ?? payload,
          at: emittedAt,
        },
      }];
    case REALTIME_EVENTS.ARTIFACT_UPDATED:
      return [{
        event: 'artifact_event',
        data: {
          type: 'UPDATED',
          artifact: payload.artifact ?? payload,
          at: emittedAt,
        },
      }];
    case REALTIME_EVENTS.ARTIFACT_DELETED:
      return [{
        event: 'artifact_event',
        data: {
          type: 'DELETED',
          artifactId: stringField(payload, 'id') ?? stringField(payload, 'artifactId'),
          at: emittedAt,
        },
      }];
    case REALTIME_EVENTS.APPROVAL_REQUESTED:
      return [{
        event: 'attention_event',
        data: {
          type: 'APPROVAL_REQUIRED',
          itemId: stringField(payload, 'id'),
          entityId: stringField(payload, 'runId') ?? stringField(payload, 'taskId') ?? stringField(payload, 'id'),
          entityType: 'workflow',
          message: stringField(payload, 'summary') ?? stringField(payload, 'title') ?? 'Approval required',
          at: emittedAt,
        },
      }];
    case REALTIME_EVENTS.APPROVAL_RESOLVED:
      return [{
        event: 'attention_event',
        data: {
          type: 'RESOLVED',
          itemId: stringField(payload, 'id'),
          at: emittedAt,
        },
      }];
    case REALTIME_EVENTS.AGENT_STATUS_CHANGED:
      return [{
        event: 'agent_state',
        data: {
          type: 'STATUS_CHANGED',
          agentId: stringField(payload, 'agentId'),
          status: stringField(payload, 'status'),
          at: emittedAt,
        },
      }];
    default:
      return [];
  }
}

function mapAgentWorkStep(payload: Record<string, unknown>, at: string): Array<{ event: string; data: unknown }> {
  const phase = stringField(payload, 'phase');
  const agentId = stringField(payload, 'agentId');
  const workflowId = stringField(payload, 'workflowId');
  const runId = stringField(payload, 'runId');
  const nodeId = stringField(payload, 'nodeId');
  const nodeLabel = stringField(payload, 'description') ?? stringField(payload, 'step') ?? 'Working';
  const agentStateType = phase === 'complete' ? 'TASK_COMPLETE' : phase === 'fail' ? 'TASK_ERROR' : 'TASK_START';
  return [
    {
      event: 'agent_state',
      data: {
        type: agentStateType,
        agentId,
        taskId: nodeId,
        workflowId,
        runId,
        nodeLabel,
        error: phase === 'fail' ? stringField(payload, 'detail') ?? nodeLabel : undefined,
        at,
      },
    },
    {
      event: 'workflow_progress',
      data: {
        type: phase === 'complete' || phase === 'fail' ? 'NODE_EXIT' : 'NODE_ENTER',
        workflowId,
        runId,
        nodeId,
        nodeLabel,
        agentId,
        status: phase === 'fail' ? 'error' : 'ok',
        at,
      },
    },
  ];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}
