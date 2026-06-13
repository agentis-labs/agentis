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

class FailingChatAdapter extends StreamingAdapter {
  override async *chat(_messages: ChatMessage[], _tools: ToolDefinition[]): AsyncIterable<ChatDelta> {
    yield { type: 'tool_result', id: 'adapter', name: 'adapter.chat', result: null, error: 'missing codex binary' };
    yield { type: 'done', finishReason: 'error' };
  }
}

class CanceledChatAdapter extends StreamingAdapter {
  override async *chat(_messages: ChatMessage[], _tools: ToolDefinition[]): AsyncIterable<ChatDelta> {
    yield { type: 'tool_result', id: 'adapter', name: 'adapter.chat', result: null, error: 'canceled: The operator canceled this turn.' };
    yield { type: 'done', finishReason: 'error' };
  }
}

class ToolAndRuntimeFailingAdapter extends StreamingAdapter {
  override async *chat(_messages: ChatMessage[], _tools: ToolDefinition[]): AsyncIterable<ChatDelta> {
    yield {
      type: 'tool_result',
      id: 'build-1',
      name: 'agentis.build_workflow',
      result: null,
      error: 'A workflow build for this conversation is already running.',
    };
    yield { type: 'tool_result', id: 'adapter', name: 'adapter.chat', result: null, error: 'Codex exited after the tool failed.' };
    yield { type: 'done', finishReason: 'error' };
  }
}

