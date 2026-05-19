/**
 * Brain & Abilities Replan — foundation validation.
 *
 * Covers the closed learning loop: durable promotion queue (BL10),
 * embedding-aware promotion (B4), brain context injection at dispatch (B2),
 * and the evaluator → brain feedback loop (Gap14).
 */

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { CollectiveBrainService } from '../../src/services/collectiveBrain.js';
import { BrainPromotionQueueWorker } from '../../src/services/brainPromotionQueueWorker.js';
import { EpisodicMemoryStore } from '../../src/services/episodicMemoryStore.js';
import { HashingEmbeddingProvider } from '../../src/services/embeddingProvider.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let brain: CollectiveBrainService;
let worker: BrainPromotionQueueWorker;

beforeEach(async () => {
  ctx = await createTestContext();
  brain = new CollectiveBrainService(
    ctx.db,
    ctx.bus,
    new EpisodicMemoryStore(ctx.db, ctx.logger, new HashingEmbeddingProvider()),
    ctx.logger,
  );
  worker = new BrainPromotionQueueWorker(ctx.db, brain, ctx.logger);
});

afterEach(() => {
  ctx.close();
});

describe('BrainPromotionQueueWorker (BL10)', () => {
  it('durably enqueues and processes an atom_promotion through embedding-aware promotion', async () => {
    worker.enqueue({
      workspaceId: ctx.workspace.id,
      itemType: 'atom_promotion',
      priority: 'normal',
      payload: {
        workspaceId: ctx.workspace.id,
        appId: null,
        runId: randomUUID(),
        taskOutput: {
          summary:
            'Observed that the Stripe checkout API returns rate limit responses after 100 requests per minute, so future calls should use exponential backoff.',
        },
      },
    });

    // Row is durable and pending before the worker runs.
    const pending = ctx.db.select().from(schema.brainPromotionQueue).all();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.status).toBe('pending');

    await worker.poll();

    const done = ctx.db.select().from(schema.brainPromotionQueue).all();
    expect(done[0]?.status).toBe('done');

    const episodes = ctx.db.select().from(schema.memoryEpisodes)
      .where(eq(schema.memoryEpisodes.workspaceId, ctx.workspace.id))
      .all();
    expect(episodes.length).toBeGreaterThan(0);
    // B5/B6 — promoted atoms are active + managed (decay-eligible).
    expect(episodes[0]?.status).toBe('active');
    expect(episodes[0]?.managed).toBe(true);
    // B4 — a real embedding vector was stored for semantic retrieval.
    expect(episodes[0]?.embedding).toBeTruthy();
  });

  it('processes high priority before normal', async () => {
    worker.enqueue({
      workspaceId: ctx.workspace.id,
      itemType: 'peer_update',
      priority: 'normal',
      payload: { workspaceId: ctx.workspace.id },
    });
    worker.enqueue({
      workspaceId: ctx.workspace.id,
      itemType: 'peer_update',
      priority: 'high',
      payload: { workspaceId: ctx.workspace.id },
    });
    await worker.poll();
    const rows = ctx.db.select().from(schema.brainPromotionQueue).all();
    expect(rows.every((r) => r.status === 'done')).toBe(true);
  });

  it('limits dream_pass work to one concurrent item per workspace', async () => {
    let releaseDreamPass!: () => void;
    const runningDreamPass = new Promise<void>((resolve) => {
      releaseDreamPass = resolve;
    });
    const run = vi.fn(() => runningDreamPass);
    worker.dreaming = { run } as unknown as NonNullable<BrainPromotionQueueWorker['dreaming']>;

    worker.enqueue({
      workspaceId: ctx.workspace.id,
      itemType: 'dream_pass',
      priority: 'low',
      payload: { workspaceId: ctx.workspace.id, peerId: randomUUID(), peerType: 'user' },
    });
    worker.enqueue({
      workspaceId: ctx.workspace.id,
      itemType: 'dream_pass',
      priority: 'low',
      payload: { workspaceId: ctx.workspace.id, peerId: randomUUID(), peerType: 'user' },
    });

    const poll = worker.poll();
    expect(run).toHaveBeenCalledTimes(1);

    const rowsWhileRunning = ctx.db.select().from(schema.brainPromotionQueue).all();
    expect(rowsWhileRunning.filter((row) => row.status === 'processing')).toHaveLength(1);
    expect(rowsWhileRunning.filter((row) => row.status === 'pending')).toHaveLength(1);

    releaseDreamPass();
    await poll;

    const rowsAfterFirstPass = ctx.db.select().from(schema.brainPromotionQueue).all();
    expect(rowsAfterFirstPass.filter((row) => row.status === 'done')).toHaveLength(1);
    expect(rowsAfterFirstPass.filter((row) => row.status === 'pending')).toHaveLength(1);
  });
});

describe('Brain dispatch injection + evaluator feedback (B2 + Gap14)', () => {
  it('injects relevant atoms at dispatch and lets evaluator verdicts move their confidence', async () => {
    const runId = randomUUID();

    // Seed the brain with a fact via the embedding-aware promotion path.
    await brain.promote({
      workspaceId: ctx.workspace.id,
      taskOutput: {
        summary:
          'Cold outreach emails with short subject lines that include the company name produced a 2x reply rate for enterprise prospects.',
      },
    });

    // B2 — dispatch a related task; relevant atoms should be retrieved.
    const dispatch = await brain.buildDispatchContext({
      workspaceId: ctx.workspace.id,
      runId,
      taskDescription: 'Write a cold outreach email subject line for an enterprise prospect',
    });
    expect(dispatch.block).toContain('WORKSPACE BRAIN');
    expect(dispatch.atomIds.length).toBeGreaterThan(0);

    // The injection was recorded so the evaluator loop can find it.
    const injected = ctx.db.select().from(schema.brainQualityEvents)
      .where(and(
        eq(schema.brainQualityEvents.runId, runId),
        eq(schema.brainQualityEvents.eventType, 'atom_injected'),
      ))
      .all();
    expect(injected.length).toBe(dispatch.atomIds.length);

    const atomId = dispatch.atomIds[0]!;
    const before = ctx.db.select().from(schema.memoryEpisodes)
      .where(eq(schema.memoryEpisodes.id, atomId)).get();

    // Gap14 — a PASS verdict credits the injected atoms.
    const result = brain.applyEvaluatorVerdict({
      workspaceId: ctx.workspace.id,
      runId,
      verdict: 'pass',
      evaluatorConfidence: 0.9,
    });
    expect(result.adjusted).toBeGreaterThan(0);

    const after = ctx.db.select().from(schema.memoryEpisodes)
      .where(eq(schema.memoryEpisodes.id, atomId)).get();
    expect(Number(after?.confidence)).toBeGreaterThan(Number(before?.confidence));

    // A FAIL verdict penalises them.
    brain.applyEvaluatorVerdict({
      workspaceId: ctx.workspace.id,
      runId,
      verdict: 'fail',
    });
    const afterFail = ctx.db.select().from(schema.memoryEpisodes)
      .where(eq(schema.memoryEpisodes.id, atomId)).get();
    expect(Number(afterFail?.confidence)).toBeLessThan(Number(after?.confidence));
  });
});
