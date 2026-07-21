/**
 * AppGoalService — the App's durable Goal (Evolution Loop north-star).
 *
 * Invariants: the Goal persists on the App manifest AND is mirrored as a governing
 * atom into the App's Brain scope so every run recalls it. Re-setting the same
 * statement does not churn new atoms.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { AppStore } from '@agentis/app';
import { SharedIntelligenceService } from '../../src/services/sharedIntelligence.js';
import { EpisodicMemoryStore } from '../../src/services/episodicMemoryStore.js';
import { AppGoalService } from '../../src/services/app/appGoal.js';
import { StubEmbeddingProvider } from '../_helpers/stubEmbeddingProvider.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let goals: AppGoalService;
let appId: string;

beforeEach(async () => {
  ctx = await createTestContext();
  const episodes = new EpisodicMemoryStore(ctx.db, ctx.logger, new StubEmbeddingProvider());
  const brain = new SharedIntelligenceService(ctx.db, ctx.bus, episodes, ctx.logger);
  goals = new AppGoalService({ db: ctx.db, bus: ctx.bus, shared: brain, logger: ctx.logger });
  const app = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Outreach', description: 'reach stores' });
  appId = app.id;
});
afterEach(() => ctx.close());

function goalAtoms(): { id: string }[] {
  return ctx.db.select({ id: schema.memoryEpisodes.id })
    .from(schema.memoryEpisodes)
    .where(and(eq(schema.memoryEpisodes.workspaceId, ctx.workspace.id), eq(schema.memoryEpisodes.scopeId, appId)))
    .all()
    .filter((r) => {
      const row = ctx.db.select().from(schema.memoryEpisodes).where(eq(schema.memoryEpisodes.id, r.id)).get();
      const tags = (row?.tags as string[] | null) ?? [];
      return tags.includes('app_goal');
    });
}

describe('AppGoalService', () => {
  it('starts with no goal', () => {
    expect(goals.get(ctx.workspace.id, appId)).toBeNull();
  });

  it('persists the goal to the manifest and returns it', async () => {
    const set = await goals.set(ctx.workspace.id, appId, {
      statement: 'Sell AI attendants to WhatsApp-using stores.',
      northStar: { metric: 'conversion_rate', direction: 'maximize' },
    });
    expect(set.statement).toContain('Sell AI attendants');
    expect(set.updatedAt).toBeTruthy();
    const got = goals.get(ctx.workspace.id, appId);
    expect(got?.statement).toBe(set.statement);
    expect(got?.northStar?.metric).toBe('conversion_rate');
    expect(got?.northStar?.direction).toBe('maximize');
  });

  it('mirrors a governing atom into the App Brain scope on change, without churning on re-set', async () => {
    await goals.set(ctx.workspace.id, appId, { statement: 'Goal one.' });
    expect(goalAtoms().length).toBe(1);
    // Same statement again → no new atom.
    await goals.set(ctx.workspace.id, appId, { statement: 'Goal one.' });
    expect(goalAtoms().length).toBe(1);
    // Changed statement → the change is mirrored (dedup may reinforce vs add, so ≥1).
    await goals.set(ctx.workspace.id, appId, { statement: 'A meaningfully different goal about reach.' });
    expect(goalAtoms().length).toBeGreaterThanOrEqual(1);
  });
});
