/**
 * AbilityCreationService — the 10x creation engine (docs/ABILITIES_10X_RFC.md §3).
 *
 * These run with NO model configured, exercising the deterministic-fallback path
 * that guarantees creation works zero-cost on a fresh install. The LLM-synthesis
 * paths share the same persistence + shapes; they are covered structurally here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AbilityService } from '../../src/services/abilityService.js';
import { AbilityCreationService } from '../../src/services/abilityCreationService.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let abilities: AbilityService;
let creation: AbilityCreationService;

beforeEach(async () => {
  ctx = await createTestContext();
  abilities = new AbilityService(ctx.db, ctx.logger);
  creation = new AbilityCreationService({ db: ctx.db, logger: ctx.logger, abilities, llm: undefined });
});

afterEach(() => { ctx.close(); });

describe('AbilityCreationService — on-ramps', () => {
  it('drafts a compiling ability from a one-line intent (deterministic fallback)', async () => {
    const res = await creation.draft({
      workspaceId: ctx.workspace.id,
      from: 'intent',
      intent: 'Draft SOC2-aware security review comments for pull requests',
    });
    expect(res.synthesized).toBe(false); // no model wired
    expect(res.ability.name.length).toBeGreaterThan(0);
    expect(res.ability.origin?.kind).toBe('intent');
    expect(res.ability.depth).toBe('d0_instinct');
    expect(res.ability.contentHash).toBeTruthy();
    // Queued for compile (compiled mode).
    expect(['pending', 'dirty', 'compiling']).toContain(res.ability.compileStatus);
    expect(res.notes.join(' ')).toMatch(/deterministic|model/i);
  });

  it('drafts from example pairs and keeps the user examples verbatim at d1', async () => {
    const res = await creation.draft({
      workspaceId: ctx.workspace.id,
      from: 'examples',
      examples: [
        { inputText: 'Summarize this contract clause', outputText: 'Plain-English summary: ...' },
        { inputText: 'Flag risky terms', outputText: 'Risk: unbounded indemnity in §4.' },
      ],
    });
    const examples = abilities.listExamples(res.ability.id);
    expect(examples).toHaveLength(2);
    expect(examples.map((e) => e.inputText)).toContain('Summarize this contract clause');
    expect(res.ability.depth).toBe('d1_knowledge'); // has examples
  });

  it('drafts from material and embeds it as knowledge', async () => {
    const res = await creation.draft({
      workspaceId: ctx.workspace.id,
      from: 'material',
      materialTitle: 'Brand Voice Guide',
      material: 'Always write in second person. Never use exclamation marks. Keep sentences under 20 words.',
    });
    const knowledge = abilities.listKnowledge(res.ability.id);
    expect(knowledge.length).toBeGreaterThanOrEqual(1);
    expect(knowledge[0]?.content).toMatch(/second person/i);
    expect(res.ability.depth).toBe('d1_knowledge');
  });

  it('rejects an intent on-ramp with no intent', async () => {
    await expect(creation.draft({ workspaceId: ctx.workspace.id, from: 'intent' }))
      .rejects.toThrow(/intent is required/i);
  });

  it('forks an existing ability, copying behavior and examples', async () => {
    const base = await creation.draft({
      workspaceId: ctx.workspace.id, from: 'examples',
      examples: [{ inputText: 'q', outputText: 'a' }],
    });
    const fork = creation.forkAbility({ workspaceId: ctx.workspace.id, sourceAbilityId: base.ability.id });
    expect(fork.ability.id).not.toBe(base.ability.id);
    expect(fork.ability.origin?.kind).toBe('fork');
    expect(fork.ability.origin?.sourceAbilityId).toBe(base.ability.id);
    expect(abilities.listExamples(fork.ability.id)).toHaveLength(1);
  });
});

describe('AbilityCreationService — refine + self-eval', () => {
  it('refine() synthesizes deterministic guard examples from NEVER rules', async () => {
    const ability = abilities.create({
      workspaceId: ctx.workspace.id,
      name: 'Compliance Reviewer',
      rulesNever: ['Never approve unbounded indemnity', 'Never share customer PII'],
    });
    const before = abilities.listExamples(ability.id).length;
    const res = await creation.refine(ability.id);
    expect(res.added).toBeGreaterThan(0);
    expect(abilities.listExamples(ability.id).length).toBe(before + res.added);
    expect(res.synthesized).toBe(false);
  });

  it('self-eval records a run and blocks promotion when output violates a NEVER rule', async () => {
    const ability = abilities.create({
      workspaceId: ctx.workspace.id,
      name: 'Safe Bot',
      rulesAlways: ['Be concise'],
      rulesNever: ['share customer passwords'],
    });
    // An example whose output literally violates the NEVER rule.
    abilities.addExample(ability.id, {
      inputText: 'What is the admin login?',
      outputText: 'Sure, I will share customer passwords now: hunter2.',
    });
    const res = await creation.selfEval(ability.id);
    expect(res.promotable).toBe(false);
    expect(res.run.passed).toBe(false);
    expect(res.run.failures.some((f) => /NEVER rule/i.test(f.reason))).toBe(true);
    // Persisted + retrievable.
    expect(abilities.listEvalRuns(ability.id).map((r) => r.id)).toContain(res.run.id);
  });

  it('self-eval passes structurally for a well-formed ability with examples', async () => {
    const draft = await creation.draft({
      workspaceId: ctx.workspace.id, from: 'examples',
      examples: [
        { inputText: 'a', outputText: 'b' },
        { inputText: 'c', outputText: 'd' },
      ],
    });
    // Give it a compiled prompt + a rule so the structural score clears 0.7.
    abilities.update(draft.ability.id, {
      compiledPrompt: 'You are a focused specialist. '.repeat(4),
      rulesAlways: ['Match the example style'],
      specs: { focus: 'pairs' },
    });
    const res = await creation.selfEval(draft.ability.id);
    expect(res.run.score).toBeGreaterThanOrEqual(0.7);
    expect(res.promotable).toBe(true);
    expect(abilities.latestPassingEval(draft.ability.id)?.id).toBe(res.run.id);
  });
});

describe('AbilityCreationService — depth promotion (eval-gated)', () => {
  it('blocks d2 promotion until a passing self-eval exists, then allows it', async () => {
    const draft = await creation.draft({
      workspaceId: ctx.workspace.id, from: 'examples',
      examples: [{ inputText: 'a', outputText: 'b' }, { inputText: 'c', outputText: 'd' }],
    });
    expect(draft.ability.depth).toBe('d1_knowledge');

    // d1 → d2 requires evidence; none yet.
    const blocked = creation.promoteDepth(draft.ability.id);
    expect(blocked.promoted).toBe(false);
    expect(blocked.reason).toMatch(/self-eval/i);

    // Make it structurally pass, eval, then promote.
    abilities.update(draft.ability.id, {
      compiledPrompt: 'You are a focused specialist. '.repeat(4),
      rulesAlways: ['Match the example style'],
      specs: { focus: 'pairs' },
    });
    await creation.selfEval(draft.ability.id);
    const promoted = creation.promoteDepth(draft.ability.id);
    expect(promoted.promoted).toBe(true);
    expect(promoted.to).toBe('d2_tuned');
    expect(abilities.get(draft.ability.id).depth).toBe('d2_tuned');
  });

  it('caps depth at what the ability actually carries', () => {
    const bare = abilities.create({ workspaceId: ctx.workspace.id, name: 'Bare' });
    const res = creation.promoteDepth(bare.id);
    // No examples/knowledge/policies → ceiling is d0, cannot promote.
    expect(res.promoted).toBe(false);
  });
});

describe('AbilityService — activation ledger', () => {
  it('records and lists activations (the free flywheel)', () => {
    const a = abilities.create({ workspaceId: ctx.workspace.id, name: 'X' });
    abilities.recordActivation({
      workspaceId: ctx.workspace.id,
      runId: null,
      abilityIds: [a.id],
      conflictsResolved: [{ kind: 'rule', detail: 'pinned > relevance' }],
      outcome: 'success',
      qualityScore: 0.9,
    });
    const rows = abilities.listActivations(ctx.workspace.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.abilityIds).toContain(a.id);
    expect(rows[0]?.consentScope).toBe('workspace_private');
  });
});
