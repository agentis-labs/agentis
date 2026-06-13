/**
 * PACER routing inside promote() (Phase 2) — the staging path (no Formation
 * Judge model). Verifies that a procedural lesson is tagged + given a long TTL
 * so it can prove reuse, while bulk evidence stays cold with the short TTL.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EpisodicMemoryStore } from '../src/services/episodicMemoryStore.js';
import { HashingEmbeddingProvider } from '../src/services/embeddingProvider.js';
import { SharedIntelligenceService } from '../src/services/sharedIntelligence.js';
import { createTestContext, type TestContext } from './_helpers/createTestContext.js';

let ctx: TestContext;
let episodes: EpisodicMemoryStore;
let brain: SharedIntelligenceService;

beforeEach(async () => {
  ctx = await createTestContext();
  episodes = new EpisodicMemoryStore(ctx.db, ctx.logger, new HashingEmbeddingProvider());
  // No formation completer wired → staging path.
  brain = new SharedIntelligenceService(ctx.db, ctx.bus, episodes, ctx.logger);
});

afterEach(() => ctx.close());

function staged() {
  return episodes.list({ workspaceId: ctx.workspace.id, includeArchived: true, limit: 500 });
}

function ttlDays(meta: Record<string, unknown>): number {
  const iso = typeof meta.ttlExpiresAt === 'string' ? Date.parse(meta.ttlExpiresAt) : NaN;
  if (!Number.isFinite(iso)) return NaN;
  return Math.round((iso - Date.now()) / 86_400_000);
}

describe('promote() staging — PACER routing', () => {
  it('stages a procedural lesson as pacer:procedural with a long TTL', async () => {
    await brain.promote({
      workspaceId: ctx.workspace.id,
      taskTitle: 'API integration',
      taskOutput: 'Always retry the Stripe webhook handler with idempotency keys, otherwise duplicate charges occur on redelivery.',
      memoryPolicy: 'form',
      originSurface: 'run_completion',
    });
    const rows = staged();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const proc = rows.find((r) => r.tags.includes('pacer:procedural'));
    expect(proc).toBeTruthy();
    expect(proc!.tags).toContain('unconsolidated');
    expect(ttlDays(proc!.metadata)).toBeGreaterThan(40); // ~60d, not the 14d evidence floor
  });

  it('stages bulk evidence as pacer:evidence with the short TTL', async () => {
    await brain.promote({
      workspaceId: ctx.workspace.id,
      taskTitle: 'Scrape run',
      taskOutput: 'Observed that the GitHub search endpoint returns at most 1000 results per query.',
      memoryPolicy: 'form',
      originSurface: 'tool_output',
    });
    const ev = staged().find((r) => r.tags.includes('pacer:evidence'));
    expect(ev).toBeTruthy();
    expect(ttlDays(ev!.metadata)).toBeLessThanOrEqual(20); // ~14d cold evidence
  });
});
