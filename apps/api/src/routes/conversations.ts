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
  type ChatPermissionMode,
  type ChatTurnContext,
  type ChatTurnTrace,
  type ViewportContext,
} from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { ConversationStore } from '../services/conversation/conversationStore.js';
import { parseModeCommand, MODE_SWITCH_ACK, defaultTaskForMode, PLAN_MODE_SYSTEM_ADDENDUM, repairArchitectureCanvas } from '../services/chat/chatPermissionMode.js';
import type { AdapterManager } from '../adapters/AdapterManager.js';
import { OpenClawAdapter } from '../adapters/OpenClawAdapter.js';
import { ChatSessionExecutor } from '../services/chat/chatSessionExecutor.js';
import { publishAgentWorkStep, publishChatDeltaProgress } from '../services/agent/agentWorkProgress.js';
import type { ViewportStore } from '../services/viewportStore.js';
import type { Logger } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';
import type { EventBus } from '../event-bus.js';
import { serializeConversationMessage, serializeQueueItem, delay, workflowIdFromViewport, serializeScopeAgent, isAdapterErrorDelta, createStreamedChatMetadata, finalizeTurnTrace, relevantTurnError, captureChatDeltaMetadata, buildPersistedChatMetadata, workflowBuildMetadataFromResult } from '../services/conversation/conversationTurnHelpers.js';
import type { AgentRow, StreamedChatMetadata } from '../services/conversation/conversationTurnHelpers.js';

