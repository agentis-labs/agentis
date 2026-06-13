/**
 * /v1/conversations — operator-agent threads.
 *
 *   GET  /                                 list of threads
 *   GET  /:agentId                         messages for a thread (creates thread on demand)
 *   POST /:agentId/send                    operator → agent
/**
 * /v1/conversations — operator-agent threads.
 *
 *   GET  /                                 list of threads
 *   GET  /:agentId                         messages for a thread (creates thread on demand)
 *   POST /:agentId/send                    operator → agent
 *   POST /:agentId/continue/:sessionId     bind thread to a mirrored session id
 *   POST /:agentId/read                    clear unread badge
 */

import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  AgentisError,
  CONSTANTS,
  REALTIME_EVENTS,
  REALTIME_ROOMS,
  type ChatDelta,
  type ChatFinishReason,
  type ChatTurnContext,
  type ChatTurnTrace,
  type ViewportContext,
} from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { ConversationStore } from '../services/conversationStore.js';
import type { AdapterManager } from '../adapters/AdapterManager.js';
import { OpenClawAdapter } from '../adapters/OpenClawAdapter.js';
import { ChatSessionExecutor } from '../services/chatSessionExecutor.js';
import type { ViewportStore } from '../services/viewportStore.js';
import type { Logger } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';
import type { EventBus } from '../event-bus.js';

const sendSchema = z.object({
  body: z.string().min(1).max(CONSTANTS.CONVERSATION_MESSAGE_MAX_LENGTH),
  clientTurnId: z.string().min(1).max(120).optional(),
  useViewportContext: z.boolean().optional().default(true),
  viewportOverride: z.object({
    surface: z.string().min(1),
    route: z.string().optional(),
    title: z.string().optional(),
    workspaceId: z.string().optional(),
    ambientId: z.string().nullable().optional(),
    resourceId: z.string().optional(),
    resourceKind: z.string().optional(),
    spaceId: z.string().nullable().optional(),
    spaceName: z.string().nullable().optional(),
    selection: z.object({
      ids: z.array(z.string()).optional(),
      label: z.string().optional(),
      kind: z.string().optional(),
    }).nullable().optional(),
    activeRunId: z.string().nullable().optional(),
    metadata: z.record(z.unknown()).optional(),
  }).nullable().optional(),
});
const confirmSchema = z.object({
  turnId: z.string().uuid(),
  confirmed: z.boolean(),
  clientTurnId: z.string().min(1).max(120).optional(),
});
const editSchema = z.object({ text: z.string().min(1).max(CONSTANTS.CONVERSATION_MESSAGE_MAX_LENGTH) });

type ConversationRouteDeps = {
  db: AgentisSqliteDb;
  auth: AuthService;
  conversations: ConversationStore;
  adapters: AdapterManager;
  logger: Logger;
  viewportStore?: ViewportStore;
  bus: EventBus;
  memoryCapture?: {
    captureTurn(args: {
      workspaceId: string;
      conversationId: string;
      userId: string;
      agentId: string;
      userDisplayName?: string | null;
      userMessage: string;
      assistantMessage?: string | null;
      finishReason?: string | null;
    }): Promise<{
      peerUpdateJobIds: string[];
      promotedSessionMoments: number;
      workspaceMemoryIds: string[];
      sessionMomentId: string | null;
    }>;
  };
};

type AgentRow = typeof schema.agents.$inferSelect;
type ConversationMessageRow = typeof schema.conversationMessages.$inferSelect;

interface PersistedToolCallData {
  id: string;
  name: string;
  status: 'running' | 'success' | 'error';
  args?: unknown;
  result?: unknown;
  error?: string | null;
  durationMs?: number | null;
}

interface StreamedChatMetadata {
  turn: ChatTurnTrace;
  thinking: string;
  activity: Array<Extract<ChatDelta, { type: 'activity' }>>;
  toolCalls: PersistedToolCallData[];
  toolStartedAt: Map<string, number>;
  workflowId: string | null;
  runId: string | null;
  runTitle: string | null;
  confirmation: (Omit<Extract<ChatDelta, { type: 'confirmation_required' }>, 'type'> & { status: 'pending' }) | null;
}

function serializeConversationMessage(message: ConversationMessageRow) {
  return {
    id: message.id,
    role: message.authorType,
    authorType: message.authorType,
    authorId: message.authorId,
    body: message.body,
    metadata: message.metadata ?? {},
    deliveryStatus: message.deliveryStatus,
    createdAt: message.createdAt,
  };
}

