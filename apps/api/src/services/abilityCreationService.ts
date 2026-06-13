/**
 * AbilityCreationService — the 10x Ability Creation Engine
 * (docs/ABILITIES_10X_RFC.md §3).
 *
 * Turning the act of authoring an Ability from "fill a form well" into "describe
 * an outcome, or point at your work, and a finished, evaluated specialist exists
 * minutes later — for free." Every path reuses the workspace's *existing* model
 * (the same per-workspace `EvaluatorRuntime` the compiler uses), so creation has
 * ZERO incremental infrastructure cost. When no model is configured, each path
 * degrades to a deterministic blueprint so a fresh install still works.
 *
 * On-ramps (§3.1) — an Ability is never born from a blank form:
 *   • intent   — one natural-language sentence → full blueprint + seed examples.
 *   • examples — input→output pairs → inferred spec/rules/voice.
 *   • material — a doc/url/transcript → embedded knowledge + distilled spec.
 *   • run/fork — handled by AbilityService.promoteRunToExample / forkAbility.
 *
 * Refinement (§3.2):
 *   • refine   — gap-fill positive AND negative examples.
 *   • selfEval — LLM-judge candidate evidence; the depth-promotion gate.
 */

import { AgentisError, ABILITY_DEPTH_ORDER } from '@agentis/core';
import type {
  AbilityDraftBlueprint,
  AbilityDraftResult,
  AbilityRefineResult,
  AbilitySelfEvalResult,
  AbilityOriginKind,
  AbilityDepth,
  AbilitySpecs,
} from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { eq } from 'drizzle-orm';
import type { Logger } from '../logger.js';
import type { AbilityService } from './abilityService.js';
import { EvaluatorRuntime } from './evaluatorRuntime.js';

export interface AbilityCreationDeps {
  db: AgentisSqliteDb;
  logger: Logger;
  abilities: AbilityService;
  /** Bootstrap-env evaluator runtime; used when a workspace has no override. */
  llm?: EvaluatorRuntime;
}

export interface DraftInput {
  workspaceId: string;
  authorId?: string | null;
  from: AbilityOriginKind;
  /** intent on-ramp. */
  intent?: string;
  /** examples on-ramp. */
  examples?: Array<{ inputText: string; outputText: string }>;
  /** material on-ramp. */
  material?: string;
  materialTitle?: string;
  /** Optional caller overrides. */
  name?: string;
  domainTag?: string;
}

const PASS_THRESHOLD = 0.7;
const MAX_EVAL_CASES = 6;

export class AbilityCreationService {
  constructor(private readonly deps: AbilityCreationDeps) {}

  // ── On-ramps ──────────────────────────────────────────────