const sendSchema = z.object({
  body: z.string().min(1).max(CONSTANTS.CONVERSATION_MESSAGE_MAX_LENGTH),
  clientTurnId: z.string().min(1).max(120).optional(),
  useViewportContext: z.boolean().optional().default(true),
  /** Composer toggle: persist the sticky permission mode alongside this turn. */
  permissionMode: z.enum(['ask', 'plan', 'auto']).optional(),
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
const rewriteSchema = sendSchema.omit({ body: true }).extend({
  text: z.string().min(1).max(CONSTANTS.CONVERSATION_MESSAGE_MAX_LENGTH),
});
type ConversationRouteDeps = {
  db: AgentisSqliteDb;
  auth: AuthService;
  conversations: ConversationStore;
  adapters: AdapterManager;
  logger: Logger;
  viewportStore?: ViewportStore;
  bus: EventBus;
  memoryCapture?: {
    captureImmediateCorrection?(args: {
      workspaceId: string;
      conversationId: string;
      userId: string;
      agentId: string;
      userDisplayName?: string | null;
      userMessage: string;
      activeWorkflowId?: string | null;
      activeNodeId?: string | null;
    }): string | null;
    captureTurn(args: {
      workspaceId: string;
      conversationId: string;
      userId: string;
      agentId: string;
      userDisplayName?: string | null;
      userMessage: string;
      assistantMessage?: string | null;
      finishReason?: string | null;
      activeWorkflowId?: string | null;
      activeNodeId?: string | null;
    }): Promise<{
      peerUpdateJobIds: string[];
      promotedSessionMoments: number;
      workspaceMemoryIds: string[];
      sessionMomentId: string | null;
      /** Learnings queued through the PRIMARY formation path (judge dedupes). */
      signals: number;
    }>;
  };
};

type ConversationRow = typeof schema.conversations.$inferSelect;






/**
 * Queue-then-auto-continue mid-turn composer — module-level guard tracking
 * which conversations currently have a turn actively streaming
 * (ChatSessionExecutor.turn in flight via `streamConversationTurnReply`). A
 * `sendConversationMessage` call that lands while its conversationId is in
 * this set is durably queued (conversation_message_queue) instead of racing
 * a second live turn; `streamConversationTurnReply` releases the guard and
 * auto-dispatches the oldest queued message once its own stream ends. Mirrors
 * the in-repo shape of `ChatSessionExecutor#pendingConfirmations` (a static
 * Map keyed by an id, cleared explicitly on completion).
 */
const activeConversationTurns = new Set<string>();

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
    const channelRows = deps.db
      .select({
        id: schema.channelConnections.id,
        kind: schema.channelConnections.kind,
        name: schema.channelConnections.name,
      })
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.workspaceId, ws.workspaceId))
      .all();
    const channelsById = new Map(channelRows.map((channel) => [channel.id, channel]));
    const enriched = rows.map((r) => {
      const a = byId.get(r.agentId);
      const channel = r.channelConnectionId ? channelsById.get(r.channelConnectionId) : null;
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
        channelConnectionId: r.channelConnectionId,
        channelChatId: r.channelChatId,
        channelKind: channel?.kind ?? null,
        channelName: channel?.name ?? null,
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

  // Queue-then-auto-continue composer: still-pending messages queued while a
  // turn was streaming. Fetched on load so a page reload never silently drops
  // them (they keep dispatching once the in-flight turn ends).
  app.get('/:agentId/queue', (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('agentId');
    const agent = deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    if (!agent || agent.workspaceId !== ws.workspaceId) throw new AgentisError('RESOURCE_NOT_FOUND', 'agent not found');
    const conversationId = c.req.query('conversationId') || null;
    const conversation = conversationId
      ? deps.conversations.getById(ws.workspaceId, conversationId)
      : deps.conversations.getOrCreateByAgent({
          workspaceId: ws.workspaceId,
          ambientId: ws.ambientId,
          userId: ws.user.id,
          agentId,
        });
    const items = deps.conversations.listQueue(ws.workspaceId, conversation.id).map(serializeQueueItem);
    return c.json({ items, conversationId: conversation.id });
  });

  // Cancel a still-pending queued message before it dispatches.
  app.delete('/:agentId/queue/:queueId', (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('agentId');
    const queueId = c.req.param('queueId');
    const agent = deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    if (!agent || agent.workspaceId !== ws.workspaceId) throw new AgentisError('RESOURCE_NOT_FOUND', 'agent not found');
    const conversationId = c.req.query('conversationId') || null;
    const conversation = conversationId
      ? deps.conversations.getById(ws.workspaceId, conversationId)
      : deps.conversations.getOrCreateByAgent({
          workspaceId: ws.workspaceId,
          ambientId: ws.ambientId,
          userId: ws.user.id,
          agentId,
        });
    const item = deps.conversations.discardQueuedMessage({
      workspaceId: ws.workspaceId,
      conversationId: conversation.id,
      queueId,
    });
    return c.json({ ok: true, item: serializeQueueItem(item) });
  });

  // Reload recovery: a tab that (re)loaded mid-queue has no way to know a
  // turn ended while it was gone (the in-flight guard is in-memory and the
  // "turn ended" dispatch only fires for tabs that were connected at the
  // time). If no turn is currently active for this conversation, atomically
  // claim the oldest pending message so the client can continue it as a
  // fresh turn — a reload must never silently strand a queued send. Returns
  // { item: null } when a turn is already active (nothing to claim) or the
  // queue is empty.
  app.post('/:agentId/queue/resume', (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('agentId');
    const agent = deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    if (!agent || agent.workspaceId !== ws.workspaceId) throw new AgentisError('RESOURCE_NOT_FOUND', 'agent not found');
    const conversationId = c.req.query('conversationId') || null;
    const conversation = conversationId
      ? deps.conversations.getById(ws.workspaceId, conversationId)
      : deps.conversations.getOrCreateByAgent({
          workspaceId: ws.workspaceId,
          ambientId: ws.ambientId,
          userId: ws.user.id,
          agentId,
        });
    if (activeConversationTurns.has(conversation.id)) {
      return c.json({ item: null });
    }
    const item = deps.conversations.dispatchNextQueued({
      workspaceId: ws.workspaceId,
      conversationId: conversation.id,
    });
    return c.json({ item: item ? serializeQueueItem(item) : null });
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

  // Composer toggle: set the conversation's sticky permission mode (ask | plan |
  // auto) without sending a message. Channels do the same via slash commands.
  app.post('/session/:conversationId/mode', async (c) => {
    const ws = getWorkspace(c);
    const conversationId = c.req.param('conversationId');
    const { mode } = z.object({ mode: z.enum(['ask', 'plan', 'auto']) }).parse(await c.req.json());
    // Reuse the existing executionMode='plan' enforcement (registry-level mutation
    // block) so Plan mode behaves identically whether set here or via /plan.
    deps.db.update(schema.conversations)
      .set({
        permissionMode: mode,
        executionMode: mode === 'plan' ? 'plan' : 'chat',
        updatedAt: new Date().toISOString(),
      })
      .where(and(
        eq(schema.conversations.id, conversationId),
        eq(schema.conversations.workspaceId, ws.workspaceId),
      ))
      .run();
    return c.json({ ok: true, permissionMode: mode });
  });

  app.delete('/session/:conversationId', (c) => {
    const ws = getWorkspace(c);
    const conversationId = c.req.param('conversationId');
    deps.conversations.deleteConversation(ws.workspaceId, conversationId);
    return c.json({ ok: true });
  });

  app.post('/:agentId/:messageId/rewrite', async (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('agentId');
    const messageId = c.req.param('messageId');
    const body = rewriteSchema.parse(await c.req.json());
    const clientTurnId = body.clientTurnId ?? randomUUID();
    const agent = deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    if (!agent || agent.workspaceId !== ws.workspaceId) throw new AgentisError('RESOURCE_NOT_FOUND', 'agent not found');
    const conversationId = c.req.query('conversationId') || null;
    const conversation = conversationId
      ? deps.conversations.getById(ws.workspaceId, conversationId)
      : deps.conversations.getOrCreateByAgent({
          workspaceId: ws.workspaceId,
          ambientId: ws.ambientId,
          userId: ws.user.id,
          agentId,
        });
    const result = deps.conversations.rewriteFromMessage({
      workspaceId: ws.workspaceId,
      conversationId: conversation.id,
      messageId,
      body: body.text,
      metadata: { clientTurnId },
    });
    captureImmediateConversationCorrection(deps, ws, {
      agentId,
      conversationId: conversation.id,
      userMessage: body.text,
      useViewportContext: body.useViewportContext,
      viewportOverride: body.viewportOverride as ViewportContext | null | undefined,
    });
    if (c.req.header('accept')?.includes('text/event-stream')) {
      return streamConversationTurnReply(c, deps, ws, {
        agentId,
        conversation,
        clientTurnId,
        currentMessageId: result.message.id,
        userMessage: body.text,
        useViewportContext: body.useViewportContext,
        viewportOverride: body.viewportOverride as ViewportContext | null | undefined,
      });
    }
    return c.json(result);
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
  publishChatDeltaProgress(deps.bus, {
    workspaceId: ws.workspaceId,
    ambientId: ws.ambientId,
    agentId,
    conversationId,
    clientTurnId,
  }, delta);
}

async function* withChatHeartbeats(
  source: AsyncIterable<ChatDelta>,
  args: { clientTurnId: string; agentId: string; workflowId?: string },
): AsyncIterable<ChatDelta> {
  const iterator = source[Symbol.asyncIterator]();
  const startedAt = Date.now();
  let nextHeartbeatAt = 15_000;
  let next = iterator.next();
  let lastActivity: Extract<ChatDelta, { type: 'activity' }> | undefined;

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
        label: lastActivity?.label ?? 'Waiting for runtime',
        detail: `Still working after ${Math.round(raced.threshold / 1000)}s.`,
        suffix: 'waiting',
      });
      nextHeartbeatAt = raced.threshold < 60_000
        ? 60_000
        : raced.threshold < 120_000
          ? 120_000
          : raced.threshold + 60_000;
      continue;
    }

    if (raced.result.done) return;
    if (raced.result.value.type === 'activity') lastActivity = raced.result.value;
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



function findWorkspaceOrchestrator(db: AgentisSqliteDb, workspaceId: string): AgentRow | null {
  return db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.role, 'orchestrator')))
    .get() ?? null;
}


