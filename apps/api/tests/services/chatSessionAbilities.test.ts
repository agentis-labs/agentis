/**
 * §M1 (Living Apps · Mind track) — abilities as identity.
 *
 * Proves an agent's PINNED ability is composed into a NORMAL chat turn's system
 * context, with NO `/slash` command. This is the un-gate: before M1, a pinned
 * ability only shaped behavior when the user typed `/<command>`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AdapterCapabilities, AgentAdapter, AdapterHealthStatus, ChatDelta, ChatInvocationOptions, ChatMessage, NormalizedAgentEvent, NormalizedTask, ToolDefinition } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { eq } from 'drizzle-orm';
import { ChatSessionExecutor } from '../../src/services/chatSessionExecutor.js';
import { AbilityService } from '../../src/services/abilityService.js';
import { AbilityComposer } from '../../src/services/abilityComposer.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

class FakeChatAdapter implements AgentAdapter {
  readonly adapterType = 'http' as const;
  calls: ChatMessage[][] = [];
  constructor(
    private readonly impl: () => AsyncIterable<ChatDelta>,
    private readonly caps: AdapterCapabilities = { interactiveChat: true, toolCalling: true, toolForwarding: 'native' },
  ) {}
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async healthCheck(): Promise<AdapterHealthStatus> {
    return { isHealthy: true, checkedAt: new Date().toISOString() };
  }
  capabilities(): AdapterCapabilities { return this.caps; }
  onEvent(_handler: (event: NormalizedAgentEvent) => void): void {}
  async dispatchTask(_task: NormalizedTask): Promise<void> {}
  async cancelTask(_taskId: string): Promise<void> {}
  chat(messages: ChatMessage[], _tools: ToolDefinition[], _options?: ChatInvocationOptions): AsyncIterable<ChatDelta> {
    this.calls.push(messages);
    return this.impl();
  }
}

async function collect(iterable: AsyncIterable<ChatDelta>): Promise<ChatDelta[]> {
  const deltas: ChatDelta[] = [];
  for await (const delta of iterable) deltas.push(delta);
  return deltas;
}

let ctx: TestContext;
let abilities: AbilityService;
let agentId: string;

function makeAgent(): string {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({
    id,
    workspaceId: ctx.workspace.id,
    userId: ctx.user.id,
    ambientId: ctx.ambient.id,
    name: 'Test agent',
    slug: `test-${id.slice(0, 8)}`,
    capabilityTags: [] as unknown as string[],
    status: 'online',
    protocol: 'http_post',
    adapterType: 'hermes',
    transport: {} as unknown as Record<string, unknown>,
  }).run();
  return id;
}

/** Create a READY ability (create() leaves it 'pending'; dispatch only reads 'ready'). */
function makeReadyAbility(name: string, compiledPrompt: string, extra?: Record<string, unknown>): string {
  const ability = abilities.create({
    workspaceId: ctx.workspace.id,
    name,
    domainTag: 'custom',
    ...(extra ?? {}),
  });
  ctx.db.update(schema.abilities)
    .set({ compileStatus: 'ready', compiledPrompt })
    .where(eq(schema.abilities.id, ability.id))
    .run();
  return ability.id;
}

beforeEach(async () => {
  ctx = await createTestContext();
  abilities = new AbilityService(ctx.db, ctx.logger);
  agentId = makeAgent();
});

afterEach(() => {
  ChatSessionExecutor.configure({});
  ctx.close();
});

describe('ChatSessionExecutor · abilities as identity (§M1)', () => {
  it('composes a PINNED ability into a normal turn (no slash command)', async () => {
    const abilityId = makeReadyAbility(
      'Brand Voice',
      'Write in a warm, concise brand voice. Lead with the outcome.',
      { rulesAlways: ['Use the customer name'], rulesNever: ['Use jargon'] },
    );
    abilities.pinAbility(agentId, abilityId);

    const adapter = new FakeChatAdapter(async function* () {
      yield { type: 'text', delta: 'ok' };
      yield { type: 'done', finishReason: 'stop' };
    });
    ChatSessionExecutor.configure({ db: ctx.db, abilityService: abilities });

    await collect(ChatSessionExecutor.turn(adapter, [], 'draft a welcome note for a new user', {
      workspaceId: ctx.workspace.id,
      agentId,
      userId: ctx.user.id,
      conversationId: 'conv_pin',
    }));

    const systemPrompt = adapter.calls[0]![0]!.content as string;
    // No slash was typed, yet the pinned ability is part of the system context.
    expect(systemPrompt).toContain('These are your abilities');
    expect(systemPrompt).toContain('Brand Voice');
    expect(systemPrompt).toContain('warm, concise brand voice');
    expect(systemPrompt).toContain('ALWAYS Use the customer name');
    expect(systemPrompt).toContain('NEVER Use jargon');
  });

  it('does not compose an ability when the agent has none pinned (degrades to today)', async () => {
    makeReadyAbility('Unpinned Skill', 'Some unpinned guidance.');

    const adapter = new FakeChatAdapter(async function* () {
      yield { type: 'text', delta: 'ok' };
      yield { type: 'done', finishReason: 'stop' };
    });
    // No embedding provider wired → semantic auto-select is skipped, so an
    // unpinned ability must NOT leak into the prompt.
    ChatSessionExecutor.configure({ db: ctx.db, abilityService: abilities });

    await collect(ChatSessionExecutor.turn(adapter, [], 'draft a welcome note', {
      workspaceId: ctx.workspace.id,
      agentId,
      userId: ctx.user.id,
      conversationId: 'conv_none',
    }));

    const systemPrompt = adapter.calls[0]![0]!.content as string;
    expect(systemPrompt).not.toContain('These are your abilities');
    expect(systemPrompt).not.toContain('Unpinned Skill');
  });

  it('auto-selects a relevant UNPINNED ability via the composer when embeddings are wired (§M1 step 2)', async () => {
    const abilityId = makeReadyAbility('Refund Handler', 'How to process a refund safely.');
    // Stamp a deterministic domain embedding so cosine score clears the threshold.
    const vec = [1, 0, 0, 0];
    ctx.db.update(schema.abilities)
      .set({ domainEmbedding: vec, minRelevanceScore: 0.1 })
      .where(eq(schema.abilities.id, abilityId))
      .run();

    const adapter = new FakeChatAdapter(async function* () {
      yield { type: 'text', delta: 'ok' };
      yield { type: 'done', finishReason: 'stop' };
    });
    ChatSessionExecutor.configure({
      db: ctx.db,
      abilityService: abilities,
      abilityComposer: new AbilityComposer(),
      // A provider that always returns the same vector → cosine = 1.0 ≥ threshold.
      abilityEmbeddings: () => ({ dimension: 4, modelId: 'test', embed: () => vec }),
    });

    await collect(ChatSessionExecutor.turn(adapter, [], 'customer wants their money back', {
      workspaceId: ctx.workspace.id,
      agentId,
      userId: ctx.user.id,
      conversationId: 'conv_semantic',
    }));

    const systemPrompt = adapter.calls[0]![0]!.content as string;
    expect(systemPrompt).toContain('These are your abilities');
    expect(systemPrompt).toContain('Refund Handler');
  });
});