export function buildConversationRoutes(deps: ConversationRouteDeps) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/orchestrator', (c) => {
    const ws = getWorkspace(c);
    const orchestrator = findWorkspaceOrchestrator(deps.db, ws.workspaceId);
    if (!orchestrator) {
      throw new AgentisError('RESOURCE_NOT_FOUND', 'workspace orchestrator not found');
    }

    const conversationId = c.req.query('conversationId') || null;
    const conversation = conversationId
      ? deps.conversations.getById(ws.workspaceId, conversationId)
      : deps.conversations.getOrCreateByAgent({
          workspaceId: ws.workspaceId,
          ambientId: ws.ambientId,
          userId: ws.user.id,
          agentId: orchestrator.id,
        });
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? CONSTANTS.CONVERSATION_HISTORY_PAGE_SIZE), 1), 200);
    const before = c.req.query('before') ?? null;
    const beforeId = c.req.query('beforeId') ?? null;
    return c.json({
      agent: serializeScopeAgent(orchestrator),
      conversation,
      messages: deps.conversations
        .messages(conversation.id, limit, before, beforeId)
        .map(serializeConversationMessage),
    });
  });

  app.post('/orchestrator/send', async (c) => {
    const ws = getWorkspace(c);
    const orchestrator = findWorkspaceOrchestrator(deps.db, ws.workspaceId);
    if (!orchestrator) {
      throw new AgentisError('RESOURCE_NOT_FOUND', 'workspace orchestrator not found');
    }
    return sendConversationMessage(c, deps, ws, orchestrator.id);
  });

  app.post('/orchestrator/confirm', async (c) => {
    const ws = getWorkspace(c);
    const orchestrator = findWorkspaceOrchestrator(deps.db, ws.workspaceId);
    if (!orchestrator) {
      throw new AgentisError('RESOURCE_NOT_FOUND', 'workspace orchestrator not found');
    }
    return confirmConversationAction(c, deps, ws, orchestrator.id);
  });

  app.post('/orchestrator/read', (c) => {
    const ws = getWorkspace(c);
    const orchestrator = findWorkspaceOrchestrator(deps.db, ws.workspaceId);
    if (!orchestrator) {
      throw new AgentisError('RESOURCE_NOT_FOUND', 'workspace orchestrator not found');
    }
    const conversationId = c.req.query('conversationId') || null;
    const conversation = conversationId
      ? deps.conversations.getById(ws.workspaceId, conversationId)
      : deps.conversations.getOrCreateByAgent({
          workspaceId: ws.workspaceId,
          ambientId: ws.ambientId,
          userId: ws.user.id,
          agentId: orchestrator.id,
        });
    deps.conversations.markRead(ws.workspaceId, conversation.id);
    return c.json({ ok: true, agent: serializeScopeAgent(orchestrator) });
  });

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const rows = deps.conversations.list(ws.workspaceId, { includeArchived: true });
    const agentRows = deps.db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.workspaceId, ws.workspaceId))
      .all();
    const byId = new Map(agentRows.map((a) => [a.id, a]));
    const enriched = rows.map((r) => {
      const a = byId.get(r.agentId);
      const last = deps.conversations.messages(r.id, 1).at(-1);
      return {
        id: r.id,
        agentId: r.agentId,
        agentName: a?.name ?? r.agentId.slice(0, 8),
        agentColor: a?.colorHex ?? '#7a8390',
        agentStatus: a?.status ?? 'offline',
        unread: r.unreadCount,
        title: r.title,
        archivedAt: r.archivedAt,
        lastMessageAt: r.lastMessageAt,
        lastMessagePreview: last ? last.body.slice(0, 80) : null,
        mirroredSessionId: r.mirroredSessionId,
        createdAt: r.createdAt,
      };
    });
    return c.json({ conversations: enriched });
  });

  app.get('/:agentId', (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('agentId');
    const conversationId = c.req.query('conversationId') ?? null;
    const agent = deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    if (!agent || agent.workspaceId !== ws.workspaceId) throw new AgentisError('RESOURCE_NOT_FOUND', 'agent not found');
    const conversation = conversationId
      ? deps.conversations.getById(ws.workspaceId, conversationId)
      : deps.conversations.getOrCreateByAgent({
          workspaceId: ws.workspaceId,
          ambientId: ws.ambientId,
          userId: ws.user.id,
          agentId,
        });
    if (conversation.agentId !== agentId) throw new AgentisError('RESOURCE_NOT_FOUND', 'conversation not found for agent');
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? CONSTANTS.CONVERSATION_HISTORY_PAGE_SIZE), 1), 200);
    const before = c.req.query('before') ?? null;
    const beforeId = c.req.query('beforeId') ?? null;
    return c.json({
      conversation,
      messages: deps.conversations
        .messages(conversation.id, limit, before, beforeId)
        .map(serializeConversationMessage),
    });
  });

  app.post('/:agentId/send', async (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('agentId');
    const agent = deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    if (!agent || agent.workspaceId !== ws.workspaceId) throw new AgentisError('RESOURCE_NOT_FOUND', 'agent not found');
    return sendConversationMessage(c, deps, ws, agentId);
  });

  app.post('/:agentId/confirm', async (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('agentId');
    const agent = deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    if (!agent || agent.workspaceId !== ws.workspaceId) throw new AgentisError('RESOURCE_NOT_FOUND', 'agent not found');
    return confirmConversationAction(c, deps, ws, agentId);
  });

  app.post('/:agentId/continue/:sessionId', (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('agentId');
    const sessionId = c.req.param('sessionId');
    const agent = deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    if (!agent || agent.workspaceId !== ws.workspaceId) throw new AgentisError('RESOURCE_NOT_FOUND', 'agent not found');
    const conversation = deps.conversations.getOrCreateByAgent({
      workspaceId: ws.workspaceId,
      ambientId: ws.ambientId,
      userId: ws.user.id,
      agentId,
      mirroredSessionId: sessionId,
    });
    return c.json({ conversation });
  });

  app.post('/:agentId/read', (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('agentId');
    const conversationId = c.req.query('conversationId') || null;
    const agent = deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    if (!agent || agent.workspaceId !== ws.workspaceId) throw new AgentisError('RESOURCE_NOT_FOUND', 'agent not found');
    const conversation = conversationId
      ? deps.conversations.getById(ws.workspaceId, conversationId)
      : deps.conversations.getOrCreateByAgent({
          workspaceId: ws.workspaceId,
          ambientId: ws.ambientId,
          userId: ws.user.id,
          agentId,
        });
    deps.conversations.markRead(ws.workspaceId, conversation.id);
    return c.json({ ok: true });
  });

  app.post('/:agentId/new', (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('agentId');
    const agent = deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    if (!agent || agent.workspaceId !== ws.workspaceId) throw new AgentisError('RESOURCE_NOT_FOUND', 'agent not found');
    const conversation = deps.conversations.startNewConversation({
      workspaceId: ws.workspaceId,
      ambientId: ws.ambientId,
      userId: ws.user.id,
      agentId,
    });
    return c.json({ ok: true, conversationId: conversation.id });
  });

  app.patch('/session/:conversationId', async (c) => {
    const ws = getWorkspace(c);
    const conversationId = c.req.param('conversationId');
    const body = await c.req.json();
    const parsed = z.object({
      title: z.string().nullable().optional(),
      archived: z.boolean().optional(),
    }).parse(body);

    const conversation = deps.conversations.updateSession(ws.workspaceId, conversationId, parsed);
    return c.json({ ok: true, conversation });
  });

  app.delete('/session/:conversationId', (c) => {
    const ws = getWorkspace(c);
    const conversationId = c.req.param('conversationId');
    deps.conversations.deleteConversation(ws.workspaceId, conversationId);
    return c.json({ ok: true });
  });

  app.patch('/:agentId/:messageId', async (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('agentId');
    const messageId = c.req.param('messageId');
    const body = editSchema.parse(await c.req.json());
    const agent = deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    if (!agent || agent.workspaceId !== ws.workspaceId) throw new AgentisError('RESOURCE_NOT_FOUND', 'agent not found');
    const conversation = deps.conversations.getOrCreateByAgent({
      workspaceId: ws.workspaceId,
      ambientId: ws.ambientId,
      userId: ws.user.id,
      agentId,
    });
    const message = deps.conversations.updateMessage({
      workspaceId: ws.workspaceId,
      conversationId: conversation.id,
      messageId,
      body: body.text,
    });
    return c.json({ message });
  });

  app.delete('/:agentId/:messageId', (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('agentId');
    const messageId = c.req.param('messageId');
    const agent = deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    if (!agent || agent.workspaceId !== ws.workspaceId) throw new AgentisError('RESOURCE_NOT_FOUND', 'agent not found');
    const conversation = deps.conversations.getOrCreateByAgent({
      workspaceId: ws.workspaceId,
      ambientId: ws.ambientId,
      userId: ws.user.id,
      agentId,
    });
    deps.conversations.deleteMessage({
      workspaceId: ws.workspaceId,
      conversationId: conversation.id,
      messageId,
    });
    return c.json({ ok: true, id: messageId });
  });

  return app;
}