function conversationHistoryForTurn(
  deps: ConversationRouteDeps,
  conversationId: string,
  currentMessageId: string | null,
) {
  return deps.conversations
    .messages(conversationId, 20)
    .filter((row) => row.id !== currentMessageId)
    .map((row) => ({
      role: row.authorType === 'operator' ? 'user' as const : 'assistant' as const,
      content: row.body,
    }));
}

function streamConversationTurnReply(
  c: Context,
  deps: ConversationRouteDeps,
  ws: ReturnType<typeof getWorkspace>,
  args: {
    agentId: string;
    conversation: ConversationRow;
    clientTurnId: string;
    currentMessageId: string | null;
    userMessage: string;
    useViewportContext: boolean;
    viewportOverride?: ViewportContext | null;
  },
) {
  const reg = deps.adapters.get(args.agentId);
  return streamSSE(c, async (stream) => {
    activeConversationTurns.add(args.conversation.id);
    try {
      await runConversationTurn(stream, c, deps, ws, args, reg);
    } finally {
      activeConversationTurns.delete(args.conversation.id);
      // Queue-then-auto-continue: this turn just ended — if a message was
      // queued while it streamed, pop the oldest and announce it on the
      // realtime bus so the client auto-continues with a fresh turn.
      try {
        deps.conversations.dispatchNextQueued({
          workspaceId: ws.workspaceId,
          conversationId: args.conversation.id,
        });
      } catch (err) {
        deps.logger.warn('conversations.queue_dispatch_failed', {
          conversationId: args.conversation.id,
          err: (err as Error).message,
        });
      }
    }
  });
}

