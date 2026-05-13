import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AdapterHealthStatus, ChatDelta, ChatMessage, NormalizedAgentEvent, NormalizedTask, ToolDefinition } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import { buildConversationRoutes } from '../../src/routes/conversations.js';
import { ConversationStore } from '../../src/services/conversationStore.js';
import { ViewportStore } from '../../src/services/viewportStore.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

class StreamingAdapter implements AgentAdapter {
  readonly adapterType = 'http' as const;
  seenMessages: ChatMessage[] = [];
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async healthCheck(): Promise<AdapterHealthStatus> {
    return { isHealthy: true, checkedAt: new Date().toISOString() };
  }
  onEvent(_handler: (event: NormalizedAgentEvent) => void): void {}
  async dispatchTask(_task: NormalizedTask): Promise<void> {}
  async cancelTask(_taskId: string): Promise<void> {}
  async *chat(messages: ChatMessage[], _tools: ToolDefinition[]): AsyncIterable<ChatDelta> {
    this.seenMessages = messages;
    yield { type: 'text', delta: 'streamed ' };
    yield { type: 'text', delta: 'reply' };
    yield { type: 'done', finishReason: 'stop' };
  }
}

function seedAgent(ctx: TestContext) {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({
    id,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    name: 'Chat Agent',
    adapterType: 'http',
  }).run();
  return id;
}

describe('conversations SSE', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(() => ctx.close());

  it('streams chat deltas and persists the final assistant response', async () => {
    const agentId = seedAgent(ctx);
    const adapter = new StreamingAdapter();
    const adapters = new AdapterManager(ctx.logger);
    adapters.register(agentId, adapter);
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const viewportStore = new ViewportStore();
    viewportStore.set(ctx.user.id, 'socket_1', {
      surface: 'workflow_detail',
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      route: `/workflows/${agentId}`,
      resourceKind: 'workflow',
      resourceId: 'workflow_1',
    });
    const app = ctx.buildApp([
      {
        path: '/v1/conversations',
        app: buildConversationRoutes({ db: ctx.db, auth: ctx.auth, conversations, adapters, logger: ctx.logger, viewportStore }),
      },
    ]);

    const res = await app.request(`/v1/conversations/${agentId}/send`, {
      method: 'POST',
      headers: { ...ctx.authHeaders, accept: 'text/event-stream' },
      body: JSON.stringify({ body: 'hello', useViewportContext: true }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('event: delta');
    expect(text).toContain('streamed');
    expect(text).toContain('event: message');

    const conversation = conversations.list(ctx.workspace.id)[0]!;
    const messages = conversations.messages(conversation.id, 10);
    expect(messages.map((message) => message.body)).toEqual(['hello', 'streamed reply']);
    expect(adapter.seenMessages[0]!.role).toBe('system');
  });
});
