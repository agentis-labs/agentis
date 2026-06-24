/**
 * Memory-formation pipeline — end-to-end QA against the doc's success criteria
 * (docs/brain/BRAIN-MEMORY-FORMATION-10X.md §7). Exercises the real
 * `SharedIntelligenceService.promote()` against an in-memory DB and asserts the
 * observable Brain state: what lands as a durable atom, what is staged & hidden,
 * and what the cleanup backfill archives.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EpisodicMemoryStore } from '../src/services/episodicMemoryStore.js';
import { StubEmbeddingProvider } from './_helpers/stubEmbeddingProvider.js';
import { SharedIntelligenceService } from '../src/services/sharedIntelligence.js';
import type { StructuredCompleter } from '../src/services/structuredCompleter.js';
import { createTestContext, type TestContext } from './_helpers/createTestContext.js';

let ctx: TestContext;
let episodes: EpisodicMemoryStore;
let brain: SharedIntelligenceService;

beforeEach(async () => {
  ctx = await createTestContext();
  episodes = new EpisodicMemoryStore(ctx.db, ctx.logger, new StubEmbeddingProvider());
  brain = new SharedIntelligenceService(ctx.db, ctx.bus, episodes, ctx.logger);
});

afterEach(() => ctx.close());

const DIGEST_OUTPUT = [
  '# Daily AI Digest',
  '| 1 | hn:48446141 | 3.70 | Healthcare AI copilot signal',
  '| 2 | hn:48446328 | 3.95 | Rising AI cost vs measurable value',
  'Link: https://github.com/example/repo',
  'I selected 8 stories because the instruction allows 5-8.',
  'No fresh unsent important AI stories were found for today’s digest.',
].join('\n');

const REAL_LESSON = 'Always validate healthcare AI outputs against a clinician before publishing because hallucinated dosages are dangerous.';

/** Episode atoms currently visible in the workspace graph. */
function visibleEpisodeSummaries(): string[] {
  const graph = brain.getGraph(ctx.workspace.id, { limit: 200 });
  return graph.nodes.filter((n) => n.atomKind === 'episode').map((n) => `${n.label} ${n.summary}`);
}

function allEpisodes() {
  return episodes.list({ workspaceId: ctx.workspace.id, includeArchived: true, limit: 500 });
}

describe('promote() — write-policy gate', () => {
  it('policy=none writes nothing', async () => {
    const r = await brain.promote({ workspaceId: ctx.workspace.id, taskOutput: DIGEST_OUTPUT, memoryPolicy: 'none' });
    expect(r).toEqual({ created: 0, reinforced: 0, linked: 0 });
    expect(allEpisodes()).toHaveLength(0);
  });

  it('policy=episodic_only writes exactly one hidden outcome marker', async () => {
    const r = await brain.promote({
      workspaceId: ctx.workspace.id,
      taskTitle: 'Daily AI Digest',
      taskOutput: DIGEST_OUTPUT,
      memoryPolicy: 'episodic_only',
    });
    expect(r.created).toBe(1);
    const rows = allEpisodes();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe('observation');
    expect(rows[0]!.tags).toContain('unconsolidated');
    // Hidden from the graph — no pattern/episode node leaks the digest.
    expect(visibleEpisodeSummaries()).toHaveLength(0);
  });
});

describe('promote() — form policy without a Formation Judge model (staging)', () => {
  it('drops structural garbage, stages the real lesson as a hidden unconsolidated trace', async () => {
    const output = `${DIGEST_OUTPUT}\n${REAL_LESSON}`;
    const r = await brain.promote({ workspaceId: ctx.workspace.id, taskOutput: output, memoryPolicy: 'form' });

    // Exactly one survivor — the embedded lesson — staged (not the 6 junk lines).
    expect(r.created).toBe(1);
    const rows = allEpisodes();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe('observation');
    expect(rows[0]!.tags).toContain('unconsolidated');
    expect(rows[0]!.summary).toMatch(/validate healthcare AI outputs/i);
    expect(typeof rows[0]!.metadata.ttlExpiresAt).toBe('string');

    // None of the production garbage was written.
    const summaries = rows.map((e) => e.summary).join(' | ');
    expect(summaries).not.toMatch(/hn:48446141|Link:|I selected|No fresh/i);

    // Staged traces are hidden from the graph.
    expect(visibleEpisodeSummaries()).toHaveLength(0);
  });
});

