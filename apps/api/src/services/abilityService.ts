/**
 * AbilityService — CRUD + dispatch-time context assembly for Abilities
 * (docs/brain/ABILITIES.md).
 *
 * An Ability is a workspace-level, compiled behavioral specialization unit.
 * Lifecycle:
 *
 *   1. Operator creates an ability draft (name, domain, specs, rules) and
 *      attaches examples + reference material.
 *   2. `AbilityCompilerService` runs the §4 compile pipeline async via the
 *      CognitivePromotionQueueWorker; on success the ability transitions to
 *      `compile_status='ready'` and a synthetic KB document is persisted so
 *      the ability is searchable from the workspace Brain.
 *   3. At every agent dispatch the WorkflowEngine scores all compiled abilities
 *      against the current task (cosine over `domain_embedding`), merges in
 *      any pinned abilities, then asks this service for a token-budget-aware
 *      `<ability>…</ability>` XML block per injected ability.
 *
 * No agent-level config is required: abilities are workspace-scoped and the
 * dispatch engine resolves which fire by relevance.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, desc, inArray } from 'drizzle-orm';
import { AgentisError, CONSTANTS } from '@agentis/core';
import type {
  AbilityRecord,
  AbilityExample,
  AbilityKnowledge,
  AbilityCompileStatus,
  AbilityExampleSource,
  AbilityKnowledgeSourceType,
  AbilitySpecs,
  AbilityPackage,
  AgentAbilityPin,
  AbilityDepth,
  AbilityVisibility,
  AbilityOrigin,
  AbilityExecutionPolicy,
  AbilityRoutingPolicy,
  AbilityEvalRun,
  AbilityActivation,
} from '@agentis/core';
import { createHash } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import { cosineSimilarity, type EmbeddingProvider } from './embeddingProvider.js';
import type { CredentialVault } from './credentialVault.js';
import { encode } from 'gpt-tokenizer';

// ────────────────────────────────────────────────────────────
// Input shapes
// ────────────────────────────────────────────────────────────

export interface CreateAbilityInput {
  workspaceId: string;
  name: string;
  slug?: string;
  description?: string | null;
  domainTag?: string | null;
  iconEmoji?: string | null;
  authorId?: string | null;
  specs?: AbilitySpecs;
  rulesAlways?: string[];
  rulesNever?: string[];
  toolHints?: string[];
  tokenBudget?: number | null;
  
  // -- V2 Features --
  mode?: 'compiled' | 'static';
  slashCommand?: string | null;
  commandDispatch?: 'model' | 'tool' | null;
  commandToolName?: string | null;
  envKeys?: string[];
  envSecretIds?: string[];
  gate?: import('@agentis/core').AbilityGate | null;
  minRelevanceScore?: number | null;
  preferredModel?: string | null;

  // -- ABILITIES-10X --
  depth?: AbilityDepth;
  visibility?: AbilityVisibility;
  origin?: AbilityOrigin | null;
  executionPolicy?: AbilityExecutionPolicy | null;
  routingPolicy?: AbilityRoutingPolicy | null;
}

export interface UpdateAbilityInput {
  name?: string;
  slug?: string;
  description?: string | null;
  domainTag?: string | null;
  iconEmoji?: string | null;
  specs?: AbilitySpecs;
  rulesAlways?: string[];
  rulesNever?: string[];
  toolHints?: string[];
  tokenBudget?: number | null;
  isPublic?: boolean;
  compiledPrompt?: string | null;
  /** Marks the ability dirty so the queue picks it up. */
  markDirty?: boolean;

  // -- V2 Features --
  mode?: 'compiled' | 'static';
  slashCommand?: string | null;
  commandDispatch?: 'model' | 'tool' | null;
  commandToolName?: string | null;
  envKeys?: string[];
  envSecretIds?: string[];
  gate?: import('@agentis/core').AbilityGate | null;
  minRelevanceScore?: number | null;
  preferredModel?: string | null;

  // -- ABILITIES-10X --
  depth?: AbilityDepth;
  visibility?: AbilityVisibility;
  origin?: AbilityOrigin | null;
  executionPolicy?: AbilityExecutionPolicy | null;
  routingPolicy?: AbilityRoutingPolicy | null;
}

export interface AddExampleInput {
  inputText: string;
  outputText: string;
  inputMediaUrl?: string | null;
  mediaDescription?: string | null;
  qualityScore?: number;
  source?: AbilityExampleSource;
  originRunId?: string | null;
  embedding?: number[] | null;
}

export interface UpdateExampleInput {
  inputText?: string;
  outputText?: string;
  qualityScore?: number;
  inputMediaUrl?: string | null;
  mediaDescription?: string | null;
}

export interface AddKnowledgeInput {
  title?: string | null;
  content: string;
  contextPrefix?: string | null;
  sourceType?: AbilityKnowledgeSourceType;
  sourceUrl?: string | null;
  importanceScore?: number;
  kbChunkId?: string | null;
  embedding?: number[] | null;
}

export interface ScoredAbility {
  ability: AbilityRecord;
  score: number;
}

// ────────────────────────────────────────────────────────────
// Service
// ────────────────────────────────────────────────────────────

