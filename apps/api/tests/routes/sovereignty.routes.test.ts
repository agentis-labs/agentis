import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EpisodicMemoryStore } from '../../src/services/episodicMemoryStore.js';
import { buildSovereigntyRoutes } from '../../src/routes/sovereignty.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let episodes: EpisodicMemoryStore;

beforeEach(async () => {
  ctx = await createTestContext();
  episodes = new EpisodicMemoryStore(ctx.db, ctx.logger);
});

afterEach(() => ctx.close());

function app() {
  return ctx.buildApp([
    { path: '/v1/sovereignty', app: buildSovereigntyRoutes({ db: ctx.db, auth: ctx.auth, episodes }) },
  ]);
}

function seed(title: string, source: string) {
  return episodes.write({
    workspaceId: ctx.workspace.id,
    type: 'distilled_lesson',
    title,
    summary: `${title} — body`,
    source,
  });
}

describe('/v1/sovereignty — Your Data ownership surface', () => {
  it('reports what you own, its provenance, and where it lives', async () => {
    seed('Ship on Monday', 'operator_write');
    seed('Prefer pnpm', 'harness_ingest');

    const res = await app().request('/v1/sovereignty/overview', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      storage: { location: string; engine: string };
      counts: { memories: number; agents: number };
      provenance: Array<{ source: string; label: string; count: number }>;
      recent: Array<{ title: string; sourceLabel: string }>;
      agents: unknown[];
    };

    expect(body.storage.location).toBe('local');
    expect(body.storage.engine).toBe('sqlite');
    expect(body.counts.memories).toBe(2);
    expect(body.counts.agents).toBe(0);
    expect(body.recent.map((r) => r.title)).toContain('Ship on Monday');
    // Provenance is labelled + grouped by source.
    const sources = body.provenance.map((p) => p.source);
    expect(sources).toContain('operator_write');
    expect(sources).toContain('harness_ingest');
  });

  it('exports a complete, open copy of your data', async () => {
    seed('Exportable fact', 'operator_write');
    const res = await app().request('/v1/sovereignty/export', { headers: ctx.authHeaders });
    expect(res.status).toBe(200);
    const body = await res.json() as { format: string; counts: { memories: number }; memories: Array<{ title: string }> };
    expect(body.format).toBe('agentis.sovereign-export');
    expect(body.counts.memories).toBe(1);
    expect(body.memories[0]?.title).toBe('Exportable fact');
  });

  it('forgets a memory provably and drops it from the owned set', async () => {
    const ep = seed('Forget me', 'operator_write');

    const del = await app().request(`/v1/sovereignty/memory/${ep.id}`, { method: 'DELETE', headers: ctx.authHeaders });
    expect(del.status).toBe(200);
    const receipt = await del.json() as { ok: boolean; receipt: { id: string; title: string } };
    expect(receipt.ok).toBe(true);
    expect(receipt.receipt.title).toBe('Forget me');

    const after = await app().request('/v1/sovereignty/overview', { headers: ctx.authHeaders });
    const body = await after.json() as { counts: { memories: number } };
    expect(body.counts.memories).toBe(0);

    // Forgetting an unknown id is a clean 404, not a silent success.
    const missing = await app().request(`/v1/sovereignty/memory/${ep.id}`, { method: 'DELETE', headers: ctx.authHeaders });
    expect(missing.status).toBe(404);
  });
});