describe('promote() — form policy with a Formation Judge model', () => {
  it('commits judged memories as typed, consolidated, graph-visible atoms', async () => {
    const stub: StructuredCompleter = {
      label: 'stub-judge',
      lastError: null,
      async completeStructured() {
        return {
          memories: [
            {
              operation: 'ADD',
              type: 'success_pattern',
              title: 'Validate healthcare AI before publishing',
              statement: 'Validate healthcare AI outputs against a clinician before publishing to avoid hallucinated dosages.',
              scope: 'workspace',
              confidence: 0.82,
              targetIndex: null,
            },
          ],
        } as unknown as Record<string, unknown>;
      },
    };
    brain.setFormationCompleter(stub);

    const output = `${DIGEST_OUTPUT}\n${REAL_LESSON}`;
    const r = await brain.promote({ workspaceId: ctx.workspace.id, taskTitle: 'Publish health brief', taskOutput: output, memoryPolicy: 'form' });
    expect(r.created).toBe(1);

    const rows = allEpisodes();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe('success_pattern');
    expect(rows[0]!.tags).toContain('consolidated');
    expect(rows[0]!.tags).not.toContain('unconsolidated');

    // Consolidated, durable memory IS visible in the graph.
    const visible = visibleEpisodeSummaries();
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatch(/validate healthcare AI outputs/i);
  });

  it('falls back to staging when the judge returns nothing parseable', async () => {
    const nullStub: StructuredCompleter = { async completeStructured() { return null; } };
    brain.setFormationCompleter(nullStub);
    const r = await brain.promote({ workspaceId: ctx.workspace.id, taskOutput: REAL_LESSON, memoryPolicy: 'form' });
    expect(r.created).toBe(1);
    expect(allEpisodes()[0]!.tags).toContain('unconsolidated');
  });
});

describe('quarantineRunPromotionJunk — §P4 cleanup backfill', () => {
  beforeEach(() => {
    // Seed the exact legacy pollution as pre-formation run_promotion atoms.
    for (const junk of [
      '| 8 | hn:48446141 | 3.70 | Healthcare AI copilot signal',
      'Link: https://github.com/salimassili62-afk/ai-costguard',
      'No fresh unsent important AI stories were found for today’s digest.',
    ]) {
      episodes.write({
        workspaceId: ctx.workspace.id,
        type: 'distilled_lesson',
        title: junk.slice(0, 40),
        summary: junk,
        source: 'run_promotion',
        confidence: 0.58,
        importance: 0.62,
        trust: 0.55,
        tags: ['collective_brain'],
        metadata: { origin: 'agent_task_output' },
      });
    }
    // One genuine lesson that must survive the backfill.
    episodes.write({
      workspaceId: ctx.workspace.id,
      type: 'distilled_lesson',
      title: 'Retry policy',
      summary: 'Always retry the export job on a 429 because the API rate-limits bursts.',
      source: 'run_promotion',
      confidence: 0.58,
      importance: 0.62,
      trust: 0.55,
      tags: ['collective_brain'],
      metadata: {},
    });
  });

  it('dry-run counts junk without archiving', () => {
    const r = brain.quarantineRunPromotionJunk(ctx.workspace.id, { dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.quarantined).toBe(3);
    expect(allEpisodes().every((e) => e.archivedAt === null)).toBe(true);
  });

  it('archives the 3 junk atoms and preserves the real lesson', () => {
    const r = brain.quarantineRunPromotionJunk(ctx.workspace.id, {});
    expect(r.quarantined).toBe(3);
    const remaining = brain.getGraph(ctx.workspace.id, { limit: 200 }).nodes.filter((n) => n.atomKind === 'episode');
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.summary).toMatch(/retry the export job/i);
    const archived = allEpisodes().filter((e) => e.archivedAt !== null);
    expect(archived).toHaveLength(3);
    expect(archived.every((e) => e.metadata.archivedReason === 'formation_backfill')).toBe(true);
  });
});