  async draft(input: DraftInput): Promise<AbilityDraftResult> {
    const llm = this.#resolveLlm(input.workspaceId);
    const notes: string[] = [];
    let blueprint: AbilityDraftBlueprint | null = null;
    let synthesized = false;

    if (input.from === 'intent') {
      if (!input.intent || !input.intent.trim()) {
        throw new AgentisError('VALIDATION_FAILED', 'intent is required for the intent on-ramp');
      }
      blueprint = await this.#blueprintFromIntent(input.intent.trim(), llm);
      synthesized = blueprint !== null;
      if (!blueprint) {
        blueprint = this.#fallbackFromIntent(input.intent.trim());
        notes.push('No model configured — generated a deterministic starter blueprint. Configure a compile model for richer synthesis.');
      }
    } else if (input.from === 'examples') {
      const pairs = (input.examples ?? []).filter((p) => p.inputText?.trim() && p.outputText?.trim());
      if (pairs.length === 0) {
        throw new AgentisError('VALIDATION_FAILED', 'at least one input/output example is required');
      }
      blueprint = await this.#blueprintFromExamples(pairs, llm);
      synthesized = blueprint !== null;
      if (!blueprint) {
        blueprint = this.#fallbackFromExamples(pairs);
        notes.push('No model configured — inferred a minimal spec and kept your examples verbatim.');
      } else {
        blueprint.examples = pairs; // never discard the user's real pairs
      }
    } else if (input.from === 'material') {
      if (!input.material || !input.material.trim()) {
        throw new AgentisError('VALIDATION_FAILED', 'material text is required for the material on-ramp');
      }
      const material = input.material.trim();
      blueprint = await this.#blueprintFromMaterial(material, input.materialTitle, llm);
      synthesized = blueprint !== null;
      if (!blueprint) {
        blueprint = this.#fallbackFromMaterial(material, input.materialTitle);
        notes.push('No model configured — embedded the material as knowledge and used a deterministic spec.');
      }
      // Always attach the source material as knowledge so retrieval has it.
      blueprint.knowledge = [
        { title: input.materialTitle ?? blueprint.name, content: material.slice(0, 30_000) },
        ...(blueprint.knowledge ?? []),
      ];
    } else {
      throw new AgentisError('VALIDATION_FAILED', `unsupported on-ramp: ${input.from}. Use intent | examples | material (run/fork have dedicated endpoints).`);
    }

    if (input.name) blueprint.name = input.name;
    if (input.domainTag) blueprint.domainTag = input.domainTag;

    const ability = this.#materialize(input, blueprint);
    return { ability: this.deps.abilities.get(ability.id), synthesized, blueprint, notes };
  }

