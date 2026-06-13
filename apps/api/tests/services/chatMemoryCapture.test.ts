import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { ChatMemoryCaptureService } from '../../src/services/chatMemoryCapture.js';
import { CognitivePromotionQueueWorker } from '../../src/services/cognitivePromotionQueueWorker.js';
import { ConversationStore } from '../../src/services/conversationStore.js';
import { EpisodicMemoryStore } from '../../src/services/episodicMemoryStore.js';
import { HashingEmbeddingProvider } from '../../src/services/embeddingProvider.js';
import { MemoryStore } from '../../src/services/memoryStore.js';
import { PeerProfileService } from '../../src/services/peerProfileService.js';
import { SessionMomentService } from '../../src/services/sessionMomentService.js';
import { SharedIntelligenceService } from '../../src/services/sharedIntelligence.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(() => ctx.close());

function seedAgent(): string {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({
    id,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    name: 'Memory Agent',
    adapterType: 'http',
    capabilityTags: [],
    config: {},
    status: 'online',
  }).run();
  return id;
}

function buildCaptureStack() {
  const embedding = new HashingEmbeddingProvider();
  const episodes = new EpisodicMemoryStore(ctx.db, ctx.logger, embedding);
  const shared = new SharedIntelligenceService(ctx.db, ctx.bus, episodes, ctx.logger);
  const queue = new CognitivePromotionQueueWorker(ctx.db, shared, ctx.logger);
  const peers = new PeerProfileService(ctx.db, ctx.bus, ctx.logger);
  const sessionMoments = new SessionMomentService(ctx.db, ctx.bus, ctx.logger);
  const memory = new MemoryStore(ctx.db, ctx.logger);

  peers.queue = queue;
  queue.PeerProfiles = peers;

  return {
    queue,
    peers,
    service: new ChatMemoryCaptureService({
      db: ctx.db,
      logger: ctx.logger,
      peerProfiles: peers,
      sessionMoments,
      brainQueue: queue,
      memory,
    }),
  };
}

describe('ChatMemoryCaptureService', () => {
  it('captures stable instructions once into workspace memory, session moments, and peer updates', async () => {
    const agentId = seedAgent();
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const conversation = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      agentId,
    });
    const userMessage = [
      'Always respond in English.',
      'I prefer TypeScript for code examples.',
      'I am the founder of Nexseed.',
    ].join(' ');
    conversations.appendOutbound({
      workspaceId: ctx.workspace.id,
      conversationId: conversation.id,
      operatorId: ctx.user.id,
      body: userMessage,
    });
    conversations.appendMirrored({
      workspaceId: ctx.workspace.id,
      conversationId: conversation.id,
      sessionMessageId: `chat_${randomUUID()}`,
      authorType: 'agent',
      body: 'Got it. I will keep those preferences in mind.',
    });

    const { queue, service } = buildCaptureStack();
    const result = await service.captureTurn({
      workspaceId: ctx.workspace.id,
      conversationId: conversation.id,
      userId: ctx.user.id,
      agentId,
      userDisplayName: ctx.user.displayName,
      userMessage,
      assistantMessage: 'Got it. I will keep those preferences in mind.',
      finishReason: 'stop',
    });

    expect(result.signals).toBe(3);
    expect(result.peerUpdateJobIds).toHaveLength(2);
    expect(result.sessionMomentId).toBeTruthy();
    expect(result.promotedSessionMoments).toBe(0);
    expect(result.workspaceMemoryIds).toHaveLength(3);

    const workspaceMemory = ctx.db.select().from(schema.workspaceMemory).where(eq(schema.workspaceMemory.workspaceId, ctx.workspace.id)).all();
    expect(workspaceMemory.map((row) => row.kind).sort()).toEqual(['fact', 'preference', 'rule']);
    expect(workspaceMemory.map((row) => row.content).join('\n')).toContain('TypeScript');

    // Operator preferences must NOT be copied into the agent's private brain
    // (memory_episodes scoped to the agent). They live once in workspace memory.
    const agentScoped = ctx.db.select().from(schema.memoryEpisodes).where(eq(schema.memoryEpisodes.scopeId, agentId)).all();
    expect(agentScoped).toHaveLength(0);

    const queued = ctx.db.select().from(schema.cognitivePromotionQueue).where(eq(schema.cognitivePromotionQueue.workspaceId, ctx.workspace.id)).all();
    expect(queued.filter((row) => row.itemType === 'peer_update')).toHaveLength(2);
    expect(queued.filter((row) => row.itemType === 'atom_promotion')).toHaveLength(0);

    await queue.poll();
    await queue.poll();

    const peerProfiles = ctx.db.select().from(schema.peerProfiles).where(eq(schema.peerProfiles.peerId, ctx.user.id)).all();
    expect(peerProfiles).toHaveLength(1);

    const directionalCards = ctx.db.select().from(schema.agentPeerCards).where(eq(schema.agentPeerCards.observerPeerId, agentId)).all();
    expect(directionalCards).toHaveLength(1);

    const conclusions = ctx.db.select().from(schema.peerProfileConclusions).where(eq(schema.peerProfileConclusions.subjectPeerId, ctx.user.id)).all();
    expect(conclusions.map((row) => row.content).join('\n')).toContain('Always respond in English');
  });

  it('does not capture a question as a preference', async () => {
    const agentId = seedAgent();
    const conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
    const conversation = conversations.getOrCreateByAgent({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      agentId,
    });

    const { service } = buildCaptureStack();
    // "how do I like responses?" embeds "I like" but is a question, not a
    // stated preference — it must not become a workspace memory atom.
    const result = await service.captureTurn({
      workspaceId: ctx.workspace.id,
      conversationId: conversation.id,
      userId: ctx.user.id,
      agentId,
      userDisplayName: ctx.user.displayName,
      userMessage: 'how do I like responses?',
      assistantMessage: 'You tend to prefer concise, direct answers.',
      finishReason: 'stop',
    });

    expect(result.signals).toBe(0);
    expect(result.workspaceMemoryIds).toHaveLength(0);
    const workspaceMemory = ctx.db.select().from(schema.workspaceMemory).where(eq(schema.workspaceMemory.workspaceId, ctx.workspace.id)).all();
    expect(workspaceMemory).toHaveLength(0);
  });
});
