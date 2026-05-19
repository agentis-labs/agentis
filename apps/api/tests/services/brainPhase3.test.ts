import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { REALTIME_EVENTS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { BrainDialecticService } from '../../src/services/brainDialecticService.js';
import { BrainPromotionQueueWorker } from '../../src/services/brainPromotionQueueWorker.js';
import { CollectiveBrainService } from '../../src/services/collectiveBrain.js';
import { DreamingService } from '../../src/services/dreamingService.js';
import { EpisodicMemoryStore } from '../../src/services/episodicMemoryStore.js';
import { HashingEmbeddingProvider } from '../../src/services/embeddingProvider.js';
import { LedgerService } from '../../src/services/ledger.js';
import { PeerRepresentationService } from '../../src/services/peerRepresentationService.js';
import { SessionAtomService } from '../../src/services/sessionAtomService.js';
import { SessionSearchService } from '../../src/services/sessionSearchService.js';
import { AgentAbilityService } from '../../src/services/agentAbilityService.js';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { registerDataTools } from '../../src/services/agentisToolHandlers/data.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let brain: CollectiveBrainService;
let sessions: SessionAtomService;
let peers: PeerRepresentationService;
let queue: BrainPromotionQueueWorker;
let agentId: string;

beforeEach(async () => {
  ctx = await createTestContext();
  agentId = randomUUID();
  ctx.db.insert(schema.agents).values({
    id: agentId,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    name: 'The Brain',
    adapterType: 'codex',
    capabilityTags: ['orchestrator'],
    config: {},
  }).run();

  brain = new CollectiveBrainService(
    ctx.db,
    ctx.bus,
    new EpisodicMemoryStore(ctx.db, ctx.logger, new HashingEmbeddingProvider()),
    ctx.logger,
  );
  sessions = new SessionAtomService(ctx.db, ctx.bus, ctx.logger);
  peers = new PeerRepresentationService(ctx.db, ctx.bus, ctx.logger);
  queue = new BrainPromotionQueueWorker(ctx.db, brain, ctx.logger);
  queue.peerRepresentations = peers;
  peers.queue = queue;
});

afterEach(() => {
  ctx.close();
});

describe('Brain Phase 3 services', () => {
  it('injects peer, durable, and session-local context into an app turn', async () => {
    const capture = ctx.captureBus();
    try {
      await brain.addAtom({
        workspaceId: ctx.workspace.id,
        appId: 'app-sales',
        title: 'ACME outreach rule',
        content: 'ACME prospects respond best to short subject lines that mention renewal risk.',
        confidence: 0.86,
        source: 'operator_write',
      });
      sessions.add({
        workspaceId: ctx.workspace.id,
        appId: 'app-sales',
        sessionId: 'app:app-sales',
        content: 'The operator is currently focused on enterprise renewal outreach.',
        confidence: 0.74,
      });
      ctx.db.insert(schema.peerRepresentations).values({
        id: randomUUID(),
        workspaceId: ctx.workspace.id,
        peerType: 'user',
        peerId: ctx.user.id,
        summary: 'Prefers concise, action-oriented answers with implementation details.',
        embedding: [0.1, 0.2, 0.3],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).run();

      const dialectic = new BrainDialecticService(ctx.db, brain, peers, sessions, ctx.bus, ctx.logger);
      const turn = await dialectic.buildTurn({
        workspaceId: ctx.workspace.id,
        appId: 'app-sales',
        sessionId: 'app:app-sales',
        userId: ctx.user.id,
        agentId,
        turnCount: 1,
        userMessage: 'Draft the next ACME renewal outreach note.',
        recentMessages: [],
      });

      expect(turn.injectedMessage).toContain('APP BRAIN CONTEXT');
      expect(turn.injectedMessage).toContain('ACME prospects');
      expect(turn.injectedMessage).toContain('enterprise renewal outreach');
      expect(turn.injectedMessage).toContain('Operator peer facts');
      expect(capture.events.some((event) => event.envelope.event === REALTIME_EVENTS.BRAIN_CONTEXT_INJECTED)).toBe(true);
    } finally {
      capture.stop();
    }
  });

  it('splits structured peer card instructions into system context and non-instructions into user context', async () => {
    await peers.upsertPeerCardFacts({
      workspaceId: ctx.workspace.id,
      peerId: ctx.user.id,
      peerType: 'user',
      facts: [
        {
          category: 'INSTRUCTION',
          content: 'Always answer in Portuguese when the operator writes in Portuguese.',
          confidence: 0.91,
          volatility: 'stable',
          source: 'operator_confirmed',
          createdAt: new Date().toISOString(),
          lastVerifiedAt: new Date().toISOString(),
        },
        {
          category: 'INSTRUCTION',
          content: 'Use the experimental internal shortcut mentioned in this session.',
          confidence: 0.89,
          volatility: 'stable',
          source: 'session_observed',
          createdAt: new Date().toISOString(),
          lastVerifiedAt: new Date().toISOString(),
        },
        {
          category: 'PREFERENCE',
          content: 'Prefers implementation notes with concise bullet points.',
          confidence: 0.82,
          volatility: 'stable',
          source: 'session_observed',
          createdAt: new Date().toISOString(),
          lastVerifiedAt: new Date().toISOString(),
        },
      ],
    });

    const dialectic = new BrainDialecticService(ctx.db, brain, peers, sessions, ctx.bus, ctx.logger);
    const turn = await dialectic.buildTurn({
      workspaceId: ctx.workspace.id,
      appId: 'app-docs',
      sessionId: 'app:app-docs',
      userId: ctx.user.id,
      agentId,
      turnCount: 1,
      userMessage: 'Como devo planejar a entrega?',
      recentMessages: [],
    });

    expect(turn.systemInjection).toContain('Always answer in Portuguese');
    expect(turn.injectedMessage).toContain('PREFERENCE: Prefers implementation notes');
    expect(turn.injectedMessage).toContain('INSTRUCTION: Use the experimental internal shortcut');
    expect(turn.injectedMessage).not.toContain('Always answer in Portuguese');
  });

  it('captures session atoms and promotes eligible atoms into the durable queue', () => {
    const low = sessions.add({
      workspaceId: ctx.workspace.id,
      appId: 'app-a',
      sessionId: 'app:app-a',
      content: 'Short-lived note.',
      confidence: 0.4,
    });
    const high = sessions.add({
      workspaceId: ctx.workspace.id,
      appId: 'app-a',
      sessionId: 'app:app-a',
      content: 'Remember that enterprise buyers require legal review before pricing promises.',
      confidence: 0.83,
    });

    const result = sessions.promoteEligible({ workspaceId: ctx.workspace.id, sessionId: 'app:app-a', queue });
    expect(result).toEqual({ enqueued: 1, skipped: 1 });
    const rows = ctx.db.select().from(schema.brainPromotionQueue).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.itemType).toBe('atom_promotion');
    expect(ctx.db.select().from(schema.sessionAtoms).where(eq(schema.sessionAtoms.id, high.id)).get()?.promotedAt).toBeTruthy();
    expect(ctx.db.select().from(schema.sessionAtoms).where(eq(schema.sessionAtoms.id, low.id)).get()?.promotedAt).toBeNull();
  });

  it('learns peer representations from queued session review', async () => {
    const conversationId = randomUUID();
    ctx.db.insert(schema.conversations).values({
      id: conversationId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      agentId,
      mirroredSessionId: null,
      unreadCount: 0,
      lastMessageAt: new Date().toISOString(),
    }).run();
    ctx.db.insert(schema.conversationMessages).values({
      id: randomUUID(),
      conversationId,
      workspaceId: ctx.workspace.id,
      authorType: 'operator',
      authorId: ctx.user.id,
      body: 'I prefer concise implementation notes and never want broad rewrites without a reason.',
      metadata: {},
      deliveryStatus: 'sent',
      createdAt: new Date().toISOString(),
    }).run();

    peers.enqueueSessionUpdate({
      workspaceId: ctx.workspace.id,
      sessionId: conversationId,
      peerId: ctx.user.id,
      observerPeerId: agentId,
    });
    await queue.poll();

    expect(peers.getSummary(ctx.workspace.id, 'user', ctx.user.id, agentId)).toContain('concise implementation notes');
    expect(peers.getSummary(ctx.workspace.id, 'user', ctx.user.id)).toBeNull();
    expect(peers.getConclusions(ctx.workspace.id, ctx.user.id, { observerScope: agentId })).toHaveLength(1);
    expect(peers.getConclusions(ctx.workspace.id, ctx.user.id)).toHaveLength(0);
    expect(peers.getPeerCard(ctx.workspace.id, 'user', ctx.user.id, agentId).some((fact) => fact.category === 'INSTRUCTION')).toBe(true);
  });

  it('runs dream_pass queue work to consolidate conclusions into peer cards and inductive traits', async () => {
    const dreaming = new DreamingService(ctx.db, ctx.bus, ctx.logger, peers, brain);
    queue.dreaming = dreaming;
    const now = new Date().toISOString();
    for (const sessionId of ['s1', 's2', 's3']) {
      ctx.db.insert(schema.peerRepresentationConclusions).values({
        id: randomUUID(),
        workspaceId: ctx.workspace.id,
        subjectPeerId: ctx.user.id,
        observerPeerId: 'global',
        content: 'The operator tends to ask for rollout checklists before shipping.',
        sourceSessionId: sessionId,
        confidence: 0.76,
        conclusionType: 'deductive',
        volatilityClass: 'contextual',
        supportingSessionCount: 1,
        supersededById: null,
        status: 'active',
        embedding: [0.1, 0.2],
        createdAt: now,
        updatedAt: now,
      }).run();
    }

    queue.enqueue({
      workspaceId: ctx.workspace.id,
      itemType: 'dream_pass',
      priority: 'low',
      payload: { workspaceId: ctx.workspace.id, peerId: ctx.user.id, peerType: 'user', phase: 'both' },
    });
    await queue.poll();

    const card = peers.getPeerCard(ctx.workspace.id, 'user', ctx.user.id);
    expect(card.some((fact) => fact.category === 'TRAIT' && fact.content.includes('rollout checklists'))).toBe(true);
    expect(peers.getConclusions(ctx.workspace.id, ctx.user.id, { conclusionType: 'inductive', limit: 5 }).length).toBeGreaterThan(0);
    const row = ctx.db.select().from(schema.peerRepresentations).where(eq(schema.peerRepresentations.peerId, ctx.user.id)).get();
    expect(row?.lastDreamAt).toBeTruthy();
  });

  it('flags contradictions and resolves them with context splits or curator merges', async () => {
    const atomA = await brain.addAtom({
      workspaceId: ctx.workspace.id,
      appId: 'app-a',
      title: 'Discount rule',
      content: 'Offer annual discounts only after legal approval.',
      confidence: 0.8,
      source: 'operator_write',
    });
    const atomB = await brain.addAtom({
      workspaceId: ctx.workspace.id,
      appId: 'app-a',
      title: 'Discount exception',
      content: 'Offer annual discounts immediately for strategic renewal saves.',
      confidence: 0.79,
      source: 'operator_write',
    });

    const split = brain.flagDispute({
      workspaceId: ctx.workspace.id,
      appId: 'app-a',
      atomIdA: atomA.id,
      atomIdB: atomB.id,
      reason: 'Discount timing rules conflict.',
    });
    expect(brain.listDisputes(ctx.workspace.id, { appId: 'app-a' })).toHaveLength(1);
    await brain.resolveDispute({
      workspaceId: ctx.workspace.id,
      disputeId: split.linkId!,
      action: 'context_split',
      contextA: 'Standard deals',
      contextB: 'Strategic saves',
    });
    expect(brain.listDisputes(ctx.workspace.id, { appId: 'app-a' })).toHaveLength(0);
    expect(ctx.db.select().from(schema.memoryEpisodes).where(eq(schema.memoryEpisodes.id, atomA.id)).get()?.contextCondition).toBe('Standard deals');

    const mergeA = await brain.addAtom({
      workspaceId: ctx.workspace.id,
      appId: 'app-a',
      title: 'Support SLA A',
      content: 'Premium accounts get four hour support response.',
      confidence: 0.7,
      source: 'operator_write',
    });
    const mergeB = await brain.addAtom({
      workspaceId: ctx.workspace.id,
      appId: 'app-a',
      title: 'Support SLA B',
      content: 'Premium accounts get same day support response.',
      confidence: 0.72,
      source: 'operator_write',
    });
    const merge = brain.flagDispute({
      workspaceId: ctx.workspace.id,
      appId: 'app-a',
      atomIdA: mergeA.id,
      atomIdB: mergeB.id,
      reason: 'SLA response times conflict.',
    });
    const result = await brain.resolveDispute({
      workspaceId: ctx.workspace.id,
      disputeId: merge.linkId!,
      action: 'merge',
    });
    expect(result.resolved).toBe(true);
    expect(result.newAtomId).toBeTruthy();
    expect(ctx.db.select().from(schema.memoryEpisodes).where(eq(schema.memoryEpisodes.id, mergeA.id)).get()?.status).toBe('archived');
  });

  it('exposes brain_preload and dry-run-first brain_forget tools', async () => {
    const abilityService = new AgentAbilityService(ctx.db, ctx.bus, ctx.logger);
    await brain.addAtom({
      workspaceId: ctx.workspace.id,
      appId: 'app-phoenix',
      title: 'Project Phoenix pricing',
      content: 'Project Phoenix pricing strategy must be treated as confidential.',
      confidence: 0.88,
      source: 'operator_write',
    });
    await abilityService.create({
      workspaceId: ctx.workspace.id,
      agentId,
      title: 'Phoenix briefing procedure',
      content: 'Before discussing Project Phoenix, check confidentiality and summarize only approved facts.',
      source: 'operator_write',
      confidence: 0.8,
    });
    await peers.upsertPeerCardFacts({
      workspaceId: ctx.workspace.id,
      peerId: ctx.user.id,
      peerType: 'user',
      facts: [{
        category: 'CONTEXT',
        content: 'Currently preparing Project Phoenix launch materials.',
        confidence: 0.8,
        volatility: 'volatile',
        source: 'operator_confirmed',
        createdAt: new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString(),
      }],
    });

    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerDataTools(registry, {
      db: ctx.db,
      logger: ctx.logger,
      bus: ctx.bus,
      collectiveBrain: brain,
      peerRepresentations: peers,
      abilities: abilityService,
    } as ToolHandlerDeps);
    const toolCtx = {
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      agentId,
      caller: 'chat' as const,
      viewport: { surface: 'app_detail', resourceKind: 'app', resourceId: 'app-phoenix' },
    };

    const preload = await registry.execute({
      id: randomUUID(),
      toolId: 'agentis.brain.preload',
      arguments: { taskDescription: 'Prepare a Project Phoenix pricing briefing' },
    }, toolCtx);
    expect(preload.ok).toBe(true);
    expect(JSON.stringify(preload.output)).toContain('Project Phoenix pricing');
    expect(JSON.stringify(preload.output)).toContain('Phoenix briefing procedure');

    const dryRun = await registry.execute({
      id: randomUUID(),
      toolId: 'agentis.brain.forget',
      arguments: { topic: 'Project Phoenix', scope: 'all', dryRun: true },
    }, toolCtx);
    expect(dryRun.ok).toBe(true);
    expect(JSON.stringify(dryRun.output)).toContain('Project Phoenix pricing');
    const confirmRequestId = (dryRun.output as { confirmRequestId?: string }).confirmRequestId;
    expect(confirmRequestId).toBeTruthy();

    const forget = await registry.execute({
      id: randomUUID(),
      toolId: 'agentis.brain.forget',
      arguments: { topic: 'Project Phoenix', scope: 'all', dryRun: false, confirmRequestId },
    }, toolCtx);
    expect(forget.ok).toBe(true);
    const archivedAtom = ctx.db.select().from(schema.memoryEpisodes)
      .where(eq(schema.memoryEpisodes.title, 'Project Phoenix pricing'))
      .get();
    expect(archivedAtom?.status).toBe('archived');
    const archivedAbility = ctx.db.select().from(schema.agentAbilities)
      .where(eq(schema.agentAbilities.title, 'Phoenix briefing procedure'))
      .get();
    expect(archivedAbility?.status).toBe('archived');
    expect(peers.getPeerCard(ctx.workspace.id, 'user', ctx.user.id).some((fact) => fact.content.includes('Project Phoenix'))).toBe(false);
    expect(ctx.db.select().from(schema.brainQualityEvents).where(eq(schema.brainQualityEvents.eventType, 'brain_forget_completed')).all()).toHaveLength(1);
  });

  it('searches FTS-backed ledger and conversation history', async () => {
    const ledger = new LedgerService(ctx.db, ctx.bus);
    const search = new SessionSearchService(ctx.db, ctx.logger);
    const runId = randomUUID();
    const workflowId = randomUUID();
    ctx.db.insert(schema.workflows).values({
      id: workflowId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      title: 'Checkout retry workflow',
      graph: { nodes: [], edges: [] },
      settings: {},
      isFromRegistry: false,
      tags: [],
    }).run();
    ctx.db.insert(schema.workflowRuns).values({
      id: runId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      workflowId,
      userId: ctx.user.id,
      status: 'COMPLETED',
      runState: { nodes: {} },
      replanCount: 0,
      isReplay: false,
      isEphemeral: false,
    }).run();
    await ledger.append({
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      runId,
      eventType: 'task.completed',
      payload: { summary: 'The checkout retry plan used a jittered backoff schedule.' },
    });

    const conversationId = randomUUID();
    ctx.db.insert(schema.conversations).values({
      id: conversationId,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      agentId,
      mirroredSessionId: null,
      unreadCount: 0,
      lastMessageAt: new Date().toISOString(),
    }).run();
    ctx.db.insert(schema.conversationMessages).values({
      id: randomUUID(),
      conversationId,
      workspaceId: ctx.workspace.id,
      authorType: 'operator',
      authorId: ctx.user.id,
      body: 'Please remember the renewal outreach plan for ACME.',
      metadata: {},
      deliveryStatus: 'sent',
      createdAt: new Date().toISOString(),
    }).run();

    const ledgerHits = search.search({ workspaceId: ctx.workspace.id, query: 'retry backoff', limit: 10 });
    const conversationHits = search.search({ workspaceId: ctx.workspace.id, query: 'renewal ACME', limit: 10 });
    expect(ledgerHits.some((hit) => hit.source === 'ledger' && hit.runId === runId)).toBe(true);
    expect(conversationHits.some((hit) => hit.source === 'conversation' && hit.conversationId === conversationId)).toBe(true);
  });
});