export class AbilityService {
  /** Set by AbilityCompilerService.attach() after both services are constructed. */
  #onCompileRequested?: (abilityId: string, workspaceId: string) => void;

  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly logger: Logger,
  ) {}

  /** Wire the compile trigger (avoids circular dep between services). */
  attachCompileHook(fn: (abilityId: string, workspaceId: string) => void): void {
    this.#onCompileRequested = fn;
  }

  // ── CRUD ──────────────────────────────────────────────────

  create(input: CreateAbilityInput): AbilityRecord {
    const now = new Date().toISOString();
    const id = randomUUID();
    const baseSlug = (input.slug ?? slugify(input.name)).trim();
    if (!baseSlug) throw new AgentisError('VALIDATION_FAILED', 'ability slug cannot be empty');

    const duplicate = this.db.select({ id: schema.abilities.id }).from(schema.abilities)
      .where(and(eq(schema.abilities.workspaceId, input.workspaceId), eq(schema.abilities.slug, baseSlug)))
      .get();
    if (duplicate && baseSlug !== 'untitled-ability') {
      throw new AgentisError('VALIDATION_FAILED', `ability slug "${baseSlug}" already exists`);
    }

    // Auto-increment only the default draft slug so the New ability button can
    // be clicked repeatedly without failing on "Untitled ability".
    const slug = duplicate ? this.#uniqueSlug(input.workspaceId, baseSlug) : baseSlug;

    this.db.insert(schema.abilities).values({
      id,
      workspaceId: input.workspaceId,
      name: input.name.trim(),
      slug,
      description: input.description ?? null,
      domainTag: input.domainTag ?? null,
      iconEmoji: input.iconEmoji ?? '⚡',
      authorId: input.authorId ?? null,
      specs: (input.specs ?? {}) as unknown as Record<string, unknown>,
      rulesAlways: (input.rulesAlways ?? []) as unknown as string[],
      rulesNever: (input.rulesNever ?? []) as unknown as string[],
      toolHints: (input.toolHints ?? []) as unknown as string[],
      mode: input.mode ?? 'compiled',
      slashCommand: input.slashCommand ?? null,
      commandDispatch: input.commandDispatch ?? null,
      commandToolName: input.commandToolName ?? null,
      envKeys: (input.envKeys ?? []) as unknown as string[],
      envSecretIds: (input.envSecretIds ?? []) as unknown as string[],
      gate: (input.gate ?? null) as unknown as Record<string, unknown>,
      minRelevanceScore: input.minRelevanceScore ?? null,
      preferredModel: input.preferredModel ?? null,
      tokenBudget: input.tokenBudget ?? null,
      depth: input.depth ?? 'd0_instinct',
      visibility: input.visibility ?? 'workspace',
      origin: (input.origin ?? null) as unknown as Record<string, unknown> | null,
      executionPolicy: (input.executionPolicy ?? null) as unknown as Record<string, unknown> | null,
      routingPolicy: (input.routingPolicy ?? null) as unknown as Record<string, unknown> | null,
      contentHash: this.#hashBehavior({
        compiledPrompt: null,
        specs: input.specs ?? {},
        rulesAlways: input.rulesAlways ?? [],
        rulesNever: input.rulesNever ?? [],
        toolHints: input.toolHints ?? [],
      }),
      compileStatus: input.mode === 'static' ? 'ready' : 'pending',
      createdAt: now,
      updatedAt: now,
    }).run();
    return this.get(id);
  }

  update(id: string, input: UpdateAbilityInput): AbilityRecord {
    const current = this.get(id);
    if (!current.workspaceId) {
      throw new AgentisError('VALIDATION_FAILED', 'Ability is not attached to a workspace');
    }
    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.slug !== undefined) {
      // Explicit slug provided — use it (deduplicated against other abilities).
      patch.slug = this.#uniqueSlug(current.workspaceId, slugify(input.slug), id);
    } else if (input.name !== undefined) {
      // Name changed without an explicit new slug → auto-derive slug from the new name.
      const derived = slugify(input.name.trim());
      if (derived) patch.slug = this.#uniqueSlug(current.workspaceId, derived, id);
    }
    if (input.description !== undefined) patch.description = input.description;
    if (input.domainTag !== undefined) patch.domainTag = input.domainTag;
    if (input.iconEmoji !== undefined) patch.iconEmoji = input.iconEmoji;
    if (input.specs !== undefined) patch.specs = input.specs as unknown as Record<string, unknown>;
    if (input.rulesAlways !== undefined) patch.rulesAlways = input.rulesAlways;
    if (input.rulesNever !== undefined) patch.rulesNever = input.rulesNever;
    if (input.toolHints !== undefined) patch.toolHints = input.toolHints;
    if (input.tokenBudget !== undefined) patch.tokenBudget = input.tokenBudget;
    if (input.isPublic !== undefined) patch.isPublic = input.isPublic;
    if (input.compiledPrompt !== undefined) patch.compiledPrompt = input.compiledPrompt;
    if (input.mode !== undefined) patch.mode = input.mode;
    if (input.slashCommand !== undefined) patch.slashCommand = input.slashCommand;
    if (input.commandDispatch !== undefined) patch.commandDispatch = input.commandDispatch;
    if (input.commandToolName !== undefined) patch.commandToolName = input.commandToolName;
    if (input.envKeys !== undefined) patch.envKeys = input.envKeys as unknown as string[];
    if (input.envSecretIds !== undefined) patch.envSecretIds = input.envSecretIds as unknown as string[];
    if (input.gate !== undefined) patch.gate = input.gate as unknown as Record<string, unknown>;
    if (input.minRelevanceScore !== undefined) patch.minRelevanceScore = input.minRelevanceScore;
    if (input.preferredModel !== undefined) patch.preferredModel = input.preferredModel;
    if (input.depth !== undefined) patch.depth = input.depth;
    if (input.visibility !== undefined) patch.visibility = input.visibility;
    if (input.origin !== undefined) patch.origin = input.origin as unknown as Record<string, unknown> | null;
    if (input.executionPolicy !== undefined) patch.executionPolicy = input.executionPolicy as unknown as Record<string, unknown> | null;
    if (input.routingPolicy !== undefined) patch.routingPolicy = input.routingPolicy as unknown as Record<string, unknown> | null;

    // Behavioral changes invalidate the compiled artifact — mark dirty so the
    // background worker recompiles before the next dispatch picks it up.
    const behavioralKeys: (keyof UpdateAbilityInput)[] = ['specs', 'rulesAlways', 'rulesNever', 'toolHints', 'description', 'domainTag', 'name', 'compiledPrompt'];
    const dirty = input.markDirty
      || behavioralKeys.some((k) => (input as Record<string, unknown>)[k] !== undefined);
    
    // For compiled mode, behavioral changes make it dirty.
    // For static mode, no compilation happens, so it always returns to ready.
    if (dirty && current.compileStatus === 'ready' && (patch.mode ?? current.mode) === 'compiled') {
      patch.compileStatus = 'dirty';
    } else if ((patch.mode ?? current.mode) === 'static') {
      patch.compileStatus = 'ready';
    }

    // Recompute the content hash whenever the behavioral payload changes so the
    // Ability Cache (and prefix-cache ordering) keys off a stable fingerprint.
    if (dirty) {
      patch.contentHash = this.#hashBehavior({
        compiledPrompt: (patch.compiledPrompt as string | null | undefined) ?? current.compiledPrompt,
        specs: (patch.specs as AbilitySpecs | undefined) ?? current.specs,
        rulesAlways: (patch.rulesAlways as string[] | undefined) ?? current.rulesAlways,
        rulesNever: (patch.rulesNever as string[] | undefined) ?? current.rulesNever,
        toolHints: (patch.toolHints as string[] | undefined) ?? current.toolHints,
      });
    }

    this.db.update(schema.abilities).set(patch).where(eq(schema.abilities.id, id)).run();
    return this.get(id);
  }

  /** Stable SHA-256 of the behavioral payload — drives the Ability Cache. */
  #hashBehavior(payload: {
    compiledPrompt: string | null;
    specs: AbilitySpecs;
    rulesAlways: string[];
    rulesNever: string[];
    toolHints: string[];
  }): string {
    const canonical = JSON.stringify({
      p: payload.compiledPrompt ?? '',
      s: Object.keys(payload.specs ?? {}).sort().map((k) => [k, payload.specs[k]]),
      a: [...(payload.rulesAlways ?? [])].sort(),
      n: [...(payload.rulesNever ?? [])].sort(),
      t: [...(payload.toolHints ?? [])].sort(),
    });
    return createHash('sha256').update(canonical).digest('hex');
  }

  // ── ABILITIES-10X: self-eval evidence + activation ledger ──

  /** Persist a self-eval run (a promotion gate, not a proof). */
  recordEvalRun(input: {
    abilityId: string;
    workspaceId: string | null;
    kind?: AbilityEvalRun['kind'];
    score: number;
    passed: boolean;
    caseCount: number;
    failures?: AbilityEvalRun['failures'];
    summary?: string | null;
    model?: string | null;
  }): AbilityEvalRun {
    const row = {
      id: randomUUID(),
      abilityId: input.abilityId,
      workspaceId: input.workspaceId ?? null,
      kind: input.kind ?? 'self_eval',
      score: clamp01(input.score),
      passed: input.passed,
      caseCount: input.caseCount,
      failures: (input.failures ?? []) as unknown as AbilityEvalRun['failures'],
      summary: input.summary ?? null,
      model: input.model ?? null,
      createdAt: new Date().toISOString(),
    };
    this.db.insert(schema.abilityEvalRuns).values(row).run();
    return toEvalRun(row);
  }

  listEvalRuns(abilityId: string, limit = 20): AbilityEvalRun[] {
    return this.db.select().from(schema.abilityEvalRuns)
      .where(eq(schema.abilityEvalRuns.abilityId, abilityId))
      .all()
      .map(toEvalRun)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit);
  }

  /** Latest passing self-eval, if any — used as the promotion gate. */
  latestPassingEval(abilityId: string): AbilityEvalRun | null {
    return this.listEvalRuns(abilityId).find((r) => r.passed) ?? null;
  }

  /** Append one row to the activation ledger (the free flywheel). */
  recordActivation(input: {
    workspaceId: string | null;
    runId?: string | null;
    agentId?: string | null;
    model?: string | null;
    abilityIds: string[];
    conflictsResolved?: AbilityActivation['conflictsResolved'];
    outcome?: string | null;
    qualityScore?: number | null;
    consentScope?: AbilityActivation['consentScope'];
  }): AbilityActivation {
    const row = {
      id: randomUUID(),
      workspaceId: input.workspaceId ?? null,
      runId: input.runId ?? null,
      agentId: input.agentId ?? null,
      model: input.model ?? null,
      abilityIds: (input.abilityIds ?? []) as unknown as string[],
      conflictsResolved: (input.conflictsResolved ?? []) as unknown as AbilityActivation['conflictsResolved'],
      outcome: input.outcome ?? null,
      qualityScore: input.qualityScore ?? null,
      consentScope: input.consentScope ?? 'workspace_private',
      createdAt: new Date().toISOString(),
    };
    this.db.insert(schema.abilityActivations).values(row).run();
    return toActivation(row);
  }

  listActivations(workspaceId: string, limit = 50): AbilityActivation[] {
    return this.db.select().from(schema.abilityActivations)
      .where(eq(schema.abilityActivations.workspaceId, workspaceId))
      .all()
      .map(toActivation)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit);
  }

  delete(id: string): void {
    const result = this.db.delete(schema.abilities).where(eq(schema.abilities.id, id)).run();
    if (Number(result.changes ?? 0) === 0) {
      throw new AgentisError('RESOURCE_NOT_FOUND', 'Ability not found');
    }
  }

  get(id: string): AbilityRecord {
    const row = this.db.select().from(schema.abilities).where(eq(schema.abilities.id, id)).get();
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', 'Ability not found');
    return toRecord(row);
  }

  /** Quietly returns null instead of throwing — used by hot paths. */
  tryGet(id: string): AbilityRecord | null {
    const row = this.db.select().from(schema.abilities).where(eq(schema.abilities.id, id)).get();
    return row ? toRecord(row) : null;
  }

  list(workspaceId: string): AbilityRecord[] {
    return this.db
      .select()
      .from(schema.abilities)
      .where(eq(schema.abilities.workspaceId, workspaceId))
      .all()
      .map(toRecord)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  /** Compiled abilities only — what dispatch considers. */
  listCompiled(workspaceId: string): AbilityRecord[] {
    return this.db
      .select()
      .from(schema.abilities)
      .where(and(
        eq(schema.abilities.workspaceId, workspaceId),
        eq(schema.abilities.compileStatus, 'ready'),
      ))
      .all()
      .map(toRecord);
  }

  // ── Examples ──────────────────────────────────────────────

  async resolveEnv(abilityId: string, vault: CredentialVault): Promise<Record<string, string>> {
    const ability = this.get(abilityId);
    if (!ability.workspaceId) return {};
    const env: Record<string, string> = {};
    
    // 1. Resolve workspace secrets
    if (ability.envSecretIds && ability.envSecretIds.length > 0) {
      for (const secretId of ability.envSecretIds) {
        const cred = this.db.select().from(schema.credentials)
          .where(and(eq(schema.credentials.workspaceId, ability.workspaceId), eq(schema.credentials.id, secretId)))
          .get();
        if (cred) {
          try {
            const val = await vault.decrypt(cred.encryptedValue);
            env[cred.name] = val;
          } catch (e) {
            this.logger.warn('ability.secret.resolve_failed', { abilityId, secretId });
          }
        }
      }
    }

    // 2. Resolve process env keys (pass-through)
    if (ability.envKeys && ability.envKeys.length > 0) {
      for (const key of ability.envKeys) {
        if (process.env[key] !== undefined) {
          env[key] = process.env[key]!;
        }
      }
    }
    return env;
  }

  findBySlashCommand(workspaceId: string, command: string): AbilityRecord | null {
    if (!command) return null;
    const cmd = command.startsWith('/') ? command.slice(1) : command;
    const match = this.db.select().from(schema.abilities)
      .where(and(
        eq(schema.abilities.workspaceId, workspaceId),
        eq(schema.abilities.slashCommand, cmd),
        inArray(schema.abilities.compileStatus, ['ready', 'dirty'])
      ))
      .get();
    return match ? (match as unknown as AbilityRecord) : null;
  }

  addExample(abilityId: string, input: AddExampleInput): AbilityExample {
    this.get(abilityId); // existence check
    const id = randomUUID();
    const row = {
      id,
      abilityId,
      inputText: input.inputText,
      outputText: input.outputText,
      inputMediaUrl: input.inputMediaUrl ?? null,
      mediaDescription: input.mediaDescription ?? null,
      qualityScore: clamp01(input.qualityScore ?? 0.8),
      source: input.source ?? 'user_curated',
      embedding: input.embedding ?? null,
      originRunId: input.originRunId ?? null,
      createdAt: new Date().toISOString(),
    };
    this.db.insert(schema.abilityExamples).values(row).run();
    this.#bumpExampleCount(abilityId);
    this.#markDirty(abilityId);
    return toExample(row);
  }

  listExamples(abilityId: string): AbilityExample[] {
    return this.db
      .select()
      .from(schema.abilityExamples)
      .where(eq(schema.abilityExamples.abilityId, abilityId))
      .all()
      .map(toExample);
  }

  updateExample(exampleId: string, input: UpdateExampleInput): AbilityExample {
    const current = this.db
      .select()
      .from(schema.abilityExamples)
      .where(eq(schema.abilityExamples.id, exampleId))
      .get();
    if (!current) throw new AgentisError('RESOURCE_NOT_FOUND', 'Example not found');
    const patch: Record<string, unknown> = {};
    if (input.inputText !== undefined) patch.inputText = input.inputText;
    if (input.outputText !== undefined) patch.outputText = input.outputText;
    if (input.qualityScore !== undefined) patch.qualityScore = clamp01(input.qualityScore);
    if (input.inputMediaUrl !== undefined) patch.inputMediaUrl = input.inputMediaUrl;
    if (input.mediaDescription !== undefined) patch.mediaDescription = input.mediaDescription;
    if (input.inputText !== undefined) patch.embedding = null; // re-embed required
    this.db.update(schema.abilityExamples).set(patch).where(eq(schema.abilityExamples.id, exampleId)).run();
    this.#markDirty(current.abilityId);
    return toExample({ ...current, ...patch });
  }

  deleteExample(exampleId: string): void {
    const current = this.db
      .select()
      .from(schema.abilityExamples)
      .where(eq(schema.abilityExamples.id, exampleId))
      .get();
    if (!current) throw new AgentisError('RESOURCE_NOT_FOUND', 'Example not found');
    this.db.delete(schema.abilityExamples).where(eq(schema.abilityExamples.id, exampleId)).run();
    this.#bumpExampleCount(current.abilityId, -1);
    this.#markDirty(current.abilityId);
  }

  promoteRunToExample(args: {
    abilityId: string;
    runId: string;
    inputText: string;
    outputText: string;
    qualityScore?: number;
  }): AbilityExample {
    return this.addExample(args.abilityId, {
      inputText: args.inputText,
      outputText: args.outputText,
      qualityScore: args.qualityScore ?? 0.85,
      source: 'promoted_from_run',
      originRunId: args.runId,
    });
  }

  // ── Knowledge ─────────────────────────────────────────────

  addKnowledge(abilityId: string, input: AddKnowledgeInput): AbilityKnowledge {
    this.get(abilityId);
    const id = randomUUID();
    const row = {
      id,
      abilityId,
      kbChunkId: input.kbChunkId ?? null,
      title: input.title ?? null,
      content: input.content,
      contextPrefix: input.contextPrefix ?? null,
      embedding: input.embedding ?? null,
      sourceType: input.sourceType ?? 'document' as AbilityKnowledgeSourceType,
      sourceUrl: input.sourceUrl ?? null,
      importanceScore: clamp01(input.importanceScore ?? 0.5),
      createdAt: new Date().toISOString(),
    };
    this.db.insert(schema.abilityKnowledge).values(row).run();
    this.#bumpKnowledgeCount(abilityId);
    this.#markDirty(abilityId);
    return toKnowledge(row);
  }

  listKnowledge(abilityId: string): AbilityKnowledge[] {
    return this.db
      .select()
      .from(schema.abilityKnowledge)
      .where(eq(schema.abilityKnowledge.abilityId, abilityId))
      .all()
      .map(toKnowledge);
  }

  deleteKnowledge(knowledgeId: string): void {
    const current = this.db
      .select()
      .from(schema.abilityKnowledge)
      .where(eq(schema.abilityKnowledge.id, knowledgeId))
      .get();
    if (!current) throw new AgentisError('RESOURCE_NOT_FOUND', 'Knowledge item not found');
    this.db.delete(schema.abilityKnowledge).where(eq(schema.abilityKnowledge.id, knowledgeId)).run();
    this.#bumpKnowledgeCount(current.abilityId, -1);
    this.#markDirty(current.abilityId);
  }

  // ── Compile orchestration ─────────────────────────────────

  /**
   * Mark the ability for compilation and notify the compiler hook. The actual
   * pipeline runs async; callers should poll `getStatus` if they need to wait.
   */
  requestCompile(abilityId: string): AbilityRecord {
    const ability = this.get(abilityId);
    this.db.update(schema.abilities).set({
      compileStatus: 'compiling',
      compileStage: 'queued',
      compileCancelRequested: false,
      compileError: null,
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.abilities.id, abilityId)).run();
    if (this.#onCompileRequested && ability.workspaceId) {
      try {
        this.#onCompileRequested(abilityId, ability.workspaceId);
      } catch (err) {
        this.db.update(schema.abilities).set({
          compileStatus: 'failed',
          compileStage: null,
          compileCancelRequested: false,
          compileError: `Compile could not be queued: ${(err as Error).message}`,
          updatedAt: new Date().toISOString(),
        }).where(eq(schema.abilities.id, abilityId)).run();
        this.logger.warn('ability.compile.enqueue_failed', {
          abilityId,
          err: (err as Error).message,
        });
      }
    }
    return this.get(abilityId);
  }

  /** Flag a running compile to bail out at the next stage boundary. */
  requestCancelCompile(abilityId: string): AbilityRecord {
    this.get(abilityId);
    this.db.update(schema.abilities).set({
      compileCancelRequested: true,
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.abilities.id, abilityId)).run();
    return this.get(abilityId);
  }

  /** True if the worker should abort and mark the compile as cancelled. */
  isCancelRequested(abilityId: string): boolean {
    const row = this.db.select({ flag: schema.abilities.compileCancelRequested })
      .from(schema.abilities)
      .where(eq(schema.abilities.id, abilityId))
      .get();
    return Boolean(row?.flag);
  }

  /** Worker writes the current phase between steps so the UI shows real progress. */
  setCompileStage(abilityId: string, stage: AbilityRecord['compileStage']): void {
    this.db.update(schema.abilities).set({
      compileStage: stage,
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.abilities.id, abilityId)).run();
  }

  setCompileState(
    abilityId: string,
    state: AbilityCompileStatus,
    extra: Partial<{ compileError: string | null; lastCompiledAt: string | null; compiledPrompt: string | null; domainEmbedding: number[] | null; kbDocumentId: string | null }> = {},
  ): void {
    const patch: Record<string, unknown> = {
      compileStatus: state,
      updatedAt: new Date().toISOString(),
    };
    if (extra.compileError !== undefined) patch.compileError = extra.compileError;
    if (extra.lastCompiledAt !== undefined) patch.lastCompiledAt = extra.lastCompiledAt;
    if (extra.compiledPrompt !== undefined) patch.compiledPrompt = extra.compiledPrompt;
    if (extra.domainEmbedding !== undefined) patch.domainEmbedding = extra.domainEmbedding;
    if (extra.kbDocumentId !== undefined) patch.kbDocumentId = extra.kbDocumentId;
    if (state !== 'compiling') {
      // Stage is only meaningful while the worker is actively running.
      patch.compileStage = null;
      patch.compileCancelRequested = false;
    }
    this.db.update(schema.abilities).set(patch).where(eq(schema.abilities.id, abilityId)).run();
  }

  setExampleEmbedding(exampleId: string, embedding: number[]): void {
    this.db.update(schema.abilityExamples)
      .set({ embedding })
      .where(eq(schema.abilityExamples.id, exampleId))
      .run();
  }

  setKnowledgeEmbedding(knowledgeId: string, embedding: number[], contextPrefix?: string | null): void {
    const patch: Record<string, unknown> = { embedding };
    if (contextPrefix !== undefined) patch.contextPrefix = contextPrefix;
    this.db.update(schema.abilityKnowledge)
      .set(patch)
      .where(eq(schema.abilityKnowledge.id, knowledgeId))
      .run();
  }

  // ── Pin management ────────────────────────────────────────

  listPinsForAgent(agentId: string): AgentAbilityPin[] {
    return this.db
      .select()
      .from(schema.agentAbilityPins)
      .where(eq(schema.agentAbilityPins.agentId, agentId))
      .all()
      .map((row) => ({
        agentId: row.agentId,
        abilityId: row.abilityId,
        enabled: Boolean(row.enabled),
        createdAt: row.createdAt,
      }));
  }

  pinAbility(agentId: string, abilityId: string): AgentAbilityPin {
    this.get(abilityId);
    const now = new Date().toISOString();
    const existing = this.db.select().from(schema.agentAbilityPins)
      .where(and(eq(schema.agentAbilityPins.agentId, agentId), eq(schema.agentAbilityPins.abilityId, abilityId)))
      .get();
    if (existing) {
      this.db.update(schema.agentAbilityPins)
        .set({ enabled: true })
        .where(and(eq(schema.agentAbilityPins.agentId, agentId), eq(schema.agentAbilityPins.abilityId, abilityId)))
        .run();
      return { agentId, abilityId, enabled: true, createdAt: existing.createdAt };
    }
    this.db.insert(schema.agentAbilityPins).values({
      agentId,
      abilityId,
      enabled: true,
      createdAt: now,
    }).run();
    return { agentId, abilityId, enabled: true, createdAt: now };
  }

  setPinEnabled(agentId: string, abilityId: string, enabled: boolean): AgentAbilityPin {
    const existing = this.db.select().from(schema.agentAbilityPins)
      .where(and(eq(schema.agentAbilityPins.agentId, agentId), eq(schema.agentAbilityPins.abilityId, abilityId)))
      .get();
    if (!existing) throw new AgentisError('RESOURCE_NOT_FOUND', 'Pin not found');
    this.db.update(schema.agentAbilityPins)
      .set({ enabled })
      .where(and(eq(schema.agentAbilityPins.agentId, agentId), eq(schema.agentAbilityPins.abilityId, abilityId)))
      .run();
    return { agentId, abilityId, enabled, createdAt: existing.createdAt };
  }

  unpinAbility(agentId: string, abilityId: string): void {
    const result = this.db.delete(schema.agentAbilityPins)
      .where(and(eq(schema.agentAbilityPins.agentId, agentId), eq(schema.agentAbilityPins.abilityId, abilityId)))
      .run();
    if (Number(result.changes ?? 0) === 0) {
      throw new AgentisError('RESOURCE_NOT_FOUND', 'Pin not found');
    }
  }

  // ── Dispatch-time retrieval ───────────────────────────────

  /**
   * Score all compiled workspace abilities against a task embedding. Caller is
   * responsible for filtering out pinned IDs and applying the relevance cutoff.
   */
  scoreAbilitiesForTask(workspaceId: string, taskEmbedding: number[]): ScoredAbility[] {
    const compiled = this.listCompiled(workspaceId);
    return compiled
      .map((ability) => ({
        ability,
        score: ability.domainEmbedding && ability.domainEmbedding.length === taskEmbedding.length
          ? cosineSimilarity(taskEmbedding, ability.domainEmbedding)
          : 0,
      }))
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Assemble the `<ability>…</ability>` XML block injected into the agent's
   * preamble. Performs KNN over `ability_examples` and cosine search over
   * `ability_knowledge` using the supplied embedding provider; degrades to
   * lexical fallback when no embeddings exist.
   *
   * Caller must respect the returned `tokens` count — the dispatcher's budget
   * accounting depends on it.
   */
  async buildContextBlock(args: {
    abilityId: string;
    task: string;
    taskEmbedding: number[];
    provider: EmbeddingProvider;
    tokenBudget: number;
    maxExamples?: number;
    maxKnowledge?: number;
  }): Promise<{ xml: string; tokens: number } | null> {
    const ability = this.tryGet(args.abilityId);
    if (!ability || ability.compileStatus !== 'ready') return null;

    const maxExamples = args.maxExamples ?? CONSTANTS.ABILITY_MAX_EXAMPLES;
    const maxKnowledge = args.maxKnowledge ?? CONSTANTS.ABILITY_MAX_KNOWLEDGE;
    const budget = Math.max(args.tokenBudget, CONSTANTS.MIN_ABILITY_TOKENS);

    const examples = this.#retrieveExamples(args.abilityId, args.taskEmbedding, maxExamples);
    const knowledge = this.#retrieveKnowledge(args.abilityId, args.taskEmbedding, maxKnowledge);

    const xml = renderAbilityXml({
      ability,
      task: args.task,
      examples,
      knowledge,
      tokenBudget: budget,
    });
    return { xml, tokens: countTokens(xml) };
  }

  /** Counter helpers exposed for compiler tests. */
  refreshCounts(abilityId: string): void {
    const examples = this.db.select().from(schema.abilityExamples)
      .where(eq(schema.abilityExamples.abilityId, abilityId)).all().length;
    const knowledge = this.db.select().from(schema.abilityKnowledge)
      .where(eq(schema.abilityKnowledge.abilityId, abilityId)).all().length;
    this.db.update(schema.abilities).set({
      exampleCount: examples,
      knowledgeCount: knowledge,
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.abilities.id, abilityId)).run();
  }

  // ── Import / export ───────────────────────────────────────

  export(abilityId: string): AbilityPackage {
    const ability = this.get(abilityId);
    const examples = this.listExamples(abilityId);
    const knowledge = this.listKnowledge(abilityId);
    return {
      format_version: '1.0',
      manifest: {
        name: ability.name,
        slug: ability.slug,
        version: ability.version,
        domain_tag: ability.domainTag ?? 'custom',
        icon_emoji: ability.iconEmoji ?? '⚡',
        description: ability.description ?? undefined,
        compiled_prompt: ability.compiledPrompt ?? '',
        specs: ability.specs,
        rules_always: ability.rulesAlways,
        rules_never: ability.rulesNever,
        tool_hints: ability.toolHints,
        example_count: ability.exampleCount,
      },
      examples: examples.map((ex) => ({
        input_text: ex.inputText,
        output_text: ex.outputText,
        input_media_url: ex.inputMediaUrl,
        media_description: ex.mediaDescription,
        quality_score: ex.qualityScore,
        source: ex.source,
        embedding: ex.embedding,
      })),
      knowledge: knowledge.map((k) => ({
        title: k.title,
        content: k.content,
        context_prefix: k.contextPrefix,
        embedding: k.embedding,
        source_type: k.sourceType,
        source_url: k.sourceUrl,
        importance_score: k.importanceScore,
      })),
    };
  }

  importPackage(args: { workspaceId: string; pkg: AbilityPackage; authorId?: string | null; modeOverride?: 'static' | 'compiled' }): AbilityRecord {
    if (args.pkg.format_version !== '1.0') {
      throw new AgentisError('VALIDATION_FAILED', `unsupported ability format ${args.pkg.format_version}`);
    }
    const m = args.pkg.manifest;
    // Resolve slug collisions inside the target workspace.
    const slug = this.#uniqueSlug(args.workspaceId, m.slug);
    const ability = this.create({
      workspaceId: args.workspaceId,
      name: m.name,
      slug,
      description: m.description ?? null,
      domainTag: m.domain_tag,
      iconEmoji: m.icon_emoji ?? '⚡',
      authorId: args.authorId ?? null,
      specs: m.specs,
      rulesAlways: m.rules_always,
      rulesNever: m.rules_never,
      toolHints: m.tool_hints,
      mode: args.modeOverride ?? m.mode ?? 'compiled',
      slashCommand: m.slash_command ?? null,
      commandDispatch: m.command_dispatch ?? null,
      commandToolName: m.command_tool_name ?? null,
      envKeys: m.env_keys ?? [],
      envSecretIds: m.env_secret_ids ?? [],
      gate: m.gate ?? null,
      minRelevanceScore: m.min_relevance_score ?? null,
      preferredModel: m.preferred_model ?? null,
    });
    // Carry over the compiled persona + embeddings so the ability is usable
    // immediately. A background recompile may still run if the workspace
    // embedding model has a different dimension.
    this.db.update(schema.abilities).set({
      compiledPrompt: m.compiled_prompt,
      version: m.version,
      hubSlug: m.slug,
      hubVersion: m.version,
      // Auto-promote to 'ready' if it's static, otherwise 'pending'
      compileStatus: (m.mode ?? 'compiled') === 'static' ? 'ready' : 'pending',
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.abilities.id, ability.id)).run();
    for (const ex of args.pkg.examples) {
      this.addExample(ability.id, {
        inputText: ex.input_text,
        outputText: ex.output_text,
        inputMediaUrl: ex.input_media_url ?? null,
        mediaDescription: ex.media_description ?? null,
        qualityScore: ex.quality_score,
        source: ex.source,
        embedding: ex.embedding ?? null,
      });
    }
    for (const k of args.pkg.knowledge) {
      this.addKnowledge(ability.id, {
        title: k.title ?? null,
        content: k.content,
        contextPrefix: k.context_prefix ?? null,
        embedding: k.embedding ?? null,
        sourceType: k.source_type,
        sourceUrl: k.source_url ?? null,
        importanceScore: k.importance_score,
      });
    }
    return this.get(ability.id);
  }

  // ── Internal helpers ──────────────────────────────────────

  #bumpExampleCount(abilityId: string, delta = 1): void {
    const row = this.db.select({ count: schema.abilities.exampleCount }).from(schema.abilities)
      .where(eq(schema.abilities.id, abilityId)).get();
    const next = Math.max(0, (row?.count ?? 0) + delta);
    this.db.update(schema.abilities)
      .set({ exampleCount: next, updatedAt: new Date().toISOString() })
      .where(eq(schema.abilities.id, abilityId)).run();
  }

  #bumpKnowledgeCount(abilityId: string, delta = 1): void {
    const row = this.db.select({ count: schema.abilities.knowledgeCount }).from(schema.abilities)
      .where(eq(schema.abilities.id, abilityId)).get();
    const next = Math.max(0, (row?.count ?? 0) + delta);
    this.db.update(schema.abilities)
      .set({ knowledgeCount: next, updatedAt: new Date().toISOString() })
      .where(eq(schema.abilities.id, abilityId)).run();
  }

  #markDirty(abilityId: string): void {
    const current = this.db.select({ status: schema.abilities.compileStatus }).from(schema.abilities)
      .where(eq(schema.abilities.id, abilityId)).get();
    if (current?.status === 'ready') {
      this.db.update(schema.abilities)
        .set({ compileStatus: 'dirty', updatedAt: new Date().toISOString() })
        .where(eq(schema.abilities.id, abilityId)).run();
    }
  }

  #uniqueSlug(workspaceId: string, base: string, excludeId?: string): string {
    let candidate = base;
    let counter = 1;
    while (true) {
      const hit = this.db.select().from(schema.abilities)
        .where(and(eq(schema.abilities.workspaceId, workspaceId), eq(schema.abilities.slug, candidate)))
        .get();
      if (!hit || hit.id === excludeId) return candidate;
      counter += 1;
      candidate = `${base}-${counter}`;
      if (counter > 50) {
        candidate = `${base}-${randomUUID().slice(0, 6)}`;
        return candidate;
      }
    }
  }

  #retrieveExamples(
    abilityId: string,
    taskEmbedding: number[],
    topK: number,
  ): Array<AbilityExample & { score: number }> {
    const examples = this.listExamples(abilityId);
    if (examples.length === 0) return [];
    const scored = examples.map((ex) => ({
      ...ex,
      score: ex.embedding && ex.embedding.length === taskEmbedding.length
        ? cosineSimilarity(taskEmbedding, ex.embedding) * 0.7 + ex.qualityScore * 0.3
        : ex.qualityScore * 0.3,
    }));
    return scored.sort((a, b) => b.score - a.score).slice(0, Math.max(0, topK));
  }

  #retrieveKnowledge(
    abilityId: string,
    taskEmbedding: number[],
    topK: number,
  ): Array<AbilityKnowledge & { score: number }> {
    const items = this.listKnowledge(abilityId);
    if (items.length === 0) return [];
    const scored = items.map((k) => ({
      ...k,
      score: k.embedding && k.embedding.length === taskEmbedding.length
        ? cosineSimilarity(taskEmbedding, k.embedding) * 0.7 + k.importanceScore * 0.3
        : k.importanceScore * 0.3,
    }));
    return scored.sort((a, b) => b.score - a.score).slice(0, Math.max(0, topK));
  }
}