class ConfirmationOnlyAdapter extends StreamingAdapter {
  override async *chat(_messages: ChatMessage[], _tools: ToolDefinition[]): AsyncIterable<ChatDelta> {
    yield {
      type: 'confirmation_required',
      turnId: randomUUID(),
      toolCall: { id: 'tool_run', name: 'agentis.workflow.run', args: { workflowId: 'wf_1' } },
      title: 'Run workflow?',
      body: 'This will start a real workflow run.',
      impact: {
        summary: 'This will start a real workflow run in the current workspace.',
        details: ['Workflow: wf_1'],
        riskLevel: 'medium',
        reversible: false,
        externalSideEffects: true,
      },
      confirmLabel: 'Run workflow',
      cancelLabel: 'Cancel',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
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
    const capturedTurns: Array<{ userMessage: string; assistantMessage?: string | null; conversationId: string }> = [];
    const memoryCapture = {
      captureTurn: async (args: { userMessage: string; assistantMessage?: string | null; conversationId: string }) => {
        capturedTurns.push(args);
      },
    };
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
        app: buildConversationRoutes({
          db: ctx.db,
          auth: ctx.auth,
          conversations,
          adapters,
          logger: ctx.logger,
          viewportStore,
          bus: ctx.bus,
          memoryCapture: memoryCapture as any,
        }),
      },
    ]);

    const clientTurnId = randomUUID();
    const res = await app.request(`/v1/conversations/${agentId}/send`, {
      method: 'POST',
      headers: { ...ctx.authHeaders, accept: 'text/event-stream' },
      body: JSON.stringify({ body: 'hello', useViewportContext: true, clientTurnId }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('event: delta');
    expect(text).toContain('"type":"activity"');
    expect(text).toContain('Request received');
    expect(text).toContain('streamed');
    expect(text).toContain('event: message');

    const conversation = conversations.list(ctx.workspace.id)[0]!;
    const messages = conversations.messages(conversation.id, 10);
    expect(messages.map((message) => message.body)).toEqual(['hello', 'streamed reply']);
    expect(messages[0]!.metadata).toMatchObject({ clientTurnId });
    expect(messages[1]!.metadata).toMatchObject({
      clientTurnId,
      turn: {
        clientTurnId,
        status: 'completed',
        finishReason: 'stop',
      },
      activity: expect.arrayContaining([
        expect.objectContaining({ type: 'activity', label: 'Request received' }),
        expect.objectContaining({ type: 'activity', label: 'Response ready', durationMs: expect.any(Number) }),
      ]),
    });
    expect(adapter.seenMessages[0]!.role).toBe('system');
    expect(capturedTurns).toEqual([
      expect.objectContaining({
        conversationId: conversation.id,
        userMessage: 'hello',
        assistantMessage: 'streamed reply',
      }),
    ]);
  });

  it('answers a greeting over SSE through the adapter (no canned shortcut)', async () => {
    const agentId = seedAgent(ctx);
    const adapter = new StreamingAdapter();
    const adapters = new AdapterManager(ctx.logger);
    adapters.register(agentId, adapter);
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const app = ctx.buildApp([
      {
        path: '/v1/conversations',
        app: buildConversationRoutes({ db: ctx.db, auth: ctx.auth, conversations, adapters, logger: ctx.logger, bus: ctx.bus }),
      },
    ]);

    const clientTurnId = randomUUID();
    const res = await app.request(`/v1/conversations/${agentId}/send`, {
      method: 'POST',
      headers: { ...ctx.authHeaders, accept: 'text/event-stream' },
      body: JSON.stringify({ body: 'hi', clientTurnId }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    // The greeting is answered by the real harness, not a hardcoded string.
    expect(text).toContain('streamed reply');
    expect(adapter.seenMessages.at(-1)).toMatchObject({ role: 'user', content: 'hi' });

    const conversation = conversations.list(ctx.workspace.id)[0]!;
    const messages = conversations.messages(conversation.id, 10);
    expect(messages.map((message) => message.body)).toEqual(['hi', 'streamed reply']);
    expect(messages[1]!.metadata).toMatchObject({ clientTurnId });
  });

  it('streams adapter failures as errors and persists the concrete failed message', async () => {
    const agentId = seedAgent(ctx);
    const adapters = new AdapterManager(ctx.logger);
    adapters.register(agentId, new FailingChatAdapter());
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const app = ctx.buildApp([
      {
        path: '/v1/conversations',
        app: buildConversationRoutes({ db: ctx.db, auth: ctx.auth, conversations, adapters, logger: ctx.logger, bus: ctx.bus }),
      },
    ]);

    const res = await app.request(`/v1/conversations/${agentId}/send`, {
      method: 'POST',
      headers: { ...ctx.authHeaders, accept: 'text/event-stream' },
      body: JSON.stringify({ body: 'hello' }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('event: error');
    expect(text).toContain('missing codex binary');
    expect(text).toContain('event: message');

    const conversation = conversations.list(ctx.workspace.id)[0]!;
    const messages = conversations.messages(conversation.id, 10);
    expect(messages.map((message) => message.body)).toEqual(['hello', 'missing codex binary']);
    expect(messages[1]!.deliveryStatus).toBe('failed');
    expect(messages[1]!.metadata).toMatchObject({
      turn: {
        status: 'failed',
        finishReason: 'error',
      },
      activity: expect.arrayContaining([
        expect.objectContaining({ label: 'Response failed', status: 'error' }),
      ]),
    });
  });

  it('persists operator cancellation as stopped instead of failed', async () => {
    const agentId = seedAgent(ctx);
    const adapters = new AdapterManager(ctx.logger);
    adapters.register(agentId, new CanceledChatAdapter());
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const app = ctx.buildApp([
      {
        path: '/v1/conversations',
        app: buildConversationRoutes({ db: ctx.db, auth: ctx.auth, conversations, adapters, logger: ctx.logger, bus: ctx.bus }),
      },
    ]);

    const res = await app.request(`/v1/conversations/${agentId}/send`, {
      method: 'POST',
      headers: { ...ctx.authHeaders, accept: 'text/event-stream' },
      body: JSON.stringify({ body: 'stop this' }),
    });

    const text = await res.text();
    expect(text).not.toContain('event: error');
    expect(text).toContain('Stopped by operator.');

    const conversation = conversations.list(ctx.workspace.id)[0]!;
    const messages = conversations.messages(conversation.id, 10);
    expect(messages[1]!.body).toBe('Stopped by operator.');
    expect(messages[1]!.deliveryStatus).toBe('delivered');
    expect(messages[1]!.metadata).toMatchObject({
      turn: {
        status: 'stopped',
        finishReason: 'max_turns',
      },
      activity: expect.arrayContaining([
        expect.objectContaining({ label: 'Stopped before completion', status: 'success' }),
      ]),
    });
  });

  it('surfaces the actionable tool failure when the runtime also exits', async () => {
    const agentId = seedAgent(ctx);
    const adapters = new AdapterManager(ctx.logger);
    adapters.register(agentId, new ToolAndRuntimeFailingAdapter());
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const app = ctx.buildApp([
      {
        path: '/v1/conversations',
        app: buildConversationRoutes({ db: ctx.db, auth: ctx.auth, conversations, adapters, logger: ctx.logger, bus: ctx.bus }),
      },
    ]);

    const res = await app.request(`/v1/conversations/${agentId}/send`, {
      method: 'POST',
      headers: { ...ctx.authHeaders, accept: 'text/event-stream' },
      body: JSON.stringify({ body: 'fix this workflow' }),
    });

    const text = await res.text();
    expect(text).toContain('A workflow build for this conversation is already running.');
    expect(text).not.toContain('I didn');

    const conversation = conversations.list(ctx.workspace.id)[0]!;
    const messages = conversations.messages(conversation.id, 10);
    expect(messages[1]!.body).toBe('A workflow build for this conversation is already running.');
    expect(messages[1]!.deliveryStatus).toBe('failed');
  });

  it('persists confirmation cards even when the assistant has no text yet', async () => {
    const agentId = seedAgent(ctx);
    const adapters = new AdapterManager(ctx.logger);
    adapters.register(agentId, new ConfirmationOnlyAdapter());
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const app = ctx.buildApp([
      {
        path: '/v1/conversations',
        app: buildConversationRoutes({ db: ctx.db, auth: ctx.auth, conversations, adapters, logger: ctx.logger, bus: ctx.bus }),
      },
    ]);

    const res = await app.request(`/v1/conversations/${agentId}/send`, {
      method: 'POST',
      headers: { ...ctx.authHeaders, accept: 'text/event-stream' },
      body: JSON.stringify({ body: 'run it' }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('confirmation_required');
    expect(text).toContain('event: message');

    const conversation = conversations.list(ctx.workspace.id)[0]!;
    const messages = conversations.messages(conversation.id, 10);
    expect(messages.map((message) => message.body)).toEqual(['run it', 'Run workflow?']);
    expect(messages[1]!.metadata).toMatchObject({
      source: 'chat_loop',
      confirmation: {
        title: 'Run workflow?',
        status: 'pending',
        impact: {
          riskLevel: 'medium',
          externalSideEffects: true,
        },
      },
    });
  });
});
