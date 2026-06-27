/**
 * ChannelTurnDispatcher — inbound channel message → real orchestrator turn →
 * reply delivered back to the channel (OMNICHANNEL-ORCHESTRATOR-10X §3.3).
 *
 * Also covers the end-to-end wiring: ChannelBridge.handleInbound fires the
 * dispatcher, and the orchestrator's reply reaches adapter.send.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { REALTIME_EVENTS, REALTIME_ROOMS, type AgentAdapter, type ChatDelta, type ChatMessage } from '@agentis/core';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import { ConversationStore } from '../../src/services/conversationStore.js';
import { ChannelBridge } from '../../src/services/channelBridge.js';
import { ChannelTurnDispatcher, interpretConfirmation } from '../../src/services/channelTurnDispatcher.js';
import { AppStore } from '@agentis/app';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import type { ChannelAdapter, ParsedInboundMessage } from '../../src/adapters/channels/types.js';

/** A chat-capable adapter stub — only `.chat`/`.capabilities` are exercised. */
function chatStub(reply: string): AgentAdapter {
  return {
    capabilities: () => ({ interactiveChat: true }),
    async *chat(): AsyncIterable<ChatDelta> {
      yield { type: 'text', delta: reply };
      yield { type: 'done', finishReason: 'stop' };
    },
  } as unknown as AgentAdapter;
}

function seedAgent(ctx: TestContext) {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({
    id,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    name: 'Orchestrator',
    adapterType: 'http',
  }).run();
  return id;
}

