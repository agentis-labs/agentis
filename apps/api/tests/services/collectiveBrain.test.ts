import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { CollectiveBrainService } from '../../src/services/collectiveBrain.js';
import { EpisodicMemoryStore } from '../../src/services/episodicMemoryStore.js';
import { HashingEmbeddingProvider } from '../../src/services/embeddingProvider.js';
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
      expect(graph.nodes.some((node) => node.atomKind === 'episode' && node.label.includes('Stripe checkout'))).toBe(true);
      expect(graph.meta.adapterTypes).toContain('claude_code');
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
});
