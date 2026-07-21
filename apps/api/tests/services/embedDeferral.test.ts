/**
 * Deferred-embedding safety.
 *
 * Write paths do not block on embedding: a sync provider returns a vector inline,
 * an async one returns a Promise and the row is flagged `needsReembed` for the
 * sweep. That promise is INTENTIONALLY discarded — and for a long time it was
 * discarded RAW. Once the embedding circuit breaker started returning a freshly
 * rejected promise per call, every deferred write dropped a rejecting promise on
 * the floor: importing a single App with learned memory produced 161 unhandled
 * rejections, which can take the process down.
 *
 * These tests assert the discard is SAFE. They fail loudly if anyone reintroduces
 * a bare `provider.embed(...)` on a write path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { embedSyncOrDefer, type EmbeddingProvider } from '../../src/services/embedding/embeddingProvider.js';
import { EpisodicMemoryStore } from '../../src/services/episodicMemoryStore.js';
import { SessionMomentService } from '../../src/services/sessionMomentService.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

/** An async provider that always fails — i.e. the model is unavailable. */
const failing: EmbeddingProvider = {
  dimension: 384,
  modelId: 'test:always-fails',
  embed: () => Promise.reject(new Error('embedding model unavailable')),
};

/** A synchronous provider, to prove the inline path still stores a vector. */
const sync: EmbeddingProvider = {
  dimension: 3,
  modelId: 'test:sync',
  embed: () => [0.1, 0.2, 0.3],
};

/** Run `fn`, then settle the microtask queue and report unhandled rejections. */
async function countUnhandledRejections(fn: () => void | Promise<void>): Promise<number> {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown) => { seen.push(reason); };
  // Vitest installs its own handlers; capture ours first so we observe everything.
  process.on('unhandledRejection', onUnhandled);
  try {
    await fn();
    // An unhandled rejection is only reported once the microtask queue drains and
    // the macrotask turn ends — wait for both.
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  return seen.length;
}

describe('embedSyncOrDefer', () => {
  it('returns the vector inline for a synchronous provider', () => {
    expect(embedSyncOrDefer(sync, 'hello')).toEqual([0.1, 0.2, 0.3]);
  });

  it('returns null for an async provider WITHOUT leaking an unhandled rejection', async () => {
    const unhandled = await countUnhandledRejections(() => {
      expect(embedSyncOrDefer(failing, 'hello')).toBeNull();
    });
    expect(unhandled).toBe(0);
  });

  it('stays quiet across many deferred writes (the 161-rejection case)', async () => {
    const unhandled = await countUnhandledRejections(() => {
      for (let i = 0; i < 200; i += 1) embedSyncOrDefer(failing, `atom ${i}`);
    });
    expect(unhandled).toBe(0);
  });
});

describe('write paths with an unavailable model', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestContext(); });
  afterEach(() => ctx.close());

  it('EpisodicMemoryStore.write defers quietly and flags the row for re-embedding', async () => {
    const store = new EpisodicMemoryStore(ctx.db, ctx.logger, failing);
    let written: { id: string } | null = null;
    const unhandled = await countUnhandledRejections(() => {
      // Mirrors an App import carrying Brain atoms — the exact path that produced
      // one unhandled rejection per atom.
      for (let i = 0; i < 25; i += 1) {
        written = store.write({
          workspaceId: ctx.workspace.id,
          type: 'observation',
          title: `Atom ${i}`,
          summary: 'imported memory',
          source: 'seed',
        });
      }
    });
    expect(unhandled).toBe(0);
    expect(written).not.toBeNull();
    // The write must still succeed — deferral is not data loss.
    const rows = store.list({ workspaceId: ctx.workspace.id, limit: 100 });
    expect(rows).toHaveLength(25);
  });

  it('SessionMomentService.add defers quietly too', async () => {
    const moments = new SessionMomentService(ctx.db, ctx.bus, ctx.logger, () => failing);
    const unhandled = await countUnhandledRejections(() => {
      for (let i = 0; i < 10; i += 1) {
        moments.add({ workspaceId: ctx.workspace.id, sessionId: 's1', content: `moment ${i}` });
      }
    });
    expect(unhandled).toBe(0);
    expect(moments.list({ workspaceId: ctx.workspace.id, sessionId: 's1' })).toHaveLength(10);
  });
});
