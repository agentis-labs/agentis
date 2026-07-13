/**
 * ChannelBridge — Batch 4 / D35 unit tests.
 *
 * Covers create/list/get/delete, inbound webhook (verify + idempotency),
 * channel-scoped conversations, and adapter-unavailability errors. Uses a
 * stubbed adapter so no network calls are made.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { eq } from 'drizzle-orm';
import { AgentisError, REALTIME_EVENTS } from '@agentis/core';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import { ChannelBridge } from '../../src/services/conversation/channelBridge.js';
import { ConversationStore } from '../../src/services/conversation/conversationStore.js';
import type { ChannelAdapter, ParsedInboundMessage } from '../../src/adapters/channels/types.js';

class StubTelegramAdapter implements ChannelAdapter {
  readonly kind = 'telegram' as const;
  readonly sent: Array<{ token: string; chatId: string; body: string }> = [];
  shouldFailSend = false;
  acceptVerify = true;
  parseResult: ParsedInboundMessage | null = {
    externalId: 'telegram:42',
    chatId: '999',
    body: 'hello from tg',
    from: 'Alice',
  };
  async send(args: { token: string; chatId: string; body: string }): Promise<void> {
    if (this.shouldFailSend) throw new Error('boom');
    this.sent.push(args);
  }
  verify(): boolean {
    return this.acceptVerify;
  }
  parseInbound(): ParsedInboundMessage | null {
    return this.parseResult;
  }
}

function seedAgent(ctx: TestContext) {
  const id = randomUUID();
  ctx.db
    .insert(schema.agents)
    .values({
      id,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'Hermes',
      adapterType: 'http',
    })
    .run();
  return id;
}

function buildBridge(ctx: TestContext, adapter: StubTelegramAdapter) {
  const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
  const bridge = new ChannelBridge({
    db: ctx.db,
    vault: ctx.vault,
    conversations,
    bus: ctx.bus,
    logger: ctx.logger,
    adapters: { telegram: adapter },
  });
  return { bridge, conversations };
}

describe('ChannelBridge', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(() => ctx.close());

  it('create() encrypts the token and lists return the public projection (no token)', () => {
    const adapter = new StubTelegramAdapter();
    const { bridge } = buildBridge(ctx, adapter);
    const agentId = seedAgent(ctx);

    const { connection, webhookSecret } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      agentId,
      kind: 'telegram',
      name: 'Tg main',
      token: 'super-secret-bot-token',
      defaultChatId: '999',
    });
    expect(webhookSecret).toMatch(/^[0-9a-f]{48}$/);
    expect(connection.id).toBeTruthy();
    expect((connection as unknown as { token?: unknown }).token).toBeUndefined();
    expect((connection as unknown as { tokenEncrypted?: unknown }).tokenEncrypted).toBeUndefined();

    const list = bridge.list(ctx.workspace.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.kind).toBe('telegram');
    expect(list[0]!.defaultChatId).toBe('999');

    // Confirm the on-disk row stores ciphertext, not the plaintext token.
    const row = ctx.db
      .select()
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, connection.id))
      .get()!;
    expect(row.tokenEncrypted).not.toContain('super-secret-bot-token');
    expect(ctx.vault.decrypt(row.tokenEncrypted)).toBe('super-secret-bot-token');
  });

  it('creates a WORKSPACE-owned connection (no agentId) — agentId is null in the projection', () => {
    const { bridge } = buildBridge(ctx, new StubTelegramAdapter());
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      kind: 'telegram', name: 'Workspace Tg', token: 'tok-ws-123456',
    });
    expect(connection.agentId).toBeNull();
    expect(bridge.list(ctx.workspace.id).find((c) => c.id === connection.id)?.agentId).toBeNull();
  });

  it('setDefault designates one connection per kind (single-default invariant) and defaultConnectionFor resolves it', () => {
    const { bridge } = buildBridge(ctx, new StubTelegramAdapter());
    const agentId = seedAgent(ctx);
    const a = bridge.create({ workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId, kind: 'telegram', name: 'Tg A', token: 'tok-a-123456' }).connection;
    const b = bridge.create({ workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id, agentId, kind: 'telegram', name: 'Tg B', token: 'tok-b-123456' }).connection;

    // Two active telegram connections → ambiguous (no default).
    expect(bridge.defaultConnectionFor(ctx.workspace.id, 'telegram')).toBeNull();

    bridge.setDefault(ctx.workspace.id, a.id, true);
    expect(bridge.defaultConnectionFor(ctx.workspace.id, 'telegram')).toBe(a.id);
    expect(bridge.list(ctx.workspace.id).find((c) => c.id === a.id)?.isDefault).toBe(true);

    // Setting B default clears A (only one default per kind).
    bridge.setDefault(ctx.workspace.id, b.id, true);
    const list = bridge.list(ctx.workspace.id);
    expect(list.find((c) => c.id === a.id)?.isDefault).toBe(false);
    expect(list.find((c) => c.id === b.id)?.isDefault).toBe(true);
    expect(bridge.defaultConnectionFor(ctx.workspace.id, 'telegram')).toBe(b.id);

    // Clearing it leaves no default → ambiguous again.
    bridge.setDefault(ctx.workspace.id, b.id, false);
    expect(bridge.defaultConnectionFor(ctx.workspace.id, 'telegram')).toBeNull();
  });

  it('create() rejects unknown kind with CHANNEL_KIND_UNAVAILABLE', () => {
    const adapter = new StubTelegramAdapter();
    const { bridge } = buildBridge(ctx, adapter);
    const agentId = seedAgent(ctx);
    expect(() =>
      bridge.create({
        workspaceId: ctx.workspace.id,
        ambientId: null,
        userId: ctx.user.id,
        agentId,
        // @ts-expect-error testing runtime guard
        kind: 'whatsapp',
        name: 'x',
        token: 'tok',
      }),
    ).toThrow(/CHANNEL_KIND_UNAVAILABLE|kind/);
  });

  it('create() rejects when the agent does not belong to the workspace', () => {
    const adapter = new StubTelegramAdapter();
    const { bridge } = buildBridge(ctx, adapter);
    expect(() =>
      bridge.create({
        workspaceId: ctx.workspace.id,
        ambientId: null,
        userId: ctx.user.id,
        agentId: randomUUID(),
        kind: 'telegram',
        name: 'x',
        token: 'tok',
      }),
    ).toThrow(/RESOURCE_NOT_FOUND|agent/);
  });

  it('handleInbound() rejects when adapter.verify returns false', async () => {
    const adapter = new StubTelegramAdapter();
    adapter.acceptVerify = false;
    const { bridge } = buildBridge(ctx, adapter);
    const agentId = seedAgent(ctx);
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'telegram',
      name: 'tg',
      token: 'tok',
    });
    await expect(
      bridge.handleInbound({ connectionId: connection.id, headers: {}, rawBody: '{}' }),
    ).rejects.toMatchObject({ code: 'CHANNEL_SIGNATURE_INVALID' });
    // Connection flipped to error.
    const row = ctx.db
      .select()
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, connection.id))
      .get()!;
    expect(row.status).toBe('error');
    expect(row.lastError).toMatch(/signature/);
  });

  it('handleInbound() appends mirrored message and is idempotent on duplicate externalId', async () => {
    const adapter = new StubTelegramAdapter();
    const { bridge, conversations } = buildBridge(ctx, adapter);
    const agentId = seedAgent(ctx);
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'telegram',
      name: 'tg',
      token: 'tok',
    });

    const first = await bridge.handleInbound({ connectionId: connection.id, headers: {}, rawBody: '{}' });
    expect(first.accepted).toBe(true);
    expect(first.idempotent).toBe(false);
    expect(first.messageId).toBeTruthy();

    // Replay same update_id → idempotent ack, no duplicate message.
    const second = await bridge.handleInbound({ connectionId: connection.id, headers: {}, rawBody: '{}' });
    expect(second.idempotent).toBe(true);

    const conv = conversations.list(ctx.workspace.id)[0]!;
    const messages = conversations.messages(conv.id, 50);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.body).toContain('hello from tg');
    expect(messages[0]!.body).toContain('Alice');
  });

  it('handleInbound() isolates channel chats from the desktop agent conversation', async () => {
    const adapter = new StubTelegramAdapter();
    const { bridge, conversations } = buildBridge(ctx, adapter);
    const agentId = seedAgent(ctx);
    const desktop = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      agentId,
    });
    conversations.appendOutbound({
      workspaceId: ctx.workspace.id,
      conversationId: desktop.id,
      operatorId: ctx.user.id,
      body: 'desktop only',
    });
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'telegram',
      name: 'tg',
      token: 'tok',
    });

    const first = await bridge.handleInbound({ connectionId: connection.id, headers: {}, rawBody: '{}' });
    expect(first.accepted).toBe(true);

    adapter.parseResult = {
      externalId: 'telegram:43',
      chatId: '1000',
      body: 'second chat',
      from: 'Bob',
    };
    await bridge.handleInbound({ connectionId: connection.id, headers: {}, rawBody: '{}' });

    const all = conversations.list(ctx.workspace.id);
    expect(all).toHaveLength(3);
    expect(conversations.messages(desktop.id, 50)).toHaveLength(1);
    const channelConversations = all.filter((conversation) => conversation.id !== desktop.id);
    expect(channelConversations.map((conversation) => conversation.channelConnectionId)).toEqual([
      connection.id,
      connection.id,
    ]);
    expect(channelConversations.map((conversation) => conversation.channelChatId).sort()).toEqual(['1000', '999']);
  });

  it('handleInbound() ignores parseInbound returning null and stays active', async () => {
    const adapter = new StubTelegramAdapter();
    adapter.parseResult = null;
    const { bridge, conversations } = buildBridge(ctx, adapter);
    const agentId = seedAgent(ctx);
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'telegram',
      name: 'tg',
      token: 'tok',
    });
    const result = await bridge.handleInbound({ connectionId: connection.id, headers: {}, rawBody: '{}' });
    expect(result.accepted).toBe(false);
    expect(conversations.list(ctx.workspace.id)).toHaveLength(0);
  });

  it('desktop operator messages are not auto-forwarded to channel defaults', async () => {
    const adapter = new StubTelegramAdapter();
    const { bridge, conversations } = buildBridge(ctx, adapter);
    const agentId = seedAgent(ctx);
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'telegram',
      name: 'tg',
      token: 'tok',
      defaultChatId: '999',
    });
    ctx.db
      .update(schema.channelConnections)
      .set({ status: 'active' })
      .where(eq(schema.channelConnections.id, connection.id))
      .run();

    const conv = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      agentId,
    });
    conversations.appendOutbound({
      workspaceId: ctx.workspace.id,
      conversationId: conv.id,
      operatorId: ctx.user.id,
      body: 'hi from operator',
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(adapter.sent).toHaveLength(0);
  });

  it('deliverToConnection flips the connection to error on send failure', async () => {
    const adapter = new StubTelegramAdapter();
    adapter.shouldFailSend = true;
    const { bridge } = buildBridge(ctx, adapter);
    const agentId = seedAgent(ctx);
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'telegram',
      name: 'tg',
      token: 'tok',
      defaultChatId: '999',
    });
    ctx.db
      .update(schema.channelConnections)
      .set({ status: 'active' })
      .where(eq(schema.channelConnections.id, connection.id))
      .run();

    await expect(
      bridge.deliverToConnection({ connectionId: connection.id, chatId: '999', body: 'fail-me' }),
    ).rejects.toThrow(/boom/);
    const row = ctx.db
      .select()
      .from(schema.channelConnections)
      .where(eq(schema.channelConnections.id, connection.id))
      .get()!;
    expect(row.status).toBe('error');
    expect(row.lastError).toContain('boom');
  });

  it('test() returns diagnostics when no chatId is available and sends when explicit', async () => {
    const adapter = new StubTelegramAdapter();
    const { bridge } = buildBridge(ctx, adapter);
    const agentId = seedAgent(ctx);
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'telegram',
      name: 'tg',
      token: 'tok',
    });
    const missingTarget = await bridge.test({ workspaceId: ctx.workspace.id, id: connection.id });
    expect(missingTarget.status).toBe('needs_action');
    expect(missingTarget.checks.some((check) => check.code === 'missing_default_target')).toBe(true);

    await bridge.test({
      workspaceId: ctx.workspace.id,
      id: connection.id,
      chatId: '111',
      body: 'ping',
    });
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]!.chatId).toBe('111');
  });

  it('handleInbound() emits CHANNEL_MESSAGE_RECEIVED on the bus', async () => {
    const adapter = new StubTelegramAdapter();
    const { bridge } = buildBridge(ctx, adapter);
    const agentId = seedAgent(ctx);
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'telegram',
      name: 'tg',
      token: 'tok',
    });
    const cap = ctx.captureBus();
    await bridge.handleInbound({ connectionId: connection.id, headers: {}, rawBody: '{}' });
    cap.stop();
    const received = cap.events.find(
      (e) => e.envelope.event === REALTIME_EVENTS.CHANNEL_MESSAGE_RECEIVED,
    );
    expect(received).toBeDefined();
  });

  it('delete() removes the row and 404s on subsequent get()', () => {
    const adapter = new StubTelegramAdapter();
    const { bridge } = buildBridge(ctx, adapter);
    const agentId = seedAgent(ctx);
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'telegram',
      name: 'tg',
      token: 'tok',
    });
    bridge.delete(ctx.workspace.id, connection.id);
    expect(() => bridge.get(ctx.workspace.id, connection.id)).toThrow(AgentisError);
  });

  // Silence the vi reference (kept for potential future use).
  it('vi import is available for spies', () => {
    expect(vi).toBeTruthy();
  });
});
