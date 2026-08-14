import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@agentis/db/sqlite';
import type { AgentAdapter, ChatMessage } from '@agentis/core';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import { ActivityFeedService } from '../../src/services/activityFeed.js';
import { ApprovalInboxService } from '../../src/services/approvalInbox.js';
import { AgentConsultationService } from '../../src/services/agent/agentConsultationService.js';

let ctx: TestContext;

beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

function seedAgent(id: string, name: string, role: string, paused = false): void {
  ctx.db.insert(schema.agents).values({
    id,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    name,
    role,
    adapterType: 'http',
    status: paused ? 'paused' : 'online',
    isPaused: paused,
  }).run();
}

function adapter(): AgentAdapter {
  return {
    adapterType: 'http',
    connect: async () => undefined,
    disconnect: async () => undefined,
    healthCheck: async () => ({ status: 'online', latencyMs: 1 }),
    capabilities: () => ({ interactiveChat: true, toolCalling: true }),
    dispatchTask: async () => undefined,
    cancelTask: async () => undefined,
    onEvent: () => undefined,
    chat: async function* () { yield { type: 'done' as const, finishReason: 'stop' as const }; },
  };
}

describe('AgentConsultationService', () => {
  it('selects the named specialist and preserves the same sanitized transcript for three rounds', async () => {
    seedAgent('caller', 'Support Agent', 'manager');
    seedAgent('specialist', 'Technical Specialist', 'specialist');
    const adapters = new AdapterManager(ctx.logger);
    adapters.register('specialist', adapter());
    const histories: ChatMessage[][] = [];
    let invocation = 0;
    const service = new AgentConsultationService({
      db: ctx.db,
      adapters,
      bus: ctx.bus,
      logger: ctx.logger,
      activity: new ActivityFeedService(ctx.db, ctx.bus),
      approvals: new ApprovalInboxService(ctx.db, ctx.bus),
      runTurn: async function* (_adapter, history, _question, specialistContext) {
        expect(specialistContext.allowedToolIds).toEqual(['agentis.knowledge.search']);
        histories.push(history);
        invocation += 1;
        yield { type: 'text', delta: invocation === 1 ? 'Use token=secret-value and retry.' : `Answer ${invocation}` };
        yield { type: 'done', finishReason: 'stop' };
      },
      confirmTurn: async function* () { yield { type: 'done', finishReason: 'stop' }; },
    });
    const toolContext = {
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      agentId: 'caller',
      caller: 'chat' as const,
      allowedToolIds: ['agentis.knowledge.search'],
    };

    const first = await service.consult({ question: 'Investigate the timeout', targetAgentId: 'specialist' }, toolContext);
    const second = await service.consult({ consultationId: first.consultationId, question: 'Could that be a retry issue?' }, toolContext);
    const third = await service.consult({ consultationId: first.consultationId, question: 'Give me the final recommendation.' }, toolContext);

    expect(first.target.id).toBe('specialist');
    expect(first.answer).toBe('Use token=[redacted] and retry.');
    expect(second.round).toBe(2);
    expect(third.round).toBe(3);
    expect(third.canContinue).toBe(false);
    expect(histories[0]).toEqual([]);
    expect(histories[1]).toEqual([
      { role: 'user', content: 'Investigate the timeout' },
      { role: 'assistant', content: 'Use token=[redacted] and retry.' },
    ]);
    await expect(service.consult({ consultationId: first.consultationId, question: 'A fourth question' }, toolContext))
      .rejects.toThrow('round limit');
    expect(ctx.db.select().from(schema.conversationMessages).all()).toHaveLength(0);
  });

  it('rejects self-consultation and visibly records a compatible fallback for a paused named target', async () => {
    seedAgent('caller', 'Support Agent', 'manager');
    seedAgent('paused', 'Paused Specialist', 'specialist', true);
    seedAgent('fallback', 'Fallback Specialist', 'specialist');
    const adapters = new AdapterManager(ctx.logger);
    adapters.register('fallback', adapter());
    const service = new AgentConsultationService({
      db: ctx.db,
      adapters,
      bus: ctx.bus,
      logger: ctx.logger,
      activity: new ActivityFeedService(ctx.db, ctx.bus),
      approvals: new ApprovalInboxService(ctx.db, ctx.bus),
      runTurn: async function* () {
        yield { type: 'text', delta: 'Fallback answer' };
        yield { type: 'done', finishReason: 'stop' };
      },
      confirmTurn: async function* () { yield { type: 'done', finishReason: 'stop' }; },
    });
    const toolContext = { workspaceId: ctx.workspace.id, userId: ctx.user.id, agentId: 'caller', caller: 'chat' as const };

    await expect(service.consult({ question: 'Ask myself', targetAgentId: 'caller' }, toolContext)).rejects.toThrow('cannot consult itself');
    await expect(service.consult(
      { question: 'Ask an ancestor', targetAgentId: 'caller' },
      { ...toolContext, agentId: 'fallback', consultationDepth: 1, consultationAncestors: ['caller'] },
    )).rejects.toThrow('cycle detected');
    const result = await service.consult({ question: 'Need expertise', targetAgentId: 'paused', targetRole: 'specialist' }, toolContext);
    expect(result.target.id).toBe('fallback');
    expect(result.substituted).toBe(true);
    const row = ctx.db.select().from(schema.agentConsultations).all()[0]!;
    expect(row.requestedTargetAgentId).toBe('paused');
    expect(row.substituted).toBe(true);
  });

  it('parks for approval, resumes the specialist continuation, then replays its answer once to the durable parent', async () => {
    seedAgent('caller', 'Support Agent', 'manager');
    seedAgent('specialist', 'Technical Specialist', 'specialist');
    const adapters = new AdapterManager(ctx.logger);
    adapters.register('specialist', adapter());
    const approvals = new ApprovalInboxService(ctx.db, ctx.bus);
    let parentResume = '';
    let initialCalls = 0;
    const service = new AgentConsultationService({
      db: ctx.db,
      adapters,
      bus: ctx.bus,
      logger: ctx.logger,
      activity: new ActivityFeedService(ctx.db, ctx.bus),
      approvals,
      runTurn: async function* () {
        initialCalls += 1;
        yield {
          type: 'confirmation_required',
          turnId: 'runtime-confirmation',
          toolCall: { id: 'tool-1', name: 'agentis.appData.update', args: {} },
          title: 'Update the incident record?',
          body: 'This changes workspace data.',
        };
      },
      confirmTurn: async function* () {
        yield { type: 'text', delta: 'The approved update succeeded.' };
        yield { type: 'done', finishReason: 'stop' };
      },
    });
    service.bindParentTurnResume((turnId) => { parentResume = turnId; });
    const toolContext = {
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      agentId: 'caller',
      caller: 'chat' as const,
      durableTurnId: 'durable-parent-turn',
      permissionMode: 'ask' as const,
    };

    const parked = await service.consult({ question: 'Please verify and update it.', targetAgentId: 'specialist' }, toolContext);
    expect(parked.status).toBe('awaiting_approval');
    await approvals.resolve({
      workspaceId: ctx.workspace.id,
      approvalId: parked.approvalId!,
      decision: 'approve',
      resolvedByUserId: ctx.user.id,
    });
    expect(parentResume).toBe('durable-parent-turn');

    const resumed = await service.consult({ question: 'Please verify and update it.', targetAgentId: 'specialist' }, toolContext);
    expect(resumed.consultationId).toBe(parked.consultationId);
    expect(resumed.answer).toBe('The approved update succeeded.');
    expect(initialCalls).toBe(1);
    expect(ctx.db.select().from(schema.agentConsultations).all()[0]!.status).toBe('completed');
  });
});
