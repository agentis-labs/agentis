import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { REALTIME_EVENTS } from '@agentis/core';
import { ChannelConnectionSupervisor } from '../../src/services/conversation/channelConnectionSupervisor.js';
import { ConversationStore } from '../../src/services/conversation/conversationStore.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

function fixture() {
  const agentId = randomUUID();
  const connectionId = randomUUID();
  ctx.db.insert(schema.agents).values({
    id: agentId,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    name: 'Orchestrator',
    role: 'orchestrator',
    adapterType: 'http',
  }).run();
  ctx.db.insert(schema.channelConnections).values({
    id: connectionId,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    agentId,
    kind: 'whatsapp',
    name: 'Observed WhatsApp',
    tokenEncrypted: ctx.vault.encrypt('persistent:whatsapp'),
    status: 'active',
    settings: { mode: 'qr_local' },
  }).run();
  const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
  const supervisor = new ChannelConnectionSupervisor({
    db: ctx.db,
    bus: ctx.bus,
    logger: ctx.logger,
    vault: ctx.vault,
    conversations,
    dataDir: '.',
  });
  return { agentId, connectionId, supervisor };
}

describe('ChannelConnectionSupervisor observed outbound synchronization', () => {
  it('mirrors a primary-phone send once and publishes provider-backed outbound evidence', () => {
    const { connectionId, supervisor } = fixture();
    const capture = ctx.captureBus();

    supervisor.observeOutbound(connectionId, {
      externalId: 'PHONE-MESSAGE-1',
      chatId: '5521970398568@s.whatsapp.net',
      body: 'Oi, boa tarde',
    });
    supervisor.observeOutbound(connectionId, {
      externalId: 'PHONE-MESSAGE-1',
      chatId: '5521970398568@s.whatsapp.net',
      body: 'Oi, boa tarde',
    });

    const messages = ctx.db.select().from(schema.conversationMessages).all();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      authorType: 'operator',
      sessionMessageId: 'PHONE-MESSAGE-1',
      body: 'Oi, boa tarde',
      deliveryStatus: 'sent',
      metadata: expect.objectContaining({
        channelOutboundObserved: true,
        source: 'external_whatsapp_client',
      }),
    });
    expect(capture.events.some((event) => event.envelope.event === REALTIME_EVENTS.CHANNEL_MESSAGE_SENT
      && (event.envelope.payload as { observed?: boolean }).observed === true)).toBe(true);
    capture.stop();
  });

  it('does not mirror an echo whose provider id belongs to an Agentis send', () => {
    const { connectionId, supervisor } = fixture();
    ctx.db.insert(schema.channelOutboundDeliveries).values({
      id: randomUUID(),
      workspaceId: ctx.workspace.id,
      connectionId,
      idempotencyKey: 'workflow:run:node',
      chatId: '5521970398568@s.whatsapp.net',
      bodyHash: 'hash',
      status: 'accepted',
      providerMessageId: 'AGENTIS-MESSAGE-1',
    }).run();

    supervisor.observeOutbound(connectionId, {
      externalId: 'AGENTIS-MESSAGE-1',
      chatId: '5521970398568@s.whatsapp.net',
      body: 'Agentis echo',
    });

    expect(ctx.db.select().from(schema.conversationMessages).all()).toHaveLength(0);
    expect(ctx.db.select().from(schema.channelDeliveries)
      .where(eq(schema.channelDeliveries.externalId, 'AGENTIS-MESSAGE-1')).all()).toHaveLength(0);
  });
});