async function relayOpenClaw(
  deps: { logger: Logger },
  adapter: OpenClawAdapter,
  sessionId: string | undefined,
  body: string,
  agentId: string,
): Promise<void> {
  try {
    await adapter.sendSessionMessage({ sessionId, body });
  } catch (err) {
    deps.logger.warn('conversations.send_failed', { agentId, err: (err as Error).message });
  }
}

type ChatSseStream = {
  writeSSE(args: { event?: string; data: string }): Promise<void>;
};

function createChatActivity(args: {
  clientTurnId?: string;
  agentId?: string;
  workflowId?: string;
  phase: Extract<ChatDelta, { type: 'activity' }>['phase'];
  status?: Extract<ChatDelta, { type: 'activity' }>['status'];
  label: string;
  detail?: string;
  suffix?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}): Extract<ChatDelta, { type: 'activity' }> {
  const stable = args.suffix ?? `${args.phase}-${Date.now()}`;
  return {
    type: 'activity',
    id: `activity-${args.clientTurnId ?? 'turn'}-${stable}`,
    phase: args.phase,
    status: args.status ?? 'running',
    label: args.label,
    ...(args.detail ? { detail: args.detail } : {}),
    startedAt: args.startedAt ?? new Date().toISOString(),
    ...(args.completedAt ? { completedAt: args.completedAt } : {}),
    ...(args.durationMs !== undefined ? { durationMs: args.durationMs } : {}),
    ...(args.workflowId ? { workflowId: args.workflowId } : {}),
    ...(args.agentId ? { agentId: args.agentId } : {}),
    ...(args.clientTurnId ? { clientTurnId: args.clientTurnId } : {}),
  };
}

async function writeChatDelta(
  stream: ChatSseStream,
  deps: ConversationRouteDeps,
  ws: ReturnType<typeof getWorkspace>,
  agentId: string,
  conversationId: string,
  clientTurnId: string,
  delta: ChatDelta,
  streamedMetadata: StreamedChatMetadata,
): Promise<void> {
  captureChatDeltaMetadata(streamedMetadata, delta);
  await stream.writeSSE({ event: 'delta', data: JSON.stringify(delta) });
  publishChatDelta(deps, ws, agentId, conversationId, clientTurnId, delta);
}

