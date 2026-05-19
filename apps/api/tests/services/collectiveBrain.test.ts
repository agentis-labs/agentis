import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { CollectiveBrainService } from '../../src/services/collectiveBrain.js';
import { EpisodicMemoryStore } from '../../src/services/episodicMemoryStore.js';
import { HashingEmbeddingProvider } from '../../src/services/embeddingProvider.js';
import { KnowledgeBaseService } from '../../src/services/knowledgeBase.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let service: CollectiveBrainService;
let agentId: string;

beforeEach(async () => {
  ctx = await createTestContext();
  agentId = randomUUID();
  ctx.db.insert(schema.agents).values({
    id: agentId,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    name: 'Claude Builder',
    adapterType: 'claude_code',
    capabilityTags: ['build'],
    config: {},
  }).run();
  service = new CollectiveBrainService(
    ctx.db,
    ctx.bus,
    new EpisodicMemoryStore(ctx.db, ctx.logger, new HashingEmbeddingProvider()),
    ctx.logger,
  );
});

afterEach(() => {
  ctx.close();
});

describe('CollectiveBrainService', () => {
  it('auto-promotes agent task output into the workspace brain graph', () => {
    const capture = ctx.captureBus();
    try {
      const summary = service.extractAndPromote({
        workspaceId: ctx.workspace.id,
        runId: randomUUID(),
        workflowId: randomUUID(),
        nodeId: 'agent-node',
        agentId,
        taskOutput: {
          summary: 'Observed that Stripe checkout returns rate limit responses after 100 requests per minute, so future calls should use exponential backoff.',
        },
      });

      expect(summary.created).toBe(1);
      const episodes = ctx.db.select().from(schema.memoryEpisodes)
        .where(eq(schema.memoryEpisodes.workspaceId, ctx.workspace.id))
        .all();
      expect(episodes).toHaveLength(1);
      expect(episodes[0]?.agentId).toBe(agentId);

      const graph = service.getGraph(ctx.workspace.id);
      const promotedNode = graph.nodes.find((node) => node.atomKind === 'episode' && node.label.includes('Stripe checkout'));
      expect(promotedNode).toBeTruthy();
      expect(graph.meta.adapterTypes).toContain('claude_code');
      const detail = service.getNode(ctx.workspace.id, promotedNode!.id);
      expect(detail?.content).toContain('Stripe checkout returns rate limit responses');
      expect(detail?.provenance.createdBy).toBe('Claude Builder');
      expect(detail?.usedBy).toContainEqual(expect.objectContaining({
        type: 'agent',
        name: 'Claude Builder',
      }));
      expect(capture.events).toContainEqual(expect.objectContaining({
        room: REALTIME_ROOMS.workspace(ctx.workspace.id),
        envelope: expect.objectContaining({ event: REALTIME_EVENTS.BRAIN_ATOM_CREATED }),
      }));
    } finally {
      capture.stop();
    }
  });

  it('reinforces matching facts instead of duplicating them', () => {
    const first = service.extractAndPromote({
      workspaceId: ctx.workspace.id,
      runId: randomUUID(),
      workflowId: randomUUID(),
      nodeId: 'agent-node',
      agentId,
      taskOutput: {
        result: 'Observed that Stripe checkout returns rate limit responses after 100 requests per minute, so future calls should use exponential backoff.',
      },
    });
    const second = service.extractAndPromote({
      workspaceId: ctx.workspace.id,
      runId: randomUUID(),
      workflowId: randomUUID(),
      nodeId: 'agent-node',
      agentId,
      taskOutput: {
        result: 'Observed that Stripe checkout returns rate limit responses after 100 requests per minute, so future calls should use exponential backoff.',
      },
    });

    expect(first.created).toBe(1);
    expect(second.reinforced).toBe(1);
    const episodes = ctx.db.select().from(schema.memoryEpisodes)
      .where(eq(schema.memoryEpisodes.workspaceId, ctx.workspace.id))
      .all();
    expect(episodes).toHaveLength(1);
    expect(Number(episodes[0]?.confidence)).toBeGreaterThan(0.58);
  });

  it('persists semantic links and exposes them in graph payloads', () => {
    const source = new EpisodicMemoryStore(ctx.db, ctx.logger, new HashingEmbeddingProvider()).write({
      workspaceId: ctx.workspace.id,
      type: 'distilled_lesson',
      title: 'Stripe retry rule',
      summary: 'Use exponential backoff after Stripe checkout rate limit responses.',
      source: 'operator_write',
      confidence: 0.9,
      trust: 0.9,
      importance: 0.8,
    });
    const target = new EpisodicMemoryStore(ctx.db, ctx.logger, new HashingEmbeddingProvider()).write({
      workspaceId: ctx.workspace.id,
      type: 'distilled_lesson',
      title: 'Stripe rate limit observation',
      summary: 'Stripe checkout returns rate limit responses after 100 requests per minute.',
      source: 'operator_write',
      confidence: 0.9,
      trust: 0.9,
      importance: 0.8,
    });

    const link = service.createLink({
      workspaceId: ctx.workspace.id,
      sourceId: source.id,
      sourceKind: 'episode',
      targetId: target.id,
      targetKind: 'episode',
      relation: 'supports',
      confidence: 0.8,
      agentId,
      adapterType: 'claude_code',
    });

    expect(link?.relation).toBe('supports');
    const graph = service.getGraph(ctx.workspace.id);
    expect(graph.links).toHaveLength(1);
    expect(graph.links[0]?.source).toBe(`episode:${source.id}`);
    expect(graph.links[0]?.target).toBe(`episode:${target.id}`);

    const stored = ctx.db.select().from(schema.knowledgeLinks)
      .where(and(eq(schema.knowledgeLinks.workspaceId, ctx.workspace.id), eq(schema.knowledgeLinks.id, link!.id)))
      .get();
    expect(stored?.adapterType).toBe('claude_code');
  });

  it('archives atoms and removes their graph links', () => {
    const source = new EpisodicMemoryStore(ctx.db, ctx.logger, new HashingEmbeddingProvider()).write({
      workspaceId: ctx.workspace.id,
      type: 'distilled_lesson',
      title: 'Old retry rule',
      summary: 'Old retry rule that should leave the graph.',
      source: 'operator_write',
      confidence: 0.9,
      trust: 0.9,
      importance: 0.8,
    });
    const target = new EpisodicMemoryStore(ctx.db, ctx.logger, new HashingEmbeddingProvider()).write({
      workspaceId: ctx.workspace.id,
      type: 'distilled_lesson',
      title: 'Current retry rule',
      summary: 'Current retry rule that remains active.',
      source: 'operator_write',
      confidence: 0.9,
      trust: 0.9,
      importance: 0.8,
    });

    service.createLink({
      workspaceId: ctx.workspace.id,
      sourceId: source.id,
      sourceKind: 'episode',
      targetId: target.id,
      targetKind: 'episode',
      relation: 'refines',
      confidence: 0.8,
    });

    expect(service.archiveAtom(ctx.workspace.id, 'episode', source.id)).toBe(true);
    const graph = service.getGraph(ctx.workspace.id);
    expect(graph.nodes.some((node) => node.atomId === source.id)).toBe(false);
    expect(graph.links.some((link) => link.sourceAtomId === source.id || link.targetAtomId === source.id)).toBe(false);
  });

  it('hides archived document chunks and their stale links from the workspace graph', () => {
    const knowledge = new KnowledgeBaseService(ctx.db);
    const base = knowledge.createKnowledgeBase({ workspaceId: ctx.workspace.id, name: 'Workspace Docs' });
    const document = knowledge.addDocument({
      workspaceId: ctx.workspace.id,
      knowledgeBaseId: base.id,
      name: 'Retry playbook.md',
      content: 'Retry failures should use exponential backoff and preserve the customer request id.',
    });
    const chunk = ctx.db.select().from(schema.kbChunks)
      .where(and(eq(schema.kbChunks.workspaceId, ctx.workspace.id), eq(schema.kbChunks.documentId, document.id)))
      .get();
    expect(chunk).toBeTruthy();

    const episode = new EpisodicMemoryStore(ctx.db, ctx.logger, new HashingEmbeddingProvider()).write({
      workspaceId: ctx.workspace.id,
      type: 'distilled_lesson',
      title: 'Retry lesson',
      summary: 'Use exponential backoff for retry failures.',
      source: 'operator_write',
      confidence: 0.9,
      trust: 0.9,
      importance: 0.8,
    });
    service.createLink({
      workspaceId: ctx.workspace.id,
      sourceId: chunk!.id,
      sourceKind: 'kb_chunk',
      targetId: episode.id,
      targetKind: 'episode',
      relation: 'supports',
      confidence: 0.8,
    });

    expect(service.getGraph(ctx.workspace.id).nodes.some((node) => node.atomId === chunk!.id)).toBe(true);

    knowledge.archiveDocument(ctx.workspace.id, base.id, document.id);
    const graph = service.getGraph(ctx.workspace.id);
    expect(graph.nodes.some((node) => node.atomId === chunk!.id)).toBe(false);
    expect(graph.links.some((link) => link.sourceAtomId === chunk!.id || link.targetAtomId === chunk!.id)).toBe(false);
  });

  it('keeps app graphs app-local unless workspace atoms are explicitly requested', () => {
    const episodes = new EpisodicMemoryStore(ctx.db, ctx.logger, new HashingEmbeddingProvider());
    const appEpisode = episodes.write({
      workspaceId: ctx.workspace.id,
      appId: 'app-a',
      type: 'distilled_lesson',
      title: 'App local lesson',
      summary: 'This lesson belongs to one app.',
      source: 'operator_write',
      confidence: 0.9,
      trust: 0.9,
      importance: 0.8,
    });
    const workspaceEpisode = episodes.write({
      workspaceId: ctx.workspace.id,
      type: 'distilled_lesson',
      title: 'Workspace lesson',
      summary: 'This lesson belongs to the workspace.',
      source: 'operator_write',
      confidence: 0.9,
      trust: 0.9,
      importance: 0.8,
    });

    const appGraph = service.getGraph(ctx.workspace.id, { scope: 'app', appId: 'app-a' });
    expect(appGraph.nodes.some((node) => node.atomId === appEpisode.id)).toBe(true);
    expect(appGraph.nodes.some((node) => node.atomId === workspaceEpisode.id)).toBe(false);

    const appWithWorkspace = service.getGraph(ctx.workspace.id, { scope: 'app', appId: 'app-a', includeWorkspace: true });
    expect(appWithWorkspace.nodes.some((node) => node.atomId === workspaceEpisode.id)).toBe(true);
  });
});