// ────────────────────────────────────────────────────────────
// Module-level helpers
// ────────────────────────────────────────────────────────────

export function countTokens(text: string): number {
  return encode(text).length;
}

export function renderAbilityXml(args: {
  ability: AbilityRecord;
  task: string;
  examples: Array<AbilityExample & { score: number }>;
  knowledge: Array<AbilityKnowledge & { score: number }>;
  tokenBudget: number;
}): string {
  const { ability, examples, knowledge, tokenBudget } = args;
  const escape = (s: string): string => s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const persona = ability.compiledPrompt?.trim() || ability.description?.trim() || `Specialist in ${ability.domainTag ?? 'their domain'}.`;
  const specsLines = Object.entries(ability.specs)
    .filter(([, v]) => v !== undefined && v !== null && String(v).length > 0)
    .map(([k, v]) => `    ${k}: ${v}`);
  const alwaysLines = ability.rulesAlways.map((r) => `    — ${r}`);
  const neverLines = ability.rulesNever.map((r) => `    — ${r}`);
  const toolHintLines = ability.toolHints.map((h) => `    ${h}`);

  // Token allocation: cap examples + knowledge sections so the total fits.
  // The persona + specs + rules block is the cheapest and always emitted.
  const headerCost = countTokens(persona) + specsLines.length * 12 + alwaysLines.length * 12 + neverLines.length * 12 + toolHintLines.length * 12;
  const remaining = Math.max(0, tokenBudget - headerCost - 40); // 40 = XML scaffolding
  const knowledgeBudget = Math.floor(remaining * 0.45);
  const examplesBudget = remaining - knowledgeBudget;

  const trimmedKnowledge = clipBlocks(
    knowledge.map((k) => formatKnowledgeChunk(k)),
    knowledgeBudget,
  );
  const trimmedExamples = clipBlocks(
    examples.map((ex) => formatExample(ex)),
    examplesBudget,
  );

  const parts: string[] = [];
  parts.push(`<ability name="${escape(ability.name)}" version="${ability.version}" domain="${ability.domainTag ?? 'custom'}">`);
  parts.push('  <persona>');
  parts.push('    ' + escape(persona).replace(/\n/g, '\n    '));
  parts.push('  </persona>');
  if (specsLines.length > 0) {
    parts.push('  <specs>');
    parts.push(...specsLines.map(escape));
    parts.push('  </specs>');
  }
  if (alwaysLines.length > 0 || neverLines.length > 0) {
    parts.push('  <rules>');
    if (alwaysLines.length > 0) {
      parts.push('    ALWAYS:');
      parts.push(...alwaysLines.map(escape));
    }
    if (neverLines.length > 0) {
      parts.push('    NEVER:');
      parts.push(...neverLines.map(escape));
    }
    parts.push('  </rules>');
  }
  if (toolHintLines.length > 0) {
    parts.push('  <tool_hints>');
    parts.push(...toolHintLines.map(escape));
    parts.push('  </tool_hints>');
  }
  if (trimmedKnowledge.length > 0) {
    parts.push(`  <knowledge retrieved="${trimmedKnowledge.length}">`);
    parts.push(...trimmedKnowledge);
    parts.push('  </knowledge>');
  }
  if (trimmedExamples.length > 0) {
    parts.push(`  <examples retrieved="${trimmedExamples.length}" method="knn">`);
    parts.push(...trimmedExamples);
    parts.push('  </examples>');
  }
  parts.push('</ability>');
  const rawXml = parts.join('\n');
  if (CONSTANTS.ABILITY_COMPACT_MODE) {
    return rawXml.replace(/\n\s+/g, '\n').replace(/\n+/g, '\n').trim();
  }
  return rawXml;
}