function publishChatDelta(
  deps: ConversationRouteDeps,
  ws: ReturnType<typeof getWorkspace>,
  agentId: string,
  conversationId: string,
  clientTurnId: string,
  delta: ChatDelta,
): void {
  const room = REALTIME_ROOMS.workspace(ws.workspaceId);
  if (delta.type === 'activity') {
    deps.bus.publish(room, REALTIME_EVENTS.AGENT_WORK_STEP, {
      workspaceId: ws.workspaceId,
      ambientId: ws.ambientId,
      agentId,
      conversationId,
      clientTurnId,
      workflowId: delta.workflowId,
      runId: delta.runId,
      nodeId: delta.nodeId,
      phase: delta.status === 'error' ? 'fail' : delta.status === 'success' ? 'complete' : delta.phase,
      description: [delta.label, delta.detail].filter(Boolean).join(' - '),
      at: delta.startedAt ?? new Date().toISOString(),
    });
    return;
  }
  if (delta.type === 'tool_call') {
    deps.bus.publish(room, REALTIME_EVENTS.AGENT_TERMINAL_TOOL_CALL, {
      workspaceId: ws.workspaceId,
      ambientId: ws.ambientId,
      agentId,
      conversationId,
      clientTurnId,
      tool: delta.name,
      args: delta.args,
      at: new Date().toISOString(),
    });
    deps.bus.publish(room, REALTIME_EVENTS.AGENT_WORK_STEP, {
      workspaceId: ws.workspaceId,
      ambientId: ws.ambientId,
      agentId,
      conversationId,
      clientTurnId,
      phase: 'tool',
      description: `Calling ${delta.name}`,
      at: new Date().toISOString(),
    });
    return;
  }
  if (delta.type === 'tool_result') {
    deps.bus.publish(room, REALTIME_EVENTS.AGENT_WORK_STEP, {
      workspaceId: ws.workspaceId,
      ambientId: ws.ambientId,
      agentId,
      conversationId,
      clientTurnId,
      phase: delta.error ? 'fail' : 'complete',
      description: delta.error ? `${delta.name} failed: ${delta.error}` : `${delta.name} completed`,
      at: new Date().toISOString(),
    });
  }
}

async function* withChatHeartbeats(
  source: AsyncIterable<ChatDelta>,
  args: { clientTurnId: string; agentId: string; workflowId?: string },
): AsyncIterable<ChatDelta> {
  const iterator = source[Symbol.asyncIterator]();
  const startedAt = Date.now();
  let nextHeartbeatAt = 15_000;
  let next = iterator.next();

  while (true) {
    const waitMs = Math.max(0, startedAt + nextHeartbeatAt - Date.now());
    const raced = await Promise.race([
      next.then((result) => ({ kind: 'delta' as const, result })),
      delay(waitMs).then(() => ({ kind: 'heartbeat' as const, threshold: nextHeartbeatAt })),
    ]);

    if (raced.kind === 'heartbeat') {
      yield createChatActivity({
        clientTurnId: args.clientTurnId,
        agentId: args.agentId,
        workflowId: args.workflowId,
        phase: 'waiting',
        label: 'Waiting for runtime',
        detail: `Still working after ${Math.round(raced.threshold / 1000)}s.`,
        suffix: `waiting-${raced.threshold}`,
      });
      nextHeartbeatAt = raced.threshold < 60_000
        ? 60_000
        : raced.threshold < 120_000
          ? 120_000
          : raced.threshold + 60_000;
      continue;
    }

    if (raced.result.done) return;
    yield raced.result.value;
    while (Date.now() - startedAt >= nextHeartbeatAt) {
      nextHeartbeatAt = nextHeartbeatAt < 60_000
        ? 60_000
        : nextHeartbeatAt < 120_000
          ? 120_000
          : nextHeartbeatAt + 60_000;
    }
    next = iterator.next();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function workflowIdFromViewport(viewport: ViewportContext | null | undefined): string | undefined {
  if (!viewport) return undefined;
  if (viewport.resourceKind === 'workflow' && viewport.resourceId) return viewport.resourceId;
  if (typeof viewport.metadata?.workflowId === 'string') return viewport.metadata.workflowId;
  return undefined;
}

function findWorkspaceOrchestrator(db: AgentisSqliteDb, workspaceId: string): AgentRow | null {
  return db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.role, 'orchestrator')))
    .get() ?? null;
}

function serializeScopeAgent(agent: AgentRow) {
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    status: agent.status,
    colorHex: agent.colorHex,
    reportsTo: agent.reportsTo,
  };
}

