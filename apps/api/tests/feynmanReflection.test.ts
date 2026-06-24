/**
 * Feynman repair loop (Phase 4) — the grounded, no-op-by-default reflection job.
 * Asserts the disciplines that make it safe: weak/ungrounded explanations store
 * NOTHING, grounded ones land as a retrievable PACER-tagged lesson, and the
 * cross-run failure counter drives the repeated-failure trigger.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EpisodicMemoryStore } from '../src/services/episodicMemoryStore.js';
import { StubEmbeddingProvider } from './_helpers/stubEmbeddingProvider.js';
import { SharedIntelligenceService } from '../src/services/sharedIntelligence.js';
import { FeynmanReflectionService, type FeynmanReflectionPayload } from '../src/services/feynmanReflection.js';
import type { StructuredCompleter } from '../src/services/structuredCompleter.js';
import { createTestContext, type TestContext } from './_helpers/createTestContext.js';

let ctx: TestContext;
let brain: SharedIntelligenceService;
let feynman: FeynmanReflectionService;
let episodes: EpisodicMemoryStore;

beforeEach(async () => {
  ctx = await createTestContext();
  episodes = new EpisodicMemoryStore(ctx.db, ctx.logger, new StubEmbeddingProvider());
  brain = new SharedIntelligenceService(ctx.db, ctx.bus, episodes, ctx.logger);
  feynman = new FeynmanReflectionService(ctx.db, brain, ctx.logger);
});

afterEach(() => ctx.close());

/** A completer that always returns the supplied object. */
function fakeCompleter(obj: Record<string, unknown> | null): StructuredCompleter {
  return {
    label: 'fake',
    lastError: null,
    async completeStructured() {
      return obj as never;
    },
  };
}

const BASE: FeynmanReflectionPayload = {
  workspaceId: '',
  nodeId: 'node-1',
  nodeTitle: 'Fetch GitHub stars',
  prompt: 'Call the GitHub API and return the star count for the repo.',
  error: 'http_request failed: ETIMEDOUT connecting to api.github.com',
  trigger: 'self_heal_exhausted',
};

function lessonAtoms() {
  return episodes.list({ workspaceId: ctx.workspace.id, includeArchived: true, limit: 500 })
    .filter((e) => e.tags.includes('feynman'));
}

describe('FeynmanReflectionService.run — grounding discipline', () => {
  it('no model + unrecognized failure → stores nothing', async () => {
    const r = await feynman.run({ ...BASE, workspaceId: ctx.workspace.id, error: 'something inscrutable happened' });
    expect(r.stored).toBe(false);
    expect(lessonAtoms()).toHaveLength(0);
  });

  it('grounded explanation → stores a PACER-tagged repair lesson', async () => {
    feynman.setCompleter(fakeCompleter({
      whatFailed: 'The GitHub API request timed out (ETIMEDOUT) connecting to api.github.com',
      whyFailed: 'The http_request had no timeout/retry and the network was slow',
      wrongAssumption: 'Assumed the GitHub API always responds instantly',
      whatToVerify: 'network reachability and a configured timeout',
      lesson: 'When an http_request to an external API fails with ETIMEDOUT, add a bounded timeout and retry with backoff before failing the node.',
      lessonClass: 'procedural',
      scope: 'workspace',
      confidence: 0.8,
    }));
    const r = await feynman.run({ ...BASE, workspaceId: ctx.workspace.id });
    expect(r.stored).toBe(true);
    const atoms = lessonAtoms();
    expect(atoms).toHaveLength(1);
    const tags = atoms[0]!.tags;
    expect(tags).toContain('failure_repair');
    expect(tags.some((t) => t.startsWith('pacer:'))).toBe(true);
  });

  it('ungrounded explanation (no overlap with real evidence) → no-op', async () => {
    feynman.setCompleter(fakeCompleter({
      whatFailed: 'The kitchen ran out of flour',
      whyFailed: 'A unicorn ate the supplies overnight',
      wrongAssumption: 'Assumed the pantry was infinite',
      whatToVerify: 'pantry inventory',
      lesson: 'Always restock the pantry before baking a cake on weekends.',
      lessonClass: 'procedural',
      scope: 'workspace',
      confidence: 0.9,
    }));
    const r = await feynman.run({ ...BASE, workspaceId: ctx.workspace.id });
    expect(r.stored).toBe(false);
    expect(r.reason).toBe('weak_explanation');
    expect(lessonAtoms()).toHaveLength(0);
  });

  it('low-confidence explanation → no-op even if grounded', async () => {
    feynman.setCompleter(fakeCompleter({
      whatFailed: 'GitHub API ETIMEDOUT',
      whyFailed: 'network',
      wrongAssumption: 'instant',
      whatToVerify: 'timeout',
      lesson: 'Add a timeout to the GitHub http_request to avoid ETIMEDOUT hangs.',
      lessonClass: 'procedural',
      scope: 'workspace',
      confidence: 0.2,
    }));
    const r = await feynman.run({ ...BASE, workspaceId: ctx.workspace.id });
    expect(r.stored).toBe(false);
    expect(lessonAtoms()).toHaveLength(0);
  });
});

describe('FeynmanReflectionService.recordFailure — cross-run counter', () => {
  it('counts repeated failures of the same (workflow,node)', () => {
    const args = { workspaceId: ctx.workspace.id, workflowId: 'wf-1', nodeId: 'node-x' };
    expect(feynman.recordFailure(args)).toBe(1);
    expect(feynman.recordFailure(args)).toBe(2);
    expect(feynman.recordFailure(args)).toBe(3);
    // A different node has its own count.
    expect(feynman.recordFailure({ ...args, nodeId: 'node-y' })).toBe(1);
  });
});
