/**
 * ConversationParticipantService + dispatcher warm-handoff routing
 * (LIVING-APPS-10X Phase 2 · G1, migration v98).
 *
 * Covers the multi-party thread layer that sits beside conversations.agentId (the
 * singular primary): add/remove/list participants, the backfill that seeds the
 * primary, and the dispatcher routing an inbound turn to an active specialist —
 * while human-takeover still parks all agents.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import type { AgentAdapter, ChatDelta, ChatTurnContext } from '@agentis/core';
import { eq } from 'drizzle-orm';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import { ConversationStore } from '../../src/services/conversationStore.js';
import { ConversationParticipantService } from '../../src/services/conversationParticipants.js';
import { ChannelTurnDispatcher } from '../../src/services/channelTurnDispatcher.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';

function chatStub(reply: string): AgentAdapter {
  return {
    capabilities: () => ({ interactiveChat: true }),
    async *chat(): AsyncIterable<ChatDelta> {
      yield { type: 'text', delta: reply };
      yield { type: 'done', finishReason: 'stop' };
    },
  } as unknown as AgentAdapter;
}

function seedAgent(ctx: TestContext, name = 'Agent'): string {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({
    id,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    name,
    adapterType: 'http',
  }).run();
  return id;
}

describe('ConversationParticipantService', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestContext(); });
  afterEach(() => ctx.close());

  it('seeds the primary from conversations.agentId, then adds/lists/removes a specialist', () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const primaryAgent = seedAgent(ctx, 'Resident');
    const specialistAgent = seedAgent(ctx, 'Specialist');
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId: primaryAgent,
    });
    const svc = new ConversationParticipantService(ctx.db);

    // ensurePrimary is idempotent — two calls, still one primary.
    expect(svc.ensurePrimary(conv.id)).toBeTruthy();
    svc.ensurePrimary(conv.id);
    expect(svc.primaryAgent(conv.id)).toBe(primaryAgent);

    const specialistId = svc.add({
      conversationId: conv.id, participantType: 'agent', participantId: specialistAgent, role: 'specialist',
    });
    expect(specialistId).toBeTruthy();

    const list = svc.list(conv.id);
    expect(list.map((p) => p.role).sort()).toEqual(['primary', 'specialist']);
    expect(list.every((p) => p.active)).toBe(true);

    // Active responder picks the specialist over the primary (warm handoff).
    expect(svc.activeResponderAgent(conv.id, primaryAgent)).toBe(specialistAgent);

    // Remove (deactivate) the specialist → hands back to the primary.
    expect(svc.remove(conv.id, specialistId!)).toBe(true);
    expect(svc.activeResponderAgent(conv.id, primaryAgent)).toBe(primaryAgent);
    expect(svc.list(conv.id, { activeOnly: true }).map((p) => p.role)).toEqual(['primary']);
  });

  it('add is idempotent on (conversation, type, participant) and re-activates', () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agent = seedAgent(ctx);
    const specialist = seedAgent(ctx, 'Spec');
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId: agent,
    });
    const svc = new ConversationParticipantService(ctx.db);
    const first = svc.add({ conversationId: conv.id, participantType: 'agent', participantId: specialist, role: 'specialist' });
    const second = svc.add({ conversationId: conv.id, participantType: 'agent', participantId: specialist, role: 'specialist', active: false });
    expect(second).toBe(first);
    expect(svc.list(conv.id)).toHaveLength(1);
    const again = svc.add({ conversationId: conv.id, participantType: 'agent', participantId: specialist, role: 'specialist', active: true });
    expect(again).toBe(first);
    expect(svc.list(conv.id, { activeOnly: true })).toHaveLength(1);
  });

  it('supports a contact participant with a null participantId (external handle)', () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agent = seedAgent(ctx);
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId: agent,
    });
    const svc = new ConversationParticipantService(ctx.db);
    const id = svc.add({ conversationId: conv.id, participantType: 'contact', participantId: null, role: 'customer' });
    expect(id).toBeTruthy();
    const list = svc.list(conv.id);
    expect(list.find((p) => p.participantType === 'contact')?.role).toBe('customer');
  });
});

describe('ChannelTurnDispatcher · multi-party routing (G1)', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestContext(); });
  afterEach(() => ctx.close());

  it('routes the inbound turn to an active specialist agent (warm handoff)', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const primaryAgent = seedAgent(ctx, 'Resident');
    const specialistAgent = seedAgent(ctx, 'Specialist');
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId: primaryAgent,
    });
    const participants = new ConversationParticipantService(ctx.db);
    participants.ensurePrimary(conv.id);
    participants.add({ conversationId: conv.id, participantType: 'agent', participantId: specialistAgent, role: 'specialist' });

    let sawAgentId: string | null = null;
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db, adapters: new AdapterManager(ctx.logger), conversations, logger: ctx.logger,
      deliver: async () => {}, fallbackAdapter: () => chatStub('handled'),
      participants,
      runTurn: async function* (_adapter, _history, _text, turnCtx: ChatTurnContext) {
        sawAgentId = turnCtx.agentId;
        yield { type: 'text', delta: 'specialist reply' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof import('../../src/services/chatSessionExecutor.js').ChatSessionExecutor.turn,
    });

    const result = await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId: primaryAgent, conversationId: conv.id, connectionId: 'c', kind: 'telegram', chatId: '1', text: 'hi',
    });

    expect(result.replied).toBe(true);
    expect(sawAgentId).toBe(specialistAgent);
  });

  it('routes to the primary when no specialist is active', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const primaryAgent = seedAgent(ctx, 'Resident');
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId: primaryAgent,
    });
    const participants = new ConversationParticipantService(ctx.db);

    let sawAgentId: string | null = null;
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db, adapters: new AdapterManager(ctx.logger), conversations, logger: ctx.logger,
      deliver: async () => {}, fallbackAdapter: () => chatStub('handled'),
      participants,
      runTurn: async function* (_adapter, _history, _text, turnCtx: ChatTurnContext) {
        sawAgentId = turnCtx.agentId;
        yield { type: 'text', delta: 'primary reply' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof import('../../src/services/chatSessionExecutor.js').ChatSessionExecutor.turn,
    });

    await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId: primaryAgent, conversationId: conv.id, connectionId: 'c', kind: 'telegram', chatId: '1', text: 'hi',
    });

    expect(sawAgentId).toBe(primaryAgent);
    // The primary participant was seeded on the way in.
    expect(participants.primaryAgent(conv.id)).toBe(primaryAgent);
  });

  it('keeps human-takeover intact — an active specialist still stays quiet when a human drives', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const primaryAgent = seedAgent(ctx, 'Resident');
    const specialistAgent = seedAgent(ctx, 'Specialist');
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId: primaryAgent,
    });
    const participants = new ConversationParticipantService(ctx.db);
    participants.ensurePrimary(conv.id);
    participants.add({ conversationId: conv.id, participantType: 'agent', participantId: specialistAgent, role: 'specialist' });
    // Operator took over.
    ctx.db.update(schema.conversations).set({ handoffState: 'human' }).where(eq(schema.conversations.id, conv.id)).run();

    let turnRan = false;
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db, adapters: new AdapterManager(ctx.logger), conversations, logger: ctx.logger,
      deliver: async () => {}, fallbackAdapter: () => chatStub('should not run'),
      participants,
      runTurn: async function* () { turnRan = true; yield { type: 'done', finishReason: 'stop' } as ChatDelta; } as unknown as typeof import('../../src/services/chatSessionExecutor.js').ChatSessionExecutor.turn,
    });

    const result = await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId: primaryAgent, conversationId: conv.id, connectionId: 'c', kind: 'telegram', chatId: '1', text: 'hi',
    });

    expect(turnRan).toBe(false);
    expect(result).toEqual({ replied: false, reason: 'human_handling' });
  });
});
