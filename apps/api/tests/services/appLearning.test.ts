/**
 * AppLearningService — everything an App learns.
 *
 * THE INVARIANT UNDER TEST: what an App learns is scoped to the APP, and it RENDERS
 * on the App's Brain map. Both halves matter and both were broken:
 *
 *   - Lessons used to be scoped to the App's *owner agent*, which is null for most
 *     Apps — so they fell through to the workspace bucket and never appeared in the
 *     App's Brain at all.
 *   - The only other writer into an App's scope (run-output mining) stages atoms as
 *     `unconsolidated`, and the graph deliberately hides those. So even an App that
 *     DID accumulate atoms rendered zero nodes.
 *
 * Hence the assertions here go all the way to `getGraph()` — asserting a row exists
 * in `memory_episodes` is NOT enough to prove an operator can see it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { AppStore } from '@agentis/app';
import { SharedIntelligenceService } from '../../src/services/sharedIntelligence.js';
import { EpisodicMemoryStore } from '../../src/services/episodicMemoryStore.js';
import { AppLearningService, type RunSettledInput } from '../../src/services/app/appLearning.js';
import { AppContactService } from '../../src/services/app/appContacts.js';
import { StubEmbeddingProvider } from '../_helpers/stubEmbeddingProvider.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let brain: SharedIntelligenceService;
let episodes: EpisodicMemoryStore;
let learning: AppLearningService;

beforeEach(async () => {
  ctx = await createTestContext();
  episodes = new EpisodicMemoryStore(ctx.db, ctx.logger, new StubEmbeddingProvider());
  brain = new SharedIntelligenceService(ctx.db, ctx.bus, episodes, ctx.logger);
  learning = new AppLearningService({ db: ctx.db, shared: brain, logger: ctx.logger });
});
afterEach(() => ctx.close());

function seedAgent(name = 'Closer'): string {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({ id, workspaceId: ctx.workspace.id, userId: ctx.user.id, name, adapterType: 'http' }).run();
  return id;
}

/** A staffed App (owner agent) + a contact. */
function seedAppWithContact(stage = 'qualifying'): { appId: string; agentId: string; contactId: string; contacts: AppContactService } {
  const agentId = seedAgent();
  const appId = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Acme Sales', ownerAgentId: agentId }).id;
  const contacts = new AppContactService(ctx.db);
  const contactId = contacts.touch({ workspaceId: ctx.workspace.id, appId, channelKind: 'whatsapp', handle: '42', displayName: 'Maria' });
  contacts.update(ctx.workspace.id, contactId, { stage, goal: 'reserve the unit' });
  return { appId, agentId, contactId, contacts };
}

/** A workflow, optionally owned by an App. Returns both ids. */
function seedWorkflow(opts: { app?: boolean; ownerAgentId?: string | null } = {}): { workflowId: string; appId: string | null } {
  const appId = opts.app
    ? new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, {
        name: 'Nightly Digest',
        ...(opts.ownerAgentId ? { ownerAgentId: opts.ownerAgentId } : {}),
      }).id
    : null;
  const workflowId = randomUUID();
  ctx.db.insert(schema.workflows).values({
    id: workflowId,
    workspaceId: ctx.workspace.id,
    userId: ctx.user.id,
    title: 'Nightly Digest',
    appId,
    graph: { nodes: [], edges: [] },
  }).run();
  return { workflowId, appId };
}

function settled(workflowId: string, over: Partial<RunSettledInput> = {}): RunSettledInput {
  return {
    workspaceId: ctx.workspace.id,
    workflowId,
    workflowTitle: 'Nightly Digest',
    runId: randomUUID(),
    status: 'COMPLETED',
    ...over,
  };
}

/** Node labels the App's Brain MAP actually renders at this scope. */
function mapLabels(scopeId: string): string[] {
  return brain
    .getGraph(ctx.workspace.id, { scope: 'scoped', scopeId, includeWorkspace: false })
    .nodes
    .filter((n) => n.atomKind !== 'core' && n.atomKind !== 'scope_owner')
    .map((n) => n.label);
}