async function sendConversationMessage(
  c: Context,
  deps: ConversationRouteDeps,
  ws: ReturnType<typeof getWorkspace>,
  agentId: string,
) {
  const body = sendSchema.parse(await c.req.json());
  const clientTurnId = body.clientTurnId ?? randomUUID();
  const conversationId = c.req.query('conversationId') || null;
  const conversation = conversationId
    ? deps.conversations.getById(ws.workspaceId, conversationId)
    : deps.conversations.getOrCreateByAgent({
        workspaceId: ws.workspaceId,
        ambientId: ws.ambientId,
        userId: ws.user.id,
        agentId,
      });
  const message = deps.conversations.appendOutbound({
    workspaceId: ws.workspaceId,
    conversationId: conversation.id,
    operatorId: ws.user.id,
    body: body.body,
    metadata: { clientTurnId },
  });
  const reg = deps.adapters.get(agentId);

  const acceptsSSE = c.req.header('accept')?.includes('text/event-stream');
  if (acceptsSSE) {
    return streamSSE(c, async (stream) => {
      const turnStartedAtMs = Date.now();
      const turnStartedAt = new Date(turnStartedAtMs).toISOString();
      let finalText = '';
      let finishReason: Extract<ChatDelta, { type: 'done' }>['finishReason'] = 'stop';
      let adapterError: string | null = null;
      const streamedMetadata = createStreamedChatMetadata(clientTurnId, turnStartedAt);
      const viewportOverride = body.viewportOverride as ViewportContext | null | undefined;
      const activeViewport = body.useViewportContext
        ? viewportOverride ?? deps.viewportStore?.get(ws.user.id) ?? null
        : viewportOverride ?? null;
      const viewportWorkflowId = workflowIdFromViewport(activeViewport);
      await writeChatDelta(stream, deps, ws, agentId, conversation.id, clientTurnId, createChatActivity({
        clientTurnId,
        agentId,
        workflowId: viewportWorkflowId,
        phase: 'received',
        label: 'Request received',
        detail: 'The agent accepted the chat turn.',
        suffix: 'received',
        startedAt: turnStartedAt,
      }), streamedMetadata);
      if (reg?.adapter?.chat) {
        const history = deps.conversations
          .messages(conversation.id, 20)
          .slice(0, -1)
          .map((row) => ({
            role: row.authorType === 'operator' ? 'user' as const : 'assistant' as const,
            content: row.body,
          }));
        const turnContext: ChatTurnContext = {
          workspaceId: ws.workspaceId,
          ambientId: ws.ambientId,
          agentId,
          userId: ws.user.id,
          conversationId: conversation.id,
          clientTurnId,
          maxTurns: 8,
          viewport: activeViewport,
          // Cancel the whole turn (chat loop + model-backed tools like workflow
          // synthesis) when the operator disconnects the SSE stream, so we stop
          // spending model credits on a turn nobody is listening to.
          signal: c.req.raw.signal,
        };
        for await (const delta of withChatHeartbeats(
          ChatSessionExecutor.turn(reg.adapter, history, body.body, turnContext),
          { clientTurnId, agentId, workflowId: viewportWorkflowId },
        )) {
          if (isAdapterErrorDelta(delta)) {
            if (delta.error.startsWith('canceled:')) {
              finishReason = 'max_turns';
              finalText = 'Stopped by operator.';
              break;
            }
            adapterError = delta.error;
            continue;
          }
          if (delta.type === 'done') {
            finishReason = delta.finishReason;
            break;
          }
          await writeChatDelta(stream, deps, ws, agentId, conversation.id, clientTurnId, delta, streamedMetadata);
          if (delta.type === 'text') finalText += delta.delta;
        }
      } else {
        // Every V1 harness adapter (OpenClaw, Hermes, Codex, Cursor, Claude Code,
        // HTTP) now implements `chat()`, so this is reached only by an adapter that
        // genuinely cannot chat. Surface the adapter's own reason, not boilerplate.
        const limitation = reg?.adapter?.capabilities?.().limitations?.[0];
        finalText = limitation
          ?? 'This agent is not connected to an interactive chat harness yet. Configure a V1 harness, then try again.';
        finishReason = 'error';
        adapterError = finalText;
        await writeChatDelta(stream, deps, ws, agentId, conversation.id, clientTurnId, {
          type: 'activity',
          id: `activity-${clientTurnId}-no-chat`,
          phase: 'error',
          status: 'error',
          label: 'Interactive chat unavailable',
          detail: finalText,
          clientTurnId,
          agentId,
        }, streamedMetadata);
        await writeChatDelta(stream, deps, ws, agentId, conversation.id, clientTurnId, { type: 'text', delta: finalText }, streamedMetadata);
      }

      if (!finalText.trim() && !streamedMetadata.confirmation) {
        if (finishReason === 'error') {
          finalText = relevantTurnError(streamedMetadata, adapterError);
        } else {
          finishReason = 'error';
          finalText = 'The runtime completed without returning an answer. The turn was stopped so you can retry without wondering whether it is still running.';
        }
      }

      const turnCompletedAt = new Date().toISOString();
      const durationMs = Math.max(0, Date.now() - turnStartedAtMs);
      finalizeTurnTrace(streamedMetadata, finishReason, turnCompletedAt, durationMs);
      const failed = streamedMetadata.turn.status === 'failed';
      const stopped = streamedMetadata.turn.status === 'stopped';
      await writeChatDelta(stream, deps, ws, agentId, conversation.id, clientTurnId, createChatActivity({
        clientTurnId,
        agentId,
        workflowId: streamedMetadata.workflowId ?? viewportWorkflowId,
        phase: failed ? 'error' : 'complete',
        status: failed ? 'error' : 'success',
        label: failed ? 'Response failed' : stopped ? 'Stopped before completion' : 'Response ready',
        detail: failed ? finalText : stopped ? 'The turn reached a runtime limit.' : 'The agent finished this turn.',
        suffix: 'terminal',
        startedAt: turnCompletedAt,
        completedAt: turnCompletedAt,
        durationMs,
      }), streamedMetadata);

      if (failed) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({
            code: 'ADAPTER_CHAT_FAILED',
            message: finalText,
          }),
        });
      }

      const hasContentToSave = finalText.trim() || streamedMetadata.confirmation || failed;
      if (hasContentToSave) {
        const bodyToSave = finalText.trim() || streamedMetadata.confirmation?.title || 'Confirmation required';

        const persisted = deps.conversations.appendMirrored({
          workspaceId: ws.workspaceId,
          conversationId: conversation.id,
          sessionMessageId: `chat_${randomUUID()}`,
          authorType: 'agent',
          body: bodyToSave,
          deliveryStatus: failed ? 'failed' : 'delivered',
          metadata: buildPersistedChatMetadata('chat_loop', streamedMetadata, clientTurnId),
        });
        await stream.writeSSE({
          event: 'message',
          data: JSON.stringify({
            id: persisted.id,
            role: 'agent',
            body: persisted.body,
            createdAt: persisted.createdAt,
            metadata: persisted.metadata,
            deliveryStatus: persisted.deliveryStatus,
          }),
        });
      }
      const capture = await deps.memoryCapture?.captureTurn({
        workspaceId: ws.workspaceId,
        conversationId: conversation.id,
        userId: ws.user.id,
        agentId,
        userDisplayName: ws.user.displayName,
        userMessage: body.body,
        assistantMessage: finalText.trim() || null,
        finishReason,
      });
      // Surface the post-turn "learning" so the small background spend (peer-profile
      // embeddings + cognitive promotion LLM passes) is never a mystery charge after
      // the turn looks done. Only emitted when real background work was actually
      // enqueued — routine turns stay silent.
      if (
        capture &&
        (capture.peerUpdateJobIds.length > 0 || capture.promotedSessionMoments > 0 || capture.workspaceMemoryIds.length > 0)
      ) {
        deps.bus.publish(REALTIME_ROOMS.workspace(ws.workspaceId), REALTIME_EVENTS.AGENT_WORK_STEP, {
          workspaceId: ws.workspaceId,
          ambientId: ws.ambientId,
          agentId,
          conversationId: conversation.id,
          clientTurnId,
          phase: 'complete',
          description: 'Learning from this conversation (updating memory in the background)',
          at: new Date().toISOString(),
        });
      }
      await writeChatDelta(
        stream,
        deps,
        ws,
        agentId,
        conversation.id,
        clientTurnId,
        { type: 'done', finishReason },
        streamedMetadata,
      );
      await stream.writeSSE({ event: 'done', data: JSON.stringify({ finishReason }) });
    });
  }

  if (reg?.adapter instanceof OpenClawAdapter) {
    await relayOpenClaw(deps, reg.adapter, conversation.mirroredSessionId ?? undefined, body.body, agentId);
  }
  return c.json({ message, conversationId: conversation.id, agentId });
}