function formatKnowledgeChunk(k: AbilityKnowledge & { score: number }): string {
  const head = k.contextPrefix?.trim() ? `${k.contextPrefix.trim()} — ` : k.title ? `${k.title} — ` : '';
  return `    — [score ${k.score.toFixed(2)}] ${head}${oneLine(k.content).slice(0, 400)}`;
}

function formatExample(ex: AbilityExample & { score: number }): string {
  const input = oneLine(ex.inputText).slice(0, 200);
  const output = oneLine(ex.outputText).slice(0, 400);
  return `    <example score="${ex.score.toFixed(2)}">\n      Task: ${input}\n      Response: ${output}\n    </example>`;
}

function clipBlocks(blocks: string[], tokenBudget: number): string[] {
  if (tokenBudget <= 0) return [];
  const out: string[] = [];
  let used = 0;
  for (const block of blocks) {
    const cost = countTokens(block);
    if (used + cost > tokenBudget) break;
    out.push(block);
    used += cost;
  }
  return out;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// ── Row → record adapters ──────────────────────────────────

function toRecord(row: typeof schema.abilities.$inferSelect): AbilityRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId ?? null,
    name: row.name,
    slug: row.slug,
    description: row.description ?? null,
    domainTag: row.domainTag ?? null,
    iconEmoji: row.iconEmoji ?? null,
    authorId: row.authorId ?? null,
    compiledPrompt: row.compiledPrompt ?? null,
    specs: (row.specs ?? {}) as AbilitySpecs,
    rulesAlways: Array.isArray(row.rulesAlways) ? row.rulesAlways as string[] : [],
    rulesNever: Array.isArray(row.rulesNever) ? row.rulesNever as string[] : [],
    toolHints: Array.isArray(row.toolHints) ? row.toolHints as string[] : [],
    
    // -- V2 Features --
    mode: (row.mode as 'compiled' | 'static') ?? 'compiled',
    slashCommand: row.slashCommand ?? null,
    commandDispatch: (row.commandDispatch as 'model' | 'tool' | null) ?? null,
    commandToolName: row.commandToolName ?? null,
    envKeys: Array.isArray(row.envKeys) ? row.envKeys as string[] : [],
    envSecretIds: Array.isArray(row.envSecretIds) ? row.envSecretIds as string[] : [],
    gate: (row.gate as AbilityRecord['gate']) ?? null,
    minRelevanceScore: row.minRelevanceScore ?? null,
    preferredModel: row.preferredModel ?? null,
    
    domainEmbedding: Array.isArray(row.domainEmbedding) ? row.domainEmbedding as number[] : null,
    exampleCount: row.exampleCount,
    knowledgeCount: row.knowledgeCount,
    compileStatus: row.compileStatus as AbilityCompileStatus,
    compileStage: (row.compileStage ?? null) as AbilityRecord['compileStage'],
    compileCancelRequested: Boolean(row.compileCancelRequested),
    lastCompiledAt: row.lastCompiledAt ?? null,
    compileError: row.compileError ?? null,
    isPublic: Boolean(row.isPublic),
    hubSlug: row.hubSlug ?? null,
    hubVersion: row.hubVersion,
    installCount: row.installCount,
    tokenBudget: row.tokenBudget ?? null,
    version: row.version,
    kbDocumentId: row.kbDocumentId ?? null,
    depth: (row.depth as AbilityDepth) ?? 'd0_instinct',
    visibility: (row.visibility as AbilityVisibility) ?? 'workspace',
    contentHash: row.contentHash ?? null,
    origin: (row.origin as AbilityOrigin | null) ?? null,
    executionPolicy: (row.executionPolicy as AbilityExecutionPolicy | null) ?? null,
    routingPolicy: (row.routingPolicy as AbilityRoutingPolicy | null) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toEvalRun(row: typeof schema.abilityEvalRuns.$inferSelect): AbilityEvalRun {
  return {
    id: row.id,
    abilityId: row.abilityId,
    workspaceId: row.workspaceId ?? null,
    kind: row.kind as AbilityEvalRun['kind'],
    score: row.score,
    passed: Boolean(row.passed),
    caseCount: row.caseCount,
    failures: Array.isArray(row.failures) ? row.failures as AbilityEvalRun['failures'] : [],
    summary: row.summary ?? null,
    model: row.model ?? null,
    createdAt: row.createdAt,
  };
}

function toActivation(row: typeof schema.abilityActivations.$inferSelect): AbilityActivation {
  return {
    id: row.id,
    workspaceId: row.workspaceId ?? null,
    runId: row.runId ?? null,
    agentId: row.agentId ?? null,
    model: row.model ?? null,
    abilityIds: Array.isArray(row.abilityIds) ? row.abilityIds as string[] : [],
    conflictsResolved: Array.isArray(row.conflictsResolved)
      ? row.conflictsResolved as AbilityActivation['conflictsResolved'] : [],
    outcome: row.outcome ?? null,
    qualityScore: row.qualityScore ?? null,
    consentScope: (row.consentScope as AbilityActivation['consentScope']) ?? 'workspace_private',
    createdAt: row.createdAt,
  };
}

function toExample(row: typeof schema.abilityExamples.$inferSelect): AbilityExample {
  return {
    id: row.id,
    abilityId: row.abilityId,
    inputText: row.inputText,
    outputText: row.outputText,
    inputMediaUrl: row.inputMediaUrl ?? null,
    mediaDescription: row.mediaDescription ?? null,
    qualityScore: row.qualityScore,
    source: row.source as AbilityExampleSource,
    embedding: Array.isArray(row.embedding) ? row.embedding as number[] : null,
    originRunId: row.originRunId ?? null,
    createdAt: row.createdAt,
  };
}

function toKnowledge(row: typeof schema.abilityKnowledge.$inferSelect): AbilityKnowledge {
  return {
    id: row.id,
    abilityId: row.abilityId,
    kbChunkId: row.kbChunkId ?? null,
    title: row.title ?? null,
    content: row.content,
    contextPrefix: row.contextPrefix ?? null,
    embedding: Array.isArray(row.embedding) ? row.embedding as number[] : null,
    sourceType: row.sourceType as AbilityKnowledgeSourceType,
    sourceUrl: row.sourceUrl ?? null,
    importanceScore: row.importanceScore,
    createdAt: row.createdAt,
  };
}
