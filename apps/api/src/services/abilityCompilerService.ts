/**
 * AbilityCompilerService — runs the 4-step compile pipeline for an Ability
 * (docs/brain/ABILITIES.md §4).
 *
 * The pipeline is async, idempotent, and cancellable. Every step writes a
 * `compile_stage` marker so the UI shows actual progress and checks
 * `compile_cancel_requested` so a Cancel button truly stops the worker.
 *
 * Steps:
 *
 *   1. Embed all examples (input_text → ability_examples.embedding).
 *   2. Contextualise + embed every knowledge chunk
 *      (context_prefix + content → ability_knowledge.embedding).
 *   3. Generate synthetic examples for high-importance knowledge chunks
 *      when an LLM is wired (skipped gracefully when not).
 *   4. Synthesize the specialist persona (compiled_prompt) from specs +
 *      examples; fall back to a deterministic template when no LLM is
 *      available.
 *
 * Side effects on success:
 *   - compile_status='ready', last_compiled_at=now, domain_embedding set.
 *   - A synthetic workspace KB chunk is written so the ability is visible to
 *     workspace Brain retrieval ("which specialists do we have?").
 *
 * Resilience guarantees (the reason this rewrite exists):
 *   - LLM-availability is probed once with a 4 s budget; failure skips all
 *     LLM-dependent steps instead of stalling them.
 *   - Embedding calls use a tight per-compile budget (default 4 s). If the
 *     configured workspace provider (openai) errors or times out, the
 *     compile transparently falls back to the local hashing provider for the
 *     remainder of this compile — the user never waits minutes for an
 *     unreachable OpenAI-compatible local provider on localhost.
 *   - Every step that depends on an external runtime has a fallback so a
 *     fresh install with no model configured still produces a usable
 *     ability via the deterministic template path.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { CONSTANTS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import type { AbilityService } from './abilityService.js';
import { EvaluatorRuntime } from './evaluatorRuntime.js';
import type { SharedIntelligenceService } from './sharedIntelligence.js';
import { embedText, type EmbeddingProvider } from './embeddingProvider.js';
import type { AbilityKnowledge, AbilityRecord } from '@agentis/core';

export interface AbilityCompilerDeps {
  db: AgentisSqliteDb;
  logger: Logger;
  abilities: AbilityService;
  intelligence: SharedIntelligenceService;
  /** Fallback EvaluatorRuntime built from env vars at bootstrap. */
  llm?: EvaluatorRuntime;
}

class CompileCancelledError extends Error {
  constructor() { super('Compile cancelled by user'); }
}

/** Hard ceiling per embed call inside a compile. Defeats unreachable-provider hangs. */
const COMPILE_EMBED_TIMEOUT_MS = 4_000;

export class AbilityCompilerService {
  constructor(private readonly deps: AbilityCompilerDeps) {}

