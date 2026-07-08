/**
 * SessionMomentService.reembedPending — backfills embeddings the write path
 * deferred for an async provider. Without this sweep, a session atom written
 * under the default (async ONNX) embedder stays `needsReembed=1` with a null
 * vector forever and is never semantically seekable (the recall gap the boot
 * re-embed sweep now closes).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { SessionMomentService } from '../../src/services/sessionMomentService.js';
import type { EmbeddingProvider } from '../../src/services/embedding/embeddingProvider.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => { ctx.close(); });

// An async provider: `embed()` returns a Promise, so `add()` cannot resolve it
// synchronously and defers (stores null vector + needsReembed=1) — the exact
// situation the default local ONNX embedder creates.
const asyncProvider: EmbeddingProvider = {
  dimension: 3,
  modelId: 'test-embed-v1',
  embed: async () => [0.1, 0.2, 0.3],
};

describe('SessionMomentService.reembedPending', () => {
  it('backfills a deferred embedding and clears the needsReembed flag', async () => {
    const svc = new SessionMomentService(ctx.db, ctx.bus, ctx.logger, () => asyncProvider);
    const atom = svc.add({ workspaceId: ctx.workspace.id, sessionId: 's1', content: 'remember the alamo' });

    const before = ctx.db.select().from(schema.sessionMoments).where(eq(schema.sessionMoments.id, atom.id)).get();
    expect(before?.needsReembed).toBe(true);
    expect(before?.embedding).toBeNull();

    const embedded = await svc.reembedPending(ctx.workspace.id);
    expect(embedded).toBe(1);

    const after = ctx.db.select().from(schema.sessionMoments).where(eq(schema.sessionMoments.id, atom.id)).get();
    expect(after?.needsReembed).toBe(false);
    expect(after?.embedding).not.toBeNull();
    expect(after?.embeddingModel).toBe('test-embed-v1');
    expect(after?.embeddingDims).toBe(3);
  });

  it('is a no-op when there is no embedding provider for the workspace', async () => {
    const svc = new SessionMomentService(ctx.db, ctx.bus, ctx.logger, () => undefined);
    svc.add({ workspaceId: ctx.workspace.id, sessionId: 's1', content: 'lexical only' });
    expect(await svc.reembedPending(ctx.workspace.id)).toBe(0);
  });
});
