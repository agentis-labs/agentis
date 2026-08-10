import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentAdapter, AdapterHealthStatus, ChatDelta, ChatInvocationOptions, ChatMessage, NormalizedAgentEvent, NormalizedTask, ToolDefinition } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import { buildConversationRoutes } from '../../src/routes/conversations.js';
import { ConversationStore } from '../../src/services/conversation/conversationStore.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

class DurableAdapter implements AgentAdapter {
  readonly adapterType = 'http' as const;
  seenOptions?: ChatInvocationOptions;
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async healthCheck(): Promise<AdapterHealthStatus> { return { isHealthy: true, checkedAt: new Date().toISOString() }; }
  onEvent(_handler: (event: NormalizedAgentEvent) => void): void {}
  async dispatchTask(_task: NormalizedTask): Promise<void> {}
  async cancelTask(_taskId: string): Promise<void> {}
  async *chat(_messages: ChatMessage[], _tools: ToolDefinition[], options?: ChatInvocationOptions): AsyncIterable<ChatDelta> {
    this.seenOptions = options;
    yield { type: 'commentary', id: 'summary-1', text: 'I am validating the workspace before I build the result.', source: 'reasoning_summary', createdAt: new Date().toISOString() };
    yield { type: 'activity', id: 'work-1', phase: 'progress', status: 'running', label: 'Building durable result' };
    yield { type: 'text', delta: 'Durable result' };
    yield { type: 'done', finishReason: 'stop' };
  }
}

describe('durable conversation turn routes', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestContext(); });
  afterEach(() => ctx.close());

  it('keeps executing without a connected stream, then replays the completed event log', async () => {
    const agentId = randomUUID();
    ctx.db.insert(schema.agents).values({
      id: agentId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name: 'Mission Agent',
      adapterType: 'http',
    }).run();
    const adapter = new DurableAdapter();
    const adapters = new AdapterManager(ctx.logger);
    adapters.register(agentId, adapter);
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const app = ctx.buildApp([{ path: '/v1/conversations', app: buildConversationRoutes({
      db: ctx.db,
      auth: ctx.auth,
      conversations,
      adapters,
      logger: ctx.logger,
      bus: ctx.bus,
    }) }]);

    const create = await app.request(`/v1/conversations/${agentId}/turns`, {
      method: 'POST',
      headers: ctx.authHeaders,
      body: JSON.stringify({ body: 'Build and implement the entire production-ready system from start to finish.', executionMode: 'mission', permissionMode: 'auto' }),
    });
    expect(create.status).toBe(202);
    const created = await create.json() as { turn: { id: string; effectiveMode: string; status: string }; conversationId: string };
    expect(created.turn).toMatchObject({ effectiveMode: 'mission', status: 'queued' });

    await expect.poll(async () => {
      const response = await app.request(`/v1/conversations/${agentId}/turns/${created.turn.id}`, { headers: ctx.authHeaders });
      return ((await response.json()) as { turn: { status: string } }).turn.status;
    }).toBe('completed');

    const eventsResponse = await app.request(`/v1/conversations/${agentId}/turns/${created.turn.id}/events`, { headers: ctx.authHeaders });
    expect(eventsResponse.status).toBe(200);
    const stream = await eventsResponse.text();
    expect(stream).toContain('"type":"execution"');
    expect(stream).toContain('Building durable result');
    expect(stream).toContain('I am validating the workspace before I build the result.');
    expect(stream).toContain('Durable result');
    expect(stream).toContain('event: message');

    expect(adapter.seenOptions).toMatchObject({ latencyClass: 'deliberate', reasoningEffort: 'high', fastMode: false });
  });
});