async function confirmConversationAction(
  c: Context,
  deps: ConversationRouteDeps,
  ws: ReturnType<typeof getWorkspace>,
  agentId: string,
) {
  const body = confirmSchema.parse(await c.req.json());
  const conversationId = c.req.query('conversationId') || null;
  const conversation = conversationId
    ? deps.conversations.getById(ws.workspaceId, conversationId)
    : deps.conversations.getOrCreateByAgent({
        workspaceId: ws.workspaceId,
        ambientId: ws.ambientId,
        userId: ws.user.id,
        agentId,
      });
  const reg = deps.adapters.get(agentId);
  if (!reg?.adapter?.chat || reg.adapter.capabilities?.().interactiveChat === false) {
    throw new AgentisError('ADAPTER_UNAVAILABLE', 'agent does not support interactive chat confirmations');
  }

  const targetMsg = deps.db
    .select()
    .from(schema.conversationMessages)
    .where(and(
      eq(schema.conversationMessages.conversationId, conversation.id),
      sql`json_extract(${schema.conversationMessages.metadata}, '$.confirmation.turnId') = ${body.turnId}`
    ))
    .get();

  if (targetMsg) {
    const metadata = (typeof targetMsg.metadata === 'string' ? JSON.parse(targetMsg.metadata) : targetMsg.metadata) as Record<string, any>;
    if (metadata && metadata.confirmation) {
      metadata.confirmation.status = body.confirmed ? 'approved' : 'cancelled';
      deps.db
        .update(schema.conversationMessages)
        .set({ metadata })
        .where(eq(schema.conversationMessages.id, targetMsg.id))
        .run();

      const updatedMsg = deps.db
        .select()
        .from(schema.conversationMessages)
        .where(eq(schema.conversationMessages.id, targetMsg.id))
        .get();

      if (updatedMsg) {
        deps.bus.publish(
          REALTIME_ROOMS.conversation(conversation.agentId),
          REALTIME_EVENTS.CONVERSATION_MESSAGE_UPDATED,
          {
            message: serializeConversationMessage(updatedMsg),
            conversationId: conversation.id,
            agentId: conversation.agentId,
          }
        );
      }
    }
  }

  const acceptsSSE = c.req.header('accept')?.includes('text/event-stream');
  if (acceptsSSE) {
    return streamSSE(c, async (stream) => {
      const clientTurnId = body.clientTurnId ?? randomUUID();
      const turnStartedAtMs = Date.now();
      const turnStartedAt = new Date(turnStartedAtMs).toISOString();
      let finalText = '';
      let finishReason: Extract<ChatDelta, { type: 'done' }>['finishReason'] = 'stop';
      let adapterError: string | null = null;
      const streamedMetadata = createStreamedChatMetadata(clientTurnId, turnStartedAt);
      await writeChatDelta(stream, deps, ws, agentId, conversation.id, clientTurnId, createChatActivity({
        clientTurnId,
        agentId,
        phase: 'received',
        label: body.confirmed ? 'Approval received' : 'Cancellation received',
        detail: body.confirmed ? 'Resuming the paused action.' : 'Stopping the paused action.',
        suffix: 'received',
        startedAt: turnStartedAt,
      }), streamedMetadata);
      for await (const delta of ChatSessionExecutor.confirm(reg.adapter, body.turnId, body.confirmed, {
        workspaceId: ws.workspaceId,
        userId: ws.user.id,
        conversationId: conversation.id,
        signal: c.req.raw.signal,
      })) {
        if (isAdapterErrorDelta(delta)) {
          adapterError = delta.error;
          continue;
        }
        if (delta.type === 'done') {
          finishReason = delta.finishReason;
          break;
        }
        await writeChatDelta(stream, deps, ws, agentId, conversation.id, clientTurnId, delta, streamedMetadata);
        if (delta.type === 'text') finalText += delta.delta;
      }

      if (!finalText.trim() && !streamedMetadata.confirmation) {
        if (finishReason === 'error') {
          finalText = relevantTurnError(streamedMetadata, adapterError);
        } else {
          finishReason = 'error';
          finalText = 'The runtime completed the confirmation without returning an answer.';
        }
      }

      const turnCompletedAt = new Date().toISOString();
      const durationMs = Math.max(0, Date.now() - turnStartedAtMs);
      finalizeTurnTrace(streamedMetadata, finishReason, turnCompletedAt, durationMs);
      const failed = streamedMetadata.turn.status === 'failed';
      await writeChatDelta(stream, deps, ws, agentId, conversation.id, clientTurnId, createChatActivity({
        clientTurnId,
        agentId,
        phase: failed ? 'error' : 'complete',
        status: failed ? 'error' : 'success',
        label: failed ? 'Action failed' : 'Action complete',
        detail: failed ? finalText : 'The confirmation turn finished.',
        suffix: 'terminal',
        startedAt: turnCompletedAt,
        completedAt: turnCompletedAt,
        durationMs,
      }), streamedMetadata);

      if (failed) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({
            code: 'ADAPTER_CHAT_FAILED',
            message: finalText,
          }),
        });
      }
      const hasContentToSave = finalText.trim() || streamedMetadata.confirmation || failed;
      if (hasContentToSave) {
        const bodyToSave = finalText.trim() || streamedMetadata.confirmation?.title || 'Confirmation required';

        const persisted = deps.conversations.appendMirrored({
          workspaceId: ws.workspaceId,
          conversationId: conversation.id,
          sessionMessageId: `chat_${randomUUID()}`,
          authorType: 'agent',
          body: bodyToSave,
          deliveryStatus: failed ? 'failed' : 'delivered',
          metadata: buildPersistedChatMetadata('chat_confirmation', streamedMetadata, clientTurnId),
        });
        await stream.writeSSE({
          event: 'message',
          data: JSON.stringify({
            id: persisted.id,
            role: 'agent',
            body: persisted.body,
            createdAt: persisted.createdAt,
            metadata: persisted.metadata,
            deliveryStatus: persisted.deliveryStatus,
          }),
        });
      }
      await writeChatDelta(
        stream,
        deps,
        ws,
        agentId,
        conversation.id,
        clientTurnId,
        { type: 'done', finishReason },
        streamedMetadata,
      );
      await stream.writeSSE({ event: 'done', data: JSON.stringify({ finishReason }) });
    });
  }

  const deltas: unknown[] = [];
  let finalText = '';
  let finishReason: Extract<ChatDelta, { type: 'done' }>['finishReason'] = 'stop';
  for await (const delta of ChatSessionExecutor.confirm(reg.adapter, body.turnId, body.confirmed, {
    workspaceId: ws.workspaceId,
    userId: ws.user.id,
    conversationId: conversation.id,
    signal: c.req.raw.signal,
  })) {
    deltas.push(delta);
    if (delta.type === 'text') finalText += delta.delta;
    if (delta.type === 'done') finishReason = delta.finishReason;
  }
  if (finishReason !== 'error' && finalText.trim()) {
    deps.conversations.appendMirrored({
      workspaceId: ws.workspaceId,
      conversationId: conversation.id,
      sessionMessageId: `chat_${randomUUID()}`,
      authorType: 'agent',
      body: finalText,
    });
  }
  return c.json({ deltas, conversationId: conversation.id, agentId });
}