async function runConversationTurn(
  stream: ChatSseStream,
  c: Context,
  deps: ConversationRouteDeps,
  ws: ReturnType<typeof getWorkspace>,
  args: {
    agentId: string;
    conversation: ConversationRow;
    clientTurnId: string;
    currentMessageId: string | null;
    userMessage: string;
    useViewportContext: boolean;
    viewportOverride?: ViewportContext | null;
  },
  reg: ReturnType<AdapterManager['get']>,
) {
  {
    const turnStartedAtMs = Date.now();
    const turnStartedAt = new Date(turnStartedAtMs).toISOString();
    let finalText = '';
    let finishReason: Extract<ChatDelta, { type: 'done' }>['finishReason'] = 'stop';
    let adapterError: string | null = null;
    const streamedMetadata = createStreamedChatMetadata(args.clientTurnId, turnStartedAt);
    const activeViewport = args.useViewportContext
      ? args.viewportOverride ?? deps.viewportStore?.get(ws.user.id) ?? null
      : args.viewportOverride ?? null;
    const viewportWorkflowId = workflowIdFromViewport(activeViewport);
    // Resolve the sticky permission mode for this turn. A leading slash command
    // (/ask /plan /auto) overrides AND persists the conversation mode; otherwise
    // the conversation's stored mode applies (default ask).
    const modeCommand = parseModeCommand(args.userMessage);
    const storedMode = ((args.conversation.permissionMode as ChatPermissionMode | null) ?? 'ask');
    const permissionMode: ChatPermissionMode = modeCommand?.mode ?? storedMode;
    if (modeCommand) {
      deps.db.update(schema.conversations)
        .set({
          permissionMode: modeCommand.mode,
          executionMode: modeCommand.mode === 'plan' ? 'plan' : 'chat',
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.conversations.id, args.conversation.id))
        .run();
    }
    // A bare mode command (no task) just switches mode and acknowledges — no model
    // turn. With a task ("/plan build X") it switches AND runs the remaining text.
    const bareModeSwitch = Boolean(modeCommand) && !modeCommand!.rest;
    const runtimeUserMessage = modeCommand
      ? (modeCommand.rest || defaultTaskForMode(permissionMode))
      : args.userMessage;

    await writeChatDelta(stream, deps, ws, args.agentId, args.conversation.id, args.clientTurnId, createChatActivity({
      clientTurnId: args.clientTurnId,
      agentId: args.agentId,
      workflowId: viewportWorkflowId,
      phase: 'received',
      label: 'Request received',
      detail: 'The agent accepted the chat turn.',
      suffix: 'received',
      startedAt: turnStartedAt,
    }), streamedMetadata);

    if (bareModeSwitch) {
      finalText = MODE_SWITCH_ACK[permissionMode];
      await writeChatDelta(stream, deps, ws, args.agentId, args.conversation.id, args.clientTurnId, {
        type: 'text',
        delta: finalText,
      }, streamedMetadata);
    } else if (reg?.adapter?.chat) {
      const history = conversationHistoryForTurn(deps, args.conversation.id, args.currentMessageId);
      const turnContext: ChatTurnContext = {
        workspaceId: ws.workspaceId,
        ambientId: ws.ambientId,
        agentId: args.agentId,
        userId: ws.user.id,
        conversationId: args.conversation.id,
        clientTurnId: args.clientTurnId,
        executionMode: permissionMode === 'plan' ? 'plan' : 'chat',
        permissionMode,
        maxTurns: 8,
        viewport: activeViewport,
        signal: c.req.raw.signal,
      };
      for await (const delta of withChatHeartbeats(
        ChatSessionExecutor.turn(reg.adapter, history, runtimeUserMessage, turnContext, {
          ...(permissionMode === 'plan' ? { systemAddendum: PLAN_MODE_SYSTEM_ADDENDUM } : {}),
        }),
        { clientTurnId: args.clientTurnId, agentId: args.agentId, workflowId: viewportWorkflowId },
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
        await writeChatDelta(stream, deps, ws, args.agentId, args.conversation.id, args.clientTurnId, delta, streamedMetadata);
        if (delta.type === 'text') finalText += delta.delta;
      }
    } else {
      const limitation = reg?.adapter?.capabilities?.().limitations?.[0];
      finalText = limitation
        ?? 'This agent is not connected to an interactive chat harness yet. Configure a V1 harness, then try again.';
      finishReason = 'error';
      adapterError = finalText;
      await writeChatDelta(stream, deps, ws, args.agentId, args.conversation.id, args.clientTurnId, {
        type: 'activity',
        id: `activity-${args.clientTurnId}-no-chat`,
        phase: 'error',
        status: 'error',
        label: 'Interactive chat unavailable',
        detail: finalText,
        clientTurnId: args.clientTurnId,
        agentId: args.agentId,
      }, streamedMetadata);
      await writeChatDelta(stream, deps, ws, args.agentId, args.conversation.id, args.clientTurnId, { type: 'text', delta: finalText }, streamedMetadata);
    }

    if (!finalText.trim() && !streamedMetadata.confirmation) {
      if (finishReason === 'error') {
        finalText = relevantTurnError(streamedMetadata, adapterError);
      } else {
        finishReason = 'error';
        finalText = 'The runtime completed without returning an answer. The turn was stopped so you can retry without wondering whether it is still running.';
      }
    }

    // Backstop: a plan-mode turn that wrote a plan but skipped/malformed the
    // architecture_canvas on a design-shaped request gets one cheap repair
    // completion so ChatPlanCanvas still renders the visual graph, not just text.
    if (permissionMode === 'plan' && finishReason !== 'error' && reg?.adapter) {
      finalText = await repairArchitectureCanvas(reg.adapter, finalText, runtimeUserMessage, c.req.raw.signal).catch(() => finalText);
    }

    const turnCompletedAt = new Date().toISOString();
    const durationMs = Math.max(0, Date.now() - turnStartedAtMs);
    finalizeTurnTrace(streamedMetadata, finishReason, turnCompletedAt, durationMs);
    const failed = streamedMetadata.turn.status === 'failed';
    const stopped = streamedMetadata.turn.status === 'stopped';
    await writeChatDelta(stream, deps, ws, args.agentId, args.conversation.id, args.clientTurnId, createChatActivity({
      clientTurnId: args.clientTurnId,
      agentId: args.agentId,
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
        conversationId: args.conversation.id,
        sessionMessageId: `chat_${randomUUID()}`,
        authorType: 'agent',
        body: bodyToSave,
        deliveryStatus: failed ? 'failed' : 'delivered',
        metadata: buildPersistedChatMetadata('chat_loop', streamedMetadata, args.clientTurnId),
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
      conversationId: args.conversation.id,
      userId: ws.user.id,
      agentId: args.agentId,
      userDisplayName: ws.user.displayName,
      userMessage: args.userMessage,
      assistantMessage: finalText.trim() || null,
      finishReason,
      activeWorkflowId: viewportWorkflowId,
      activeNodeId: activeViewport?.selection?.ids?.[0] ?? null,
    });
    // BRAIN-BLUEPRINT-10X §visibility — the STORE half of the legible mind (the
    // recall half is the executor's "Recalled N memories"). `signals` counts the
    // learnings queued through the PRIMARY formation path (judge dedupes/rejects);
    // the old condition ignored it, so exactly the turns that learned showed
    // nothing — why the mind felt dead. The stream is still open here (`done` is
    // written below), so the operator sees it in the turn itself.
    if (
      capture &&
      (capture.signals > 0 || capture.peerUpdateJobIds.length > 0 || capture.promotedSessionMoments > 0 || capture.workspaceMemoryIds.length > 0)
    ) {
      const stored = Math.max(capture.signals, capture.workspaceMemoryIds.length);
      if (stored > 0) {
        const storedAt = new Date().toISOString();
        await writeChatDelta(stream, deps, ws, args.agentId, args.conversation.id, args.clientTurnId, createChatActivity({
          clientTurnId: args.clientTurnId,
          agentId: args.agentId,
          phase: 'complete',
          status: 'success',
          label: `Storing ${stored} ${stored === 1 ? 'memory' : 'memories'}`,
          detail: 'Learnings from this turn were queued into the Brain — the formation judge reconciles duplicates and rejects junk.',
          suffix: 'memory-store',
          startedAt: storedAt,
          completedAt: storedAt,
        }), streamedMetadata);
      }
      publishAgentWorkStep(deps.bus, {
        workspaceId: ws.workspaceId,
        ambientId: ws.ambientId,
        agentId: args.agentId,
        conversationId: args.conversation.id,
        clientTurnId: args.clientTurnId,
        phase: 'complete',
        description: 'Learning from this conversation (updating memory in the background)',
        at: new Date().toISOString(),
      });
    }

    await writeChatDelta(
      stream,
      deps,
      ws,
      args.agentId,
      args.conversation.id,
      args.clientTurnId,
      { type: 'done', finishReason },
      streamedMetadata,
    );
    await stream.writeSSE({ event: 'done', data: JSON.stringify({ finishReason }) });
  }
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
  // Composer toggle: persist the sticky permission mode with this turn so the
  // executor (and the next turn) honor it. The conversation row is read again in
  // streamConversationTurnReply, so update the in-memory copy too.
  if (body.permissionMode && body.permissionMode !== conversation.permissionMode) {
    deps.db.update(schema.conversations)
      .set({
        permissionMode: body.permissionMode,
        executionMode: body.permissionMode === 'plan' ? 'plan' : 'chat',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.conversations.id, conversation.id))
      .run();
    conversation.permissionMode = body.permissionMode;
  }

  // Explicit corrections are durable before the agent begins work (and even
  // when this message must wait behind another active turn).
  captureImmediateConversationCorrection(deps, ws, {
    agentId,
    conversationId: conversation.id,
    userMessage: body.body,
    useViewportContext: body.useViewportContext,
    viewportOverride: body.viewportOverride as ViewportContext | null | undefined,
  });

  // Queue-then-auto-continue: a turn is already streaming for this
  // conversation (chat, channel dispatcher, or another tab). Rather than race
  // a second live turn, durably queue this send — `streamConversationTurnReply`
  // auto-dispatches it, oldest first, the moment the in-flight turn ends. This
  // check is independent of the request's Accept header: the frontend calls
  // this same endpoint without opening an SSE stream while a turn is active.
  if (activeConversationTurns.has(conversation.id)) {
    const item = deps.conversations.enqueueMessage({
      workspaceId: ws.workspaceId,
      conversationId: conversation.id,
      text: body.body,
    });
    return c.json({ queued: true, item: serializeQueueItem(item), conversationId: conversation.id, agentId }, 202);
  }

  const message = deps.conversations.appendOutbound({
    workspaceId: ws.workspaceId,
    conversationId: conversation.id,
    operatorId: ws.user.id,
    body: body.body,
    metadata: { clientTurnId },
  });
  if (c.req.header('accept')?.includes('text/event-stream')) {
    return streamConversationTurnReply(c, deps, ws, {
      agentId,
      conversation,
      clientTurnId,
      currentMessageId: message.id,
      userMessage: body.body,
      useViewportContext: body.useViewportContext,
      viewportOverride: body.viewportOverride as ViewportContext | null | undefined,
    });
  }
  const reg = deps.adapters.get(agentId);

  if (reg?.adapter instanceof OpenClawAdapter) {
    await relayOpenClaw(deps, reg.adapter, conversation.mirroredSessionId ?? undefined, body.body, agentId);
  }
  return c.json({ message, conversationId: conversation.id, agentId });
}

function captureImmediateConversationCorrection(
  deps: ConversationRouteDeps,
  ws: ReturnType<typeof getWorkspace>,
  args: {
    agentId: string;
    conversationId: string;
    userMessage: string;
    useViewportContext: boolean;
    viewportOverride?: ViewportContext | null;
  },
): void {
  const activeViewport = args.useViewportContext
    ? args.viewportOverride ?? deps.viewportStore?.get(ws.user.id) ?? null
    : args.viewportOverride ?? null;
  deps.memoryCapture?.captureImmediateCorrection?.({
    workspaceId: ws.workspaceId,
    conversationId: args.conversationId,
    userId: ws.user.id,
    agentId: args.agentId,
    userDisplayName: ws.user.displayName,
    userMessage: args.userMessage,
    activeWorkflowId: workflowIdFromViewport(activeViewport),
    activeNodeId: activeViewport?.selection?.ids?.[0] ?? null,
  });
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







