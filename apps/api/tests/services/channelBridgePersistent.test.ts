/**
 * ChannelBridge persistent-transport routing (WhatsApp).
 *
 * WhatsApp is QR-authenticated (no token) and sends over a live socket owned by
 * the supervisor, not the stateless webhook adapter. These tests use a fake
 * PersistentChannelTransport so no baileys socket is needed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { eq } from 'drizzle-orm';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import { ChannelBridge, type PersistentChannelTransport } from '../../src/services/conversation/channelBridge.js';
import { ConversationStore } from '../../src/services/conversation/conversationStore.js';
import { SlackChannelAdapter } from '../../src/adapters/channels/slack.js';

function seedAgent(ctx: TestContext) {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({
    id, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
    name: 'Orchestrator', adapterType: 'http',
  }).run();
  return id;
}

function fakeTransport() {
  const sent: Array<{ connectionId: string; chatId: string; body: string }> = [];
  const stopped: string[] = [];
  const created: string[] = [];
  const typing: Array<{ connectionId: string; chatId: string; on: boolean }> = [];
  const transport: PersistentChannelTransport = {
    handles: (conn) => conn.kind === 'whatsapp'
      || (conn.kind === 'telegram' && (conn.settings as { transport?: string } | undefined)?.transport === 'polling')
      || (conn.kind === 'discord' && (conn.settings as { transport?: string } | undefined)?.transport === 'gateway'),
    requiresNoToken: (kind) => kind === 'whatsapp',
    onCreated: (conn) => { created.push(conn.id); },
    status: () => ({ status: 'open' }),
    send: async (connectionId, chatId, body) => { sent.push({ connectionId, chatId, body }); },
    setTyping: async (connectionId, chatId, on) => { typing.push({ connectionId, chatId, on }); },
    stop: async (connectionId) => { stopped.push(connectionId); },
  };
  return { transport, sent, stopped, created, typing };
}

function buildBridge(ctx: TestContext) {
  const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
  const bridge = new ChannelBridge({
    db: ctx.db, vault: ctx.vault, conversations, bus: ctx.bus, logger: ctx.logger,
    adapters: { slack: new SlackChannelAdapter() },
  });
  return { bridge, conversations };
}

describe('ChannelBridge persistent transport (WhatsApp)', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestContext(); });
  afterEach(() => ctx.close());

  it('creates a WhatsApp connection without a token, needing QR action', () => {
    const { bridge } = buildBridge(ctx);
    const { transport } = fakeTransport();
    bridge.setPersistentTransport(transport);
    const agentId = seedAgent(ctx);

    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      agentId, kind: 'whatsapp', name: 'WA personal',
    });
    expect(connection.kind).toBe('whatsapp');
    expect(connection.status).toBe('needs_action');
    expect(connection.health.status).toBe('needs_action');

    // tokenEncrypted is still populated (NOT NULL) with an encrypted marker.
    const row = ctx.db.select().from(schema.channelConnections).where(eq(schema.channelConnections.id, connection.id)).get()!;
    expect(row.tokenEncrypted).toBeTruthy();
    expect(ctx.vault.decrypt(row.tokenEncrypted)).toContain('persistent:whatsapp');
  });

  it('rejects a non-persistent kind without a token', () => {
    const { bridge } = buildBridge(ctx);
    const { transport } = fakeTransport();
    bridge.setPersistentTransport(transport);
    const agentId = seedAgent(ctx);
    expect(() =>
      bridge.create({ workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id, agentId, kind: 'slack', name: 'x' }),
    ).toThrow(/token/);
  });

  it('deliverToConnection routes WhatsApp sends to the live transport', async () => {
    const { bridge } = buildBridge(ctx);
    const { transport, sent } = fakeTransport();
    bridge.setPersistentTransport(transport);

    const agentId = seedAgent(ctx);
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      agentId, kind: 'whatsapp', name: 'WA',
    });

    await bridge.deliverToConnection({ connectionId: connection.id, chatId: '1234567@s.whatsapp.net', body: 'pong' });
    expect(sent).toEqual([{ connectionId: connection.id, chatId: '1234567@s.whatsapp.net', body: 'pong' }]);

    const row = ctx.db.select().from(schema.channelConnections).where(eq(schema.channelConnections.id, connection.id)).get()!;
    expect(row.status).toBe('active'); // markActive after a successful send
  });

  it('normalizes explicit WhatsApp phone numbers before live send', async () => {
    const { bridge } = buildBridge(ctx);
    const { transport, sent } = fakeTransport();
    bridge.setPersistentTransport(transport);
    const agentId = seedAgent(ctx);
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      agentId, kind: 'whatsapp', name: 'WA',
    });

    await bridge.deliverToConnection({ connectionId: connection.id, chatId: '+1 (234) 567-8901', body: 'pong' });
    expect(sent).toEqual([{ connectionId: connection.id, chatId: '12345678901@s.whatsapp.net', body: 'pong' }]);
  });

  it('marks open WhatsApp QR healthy without requiring a default recipient', async () => {
    const { bridge } = buildBridge(ctx);
    const { transport } = fakeTransport();
    bridge.setPersistentTransport(transport);
    const agentId = seedAgent(ctx);
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      agentId, kind: 'whatsapp', name: 'WA',
    });

    const health = await bridge.test({ workspaceId: ctx.workspace.id, id: connection.id });
    expect(health.status).toBe('active');
    expect(health.checks.find((check) => check.name === 'outbound')?.code).toBe('outbound_ready_for_explicit_recipient');
    expect(health.checks.find((check) => check.name === 'inbound')?.code).toBe('inbound_live_ready_no_default');
  });

  it('Telegram polling: onCreated fires and outbound routes through the live session', async () => {
    const { bridge } = buildBridge(ctx);
    const { transport, sent, created } = fakeTransport();
    bridge.setPersistentTransport(transport);
    const agentId = seedAgent(ctx);

    // Telegram polling still needs the bot token, but does NOT need the webhook
    // adapter registered (it's delivered by the live session).
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      agentId, kind: 'telegram', name: 'TG poll', token: '123456:bot-token', transport: 'polling',
    });
    expect(connection.status).toBe('verifying');
    expect(created).toEqual([connection.id]);

    await bridge.deliverToConnection({ connectionId: connection.id, chatId: '987', body: 'hi' });
    expect(sent).toEqual([{ connectionId: connection.id, chatId: '987', body: 'hi' }]);
  });

  it('setTyping routes to the live transport for persistent kinds only', async () => {
    const { bridge } = buildBridge(ctx);
    const { transport, typing } = fakeTransport();
    bridge.setPersistentTransport(transport);
    const agentId = seedAgent(ctx);
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      agentId, kind: 'whatsapp', name: 'WA',
    });
    await bridge.setTyping(connection.id, '777@s.whatsapp.net', true);
    await bridge.setTyping(connection.id, '777@s.whatsapp.net', false);
    expect(typing).toEqual([
      { connectionId: connection.id, chatId: '777@s.whatsapp.net', on: true },
      { connectionId: connection.id, chatId: '777@s.whatsapp.net', on: false },
    ]);

    // A webhook (slack) connection is not handled by the persistent transport → no-op.
    const slack = bridge.create({
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      agentId, kind: 'slack', name: 'SL', token: 'xoxb-token',
    });
    await bridge.setTyping(slack.connection.id, 'C1', true);
    expect(typing).toHaveLength(2); // unchanged
  });

  it('Discord gateway: onCreated fires and outbound routes through the live session', async () => {
    const { bridge } = buildBridge(ctx);
    const { transport, sent, created } = fakeTransport();
    bridge.setPersistentTransport(transport);
    const agentId = seedAgent(ctx);
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      agentId, kind: 'discord', name: 'DC gateway', token: 'discord-bot-token', transport: 'gateway',
    });
    expect(connection.status).toBe('verifying');
    expect(created).toEqual([connection.id]);
    await bridge.deliverToConnection({ connectionId: connection.id, chatId: 'chan-1', body: 'hi' });
    expect(sent).toEqual([{ connectionId: connection.id, chatId: 'chan-1', body: 'hi' }]);
  });

  it('delete stops the live session', () => {
    const { bridge } = buildBridge(ctx);
    const { transport, stopped } = fakeTransport();
    bridge.setPersistentTransport(transport);
    const agentId = seedAgent(ctx);
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      agentId, kind: 'whatsapp', name: 'WA',
    });
    bridge.delete(ctx.workspace.id, connection.id);
    expect(stopped).toEqual([connection.id]);
  });
});