function isAdapterErrorDelta(delta: ChatDelta): delta is Extract<ChatDelta, { type: 'tool_result' }> & { error: string } {
  return delta.type === 'tool_result'
    && delta.id === 'adapter'
    && delta.name === 'adapter.chat'
    && typeof delta.error === 'string'
    && delta.error.trim().length > 0;
}

function createStreamedChatMetadata(
  clientTurnId: string = randomUUID(),
  startedAt = new Date().toISOString(),
): StreamedChatMetadata {
  return {
    turn: {
      clientTurnId,
      startedAt,
      status: 'running',
    },
    thinking: '',
    activity: [],
    toolCalls: [],
    toolStartedAt: new Map(),
    workflowId: null,
    runId: null,
    runTitle: null,
    confirmation: null,
  };
}

function finalizeTurnTrace(
  state: StreamedChatMetadata,
  finishReason: ChatFinishReason,
  completedAt: string,
  durationMs: number,
): void {
  state.turn = {
    ...state.turn,
    completedAt,
    durationMs,
    finishReason,
    status: finishReason === 'error'
      ? 'failed'
      : finishReason === 'max_turns' || finishReason === 'length'
        ? 'stopped'
        : 'completed',
  };
}

function relevantTurnError(state: StreamedChatMetadata, adapterError: string | null): string {
  const toolError = [...state.toolCalls]
    .reverse()
    .find((call) => call.status === 'error' && call.name !== 'adapter.chat')
    ?.error
    ?.trim();
  return toolError
    || adapterError?.trim()
    || 'The agent runtime failed before it could complete the chat turn.';
}

