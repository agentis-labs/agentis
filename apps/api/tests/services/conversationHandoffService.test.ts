import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@agentis/db/sqlite';
import { ConversationHandoffService } from '../../src/services/conversation/conversationHandoffService.js';
import { ConversationStore } from '../../src/services/conversation/conversationStore.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

describe('ConversationHandoffService', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestContext(); });
  afterEach(() => ctx.close());

  it('persists human ownership without a timeout and changes the monotonic epoch on each boundary', () => {
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id,
      userId: ctx.user.id, name: 'Agent', adapterType: 'http',
    }).run();
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const conversation = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id,
      userId: ctx.user.id, agentId,
    });
    const service = new ConversationHandoffService({ db: ctx.db, bus: ctx.bus });
    const claimed = service.claimHuman({ workspaceId: ctx.workspace.id, conversationId: conversation.id, source: 'provider_observed' });
    expect(claimed).toMatchObject({ state: 'human', source: 'provider_observed', automationEpoch: 1 });
    expect(claimed.claimedAt).toBeTruthy();

    // A fresh service instance proves that ownership is durable, not an in-memory timer.
    const afterRestart = new ConversationHandoffService({ db: ctx.db, bus: ctx.bus });
    expect(afterRestart.current(ctx.workspace.id, conversation.id)).toMatchObject({ state: 'human', automationEpoch: 1 });
    expect(() => afterRestart.assertAutomationAllowed({ workspaceId: ctx.workspace.id, conversationId: conversation.id }))
      .toThrow(/human operator/i);

    const released = afterRestart.releaseToAgent(ctx.workspace.id, conversation.id);
    expect(released).toMatchObject({ state: 'agent', source: null, claimedAt: null, automationEpoch: 2 });
    expect(() => afterRestart.assertAutomationAllowed({
      workspaceId: ctx.workspace.id, conversationId: conversation.id, expectedEpoch: 1,
    })).toThrow(/ownership changed/i);
  });
});
