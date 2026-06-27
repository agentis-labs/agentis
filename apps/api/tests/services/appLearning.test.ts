/**
 * AppLearningService — the conversational learning loop (LIVING-APPS-10X Phase M2 · G10).
 *
 * Proves end-to-end: an outcome recorded on a contact (a) stamps the contact,
 * (b) deposits a GRADED LESSON into the owner agent's memory plane via the existing
 * brain-formation path, and (c) recurring lessons GRADUATE into an ability draft via
 * the existing MemoryReflectionService → SkillProposer → AbilityCreationService hook.
 * Visibility (`recentLearnings`) surfaces both. Everything is additive + non-throwing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { AppStore } from '@agentis/app';
import { SharedIntelligenceService } from '../../src/services/sharedIntelligence.js';
import { EpisodicMemoryStore } from '../../src/services/episodicMemoryStore.js';
import { MemoryReflectionService } from '../../src/services/memoryReflectionService.js';
import { AppLearningService } from '../../src/services/appLearning.js';
import { AbilityService } from '../../src/services/abilityService.js';
import { AbilityCreationService } from '../../src/services/abilityCreationService.js';
import { AppContactService } from '../../src/services/appContacts.js';
import { StubEmbeddingProvider } from '../_helpers/stubEmbeddingProvider.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let brain: SharedIntelligenceService;
let episodes: EpisodicMemoryStore;

beforeEach(async () => {
  ctx = await createTestContext();
  episodes = new EpisodicMemoryStore(ctx.db, ctx.logger, new StubEmbeddingProvider());
  brain = new SharedIntelligenceService(ctx.db, ctx.bus, episodes, ctx.logger);
});
afterEach(() => ctx.close());

function seedAgent(name = 'Closer'): string {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({ id, workspaceId: ctx.workspace.id, userId: ctx.user.id, name, adapterType: 'http' }).run();
  return id;
}

/** A staffed App (owner agent) + a contact. Returns ids. */
function seedAppWithContact(stage = 'qualifying'): { appId: string; agentId: string; contactId: string; contacts: AppContactService } {
  const agentId = seedAgent();
  const appId = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Acme Sales', ownerAgentId: agentId }).id;
  const contacts = new AppContactService(ctx.db);
  const contactId = contacts.touch({ workspaceId: ctx.workspace.id, appId, channelKind: 'whatsapp', handle: '42', displayName: 'Maria' });
  contacts.update(ctx.workspace.id, contactId, { stage, goal: 'reserve the unit' });
  return { appId, agentId, contactId, contacts };
}

describe('AppLearningService.recordOutcome — outcome → graded lesson', () => {
  it('stamps the contact and deposits a graded lesson scoped to the owner agent', async () => {
    const { appId, agentId, contactId, contacts } = seedAppWithContact('won');
    const learning = new AppLearningService({ db: ctx.db, shared: brain, logger: ctx.logger });

    const result = await learning.recordOutcome({ workspaceId: ctx.workspace.id, appId, contactId, outcome: 'won' });
    expect(result.recorded).toBe(true);
    expect(result.lessonDeposited).toBe(true);

    // Contact stamped.
    const contact = contacts.get(ctx.workspace.id, contactId);
    expect(contact?.outcome).toBe('won');
    expect(contact?.outcomeAt).toBeTruthy();

    // A distilled lesson landed in the owner agent's scope, tagged for visibility.
    const lessons = ctx.db.select().from(schema.memoryEpisodes)
      .where(and(eq(schema.memoryEpisodes.workspaceId, ctx.workspace.id), eq(schema.memoryEpisodes.scopeId, agentId)))
      .all()
      .filter((r) => (r.tags as string[]).includes('m2_lesson'));
    expect(lessons).toHaveLength(1);
    expect(lessons[0]!.type).toBe('distilled_lesson');
    expect((lessons[0]!.tags as string[])).toContain(`app:${appId}`);
    expect((lessons[0]!.tags as string[])).toContain('outcome:won');
    // It's a distilled rule, not a raw transcript.
    expect(lessons[0]!.summary.length).toBeGreaterThan(20);
  });

  it('is idempotent on the same outcome (no double-deposit)', async () => {
    const { appId, agentId, contactId } = seedAppWithContact('won');
    const learning = new AppLearningService({ db: ctx.db, shared: brain, logger: ctx.logger });

    await learning.recordOutcome({ workspaceId: ctx.workspace.id, appId, contactId, outcome: 'won' });
    const second = await learning.recordOutcome({ workspaceId: ctx.workspace.id, appId, contactId, outcome: 'won' });
    expect(second.recorded).toBe(false);

    const lessons = ctx.db.select().from(schema.memoryEpisodes)
      .where(eq(schema.memoryEpisodes.scopeId, agentId)).all()
      .filter((r) => (r.tags as string[]).includes('m2_lesson'));
    expect(lessons).toHaveLength(1);
  });

  it('prefers the agent-distilled note when provided', async () => {
    const { appId, agentId, contactId } = seedAppWithContact();
    const learning = new AppLearningService({ db: ctx.db, shared: brain, logger: ctx.logger });
    await learning.recordOutcome({
      workspaceId: ctx.workspace.id, appId, contactId, outcome: 'lost',
      note: 'Offering a same-day call instead of email reply keeps high-intent leads from going cold.',
    });
    const lesson = ctx.db.select().from(schema.memoryEpisodes).where(eq(schema.memoryEpisodes.scopeId, agentId)).all()
      .find((r) => (r.tags as string[]).includes('m2_lesson'));
    expect(lesson?.summary).toContain('same-day call');
  });
});