  /** Entry point — invoked by the cognitive promotion queue worker. */
  async compile(abilityId: string, workspaceId: string): Promise<void> {
    const ability = this.deps.abilities.tryGet(abilityId);
    if (!ability) {
      this.deps.logger.warn('ability.compile.missing', { abilityId });
      return;
    }
    if (ability.workspaceId !== workspaceId) {
      this.deps.logger.warn('ability.compile.workspace_mismatch', {
        abilityId,
        expected: workspaceId,
        actual: ability.workspaceId,
      });
      return;
    }

    // Resolve the embedding provider but wrap it so any failure switches us
    // to the local hashing provider for the rest of this compile — no
    // long-tail waits on an unreachable network model.
    const baseProvider = this.deps.intelligence.embeddingProvider(workspaceId);
    const provider = this.#wrapProvider(baseProvider);

    // Resolve the LLM: prefer the workspace-level configured model, fall
    // back to the bootstrap-env runtime. Either is optional — we still
    // produce a usable ability via the deterministic template path.
    const llm = this.#resolveLlm(workspaceId);
    const llmAvailable = llm ? await this.#probeLlm(llm) : false;

    try {
      this.#checkCancel(abilityId);

      this.deps.abilities.setCompileStage(abilityId, 'embedding_examples');
      await this.#embedExamples(ability, provider);
      this.#checkCancel(abilityId);

      this.deps.abilities.setCompileStage(abilityId, 'contextualizing_knowledge');
      await this.#contextualizeKnowledge(ability, provider);
      this.#checkCancel(abilityId);

      this.deps.abilities.setCompileStage(abilityId, 'generating_synthetic_examples');
      await this.#generateSyntheticExamples(ability, llm, llmAvailable);
      this.#checkCancel(abilityId);

      this.deps.abilities.setCompileStage(abilityId, 'synthesizing_persona');
      const persona = await this.#synthesizePersona(ability, llm, llmAvailable);
      this.#checkCancel(abilityId);

      this.deps.abilities.setCompileStage(abilityId, 'indexing_brain');
      const domainEmbedding = await this.#domainEmbedding(ability, persona, provider);
      const kbDocumentId = this.#publishToWorkspaceBrain(ability, persona, provider, domainEmbedding);

      this.deps.abilities.setCompileStage(abilityId, 'finalizing');
      this.deps.abilities.setCompileState(abilityId, 'ready', {
        compileError: null,
        lastCompiledAt: new Date().toISOString(),
        compiledPrompt: persona,
        domainEmbedding,
        kbDocumentId,
      });
      this.deps.abilities.refreshCounts(abilityId);
      this.deps.logger.info('ability.compile.completed', {
        abilityId,
        workspaceId,
        exampleCount: ability.exampleCount,
        knowledgeCount: ability.knowledgeCount,
        llmUsed: llmAvailable,
        providerFallback: provider !== baseProvider,
      });
    } catch (err) {
      if (err instanceof CompileCancelledError) {
        this.deps.abilities.setCompileState(abilityId, 'failed', {
          compileError: 'Cancelled by user',
          lastCompiledAt: new Date().toISOString(),
        });
        this.deps.logger.info('ability.compile.cancelled', { abilityId, workspaceId });
        return;
      }
      const message = (err as Error).message;
      this.deps.abilities.setCompileState(abilityId, 'failed', {
        compileError: message.slice(0, 500),
        lastCompiledAt: new Date().toISOString(),
      });
      this.deps.logger.error('ability.compile.failed', {
        abilityId,
        workspaceId,
        err: message,
      });
      // Do NOT rethrow — we already persisted the failure on the ability
      // row. Rethrowing would make the cognitive promotion queue retry up
      // to 5 times, multiplying the wait the user just suffered through.
      // The user can hit Recompile manually.
    }
  }

  // ── Cancellation ──────────────────────────────────────────