  /** Clone-and-specialize an existing ability (the fork on-ramp). */
  forkAbility(input: { workspaceId: string; authorId?: string | null; sourceAbilityId: string; name?: string }): AbilityDraftResult {
    const source = this.deps.abilities.get(input.sourceAbilityId);
    const blueprint: AbilityDraftBlueprint = {
      name: input.name ?? `${source.name} (fork)`,
      description: source.description ?? undefined,
      domainTag: source.domainTag ?? undefined,
      iconEmoji: source.iconEmoji ?? undefined,
      specs: source.specs,
      rulesAlways: source.rulesAlways,
      rulesNever: source.rulesNever,
      toolHints: source.toolHints,
      examples: this.deps.abilities.listExamples(source.id).map((e) => ({ inputText: e.inputText, outputText: e.outputText })),
      knowledge: this.deps.abilities.listKnowledge(source.id).map((k) => ({ title: k.title ?? undefined, content: k.content })),
    };
    const ability = this.#materialize(
      { workspaceId: input.workspaceId, authorId: input.authorId, from: 'fork' },
      blueprint,
      { kind: 'fork', sourceAbilityId: source.id, createdAt: new Date().toISOString() },
    );
    return { ability: this.deps.abilities.get(ability.id), synthesized: false, blueprint, notes: [`Forked from "${source.name}".`] };
  }

  // ── Refinement ────────────────────────────────────────────

  /** Gap-fill positive AND negative coverage examples (§3.2). */
  async refine(abilityId: string): Promise<AbilityRefineResult> {
    const ability = this.deps.abilities.get(abilityId);
    const llm = ability.workspaceId ? this.#resolveLlm(ability.workspaceId) : undefined;
    const existing = this.deps.abilities.listExamples(abilityId);
    const notes: string[] = [];

    let pairs: Array<{ inputText: string; outputText: string }> = [];
    let synthesized = false;

    if (llm && await this.#probe(llm)) {
      const result = await llm.completeStructured<{ examples?: Array<{ task: string; response: string; kind?: string }> }>({
        system:
          'You expand behavioral coverage for a domain specialist agent. Produce realistic example interactions — include at least one NEGATIVE case that tests a "never" rule (a tempting wrong request + the correct compliant handling). Respond with strict JSON only.',
        user: this.#describeAbility(ability)
          + `\n\nExisting example tasks:\n${existing.slice(0, 6).map((e) => `- ${e.inputText.slice(0, 160)}`).join('\n') || '(none yet)'}`
          + '\n\nReturn 4 NEW, non-duplicate examples:\n{"examples":[{"task":"...","response":"...","kind":"positive|negative"}]}',
        maxTokens: 1100,
        maxAttempts: 1,
      }).catch(() => null);
      if (result?.examples?.length) {
        pairs = result.examples
          .filter((e) => e.task?.trim() && e.response?.trim())
          .map((e) => ({ inputText: e.task.trim(), outputText: e.response.trim() }));
        synthesized = pairs.length > 0;
      }
    }

    if (pairs.length === 0) {
      // Deterministic guard examples from the NEVER rules — never a no-op.
      pairs = (ability.rulesNever ?? []).slice(0, 3).map((rule) => ({
        inputText: `A user asks you to ${rule.replace(/^never\s+/i, '').toLowerCase()}.`,
        outputText: `Decline and explain that this specialist never does that (rule: "${rule}"), then offer the compliant alternative.`,
      }));
      if (pairs.length === 0) {
        notes.push('Add a few "never" rules or configure a model so refinement has material to expand.');
        return { added: 0, examples: [], synthesized: false, notes };
      }
      notes.push('No model available — synthesized deterministic guard examples from your "never" rules.');
    }

    const added = pairs.map((p) => this.deps.abilities.addExample(abilityId, {
      inputText: p.inputText.slice(0, 8_000),
      outputText: p.outputText.slice(0, 16_000),
      source: 'synthetic',
      qualityScore: 0.7,
    }));
    this.deps.abilities.requestCompile(abilityId);
    return { added: added.length, examples: added, synthesized, notes };
  }

  /**
   * Self-eval — zero-cost evidence that the ability behaves. Judges each example
   * output against criteria derived from the ability's specs + rules. The result
   * is the gate for promoting to a deeper depth (§6). Evals MEASURE; they do not
   * PROVE — callers should surface that to the user.
   */
  async selfEval(abilityId: string): Promise<AbilitySelfEvalResult> {
    const ability = this.deps.abilities.get(abilityId);
    const examples = this.deps.abilities.listExamples(abilityId);
    const llm = ability.workspaceId ? this.#resolveLlm(ability.workspaceId) : undefined;
    const failures: AbilitySelfEvalResult['run']['failures'] = [];

    // Hard rule check first (cheap, deterministic): a "never" phrase appearing
    // verbatim in an example output is a blocking failure regardless of model.
    const neverPhrases = (ability.rulesNever ?? []).map((r) => r.toLowerCase()).filter((r) => r.length > 6);
    for (const ex of examples) {
      const hit = neverPhrases.find((p) => ex.outputText.toLowerCase().includes(p));
      if (hit) failures.push({ input: ex.inputText.slice(0, 160), reason: `output appears to violate a NEVER rule: "${hit}"` });
    }

    let score: number;
    let model: string | null = null;
    let summary: string;

    const cases = examples.slice(0, MAX_EVAL_CASES);
    const llmReady = llm ? await this.#probe(llm) : false;

    if (llm && llmReady && cases.length > 0) {
      const criteria = this.#evalCriteria(ability);
      const scores: number[] = [];
      for (const ex of cases) {
        const verdict = await llm.evaluate({
          workspaceId: ability.workspaceId ?? 'unknown',
          target: { task: ex.inputText, response: ex.outputText },
          criteria,
          passThreshold: 7,
        }).catch(() => null);
        if (!verdict) continue;
        scores.push(verdict.score / 10);
        if (!verdict.passed) failures.push({ input: ex.inputText.slice(0, 160), reason: verdict.critique.slice(0, 240), score: verdict.score / 10 });
      }
      score = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
      model = 'configured';
      summary = `LLM-judged ${scores.length}/${cases.length} example(s); mean ${(score * 100).toFixed(0)}%.`;
    } else {
      // Deterministic structural eval — no model required.
      score = this.#structuralScore(ability, examples.length);
      summary = `Structural self-eval (no model configured): ${(score * 100).toFixed(0)}%.`;
      if (examples.length === 0) failures.push({ input: '(no examples)', reason: 'add examples so coverage can be judged' });
    }

    const blockingFailure = failures.some((f) => f.reason.includes('NEVER rule'));
    const passed = score >= PASS_THRESHOLD && !blockingFailure;

    const run = this.deps.abilities.recordEvalRun({
      abilityId,
      workspaceId: ability.workspaceId,
      kind: 'self_eval',
      score,
      passed,
      caseCount: cases.length,
      failures,
      summary,
      model,
    });
    return { run, promotable: passed };
  }

  // ── Depth promotion (eval-gated) ──────────────────────────

  /**
   * Promote an ability one rung up the depth ladder — the "greater ability =
   * greater specialist" dial. Gated on a passing self-eval (§6): you earn depth
   * from evidence, you never default into it. Capped by what the ability
   * actually carries, so depth never overstates the real specialization.
   */
  promoteDepth(abilityId: string): { from: AbilityDepth; to: AbilityDepth; promoted: boolean; reason: string } {
    const ability = this.deps.abilities.get(abilityId);
    const from = ability.depth;

    const ceiling = this.#depthCeiling(ability);
    const nextIdx = Math.min(ABILITY_DEPTH_ORDER.indexOf(from) + 1, ABILITY_DEPTH_ORDER.indexOf(ceiling));
    const to = ABILITY_DEPTH_ORDER[nextIdx] ?? from;

    if (to === from) {
      return { from, to, promoted: false, reason: `Already at the deepest rung its content supports (${ceiling}). Add examples/knowledge/policies or run self-eval to go deeper.` };
    }

    // d2+ requires a passing self-eval as evidence.
    if (ABILITY_DEPTH_ORDER.indexOf(to) >= ABILITY_DEPTH_ORDER.indexOf('d2_tuned')) {
      const passing = this.deps.abilities.latestPassingEval(abilityId);
      if (!passing) {
        return { from, to: from, promoted: false, reason: 'Promotion to d2+ requires a passing self-eval. Run /eval first.' };
      }
    }

    this.deps.abilities.update(abilityId, { depth: to });
    return { from, to, promoted: true, reason: `Promoted ${from} → ${to}.` };
  }

  /** Deepest rung an ability's actual content can justify. */
  #depthCeiling(ability: { routingPolicy: unknown; executionPolicy: unknown; exampleCount: number; knowledgeCount: number }): AbilityDepth {
    if (ability.routingPolicy) return 'd4_conductor';
    if (ability.executionPolicy) return 'd3_method';
    const passing = false; // d2 ceiling handled by the eval gate above; content ceiling is d1/d2.
    void passing;
    if (ability.exampleCount > 0 || ability.knowledgeCount > 0) return 'd2_tuned';
    return 'd0_instinct';
  }

  // ── Blueprint synthesis (LLM) ─────────────────────────────

  async #blueprintFromIntent(intent: string, llm?: EvaluatorRuntime): Promise<AbilityDraftBlueprint | null> {
    if (!llm || !(await this.#probe(llm))) return null;
    const out = await llm.completeStructured<RawBlueprint>({
      system:
        'You design a reusable behavioral specialization ("Ability") for an AI agent — like a LoRA add-on, but pure behavior. From a one-line intent, produce a tight specialist spec. Rules must be imperative and concrete. Respond with strict JSON only.',
      user: `Intent: ${intent}\n\nReturn:\n${BLUEPRINT_SHAPE}`,
      maxTokens: 1100,
      maxAttempts: 2,
    }).catch(() => null);
    return out ? this.#normalizeBlueprint(out, intent) : null;
  }

  async #blueprintFromExamples(pairs: Array<{ inputText: string; outputText: string }>, llm?: EvaluatorRuntime): Promise<AbilityDraftBlueprint | null> {
    if (!llm || !(await this.#probe(llm))) return null;
    const sample = pairs.slice(0, 6).map((p, i) => `#${i + 1}\nINPUT: ${p.inputText.slice(0, 400)}\nOUTPUT: ${p.outputText.slice(0, 400)}`).join('\n\n');
    const out = await llm.completeStructured<RawBlueprint>({
      system:
        'You reverse-engineer a reusable behavioral specialization ("Ability") from example interactions. Infer the spec, voice, and rules that explain ALL the examples. Respond with strict JSON only.',
      user: `Examples:\n${sample}\n\nReturn:\n${BLUEPRINT_SHAPE}`,
      maxTokens: 1100,
      maxAttempts: 2,
    }).catch(() => null);
    return out ? this.#normalizeBlueprint(out, pairs[0]?.inputText ?? '') : null;
  }

  async #blueprintFromMaterial(material: string, title: string | undefined, llm?: EvaluatorRuntime): Promise<AbilityDraftBlueprint | null> {
    if (!llm || !(await this.#probe(llm))) return null;
    const out = await llm.completeStructured<RawBlueprint>({
      system:
        'You distill source material (docs, guidelines, transcripts) into a reusable behavioral specialization ("Ability") for an AI agent. Extract the rules and voice the material implies. Respond with strict JSON only.',
      user: `${title ? `Title: ${title}\n` : ''}Material:\n${material.slice(0, 8_000)}\n\nReturn:\n${BLUEPRINT_SHAPE}`,
      maxTokens: 1100,
      maxAttempts: 2,
    }).catch(() => null);
    return out ? this.#normalizeBlueprint(out, title ?? material) : null;
  }

  // ── Deterministic fallbacks (no model) ────────────────────

  #fallbackFromIntent(intent: string): AbilityDraftBlueprint {
    const name = this.#titleCase(this.#firstSeg(intent).slice(0, 60)) || 'New Ability';
    return {
      name,
      description: intent.slice(0, 240),
      domainTag: this.#slugWord(intent),
      specs: { focus: intent.slice(0, 200) },
      rulesAlways: ['Stay strictly within this specialty', 'Be concrete and actionable'],
      rulesNever: ['Pad answers with generic filler'],
      toolHints: [],
    };
  }

  #fallbackFromExamples(pairs: Array<{ inputText: string; outputText: string }>): AbilityDraftBlueprint {
    return {
      name: this.#titleCase(this.#firstSeg(pairs[0]?.inputText ?? '').slice(0, 50)) || 'Example-Derived Ability',
      description: `Specialist inferred from ${pairs.length} example(s).`,
      domainTag: this.#slugWord(pairs[0]?.inputText ?? ''),
      specs: { derived_from: `${pairs.length} examples` },
      rulesAlways: ['Match the style and structure of the provided examples'],
      rulesNever: [],
      toolHints: [],
      examples: pairs,
    };
  }

  #fallbackFromMaterial(material: string, title?: string): AbilityDraftBlueprint {
    return {
      name: this.#titleCase(title ?? this.#firstLine(material).slice(0, 50)) || 'Material-Derived Ability',
      description: `Specialist grounded in provided material${title ? `: ${title}` : ''}.`,
      domainTag: this.#slugWord(title ?? material),
      specs: {},
      rulesAlways: ['Ground answers in the attached knowledge', 'Cite the source material when relevant'],
      rulesNever: ['Contradict the attached knowledge'],
      toolHints: [],
    };
  }

  // ── Helpers ───────────────────────────────────────────────

  #materialize(
    input: { workspaceId: string; authorId?: string | null; from: AbilityOriginKind; intent?: string; material?: string },
    bp: AbilityDraftBlueprint,
    originOverride?: AbilityDraftResult['ability']['origin'],
  ) {
    const hasDepthMaterial = (bp.examples?.length ?? 0) > 0 || (bp.knowledge?.length ?? 0) > 0;
    const ability = this.deps.abilities.create({
      workspaceId: input.workspaceId,
      authorId: input.authorId ?? null,
      name: bp.name.slice(0, 120),
      description: bp.description?.slice(0, 1000) ?? null,
      domainTag: bp.domainTag?.slice(0, 60) ?? null,
      iconEmoji: bp.iconEmoji ?? null,
      specs: this.#sanitizeSpecs(bp.specs),
      rulesAlways: (bp.rulesAlways ?? []).slice(0, 40),
      rulesNever: (bp.rulesNever ?? []).slice(0, 40),
      toolHints: (bp.toolHints ?? []).slice(0, 20),
      mode: 'compiled',
      depth: hasDepthMaterial ? 'd1_knowledge' : 'd0_instinct',
      origin: originOverride ?? {
        kind: input.from,
        seed: (input.intent ?? input.material ?? '').slice(0, 280) || undefined,
        createdAt: new Date().toISOString(),
      },
    });

    for (const ex of bp.examples ?? []) {
      if (!ex.inputText?.trim() || !ex.outputText?.trim()) continue;
      this.deps.abilities.addExample(ability.id, {
        inputText: ex.inputText.slice(0, 8_000),
        outputText: ex.outputText.slice(0, 16_000),
        source: input.from === 'examples' ? 'user_curated' : 'synthetic',
        qualityScore: input.from === 'examples' ? 0.9 : 0.7,
      });
    }
    for (const k of bp.knowledge ?? []) {
      if (!k.content?.trim()) continue;
      this.deps.abilities.addKnowledge(ability.id, {
        title: k.title ?? null,
        content: k.content.slice(0, 32_000),
        sourceType: 'manual',
        importanceScore: 0.7,
      });
    }
    this.deps.abilities.requestCompile(ability.id);
    return ability;
  }

  #normalizeBlueprint(raw: RawBlueprint, seed: string): AbilityDraftBlueprint {
    const arr = (v: unknown): string[] => Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => (x as string).trim()) : [];
    return {
      name: (typeof raw.name === 'string' && raw.name.trim()) ? raw.name.trim() : this.#titleCase(seed.slice(0, 50)),
      description: typeof raw.description === 'string' ? raw.description : undefined,
      domainTag: typeof raw.domain_tag === 'string' ? raw.domain_tag : this.#slugWord(seed),
      iconEmoji: typeof raw.icon_emoji === 'string' ? raw.icon_emoji : undefined,
      specs: (raw.specs && typeof raw.specs === 'object') ? raw.specs as AbilitySpecs : {},
      rulesAlways: arr(raw.rules_always),
      rulesNever: arr(raw.rules_never),
      toolHints: arr(raw.tool_hints),
      examples: Array.isArray(raw.examples)
        ? raw.examples
            .filter((e): e is { task: string; response: string } => Boolean(e?.task && e?.response))
            .map((e) => ({ inputText: String(e.task), outputText: String(e.response) }))
        : [],
    };
  }

  #describeAbility(a: { name: string; domainTag: string | null; specs: AbilitySpecs; rulesAlways: string[]; rulesNever: string[] }): string {
    return [
      `Ability: ${a.name}`,
      a.domainTag ? `Domain: ${a.domainTag}` : '',
      Object.keys(a.specs ?? {}).length ? `Specs: ${JSON.stringify(a.specs)}` : '',
      a.rulesAlways.length ? `ALWAYS: ${a.rulesAlways.join('; ')}` : '',
      a.rulesNever.length ? `NEVER: ${a.rulesNever.join('; ')}` : '',
    ].filter(Boolean).join('\n');
  }

  #evalCriteria(a: { name: string; domainTag: string | null; specs: AbilitySpecs; rulesAlways: string[]; rulesNever: string[]; compiledPrompt: string | null }): string {
    return `You are grading whether a RESPONSE is what the "${a.name}" specialist`
      + `${a.domainTag ? ` (${a.domainTag})` : ''} should produce for the given TASK.\n`
      + (a.rulesAlways.length ? `It must ALWAYS: ${a.rulesAlways.join('; ')}.\n` : '')
      + (a.rulesNever.length ? `It must NEVER: ${a.rulesNever.join('; ')}.\n` : '')
      + (Object.keys(a.specs ?? {}).length ? `Domain specs: ${JSON.stringify(a.specs)}.\n` : '')
      + 'Score 0-10 for how well the response fits this specialist. Penalize generic, off-domain, or rule-violating answers.';
  }

  #structuralScore(a: { compiledPrompt: string | null; rulesAlways: string[]; rulesNever: string[]; specs: AbilitySpecs }, exampleCount: number): number {
    let s = 0;
    if (a.compiledPrompt && a.compiledPrompt.length > 40) s += 0.3;
    if (exampleCount >= 2) s += 0.3; else if (exampleCount === 1) s += 0.15;
    if (a.rulesAlways.length >= 1) s += 0.2;
    if (Object.keys(a.specs ?? {}).length >= 1) s += 0.1;
    if (a.rulesNever.length >= 1) s += 0.1;
    return Math.min(1, s);
  }

  #sanitizeSpecs(specs?: AbilitySpecs): AbilitySpecs {
    const out: AbilitySpecs = {};
    for (const [k, v] of Object.entries(specs ?? {})) {
      if (typeof v === 'string' && v.trim()) out[k.slice(0, 60)] = v.slice(0, 1_000);
    }
    return out;
  }

  #titleCase(s: string): string {
    return s.trim().replace(/\s+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** First sentence-ish segment, never undefined. */
  #firstSeg(s: string): string {
    return s.split(/[.,;\n]/)[0] ?? s;
  }

  /** First line, never undefined. */
  #firstLine(s: string): string {
    return s.split('\n')[0] ?? s;
  }

  #slugWord(s: string): string {
    const w = s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim().split(/\s+/).slice(0, 2).join('_');
    return w || 'general';
  }

  /** Mirror of AbilityCompilerService#resolveLlm — same zero-cost workspace model. */
  #resolveLlm(workspaceId: string): EvaluatorRuntime | undefined {
    try {
      const row = this.deps.db.select({ brainSettings: schema.workspaces.brainSettings })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId))
        .get();
      const settings = (row?.brainSettings ?? {}) as Record<string, unknown>;
      const cfg = (settings.abilityCompilerModel ?? null) as { baseUrl?: string; model?: string; apiKey?: string } | null;
      if (cfg && typeof cfg.baseUrl === 'string' && typeof cfg.model === 'string' && cfg.baseUrl && cfg.model) {
        return new EvaluatorRuntime({
          baseUrl: cfg.baseUrl,
          apiKey: typeof cfg.apiKey === 'string' ? cfg.apiKey : undefined,
          model: cfg.model,
          logger: this.deps.logger,
          timeoutMs: 20_000,
        });
      }
    } catch (err) {
      this.deps.logger.warn('ability.create.workspace_llm_resolve_failed', { err: (err as Error).message });
    }
    return this.deps.llm;
  }

  async #probe(llm: EvaluatorRuntime): Promise<boolean> {
    try {
      const r = await llm.completeStructured<{ ok?: boolean }>({
        system: 'Respond with {"ok":true}', user: 'ping', maxTokens: 10, maxAttempts: 1, timeoutMs: 4_000,
      });
      return r !== null;
    } catch {
      return false;
    }
  }
}

interface RawBlueprint extends Record<string, unknown> {
  name?: unknown;
  description?: unknown;
  domain_tag?: unknown;
  icon_emoji?: unknown;
  specs?: unknown;
  rules_always?: unknown;
  rules_never?: unknown;
  tool_hints?: unknown;
  examples?: Array<{ task?: string; response?: string }>;
}

const BLUEPRINT_SHAPE =
  '{"name":"...","description":"...","domain_tag":"snake_case","icon_emoji":"⚡","specs":{"key":"value"},'
  + '"rules_always":["..."],"rules_never":["..."],"tool_hints":["..."],'
  + '"examples":[{"task":"...","response":"..."},{"task":"...","response":"..."}]}';