describe('AppLearningService — graduation (recurrence → ability draft)', () => {
  it('graduates a recurring winning pattern into an ability draft via the existing hooks', async () => {
    const { appId, agentId, contactId } = seedAppWithContact('won');

    // Wire the real graduation flywheel: reflection → SkillProposer → ability draft.
    const abilityService = new AbilityService(ctx.db, ctx.logger);
    const abilityCreation = new AbilityCreationService({ db: ctx.db, logger: ctx.logger, abilities: abilityService });
    const reflection = new MemoryReflectionService(ctx.db, brain, ctx.logger);
    // Scripted completer → a grounded PROCEDURAL rule the deduction pass returns.
    reflection.setCompleter({
      async completeStructured<T>(): Promise<T | null> {
        return {
          statement: 'Always follow up promptly on whatsapp relationships that reach the won stage to keep momentum.',
          title: 'Follow up promptly on won whatsapp deals',
          confidence: 0.85,
        } as unknown as T;
      },
    });
    const drafts: Promise<unknown>[] = [];
    reflection.setSkillProposer((args) => {
      drafts.push(abilityCreation.draft({ workspaceId: args.workspaceId, from: 'intent', intent: args.intent, name: args.title, originMetadata: args.scopeId ? { scopeId: args.scopeId } : undefined }));
    });

    const learning = new AppLearningService({ db: ctx.db, shared: brain, logger: ctx.logger, reflection });

    // Three recurring 'won' lessons across distinct contacts → ≥3 distinct sources,
    // which is the skill-proposal threshold in MemoryReflectionService.
    const contacts = new AppContactService(ctx.db);
    await learning.recordOutcome({ workspaceId: ctx.workspace.id, appId, contactId, outcome: 'won' });
    for (let i = 0; i < 2; i++) {
      const cid = contacts.touch({ workspaceId: ctx.workspace.id, appId, channelKind: 'whatsapp', handle: `h${i}` });
      contacts.update(ctx.workspace.id, cid, { stage: 'won', goal: 'reserve the unit' });
      await learning.recordOutcome({ workspaceId: ctx.workspace.id, appId, contactId: cid, outcome: 'won' });
    }

    // Let the fire-and-forget draft(s) settle.
    await Promise.allSettled(drafts);

    // An ability draft was proposed, attributable to the owner-agent scope.
    const abilities = ctx.db.select().from(schema.abilities).where(eq(schema.abilities.workspaceId, ctx.workspace.id)).all();
    expect(abilities.length).toBeGreaterThanOrEqual(1);
    const graduated = abilities.find((a) => ((a.origin ?? {}) as Record<string, unknown>).scopeId === agentId);
    expect(graduated).toBeTruthy();

    // Visibility surfaces both the lessons and the graduated ability.
    const learnings = learning.recentLearnings(ctx.workspace.id, appId);
    expect(learnings.ownerAgentId).toBe(agentId);
    expect(learnings.lessons.length).toBeGreaterThanOrEqual(1);
    expect(learnings.abilities.length).toBeGreaterThanOrEqual(1);
  });
});

describe('AppLearningService — abandoned sweep + stage derivation', () => {
  it('sweeps untouched contacts into an abandoned outcome', async () => {
    const { appId, contactId, contacts } = seedAppWithContact();
    // Backdate lastTouch well past the threshold.
    ctx.db.update(schema.appContacts).set({ lastTouchAt: '2020-01-01T00:00:00.000Z' }).where(eq(schema.appContacts.id, contactId)).run();

    const learning = new AppLearningService({ db: ctx.db, shared: brain, logger: ctx.logger });
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