function captureChatDeltaMetadata(state: StreamedChatMetadata, delta: ChatDelta): void {
  if (delta.type === 'activity') {
    state.activity = [...state.activity.filter((entry) => entry.id !== delta.id), delta].slice(-80);
    if (delta.workflowId) state.workflowId = delta.workflowId;
    if (delta.runId) state.runId = delta.runId;
    return;
  }
  if (delta.type === 'thinking') {
    state.thinking += delta.delta;
    return;
  }
  if (delta.type === 'tool_call') {
    state.toolStartedAt.set(delta.id, Date.now());
    state.toolCalls = [
      ...state.toolCalls.filter((entry) => entry.id !== delta.id),
      {
        id: delta.id,
        name: delta.name,
        status: 'running',
        args: delta.args,
      },
    ];
    return;
  }
  if (delta.type === 'tool_result') {
    const startedAt = state.toolStartedAt.get(delta.id);
    const durationMs = startedAt !== undefined ? Math.max(0, Date.now() - startedAt) : null;
    const previous = state.toolCalls.find((entry) => entry.id === delta.id);
    state.toolCalls = [
      ...state.toolCalls.filter((entry) => entry.id !== delta.id),
      {
        id: delta.id,
        name: delta.name,
        status: delta.error ? 'error' : 'success',
        args: previous?.args,
        result: delta.result,
        error: delta.error ?? null,
        durationMs,
      },
    ];
    const build = workflowBuildMetadataFromResult(delta.result);
    if (build) {
      state.workflowId = build.workflowId;
      state.runId = build.runId;
      state.runTitle = build.title ?? state.runTitle;
    }
    return;
  }
  if (delta.type === 'confirmation_required') {
    state.confirmation = {
      turnId: delta.turnId,
      toolCall: delta.toolCall,
      title: delta.title,
      body: delta.body,
      impact: delta.impact,
      confirmLabel: delta.confirmLabel,
      cancelLabel: delta.cancelLabel,
      expiresAt: delta.expiresAt,
      status: 'pending',
    };
  }
}

function buildPersistedChatMetadata(
  source: 'chat_loop' | 'chat_confirmation',
  state: StreamedChatMetadata,
  clientTurnId?: string | null,
): Record<string, unknown> {
  return {
    source,
    ...(clientTurnId ? { clientTurnId } : {}),
    turn: state.turn,
    ...(state.thinking.trim() ? { thinking: state.thinking } : {}),
    ...(state.activity.length > 0 ? { activity: state.activity } : {}),
    ...(state.toolCalls.length > 0 ? { toolCalls: state.toolCalls } : {}),
    ...(state.workflowId ? { workflowId: state.workflowId } : {}),
    ...(state.runId ? { runId: state.runId } : {}),
    ...(state.runTitle ? { runTitle: state.runTitle } : {}),
    ...(state.confirmation ? { confirmation: state.confirmation } : {}),
  };
}

function workflowBuildMetadataFromResult(result: unknown): { workflowId: string; runId: string; title?: string } | null {
  if (!result || typeof result !== 'object') return null;
  const value = result as { workflowId?: unknown; runId?: unknown; title?: unknown };
  if (typeof value.workflowId !== 'string' || !value.workflowId.trim()) return null;
  if (typeof value.runId !== 'string' || !value.runId.trim()) return null;
  return {
    workflowId: value.workflowId,
    runId: value.runId,
    ...(typeof value.title === 'string' && value.title.trim() ? { title: value.title.trim() } : {}),
  };
}
