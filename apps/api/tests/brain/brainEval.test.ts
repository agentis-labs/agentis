/**
 * §C8 — the brain benchmark CI gate. Runs the LoCoMo/BEAM-style harness against
 * the real retrieval + cited-ask stack and FAILS the build if abstention,
 * faithfulness, or recall regress below baseline. This is the "measure
 * ourselves" guardrail — every phase that claims a number has to keep it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { AgentisToolContext } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { SharedIntelligenceService } from '../../src/services/sharedIntelligence.js';
import { EpisodicMemoryStore } from '../../src/services/episodicMemoryStore.js';
import { StubEmbeddingProvider } from '../_helpers/stubEmbeddingProvider.js';
import { BrainAskService } from '../../src/services/brain/brainAskService.js';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { registerBrainTools } from '../../src/services/agentisToolHandlers/brain.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';
import { runBrainEval, runRecoveryEval, BRAIN_EVAL_CASES, BRAIN_RECOVERY_CASES } from '../../eval/brain/brainEvalHarness.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let brain: SharedIntelligenceService;

beforeEach(async () => {
  ctx = await createTestContext();
  const episodes = new EpisodicMemoryStore(ctx.db, ctx.logger, new StubEmbeddingProvider());
  brain = new SharedIntelligenceService(ctx.db, ctx.bus, episodes, ctx.logger);
});
afterEach(() => ctx.close());

describe('§C8 brain benchmark harness', () => {
  it('meets the baseline scorecard (CI gate)', async () => {
    const ask = new BrainAskService(brain, ctx.logger); // deterministic cited list

    const seed = async (facts: string[]): Promise<string> => {
      // Isolate each case: clear the workspace's episodic memory first.
      ctx.db.delete(schema.memoryEpisodes).where(eq(schema.memoryEpisodes.workspaceId, ctx.workspace.id)).run();
      for (const f of facts) {
        await brain.addAtom({ workspaceId: ctx.workspace.id, content: f, source: 'system_write', confidence: 0.85 });
      }
      return ctx.workspace.id;
    };

    const card = await runBrainEval({ cases: BRAIN_EVAL_CASES, seed, ask, brain });

    // ── CI gate thresholds ──────────────────────────────────────────────────
    // Abstention on unanswerables is NON-NEGOTIABLE — never hallucinate.
    expect(card.abstentionRate).toBe(1);
    // Of the cases we DID answer, they must be grounded-correct.
    expect(card.faithfulness).toBeGreaterThanOrEqual(0.8);
    // Overall recall baseline across all categories.
    expect(card.overall.accuracy).toBeGreaterThanOrEqual(0.7);
    // Single-hop must be effectively solved.
    expect(card.byCategory.single_hop.accuracy).toBeGreaterThanOrEqual(0.9);
  });

  it('recovers via agentis.brain.search after the upfront pass misses (CI gate)', async () => {
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerBrainTools(registry, { logger: ctx.logger, sharedIntelligence: brain } as unknown as ToolHandlerDeps);
    const toolCtx = (workspaceId: string): AgentisToolContext =>
      ({ workspaceId, agentId: null, caller: 'agent' } as unknown as AgentisToolContext);

    const seed = async (facts: string[]): Promise<string> => {
      ctx.db.delete(schema.memoryEpisodes).where(eq(schema.memoryEpisodes.workspaceId, ctx.workspace.id)).run();
      for (const f of facts) {
        // Below the 0.74 confidence bar that alone clears the relevance floor
        // (§B2.3's `hit.confidence >= 0.74` short-circuit) — this case needs
        // the mismatched initial query to abstain on RELEVANCE, the way an
        // ordinary (not operator-authored) memory would.
        await brain.addAtom({ workspaceId: ctx.workspace.id, content: f, source: 'system_write', confidence: 0.5 });
      }
      return ctx.workspace.id;
    };

    const card = await runRecoveryEval({ cases: BRAIN_RECOVERY_CASES, seed, brain, registry, toolCtx });

    // The setup must actually exercise recovery — if the upfront pass didn't
    // abstain, this case isn't testing what it claims to.
    expect(card.results.every((r) => r.initialAbstained)).toBe(true);
    expect(card.recoveryRate).toBe(1);
  });
});