describe('AppLearningService.onRunSettled — a run is what an App learns from', () => {
  it('renders a node on the App Brain map after a single successful run', async () => {
    const { workflowId, appId } = seedWorkflow({ app: true });
    expect(mapLabels(appId!)).toHaveLength(0);

    const result = await learning.onRunSettled(settled(workflowId));

    expect(result?.created).toBe(true);
    // The whole point: it is VISIBLE on the map, not merely present in the table.
    expect(mapLabels(appId!)).toEqual([expect.stringContaining('Proven')]);
  });

  it('scopes the lesson to the App even when the App has NO owner agent', async () => {
    // This is the case that silently broke every App: ownerAgentId is null for most
    // of them, so the old scopeId=ownerAgentId degraded to the workspace bucket.
    const { workflowId, appId } = seedWorkflow({ app: true, ownerAgentId: null });
    await learning.onRunSettled(settled(workflowId));

    const rows = ctx.db.select().from(schema.memoryEpisodes)
      .where(eq(schema.memoryEpisodes.workspaceId, ctx.workspace.id)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scopeId).toBe(appId);
  });

  it('attributes the operating agent without scoping the lesson to it', async () => {
    const agentId = seedAgent('Operator');
    const { workflowId, appId } = seedWorkflow({ app: true, ownerAgentId: agentId });
    await learning.onRunSettled(settled(workflowId, { agentId }));

    const row = ctx.db.select().from(schema.memoryEpisodes)
      .where(eq(schema.memoryEpisodes.workspaceId, ctx.workspace.id)).get();
    expect(row?.scopeId).toBe(appId);
    expect(row?.agentId).toBe(agentId);
    // The agent's OWN map must not absorb the App's lesson.
    expect(mapLabels(agentId)).toHaveLength(0);
  });

  it('records a deficient verdict — a run can COMPLETE without accomplishing', async () => {
    const { workflowId, appId } = seedWorkflow({ app: true });
    await learning.onRunSettled(settled(workflowId, {
      status: 'COMPLETED',
      verdict: {
        outcome: 'hollow',
        deficiencies: [{ claim: 'digest email delivered', detail: 'body was empty' }],
      },
    }));

    const row = ctx.db.select().from(schema.memoryEpisodes).where(eq(schema.memoryEpisodes.scopeId, appId!)).get();
    expect(row?.type).toBe('failure');
    expect(row?.summary).toContain('did NOT accomplish');
    expect(row?.summary).toContain('body was empty');
    expect(row?.outcomeStatus).toBe('bad');
    expect(mapLabels(appId!)).toEqual([expect.stringContaining('Deficient (hollow)')]);
  });

  it('names the failing step so the weak point is findable', async () => {
    const { workflowId, appId } = seedWorkflow({ app: true });
    await learning.onRunSettled(settled(workflowId, {
      status: 'FAILED',
      failures: [{ nodeId: 'fetch', nodeTitle: 'Fetch headlines', error: 'HTTP 503 from feed' }],
    }));

    const row = ctx.db.select().from(schema.memoryEpisodes).where(eq(schema.memoryEpisodes.scopeId, appId!)).get();
    expect(row?.summary).toContain('Fetch headlines');
    expect(row?.summary).toContain('HTTP 503');
  });

  it('reinforces instead of cloning when the same outcome repeats', async () => {
    const { workflowId, appId } = seedWorkflow({ app: true });
    for (let i = 0; i < 5; i += 1) await learning.onRunSettled(settled(workflowId));

    // 5 runs, 1 node — a hundred nightly runs must not become a hundred nodes.
    const rows = ctx.db.select().from(schema.memoryEpisodes).where(eq(schema.memoryEpisodes.scopeId, appId!)).all();
    expect(rows).toHaveLength(1);
    expect(mapLabels(appId!)).toHaveLength(1);
    // Repetition made the lesson stronger, not noisier.
    expect(rows[0]!.reinforcedAt).toBeTruthy();
    expect(Number(rows[0]!.confidence)).toBeGreaterThan(0.7);
  });

  it('falls back to the workflow scope when no App owns it (Workflow Brain)', async () => {
    const { workflowId } = seedWorkflow({ app: false });
    await learning.onRunSettled(settled(workflowId));

    expect(mapLabels(workflowId)).toEqual([expect.stringContaining('Proven')]);
  });

  it('learns nothing from a cancelled run — it proved nothing', async () => {
    const { workflowId, appId } = seedWorkflow({ app: true });
    const result = await learning.onRunSettled(settled(workflowId, { status: 'CANCELLED' }));

    expect(result).toBeNull();
    expect(mapLabels(appId!)).toHaveLength(0);
  });

  it('writes nothing for an unknown workflow rather than stranding an atom', async () => {
    // Never throws (the loop must not be able to break a run's terminal path), and
    // never invents a scope no surface will read.
    await expect(learning.onRunSettled(settled('no-such-workflow'))).resolves.toBeNull();
    expect(ctx.db.select().from(schema.memoryEpisodes).all()).toHaveLength(0);
  });
});