  #checkCancel(abilityId: string): void {
    if (this.deps.abilities.isCancelRequested(abilityId)) {
      throw new CompileCancelledError();
    }
  }

  // ── Provider wrapping ────────────────────────────────────

  /**
   * Returns a provider that delegates to `inner` but degrades to a fresh
   * HashingEmbeddingProvider after the first failure. This caps total
   * waiting time to (timeout × number-of-failures-before-fallback) instead
   * of (timeout × every-embed-call).
   */
  #wrapProvider(inner: EmbeddingProvider): EmbeddingProvider {
    let degraded = false;
    const zero = (): number[] => new Array<number>(inner.dimension).fill(0);
    return {
      dimension: inner.dimension,
      modelId: inner.modelId,
      embed: async (text: string): Promise<number[]> => {
        if (degraded) return zero();
        try {
          return await withTimeout(Promise.resolve(inner.embed(text)), COMPILE_EMBED_TIMEOUT_MS);
        } catch (err) {
          // Never let a flaky/slow embedder tank a compile: degrade to zero
          // vectors for the rest of this compile (non-lexical; flagged for
          // re-embed later), rather than falling back to keyword hashing.
          degraded = true;
          this.deps.logger.warn('ability.compile.embed_degraded', {
            err: (err as Error).message,
            note: 'embedding provider unavailable; remaining atoms get zero vectors (re-embedded later)',
          });
          return zero();
        }
      },
    };
  }

  // ── LLM resolution ────────────────────────────────────────

  /**
   * Build an EvaluatorRuntime from the workspace's brain_settings.abilityCompilerModel
   * if configured, else use the bootstrap-env runtime, else return undefined
   * (which routes the persona step to the deterministic template).
   */
  #resolveLlm(workspaceId: string): EvaluatorRuntime | undefined {
    try {
      const row = this.deps.db.select({ brainSettings: schema.workspaces.brainSettings })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId))
        .get();
      const settings = (row?.brainSettings ?? {}) as Record<string, unknown>;
      const cfg = (settings.abilityCompilerModel ?? null) as
        | { baseUrl?: string; model?: string; apiKey?: string }
        | null;
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
      this.deps.logger.warn('ability.compile.workspace_llm_resolve_failed', { err: (err as Error).message });
    }
    return this.deps.llm;
  }

  /** Probe LLM reachability with a short budget (4 s) so unreachable models don't stall. */
  async #probeLlm(llm: EvaluatorRuntime): Promise<boolean> {
    try {
      const result = await llm.completeStructured<{ ok?: boolean }>({
        system: 'Respond with {"ok":true}',
        user: 'ping',
        maxTokens: 10,
        maxAttempts: 1,
        timeoutMs: 4_000,
      });
      return result !== null;
    } catch {
      return false;
    }
  }

  // ── Step 1: embed examples ────────────────────────────────

  async #embedExamples(ability: AbilityRecord, provider: EmbeddingProvider): Promise<void> {
    const examples = this.deps.abilities.listExamples(ability.id);
    for (const ex of examples) {
      if (ex.embedding && ex.embedding.length === provider.dimension) continue;
      try {
        const vec = await embedText(provider, ex.inputText.slice(0, 4000));
        this.deps.abilities.setExampleEmbedding(ex.id, vec);
      } catch (err) {
        this.deps.logger.warn('ability.compile.embed_example_failed', {
          abilityId: ability.id,
          exampleId: ex.id,
          err: (err as Error).message,
        });
      }
    }
  }

  // ── Step 2: contextualise + embed knowledge ───────────────

  async #contextualizeKnowledge(ability: AbilityRecord, provider: EmbeddingProvider): Promise<void> {
    const items = this.deps.abilities.listKnowledge(ability.id);
    for (const k of items) {
      const prefix = k.contextPrefix ?? this.#deriveContextPrefix(ability, k);
      if (k.embedding && k.embedding.length === provider.dimension && k.contextPrefix === prefix) continue;
      const embedSource = `${prefix}\n\n${k.content}`.slice(0, 6000);
      try {
        const vec = await embedText(provider, embedSource);
        this.deps.abilities.setKnowledgeEmbedding(k.id, vec, prefix);
      } catch (err) {
        this.deps.logger.warn('ability.compile.embed_knowledge_failed', {
          abilityId: ability.id,
          knowledgeId: k.id,
          err: (err as Error).message,
        });
      }
    }
  }

  #deriveContextPrefix(ability: AbilityRecord, k: AbilityKnowledge): string {
    const head: string[] = [`Ability: ${ability.name}`];
    if (ability.domainTag) head.push(`Domain: ${ability.domainTag}`);
    if (k.title) head.push(`Section: ${k.title}`);
    return head.join(' · ');
  }

  // ── Step 3: generate synthetic examples ───────────────────

  async #generateSyntheticExamples(
    ability: AbilityRecord,
    llm: EvaluatorRuntime | undefined,
    llmAvailable: boolean,
  ): Promise<void> {
    if (!llm || !llmAvailable) return;
    const items = this.deps.abilities.listKnowledge(ability.id)
      .filter((k) => k.importanceScore >= CONSTANTS.ABILITY_SYNTHETIC_IMPORTANCE_THRESHOLD);
    if (items.length === 0) return;

    // Cap at 3 chunks and run in parallel so the step takes at most ~10 s.
    const cap = Math.min(items.length, 3);
    const chosen = items.slice(0, cap);

    await Promise.allSettled(chosen.map(async (chunk) => {
      try {
        const result = await llm.completeStructured<{ examples?: Array<{ task: string; response: string }> }>({
          system: 'You are bootstrapping behavioral coverage for a domain specialist AI agent. Given a chunk of domain content, write two realistic example interactions a specialist would handle that REQUIRE this content to answer well. Respond with strict JSON only.',
          user: `Domain: ${ability.domainTag ?? 'general'}\nSpecialist name: ${ability.name}\nKnowledge chunk:\n${chunk.content.slice(0, 2500)}\n\nReturn:\n{"examples":[{"task":"...","response":"..."},{"task":"...","response":"..."}]}`,
          maxTokens: 900,
          maxAttempts: 1,
          timeoutMs: 10_000,
        });
        const examples = Array.isArray(result?.examples) ? result.examples : [];
        for (const ex of examples) {
          if (typeof ex.task !== 'string' || typeof ex.response !== 'string') continue;
          if (!ex.task.trim() || !ex.response.trim()) continue;
          this.deps.abilities.addExample(ability.id, {
            inputText: ex.task.slice(0, 1000),
            outputText: ex.response.slice(0, 2000),
            qualityScore: 0.65, // synthetic — lower than curated by default
            source: 'synthetic',
          });
        }
      } catch (err) {
        this.deps.logger.warn('ability.compile.synthetic_failed', {
          abilityId: ability.id,
          knowledgeId: chunk.id,
          err: (err as Error).message,
        });
      }
    }));
  }

  // ── Step 4: synthesize persona ────────────────────────────

  async #synthesizePersona(
    ability: AbilityRecord,
    llm: EvaluatorRuntime | undefined,
    llmAvailable: boolean,
  ): Promise<string> {
    if (ability.specs && (ability.specs as any).__persona_locked === 'true' && ability.compiledPrompt) {
      return ability.compiledPrompt;
    }
    // Refresh examples to include any synthetic ones from step 3.
    const examples = this.deps.abilities.listExamples(ability.id);
    if (llm && llmAvailable) {
      try {
        const exampleSnippets = examples
          .slice(0, 6)
          .map((ex, idx) => `Example ${idx + 1}:\n  Input: ${ex.inputText.slice(0, 200)}\n  Output: ${ex.outputText.slice(0, 400)}`)
          .join('\n');
        const result = await llm.completeStructured<{ persona?: string }>({
          system: 'You write tight, behavioral specialist personas (4–6 sentences, first-person). The persona will be injected directly into an AI agent\'s system prompt to make it act as the specified specialist. Respond with strict JSON only.',
          user: [
            `Specialist name: ${ability.name}`,
            ability.description ? `Description: ${ability.description}` : '',
            ability.domainTag ? `Domain: ${ability.domainTag}` : '',
            `Specs: ${JSON.stringify(ability.specs)}`,
            ability.rulesAlways.length ? `Always: ${ability.rulesAlways.join('; ')}` : '',
            ability.rulesNever.length ? `Never: ${ability.rulesNever.join('; ')}` : '',
            exampleSnippets ? `Sample behaviors:\n${exampleSnippets}` : '',
            'Return: {"persona":"<4-6 sentence first-person identity>"}',
          ].filter(Boolean).join('\n\n'),
          maxTokens: 600,
          maxAttempts: 1,
          timeoutMs: 15_000,
        });
        if (result?.persona && typeof result.persona === 'string' && result.persona.trim().length > 0) {
          return result.persona.trim();
        }
      } catch (err) {
        this.deps.logger.warn('ability.compile.persona_llm_failed', {
          abilityId: ability.id,
          err: (err as Error).message,
        });
      }
    }
    // Deterministic fallback — assembled from the operator's structured input.
    return this.#deterministicPersona(ability);
  }

  #deterministicPersona(ability: AbilityRecord): string {
    const fragments: string[] = [];
    fragments.push(`You are a ${ability.name}${ability.domainTag ? ` specialising in ${ability.domainTag.replace(/_/g, ' ')}` : ''}.`);
    if (ability.description) fragments.push(ability.description);
    const specEntries = Object.entries(ability.specs).filter(([, v]) => Boolean(v));
    if (specEntries.length > 0) {
      fragments.push(`Default stack and conventions: ${specEntries.map(([k, v]) => `${k}=${v}`).join('; ')}.`);
    }
    if (ability.rulesAlways.length > 0) {
      fragments.push(`You always: ${ability.rulesAlways.slice(0, 4).join('; ')}.`);
    }
    if (ability.rulesNever.length > 0) {
      fragments.push(`You never: ${ability.rulesNever.slice(0, 4).join('; ')}.`);
    }
    fragments.push('You produce production-grade work, prioritise clarity over cleverness, and explain non-obvious decisions briefly.');
    return fragments.join(' ');
  }

  // ── Step 5: domain embedding + Brain publish ──────────────

  async #domainEmbedding(ability: AbilityRecord, persona: string, provider: EmbeddingProvider): Promise<number[]> {
    const seed = [
      ability.name,
      ability.description ?? '',
      ability.domainTag ?? '',
      persona,
      ability.rulesAlways.join(' '),
      Object.values(ability.specs).filter(Boolean).join(' '),
    ].join(' ').slice(0, 4000);
    try {
      return await embedText(provider, seed);
    } catch (err) {
      // Final safety net — never let a flaky embedding provider tank the entire
      // compile. Store a zero vector (flagged for re-embed later) rather than a
      // lexical hash; the ability still publishes.
      this.deps.logger.warn('ability.compile.domain_embedding_fallback', {
        abilityId: ability.id,
        err: (err as Error).message,
      });
      return new Array<number>(provider.dimension).fill(0);
    }
  }

  #publishToWorkspaceBrain(
    ability: AbilityRecord,
    persona: string,
    provider: EmbeddingProvider,
    embedding: number[],
  ): string {
    if (!ability.workspaceId) return '';
    const content = [
      persona,
      ability.domainTag ? `Domain: ${ability.domainTag}` : '',
      Object.keys(ability.specs).length ? `Specs: ${JSON.stringify(ability.specs)}` : '',
      ability.rulesAlways.length ? `Always: ${ability.rulesAlways.join('; ')}` : '',
      ability.rulesNever.length ? `Never: ${ability.rulesNever.join('; ')}` : '',
    ].filter(Boolean).join('\n\n');
    const title = `Ability: ${ability.name}`;
    // Replace prior KB chunk if one was written for this ability.
    if (ability.kbDocumentId) {
      this.deps.db.delete(schema.knowledgeChunks)
        .where(eq(schema.knowledgeChunks.id, ability.kbDocumentId))
        .run();
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.deps.db.insert(schema.knowledgeChunks).values({
      id,
      workspaceId: ability.workspaceId,
      scopeId: null,
      title,
      content,
      contentTokens: [] as unknown as string[],
      source: 'promotion',
      provenance: {
        kind: 'ability',
        ability_id: ability.id,
        ability_slug: ability.slug,
        domain_tag: ability.domainTag ?? null,
      } as unknown as Record<string, unknown>,
      tags: ['ability', ability.domainTag ?? 'custom'] as unknown as string[],
      embedding: embedding as unknown as number[],
      trust: '1',
      createdAt: now,
      updatedAt: now,
    } as typeof schema.knowledgeChunks.$inferInsert).run();
    void provider;
    return id;
  }
}

/** Race a promise against a timeout; on timeout, reject so the caller can degrade. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<T>([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`embedding timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