describe('ChannelTurnDispatcher', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestContext(); });
  afterEach(() => ctx.close());

  it('runs a turn, persists the reply as an agent message, and delivers it', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
    });

    const delivered: Array<{ connectionId: string; chatId: string; body: string }> = [];
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db,
      adapters: new AdapterManager(ctx.logger),
      conversations,
      logger: ctx.logger,
      deliver: async (args) => { delivered.push(args); },
      fallbackAdapter: () => chatStub('Hello from the orchestrator.'),
    });

    const result = await dispatcher.dispatch({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      agentId,
      conversationId: conv.id,
      connectionId: 'conn-1',
      kind: 'telegram',
      chatId: '999',
      text: 'hi',
    });

    expect(result.replied).toBe(true);
    expect(delivered).toEqual([{ connectionId: 'conn-1', chatId: '999', body: 'Hello from the orchestrator.' }]);

    const messages = conversations.messages(conv.id, 50);
    const agentMsg = messages.find((m) => m.authorType === 'agent');
    expect(agentMsg?.body).toBe('Hello from the orchestrator.');
    expect((agentMsg?.metadata as { channelReply?: boolean })?.channelReply).toBe(true);
  });

  it('publishes channel turn progress into the workspace activity feed', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
    });
    const cap = ctx.captureBus();
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db,
      adapters: new AdapterManager(ctx.logger),
      conversations,
      logger: ctx.logger,
      bus: ctx.bus,
      deliver: async () => {},
      fallbackAdapter: () => chatStub('unused'),
      runTurn: async function* () {
        yield {
          type: 'activity',
          id: 'activity-channel-runtime',
          phase: 'runtime',
          status: 'running',
          label: 'Waiting for model output',
        } as ChatDelta;
        yield { type: 'tool_call', id: 'tool-1', name: 'agentis.lookup', args: { q: 'status' } } as ChatDelta;
        yield { type: 'tool_result', id: 'tool-1', name: 'agentis.lookup', result: { ok: true } } as ChatDelta;
        yield { type: 'text', delta: 'ok' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof import('../../src/services/chatSessionExecutor.js').ChatSessionExecutor.turn,
    });

    await dispatcher.dispatch({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      agentId,
      conversationId: conv.id,
      connectionId: 'conn-1',
      kind: 'telegram',
      chatId: '999',
      text: 'hi',
    });
    cap.stop();

    const workSteps = cap.events
      .filter((event) => event.envelope.event === REALTIME_EVENTS.AGENT_WORK_STEP)
      .map((event) => event.envelope.payload as { conversationId?: string; description?: string; phase?: string });
    expect(workSteps.some((event) => event.conversationId === conv.id && /Telegram message received/.test(event.description ?? ''))).toBe(true);
    expect(workSteps.some((event) => event.conversationId === conv.id && /Waiting for model output/.test(event.description ?? ''))).toBe(true);
    expect(workSteps.some((event) => event.conversationId === conv.id && /agentis.lookup completed/.test(event.description ?? ''))).toBe(true);
  });

  it('persists and delivers a credit/quota failure notice instead of going silent', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
    });
    const delivered: string[] = [];
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db,
      adapters: new AdapterManager(ctx.logger),
      conversations,
      logger: ctx.logger,
      bus: ctx.bus,
      deliver: async (args) => { delivered.push(args.body); },
      fallbackAdapter: () => chatStub('unused'),
      runTurn: async function* () {
        throw new Error('insufficient_quota: out of credits');
      } as unknown as typeof import('../../src/services/chatSessionExecutor.js').ChatSessionExecutor.turn,
    });

    const result = await dispatcher.dispatch({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      agentId,
      conversationId: conv.id,
      connectionId: 'conn-1',
      kind: 'telegram',
      chatId: '999',
      text: 'hi',
    });

    expect(result).toEqual({ replied: true, reason: 'error_notified' });
    expect(delivered[0]).toMatch(/out of credits|quota/i);
    const messages = conversations.messages(conv.id, 50);
    const failure = messages.find((message) => message.authorType === 'agent' && /out of credits|quota/i.test(message.body));
    expect(failure?.deliveryStatus).toBe('failed');
  });

  it('maps prior channel-inbound system messages to user role in history', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
    });
    // Prior turn: a channel-inbound human message + an agent reply.
    conversations.appendMirrored({
      workspaceId: ctx.workspace.id, conversationId: conv.id, sessionMessageId: 'ext-1',
      authorType: 'system', body: 'earlier question', metadata: { channelInbound: true },
    });
    conversations.appendMirrored({
      workspaceId: ctx.workspace.id, conversationId: conv.id, sessionMessageId: 'reply-1',
      authorType: 'agent', body: 'earlier answer',
    });

    let captured: ChatMessage[] = [];
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db,
      adapters: new AdapterManager(ctx.logger),
      conversations,
      logger: ctx.logger,
      deliver: async () => {},
      fallbackAdapter: () => chatStub('ok'),
      runTurn: async function* (_adapter, history) {
        captured = history;
        yield { type: 'text', delta: 'ok' };
        yield { type: 'done', finishReason: 'stop' };
      } as unknown as typeof import('../../src/services/chatSessionExecutor.js').ChatSessionExecutor.turn,
    });

    await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, conversationId: conv.id, connectionId: 'c', kind: 'telegram', chatId: '1', text: 'follow up',
    });

    expect(captured).toEqual([
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
    ]);
  });

  it('scopes turn history to the active thread (subject isolation)', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
    });
    // Two prior human turns in two different threads of the same conversation.
    conversations.appendMirrored({
      workspaceId: ctx.workspace.id, conversationId: conv.id, sessionMessageId: 'tA-1',
      authorType: 'system', body: 'about the budget', metadata: { channelInbound: true, threadId: 'chan:A' },
    });
    conversations.appendMirrored({
      workspaceId: ctx.workspace.id, conversationId: conv.id, sessionMessageId: 'tB-1',
      authorType: 'system', body: 'about the deploy', metadata: { channelInbound: true, threadId: 'chan:B' },
    });

    let captured: ChatMessage[] = [];
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db, adapters: new AdapterManager(ctx.logger), conversations, logger: ctx.logger,
      deliver: async () => {}, fallbackAdapter: () => chatStub('ok'),
      runTurn: async function* (_a, history) {
        captured = history;
        yield { type: 'text', delta: 'ok' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof import('../../src/services/chatSessionExecutor.js').ChatSessionExecutor.turn,
    });

    await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, conversationId: conv.id, connectionId: 'c', kind: 'slack', chatId: 'chan:thread:A',
      threadId: 'chan:A', text: 'follow up on budget',
    });

    // Only the thread-A message survives; thread-B is excluded.
    expect(captured).toEqual([{ role: 'user', content: 'about the budget' }]);
  });

  it('delivers a not-connected notice when no chat adapter is available', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
    });
    const delivered: string[] = [];
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db,
      adapters: new AdapterManager(ctx.logger),
      conversations,
      logger: ctx.logger,
      deliver: async (a) => { delivered.push(a.body); },
      fallbackAdapter: () => undefined,
    });
    const result = await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, conversationId: conv.id, connectionId: 'c', kind: 'telegram', chatId: '1', text: 'hi',
    });
    expect(result.replied).toBe(false);
    expect(result.reason).toBe('no_chat_adapter');
    expect(delivered[0]).toMatch(/not connected to an interactive runtime/);
  });

  it('stays quiet when an operator has taken over the thread (Living Apps Phase 2)', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
    });
    // Operator took over: park the agent.
    ctx.db.update(schema.conversations).set({ handoffState: 'human' }).where(eq(schema.conversations.id, conv.id)).run();

    let turnRan = false;
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db, adapters: new AdapterManager(ctx.logger), conversations, logger: ctx.logger,
      deliver: async () => {}, fallbackAdapter: () => chatStub('should not run'),
      runTurn: async function* () { turnRan = true; yield { type: 'done', finishReason: 'stop' } as ChatDelta; } as unknown as typeof import('../../src/services/chatSessionExecutor.js').ChatSessionExecutor.turn,
    });

    const result = await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, conversationId: conv.id, connectionId: 'c', kind: 'telegram', chatId: '1', text: 'hi',
    });

    expect(turnRan).toBe(false);
    expect(result).toEqual({ replied: false, reason: 'human_handling' });
  });

  it('runs an App-bound channel turn in App context (Living Apps Phase 0)', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const app = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Acme Sales' });

    // A channel connection bound to the App.
    const connId = randomUUID();
    ctx.db.insert(schema.channelConnections).values({
      id: connId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      agentId,
      appId: app.id,
      kind: 'telegram',
      name: 'Acme line',
      tokenEncrypted: 'x',
    }).run();

    // The channel-bound conversation adopts the App.
    const conv = conversations.getOrCreateByChannel({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, channelConnectionId: connId, channelChatId: '42', appId: app.id,
    });
    expect((conv as { appId?: string | null }).appId).toBe(app.id);

    let capturedCtx: { appId?: string | null } | null = null;
    let capturedOptions: { systemAddendum?: string } | null = null;
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db, adapters: new AdapterManager(ctx.logger), conversations, logger: ctx.logger,
      deliver: async () => {}, fallbackAdapter: () => chatStub('ok'),
      runTurn: async function* (_a, _h, _t, c, o) {
        capturedCtx = c as { appId?: string | null };
        capturedOptions = (o ?? null) as { systemAddendum?: string } | null;
        yield { type: 'text', delta: 'ok' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof import('../../src/services/chatSessionExecutor.js').ChatSessionExecutor.turn,
    });

    await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, appId: app.id, conversationId: conv.id, connectionId: connId, kind: 'telegram', chatId: '42', text: 'hi',
    });

    // The turn carries the App in context (so data_insert resolves to it)…
    expect(capturedCtx?.appId).toBe(app.id);
    // …and the resident-agent operating doctrine is injected, naming the App.
    expect(capturedOptions?.systemAddendum ?? '').toMatch(/Acme Sales/);
    expect(capturedOptions?.systemAddendum ?? '').toMatch(/data_insert|datastore/);
  });

  it('withholds an App-bound reply that hits a blocked claim, and holds an approval-gated reply (G7)', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const app = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Acme Sales' });
    // Policy: never promise a refund; price talk needs approval.
    ctx.db.update(schema.apps).set({
      policyJson: { audience: [], shareable: false, customCode: 'disabled', grants: [], outbound: { blockedClaims: ['refund'], requireApprovalFor: ['discount'] } },
    }).where(eq(schema.apps.id, app.id)).run();

    const connId = randomUUID();
    ctx.db.insert(schema.channelConnections).values({
      id: connId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, appId: app.id, kind: 'telegram', name: 'Acme line', tokenEncrypted: 'x',
    }).run();
    const conv = conversations.getOrCreateByChannel({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, channelConnectionId: connId, channelChatId: '42', appId: app.id,
    });

    const { OutboundPolicyService } = await import('../../src/services/outboundPolicy.js');
    const outboundPolicy = new OutboundPolicyService({ db: ctx.db, logger: ctx.logger });
    const delivered: string[] = [];
    const approvals: Array<{ body: string; reason: string }> = [];
    let replyText = '';
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db, adapters: new AdapterManager(ctx.logger), conversations, logger: ctx.logger,
      deliver: async (a) => { delivered.push(a.body); },
      fallbackAdapter: () => chatStub('placeholder'),
      outboundPolicy,
      requestOutboundApproval: async (a) => { approvals.push({ body: a.body, reason: a.reason }); return true; },
      runTurn: async function* () {
        yield { type: 'text', delta: replyText } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof import('../../src/services/chatSessionExecutor.js').ChatSessionExecutor.turn,
    });

    // 1) A blocked-claim reply is WITHHELD — nothing reaches the channel.
    replyText = 'Yes, we offer a full refund anytime.';
    const blocked = await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, appId: app.id, conversationId: conv.id, connectionId: connId, kind: 'telegram', chatId: '42', text: 'can I get a refund?',
    });
    expect(blocked).toMatchObject({ replied: false, reason: 'blocked_claim' });
    expect(delivered).toHaveLength(0);
    expect(approvals).toHaveLength(0);

    // 2) An approval-gated reply is HELD for the operator, not delivered.
    replyText = 'I can offer you a 10% discount.';
    const held = await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, appId: app.id, conversationId: conv.id, connectionId: connId, kind: 'telegram', chatId: '42', text: 'any deal?',
    });
    expect(held).toMatchObject({ replied: false, reason: 'held_for_approval' });
    expect(delivered).toHaveLength(0);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.body).toMatch(/discount/);

    // 3) A clean reply goes out normally + is recorded against the counter.
    replyText = 'Sure, here is the brochure.';
    const ok = await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, appId: app.id, conversationId: conv.id, connectionId: connId, kind: 'telegram', chatId: '42', text: 'tell me more',
    });
    expect(ok.replied).toBe(true);
    expect(delivered).toEqual(['Sure, here is the brochure.']);
    const rows = ctx.db.select().from(schema.appOutboundLog).where(eq(schema.appOutboundLog.appId, app.id)).all();
    expect(rows).toHaveLength(1); // only the delivered reply counted
  });

  it('surfaces resident-agent activity in the App console on an App-bound turn (G9 co-presence)', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const app = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Acme Sales' });
    const connId = randomUUID();
    ctx.db.insert(schema.channelConnections).values({
      id: connId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, appId: app.id, kind: 'telegram', name: 'Acme line', tokenEncrypted: 'x',
    }).run();
    const conv = conversations.getOrCreateByChannel({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, channelConnectionId: connId, channelChatId: '42', appId: app.id,
    });

    const activity: Array<{ room: string; payload: { state?: string; conversationId?: string; appId?: string } }> = [];
    const unsub = ctx.bus.subscribe(({ room, envelope }) => {
      if (envelope.event === REALTIME_EVENTS.APP_AGENT_ACTIVITY) {
        activity.push({ room, payload: envelope.payload as { state?: string } });
      }
    });

    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db, adapters: new AdapterManager(ctx.logger), conversations, logger: ctx.logger, bus: ctx.bus,
      deliver: async () => {}, fallbackAdapter: () => chatStub('ok'),
      runTurn: async function* () {
        yield { type: 'thinking', delta: 'weighing the discount' } as ChatDelta;
        yield { type: 'text', delta: 'ok' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof import('../../src/services/chatSessionExecutor.js').ChatSessionExecutor.turn,
    });

    await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, appId: app.id, conversationId: conv.id, connectionId: connId, kind: 'telegram', chatId: '42', text: 'hi',
    });
    unsub();

    const states = activity.map((a) => a.payload.state);
    // thinking → typing while the turn runs, then idle to clear the indicator.
    expect(states).toContain('thinking');
    expect(states).toContain('typing');
    expect(states[states.length - 1]).toBe('idle');
    // Every activity event is scoped to this App + thread and dual-published to the App room.
    expect(activity.every((a) => a.payload.appId === app.id && a.payload.conversationId === conv.id)).toBe(true);
    expect(activity.some((a) => a.room === REALTIME_ROOMS.app(app.id))).toBe(true);
  });

  it('does NOT emit App console activity for a non-App channel turn', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const connId = randomUUID();
    ctx.db.insert(schema.channelConnections).values({
      id: connId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, kind: 'telegram', name: 'Plain line', tokenEncrypted: 'x',
    }).run();
    const conv = conversations.getOrCreateByChannel({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, channelConnectionId: connId, channelChatId: '43',
    });
    let activityCount = 0;
    const unsub = ctx.bus.subscribe(({ envelope }) => {
      if (envelope.event === REALTIME_EVENTS.APP_AGENT_ACTIVITY) activityCount += 1;
    });
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db, adapters: new AdapterManager(ctx.logger), conversations, logger: ctx.logger, bus: ctx.bus,
      deliver: async () => {}, fallbackAdapter: () => chatStub('ok'),
      runTurn: async function* () {
        yield { type: 'thinking', delta: 'hmm' } as ChatDelta;
        yield { type: 'text', delta: 'ok' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof import('../../src/services/chatSessionExecutor.js').ChatSessionExecutor.turn,
    });
    await dispatcher.dispatch({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, conversationId: conv.id, connectionId: connId, kind: 'telegram', chatId: '43', text: 'hi',
    });
    unsub();
    expect(activityCount).toBe(0);
  });

  it('channel-delivered confirmation: prompts yes/no, then resolves on the next reply', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
    });
    const delivered: string[] = [];
    const confirmCalls: Array<{ turnId: string; confirmed: boolean }> = [];

    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db,
      adapters: new AdapterManager(ctx.logger),
      conversations,
      logger: ctx.logger,
      deliver: async (a) => { delivered.push(a.body); },
      fallbackAdapter: () => chatStub('unused'),
      // First turn asks for confirmation.
      runTurn: async function* () {
        yield { type: 'confirmation_required', turnId: 't-99', toolCall: { id: 'x', name: 'agentis.run.cancel', args: {} }, title: 'Cancel run?', body: 'This stops run r1.', confirmLabel: 'Cancel run', cancelLabel: 'Cancel', expiresAt: new Date(Date.now() + 60000).toISOString() } as unknown as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof import('../../src/services/chatSessionExecutor.js').ChatSessionExecutor.turn,
      runConfirm: async function* (_adapter, turnId, confirmed) {
        confirmCalls.push({ turnId, confirmed });
        yield { type: 'text', delta: confirmed ? 'Run cancelled.' : 'Left it running.' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof import('../../src/services/chatSessionExecutor.js').ChatSessionExecutor.confirm,
    });

    const base = {
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, conversationId: conv.id, connectionId: 'c1', kind: 'telegram', chatId: '42',
    };
    // Turn 1: triggers a confirmation prompt.
    await dispatcher.dispatch({ ...base, text: 'stop the run' });
    expect(delivered[0]).toContain('Cancel run?');
    expect(delivered[0]).toContain('Reply "yes" to confirm');
    expect(confirmCalls).toHaveLength(0);

    // Turn 2: "yes" resolves the pending confirmation.
    await dispatcher.dispatch({ ...base, text: 'yes' });
    expect(confirmCalls).toEqual([{ turnId: 't-99', confirmed: true }]);
    expect(delivered[1]).toBe('Run cancelled.');
  });

  it('debounces rapid-fire messages into a single turn with combined text', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const agentId = seedAgent(ctx);
    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId,
    });
    // Two inbound messages already persisted (as the bridge would) before dispatch.
    const m1 = conversations.appendMirrored({
      workspaceId: ctx.workspace.id, conversationId: conv.id, sessionMessageId: 'i1',
      authorType: 'system', body: 'first', metadata: { channelInbound: true },
    });
    const m2 = conversations.appendMirrored({
      workspaceId: ctx.workspace.id, conversationId: conv.id, sessionMessageId: 'i2',
      authorType: 'system', body: 'second', metadata: { channelInbound: true },
    });

    const turns: Array<{ text: string; history: ChatMessage[] }> = [];
    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db, adapters: new AdapterManager(ctx.logger), conversations, logger: ctx.logger,
      deliver: async () => {}, fallbackAdapter: () => chatStub('ok'), debounceMs: 40,
      runTurn: async function* (_a, history, userMessage) {
        turns.push({ text: userMessage as string, history });
        yield { type: 'text', delta: 'ok' } as ChatDelta;
        yield { type: 'done', finishReason: 'stop' } as ChatDelta;
      } as unknown as typeof import('../../src/services/chatSessionExecutor.js').ChatSessionExecutor.turn,
    });

    const base = {
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      agentId, conversationId: conv.id, connectionId: 'c', kind: 'telegram', chatId: '1',
    };
    await dispatcher.dispatch({ ...base, text: 'first', inboundMessageId: m1.id });
    await dispatcher.dispatch({ ...base, text: 'second', inboundMessageId: m2.id });
    await new Promise((r) => setTimeout(r, 90));

    // Exactly one turn, combined text, and both inbound messages excluded from history.
    expect(turns).toHaveLength(1);
    expect(turns[0]!.text).toBe('first\nsecond');
    expect(turns[0]!.history).toEqual([]);
  });

  it('interpretConfirmation maps affirmatives/negatives, null otherwise', () => {
    for (const yes of ['yes', 'Y', 'approve', 'ok', 'do it', '👍', 'sim']) expect(interpretConfirmation(yes)).toBe(true);
    for (const no of ['no', 'cancel', 'stop', 'reject', '👎', 'não']) expect(interpretConfirmation(no)).toBe(false);
    for (const other of ['build me a workflow', 'maybe later', 'what runs are active?']) expect(interpretConfirmation(other)).toBeNull();
  });

  it('end-to-end: ChannelBridge.handleInbound fires the turn and the reply is sent', async () => {
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const sent: Array<{ chatId: string; body: string }> = [];
    const channelAdapter: ChannelAdapter = {
      kind: 'telegram',
      async send(args) { sent.push({ chatId: args.chatId, body: args.body }); },
      verify: () => true,
      parseInbound: (): ParsedInboundMessage => ({ externalId: 'u1', chatId: '777', body: 'ping', from: 'Bob' }),
    };
    const bridge = new ChannelBridge({
      db: ctx.db, vault: ctx.vault, conversations, bus: ctx.bus, logger: ctx.logger,
      adapters: { telegram: channelAdapter },
    });
    const agentId = seedAgent(ctx);
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      agentId, kind: 'telegram', name: 'tg', token: 'tok',
    });

    const dispatcher = new ChannelTurnDispatcher({
      db: ctx.db,
      adapters: new AdapterManager(ctx.logger),
      conversations,
      logger: ctx.logger,
      deliver: (args) => bridge.deliverToConnection(args),
      fallbackAdapter: () => chatStub('pong'),
    });
    bridge.setTurnDispatcher(dispatcher);

    await bridge.handleInbound({ connectionId: connection.id, headers: {}, rawBody: '{}' });
    // Dispatcher runs fire-and-forget; drain microtasks.
    await new Promise((r) => setTimeout(r, 20));

    expect(sent).toEqual([{ chatId: '777', body: 'pong' }]);
    const conv = conversations.list(ctx.workspace.id)[0]!;
    const messages = conversations.messages(conv.id, 50);
    // inbound (system) + reply (agent)
    expect(messages.some((m) => m.authorType === 'system' && m.body.includes('ping'))).toBe(true);
    expect(messages.some((m) => m.authorType === 'agent' && m.body === 'pong')).toBe(true);
  });
});