describe('AppLearningService.recordOutcome — relationship outcome → graded lesson', () => {
  it('stamps the contact and deposits a lesson visible on the App map', async () => {
    const { appId, contactId, contacts } = seedAppWithContact('won');

    const result = await learning.recordOutcome({ workspaceId: ctx.workspace.id, appId, contactId, outcome: 'won' });
    expect(result.recorded).toBe(true);
    expect(result.lessonDeposited).toBe(true);

    const contact = contacts.get(ctx.workspace.id, contactId);
    expect(contact?.outcome).toBe('won');
    expect(contact?.outcomeAt).toBeTruthy();

    // The lesson belongs to the APP, and it renders.
    const lessons = ctx.db.select().from(schema.memoryEpisodes)
      .where(and(eq(schema.memoryEpisodes.workspaceId, ctx.workspace.id), eq(schema.memoryEpisodes.scopeId, appId)))
      .all()
      .filter((r) => (r.tags as string[]).includes('m2_lesson'));
    expect(lessons).toHaveLength(1);
    expect((lessons[0]!.tags as string[])).toContain(`app:${appId}`);
    expect((lessons[0]!.tags as string[])).toContain('outcome:won');
    expect(lessons[0]!.summary.length).toBeGreaterThan(20);
    expect(mapLabels(appId)).toHaveLength(1);
  });

  it('is idempotent on the same outcome (no double-deposit)', async () => {
    const { appId, contactId } = seedAppWithContact('won');

    await learning.recordOutcome({ workspaceId: ctx.workspace.id, appId, contactId, outcome: 'won' });
    const second = await learning.recordOutcome({ workspaceId: ctx.workspace.id, appId, contactId, outcome: 'won' });
    expect(second.recorded).toBe(false);

    const lessons = ctx.db.select().from(schema.memoryEpisodes)
      .where(eq(schema.memoryEpisodes.scopeId, appId)).all()
      .filter((r) => (r.tags as string[]).includes('m2_lesson'));
    expect(lessons).toHaveLength(1);
  });

  it('prefers the agent-distilled note when provided', async () => {
    const { appId, contactId } = seedAppWithContact();
    await learning.recordOutcome({
      workspaceId: ctx.workspace.id, appId, contactId, outcome: 'lost',
      note: 'Offering a same-day call instead of email reply keeps high-intent leads from going cold.',
    });
    const lesson = ctx.db.select().from(schema.memoryEpisodes).where(eq(schema.memoryEpisodes.scopeId, appId)).all()
      .find((r) => (r.tags as string[]).includes('m2_lesson'));
    expect(lesson?.summary).toContain('same-day call');
  });

  it('surfaces the App scope through recentLearnings', async () => {
    const { appId, contactId } = seedAppWithContact('won');
    await learning.recordOutcome({ workspaceId: ctx.workspace.id, appId, contactId, outcome: 'won' });

    const recent = learning.recentLearnings(ctx.workspace.id, appId);
    expect(recent.lessons).toHaveLength(1);
    expect(recent.lessons[0]!.outcome).toBe('won');
  });
});

describe('AppLearningService — abandoned sweep + stage derivation', () => {
  it('sweeps untouched contacts into an abandoned outcome', async () => {
    const { contactId, contacts } = seedAppWithContact();
    ctx.db.update(schema.appContacts).set({ lastTouchAt: '2020-01-01T00:00:00.000Z' }).where(eq(schema.appContacts.id, contactId)).run();

    const { swept } = await learning.sweepAbandoned();
    expect(swept).toBeGreaterThanOrEqual(1);
    expect(contacts.get(ctx.workspace.id, contactId)?.outcome).toBe('abandoned');
  });

  it('maps a terminal stage to an outcome', () => {
    expect(AppLearningService.outcomeForStage('won')).toBe('won');
    expect(AppLearningService.outcomeForStage('closed_lost')).toBe('lost');
    expect(AppLearningService.outcomeForStage('qualifying')).toBeNull();
    expect(AppLearningService.outcomeForStage(null)).toBeNull();
  });
});
