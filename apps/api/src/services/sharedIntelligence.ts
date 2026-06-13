import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  REALTIME_EVENTS,
  REALTIME_ROOMS,
  type BrainGraph,
  type BrainGraphLink,
  type BrainGraphNode,
  type BrainGraphScope,
  type KnowledgeAtomKind,
  type KnowledgeLinkRelation,
  type RuntimeEpisodeType,
} from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import type { EventBus } from '../event-bus.js';
import type { EpisodicMemoryStore } from './episodicMemoryStore.js';
import {
  type EmbeddingProvider,
  cosineSimilarity,
  embedText,
  selectEmbeddingProvider,
} from './embeddingProvider.js';
import {
  extractCandidateStatements,
  isRejectable,
  scoreStatement,
  FormationJudge,
  FORMATION_MIN_SCORE,
  type FormationNeighbor,
  type FormedMemory,
  type MemoryWritePolicy,
} from './brainFormation.js';
import type { StructuredCompleter } from './structuredCompleter.js';
import {
  classifyPacer,
  pacerRouting,
  type PacerClass,
  type SourceSurface,
} from './brainPacer.js';

/**
 * Structural seam for the CORA organizational-context layer (apps/api/src/cora).
 * Kept structural (not an import) so the Brain composer has no hard dependency
 * on the CORA module — bootstrap wires the real composer via setCoraComposer.
 */
export interface CoraDispatchComposer {
  composeForDispatch(args: {
    workspaceId: string;
    agentId: string;
    runId?: string | null;
    taskDescription: string;
    interactionAudience?: 'private' | 'customer' | 'public';
    limit?: number;
  }): { block: string };
}

export interface CollectiveCognitivePromotionInput {
  workspaceId: string;
  workflowId?: string | null;
  runId?: string | null;
  nodeId?: string | null;
  agentId?: string | null;
  adapterType?: string | null;
  scopeId?: string | null;
  taskInput?: unknown;
  taskOutput: unknown;
  /** Human-readable task label, used by the Formation Judge for context. */
  taskTitle?: string | null;
  /**
   * What the run is allowed to write. Resolved by the write-policy gate at
   * enqueue time. Defaults to `form` for backward compatibility.
   */
  memoryPolicy?: MemoryWritePolicy;
  /**
   * Where the content came from (Phase 2). Drives PACER classification +
   * source-aware routing. Defaults to `run_completion`.
   */
  originSurface?: SourceSurface | null;
}

export interface BrainGraphOptions {
  scope?: BrainGraphScope;
  scopeId?: string | null;
  includeWorkspace?: boolean;
  kinds?: KnowledgeAtomKind[];
  minConfidence?: number;
  limit?: number;
}

export interface KnowledgeLinkInput {
  workspaceId: string;
  sourceId: string;
  sourceKind: KnowledgeAtomKind;
  targetId: string;
  targetKind: KnowledgeAtomKind;
  relation: KnowledgeLinkRelation;
  confidence?: number;
  agentId?: string | null;
  adapterType?: string | null;
  runId?: string | null;
  scopeId?: string | null;
}

interface AtomCandidate {
  id: string;
  kind: KnowledgeAtomKind;
  text: string;
  node: BrainGraphNode;
}

interface SimilarAtom {
  atom: AtomCandidate;
  score: number;
}

interface BrainAtomDetail {
  content: string;
  source: string;
  createdAt: string;
  updatedAt: string;
  agentId?: string | null;
  workflowId?: string | null;
  runId?: string | null;
}

interface BrainUsageSummary {
  id: string;
  type: 'agent' | 'workflow';
  name: string;
  count: number;
}

export interface BrainSearchResult {
  id: string;
  kind: KnowledgeAtomKind;
  title: string;
  content: string;
  confidence: number;
  score: number;
  scopeId: string | null;
  tags: string[];
  status?: string | null;
  managed?: boolean | null;
  updatedAt: string;
}

export interface BrainSummary {
  workspaceIntelligence: { count: number; averageConfidence: number; capacityTokens: number };
  scopedBrain: { count: number; averageConfidence: number; capacityTokens: number };
  SessionMoments: { count: number; capacityTokens: number };
  compressionStatus: { lastRunAt: string | null; atomsArchived: number; nextTriggerAt: string | null };
}

const DEFAULT_GRAPH_LIMIT = 200;
const MAX_GRAPH_LIMIT = 500;
const HIGH_SIMILARITY = 0.86;
const RELATED_SIMILARITY = 0.52;
const GLOBAL_CONFIDENCE_THRESHOLD = 0.7;

// Brain & Abilities Replan — embedding-aware promotion (B4) thresholds.
/** Cosine similarity above which two atoms are treated as the same concept. */
const EMBED_HIGH_SIMILARITY = 0.88;
/** Cosine similarity above which two atoms get a `refines`/`related` link. */
/** Minimum cosine relevance for an atom to enter a dispatch context block. */
const DISPATCH_MIN_RELEVANCE = 0.32;
/**
 * Max slots reserved for the always-on constitutional tier (operator-authored
 * rules + charter) within a single dispatch. Bounds the charter so it can never
 * crowd out relevance retrieval; the rest of the budget goes to relevance.
 */
const CONSTITUTIONAL_MAX = 5;
/** Evaluator ? brain confidence deltas (Gap14). */
const EVAL_DELTA_PASS = 0.04;
const EVAL_DELTA_PASS_TOP = 0.08;
const EVAL_DELTA_FAIL = -0.06;
/** Atoms below this confidence are auto-archived. */
const ARCHIVE_CONFIDENCE_FLOOR = 0.05;

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has', 'have',
  'i', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'their', 'this',
  'to', 'was', 'were', 'will', 'with', 'you', 'your', 'we', 'our', 'they', 'them', 'these',
  'those', 'do', 'does', 'did', 'if', 'then', 'than', 'so', 'too', 'can', 'could', 'would',
  'should', 'about', 'after', 'before', 'between', 'during', 'over', 'under', 'out', 'off',
]);

export class SharedIntelligenceService {
  /** Per-workspace embedding provider cache (resolved from workspace config). */
  readonly #embeddingProviders = new Map<string, EmbeddingProvider>();

  /**
   * Optional model behind the Formation Judge (the Mem0-style extract+classify
   * +reconcile step). When set, `promote()` forms typed, durable memory; when
   * unset, survivors are merely staged as low-confidence episodic traces that
   * decay. Wired from the configured evaluator runtime in bootstrap.
   */
  #formationCompleter: StructuredCompleter | null = null;

  /**
   * Optional CORA layer (the Workspace Brain's organizational reasoning
   * engine). When set, buildDispatchContext appends grant-gated, audited
   * organizational claims after the existing Brain tiers. Same extension
   * pattern as the Formation Judge: CORA extends this composer, it never
   * forks it (RFC §12.2).
   */
  #coraComposer: CoraDispatchComposer | null = null;

  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly bus: EventBus,
    private readonly episodes: EpisodicMemoryStore,
    private readonly logger: Logger,
  ) {}

  /** Wire (or clear) the Formation Judge model. */
  setFormationCompleter(completer: StructuredCompleter | null): void {
    this.#formationCompleter = completer;
  }

  /** Wire (or clear) the CORA organizational-context layer. */
  setCoraComposer(composer: CoraDispatchComposer | null): void {
    this.#coraComposer = composer;
  }

  /**
   * Resolve (and cache) the embedding provider for a workspace from its
   * `embedding_provider_type` column. Appendix A: provider is user-selectable.
   */
  #resolveEmbeddingProvider(workspaceId: string): EmbeddingProvider {
    const cached = this.#embeddingProviders.get(workspaceId);
    if (cached) return cached;
    let type = 'hashing';
    let config: Record<string, unknown> = {};
    try {
      const row = this.db
        .select({
          type: schema.workspaces.embeddingProviderType,
          config: schema.workspaces.embeddingProviderConfig,
        })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId))
        .get();
      if (row?.type) type = row.type;
      config = parseJsonRecord(row?.config);
    } catch {
      // Column may not exist on very old DBs — degrade to hashing.
    }
    const provider = selectEmbeddingProvider(type, config);
    this.#embeddingProviders.set(workspaceId, provider);
    return provider;
  }

  /** Drop a cached provider — call after the operator changes workspace config. */
  invalidateEmbeddingProvider(workspaceId: string): void {
    this.#embeddingProviders.delete(workspaceId);
  }

  embeddingProvider(workspaceId: string): EmbeddingProvider {
    return this.#resolveEmbeddingProvider(workspaceId);
  }

  embeddingStatus(workspaceId: string): {
    type: string;
    degraded: boolean;
    retrievalPaused: boolean;
    migration: Record<string, unknown> | null;
  } {
    const row = this.db.select({
      type: schema.workspaces.embeddingProviderType,
      brainSettings: schema.workspaces.brainSettings,
    }).from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .get();
    const settings = parseJsonRecord(row?.brainSettings);
    const migration = settings.embeddingMigration && typeof settings.embeddingMigration === 'object' && !Array.isArray(settings.embeddingMigration)
      ? settings.embeddingMigration as Record<string, unknown>
      : null;
    return {
      type: row?.type ?? 'hashing',
      degraded: (row?.type ?? 'hashing') === 'hashing',
      retrievalPaused: migration?.status === 'running',
      migration,
    };
  }

  /**
   * Memory FORMATION (the heart of the brain write-path fix). Called by the
   * durable queue worker after a task completes. Three-stage pipeline:
   *
   *   policy gate → deterministic extraction → (LLM Formation Judge | staging)
   *
   * - `none`          → writes nothing.
   * - `episodic_only` → writes at most ONE low-confidence outcome marker
   *                     (hidden from the graph); never forms pattern atoms.
   * - `form`          → deterministic gate drops structural garbage, then:
   *      • with a Formation Judge model: extract durable statements, type them,
   *        and ADD/UPDATE/NOOP against existing memory (Mem0 two-phase).
   *      • without a model: stage survivors as low-confidence `observation`
   *        episodes tagged `unconsolidated` that decay if never reinforced.
   */
  async promote(input: CollectiveCognitivePromotionInput): Promise<{ created: number; reinforced: number; linked: number }> {
    const ZERO = { created: 0, reinforced: 0, linked: 0 };
    const policy: MemoryWritePolicy = input.memoryPolicy ?? 'form';
    if (policy === 'none') return ZERO;

    const provider = this.#resolveEmbeddingProvider(input.workspaceId);
    const resolvedAgent = input.agentId ? this.resolveAgent(input.workspaceId, input.agentId) : null;
    const adapterType = input.adapterType ?? resolvedAgent?.adapterType ?? null;

    if (policy === 'episodic_only') {
      const created = this.#writeEpisodicMarker(input, provider, adapterType);
      return { created, reinforced: 0, linked: 0 };
    }

    const candidates = extractCandidateStatements(input.taskOutput);
    if (candidates.length === 0) return ZERO;

    const existing = this.#loadEpisodeVectors(input.workspaceId, input.scopeId ?? null);

    // Preferred path: a Formation Judge model forms typed, durable memory.
    if (this.#formationCompleter) {
      try {
        const neighbors = await this.#formationNeighbors(input, candidates);
        const judge = new FormationJudge(this.#formationCompleter);
        const formed = await judge.judge(candidates, {
          taskTitle: input.taskTitle ?? null,
          agentScopeId: input.scopeId ?? null,
          neighbors,
        });
        if (formed) {
          const result = await this.#commitFormedMemories(input, formed, provider, adapterType, existing);
          this.logger.info('collective_brain.formation.applied', {
            workspaceId: input.workspaceId,
            runId: input.runId,
            candidates: candidates.length,
            ...result,
          });
          return result;
        }
        // Judge unavailable/failed → fall through to episodic staging.
      } catch (err) {
        this.logger.warn('collective_brain.formation.failed', {
          workspaceId: input.workspaceId,
          message: (err as Error).message,
        });
      }
    }

    // Fallback: stage survivors as low-confidence episodic traces (no model).
    let created = 0;
    let reinforced = 0;
    let linked = 0;
    for (const cand of candidates) {
      const r = await this.#stageOrReinforce(input, cand, provider, adapterType, existing);
      created += r.created;
      reinforced += r.reinforced;
      linked += r.linked;
    }
    if (created || reinforced) {
      this.logger.info('collective_brain.staged', {
        workspaceId: input.workspaceId,
        runId: input.runId,
        created,
        reinforced,
      });
    }
    return { created, reinforced, linked };
  }

  /** TTL (days) before an unconsolidated episodic trace is eligible for expiry. */
  static readonly STAGED_TTL_DAYS = 14;
  static readonly MARKER_TTL_DAYS = 30;

  /** Write one low-confidence outcome marker for a transient (episodic_only) run. */
  #writeEpisodicMarker(input: CollectiveCognitivePromotionInput, provider: EmbeddingProvider, adapterType: string | null): number {
    const summary = episodicMarkerSummary(input);
    if (!summary) return 0;
    const title = truncate(input.taskTitle?.trim() || 'Task run', 92);
    this.episodes.write({
      workspaceId: input.workspaceId,
      scopeId: input.scopeId ?? null,
      workflowId: input.workflowId ?? null,
      runId: input.runId ?? null,
      agentId: input.agentId ?? null,
      type: 'observation',
      title,
      summary,
      source: 'run_promotion',
      confidence: 0.25,
      importance: 0.3,
      trust: 0.4,
      tags: ['episodic_marker', 'unconsolidated', 'pacer:evidence', ...(adapterType ? [adapterType] : [])],
      entities: input.nodeId ? [input.nodeId] : [],
      outcomeStatus: 'mixed',
      metadata: {
        adapterType,
        nodeId: input.nodeId ?? null,
        origin: 'episodic_marker',
        // PACER (Phase 1): an outcome marker is grounded run-local evidence.
        pacerClass: 'evidence' as PacerClass,
        originSurface: input.originSurface ?? 'run_completion',
        formationMode: 'episodic_marker',
        ttlExpiresAt: ttlIso(SharedIntelligenceService.MARKER_TTL_DAYS),
        embeddingProvider: provider.dimension,
      },
    });
    return 1;
  }

  /** Retrieve nearby existing memories for the Formation Judge to reconcile against. */
  async #formationNeighbors(input: CollectiveCognitivePromotionInput, candidates: { text: string }[]): Promise<FormationNeighbor[]> {
    const query = candidates.slice(0, 6).map((c) => c.text).join(' ');
    try {
      const hits = await this.searchAtoms({
        workspaceId: input.workspaceId,
        scopeId: input.scopeId ?? null,
        query,
        scope: input.scopeId ? 'both' : 'workspace',
        limit: 6,
        minConfidence: 0,
      });
      return hits.map((h) => ({ id: h.id, title: h.title, summary: h.content }));
    } catch {
      return [];
    }
  }

  /** Commit the Formation Judge's decisions into typed, durable episode atoms. */
  async #commitFormedMemories(
    input: CollectiveCognitivePromotionInput,
    formed: FormedMemory[],
    provider: EmbeddingProvider,
    adapterType: string | null,
    existing: EpisodeVector[],
  ): Promise<{ created: number; reinforced: number; linked: number }> {
    let created = 0;
    let reinforced = 0;
    let linked = 0;

    for (const mem of formed) {
      if (mem.operation !== 'ADD') {
        // UPDATE / NOOP — reinforce the cited existing atom; UPDATE also refreshes its text.
        if (!mem.targetAtomId) continue;
        if (mem.operation === 'UPDATE') {
          this.episodes.update(input.workspaceId, mem.targetAtomId, { summary: mem.statement, title: mem.title });
        }
        const node = this.reinforceAtom(input.workspaceId, 'episode', mem.targetAtomId, {
          agentId: input.agentId ?? null,
          adapterType,
          runId: input.runId ?? null,
          scopeId: input.scopeId ?? null,
        });
        if (node) {
          reinforced += 1;
          this.publishAtom(input.workspaceId, REALTIME_EVENTS.BRAIN_ATOM_REINFORCED, node);
        }
        continue;
      }

      const scopeId = mem.scope === 'agent' ? (input.scopeId ?? null) : null;
      let vec: number[] | null = null;
      try {
        vec = await embedText(provider, mem.statement);
      } catch { /* embedding optional */ }

      // PACER (Phase 1+2): classify the formed memory using the judge's type as
      // a prior plus the source surface and the (un-stripped) statement text.
      const pacer = classifyPacer({
        text: mem.statement,
        surface: input.originSurface ?? 'run_completion',
        episodeType: mem.type,
        agentRole: null,
      });
      const routing = pacerRouting(pacer.pacerClass);

      const episode = this.episodes.write({
        workspaceId: input.workspaceId,
        scopeId,
        workflowId: input.workflowId ?? null,
        runId: input.runId ?? null,
        agentId: input.agentId ?? null,
        type: mem.type,
        title: mem.title,
        summary: mem.statement,
        source: 'run_promotion',
        confidence: mem.confidence,
        importance: Math.max(0.62, routing.importanceFloor),
        trust: 0.6,
        tags: ['collective_brain', 'consolidated', `pacer:${pacer.pacerClass}`, ...(adapterType ? [adapterType] : [])],
        entities: input.nodeId ? [input.nodeId] : [],
        outcomeStatus: outcomeFor(mem.type),
        metadata: {
          adapterType,
          nodeId: input.nodeId ?? null,
          origin: 'formation_judge',
          formationReason: mem.reason ?? null,
          // PACER metadata — read by maintenance, compression, and the UI.
          pacerClass: pacer.pacerClass,
          pacerConfidence: pacer.confidence,
          pacerReason: pacer.reason,
          originSurface: input.originSurface ?? 'run_completion',
          formationMode: 'formation_judge',
          embeddingProvider: provider.dimension,
        },
      });
      created += 1;
      if (vec) this.#applyEmbedding(episode.id, vec);
      this.publishAtom(input.workspaceId, REALTIME_EVENTS.BRAIN_ATOM_CREATED, episodeToGraphNode(episode, 1));
      existing.push({ id: episode.id, vec, text: `${episode.title}\n${episode.summary}` });
    }
    return { created, reinforced, linked };
  }

  /**
   * Episodic staging (no Formation Judge model). Writes a survivor as a
   * low-confidence `observation` tagged `unconsolidated` with a TTL, or
   * reinforces a near-duplicate. These never render as patterns and decay.
   */
  async #stageOrReinforce(
    input: CollectiveCognitivePromotionInput,
    cand: { text: string; score: number },
    provider: EmbeddingProvider,
    adapterType: string | null,
    existing: EpisodeVector[],
  ): Promise<{ created: number; reinforced: number; linked: number }> {
    let vec: number[] | null = null;
    try {
      vec = await embedText(provider, cand.text);
    } catch { /* embedding optional */ }

    const best = vec ? bestCosine(existing, vec) : bestLexical(existing, cand.text);
    if (best && best.score >= EMBED_HIGH_SIMILARITY) {
      const node = this.reinforceAtom(input.workspaceId, 'episode', best.entry.id, {
        agentId: input.agentId ?? null,
        adapterType,
        runId: input.runId ?? null,
        scopeId: input.scopeId ?? null,
      });
      if (node) {
        this.publishAtom(input.workspaceId, REALTIME_EVENTS.BRAIN_ATOM_REINFORCED, node);
        return { created: 0, reinforced: 1, linked: 0 };
      }
    }

    // PACER (Phase 2): classify the raw candidate (NOT the stripped survivor —
    // procedural/reference signals live in code refs/paths the strip removes).
    // Routing then decides how long this staged trace lives: a procedural rule
    // gets ~60 days to prove itself; bulk evidence decays in ~14.
    const pacer = classifyPacer({
      text: cand.text,
      surface: input.originSurface ?? 'run_completion',
      episodeType: 'observation',
    });
    const routing = pacerRouting(pacer.pacerClass);

    const episode = this.episodes.write({
      workspaceId: input.workspaceId,
      scopeId: input.scopeId ?? null,
      workflowId: input.workflowId ?? null,
      runId: input.runId ?? null,
      agentId: input.agentId ?? null,
      type: 'observation',
      title: titleFromFact(cand.text),
      summary: cand.text,
      source: 'run_promotion',
      confidence: clamp01(0.25 + 0.15 * cand.score),
      importance: Math.max(0.45, routing.importanceFloor * 0.75),
      trust: 0.45,
      tags: ['collective_brain', 'unconsolidated', `pacer:${pacer.pacerClass}`, ...(adapterType ? [adapterType] : [])],
      entities: input.nodeId ? [input.nodeId] : [],
      outcomeStatus: 'mixed',
      metadata: {
        adapterType,
        nodeId: input.nodeId ?? null,
        origin: 'agent_task_output',
        pacerClass: pacer.pacerClass,
        pacerConfidence: pacer.confidence,
        pacerReason: pacer.reason,
        originSurface: input.originSurface ?? 'run_completion',
        formationMode: 'staged',
        ttlExpiresAt: ttlIso(routing.stagedTtlDays),
        taskInputPreview: compactValue(input.taskInput),
        embeddingProvider: provider.dimension,
      },
    });
    if (vec) this.#applyEmbedding(episode.id, vec);
    this.publishAtom(input.workspaceId, REALTIME_EVENTS.BRAIN_ATOM_CREATED, episodeToGraphNode(episode, 1));
    existing.push({ id: episode.id, vec, text: `${episode.title}\n${episode.summary}` });
    return { created: 1, reinforced: 0, linked: 0 };
  }

  #applyEmbedding(episodeId: string, vec: number[]): void {
    this.db.update(schema.memoryEpisodes)
      .set({ embedding: vec as unknown as null })
      .where(eq(schema.memoryEpisodes.id, episodeId))
      .run();
  }

  /**
   * One-shot cleanup of pre-formation pollution (§P4). Re-runs the deterministic
   * gate over existing run-promoted episodes and archives the ones that are
   * structural garbage (table rows, URLs, first-person narration, junk that
   * scores below the formation floor). Reversible: rows are archived with a
   * reason, never hard-deleted. `dryRun` returns counts without writing.
   */
  quarantineRunPromotionJunk(workspaceId: string, options: { dryRun?: boolean; limit?: number } = {}): { scanned: number; quarantined: number; dryRun: boolean } {
    const dryRun = options.dryRun ?? false;
    const limit = Math.min(Math.max(options.limit ?? 5000, 1), 20000);
    const rows = this.db.select({
      id: schema.memoryEpisodes.id,
      title: schema.memoryEpisodes.title,
      summary: schema.memoryEpisodes.summary,
      tags: schema.memoryEpisodes.tags,
      metadata: schema.memoryEpisodes.metadata,
    })
      .from(schema.memoryEpisodes)
      .where(and(
        eq(schema.memoryEpisodes.workspaceId, workspaceId),
        eq(schema.memoryEpisodes.source, 'run_promotion'),
        isNull(schema.memoryEpisodes.archivedAt),
      ))
      .limit(limit)
      .all();

    let quarantined = 0;
    const now = new Date().toISOString();
    for (const row of rows) {
      const tags = parseJsonArray<string>(row.tags);
      // 'consolidated' atoms were formed by the judge — trust them.
      if (tags.includes('consolidated')) continue;
      const text = `${row.summary}`.trim();
      const isJunk = isRejectable(text) || scoreStatement(text) < FORMATION_MIN_SCORE;
      if (!isJunk) continue;
      quarantined += 1;
      if (dryRun) continue;
      // Preserve provenance — only annotate the archive reason.
      const metadata = { ...parseJsonRecord(row.metadata), archivedReason: 'formation_backfill' };
      this.db.update(schema.memoryEpisodes)
        .set({ status: 'archived', archivedAt: now, updatedAt: now, metadata })
        .where(eq(schema.memoryEpisodes.id, row.id))
        .run();
    }
    if (!dryRun && quarantined > 0) {
      this.logger.info('brain.formation_backfill.quarantined', { workspaceId, scanned: rows.length, quarantined });
    }
    return { scanned: rows.length, quarantined, dryRun };
  }

  /**
   * Build the frozen brain context block injected at agent dispatch (B2 + B7).
   * Records an `atom_injected` quality event per atom so the evaluator
   * feedback loop (Gap14) can later find which atoms shaped the run.
   */
  async buildDispatchContext(args: {
    workspaceId: string;
    scopeId?: string | null;
    agentId?: string | null;
    runId?: string | null;
    taskDescription: string;
    limit?: number;
  }): Promise<{ block: string; atomIds: string[] }> {
    const limit = Math.min(Math.max(args.limit ?? 6, 1), 12);
    const scopeId = args.scopeId ?? null;
    const embeddingStatus = this.embeddingStatus(args.workspaceId);
    if (embeddingStatus.retrievalPaused) {
      return {
        block: `WORKSPACE BRAIN [embedding migration running | retrieval paused | capacity: ${this.#capacityStatus(args.workspaceId).percent}%]\nBrain retrieval is paused while atoms are re-embedded for the configured provider.`,
        atomIds: [],
      };
    }
    // Tier 1 — constitutional: operator-authored binding context (the workspace
    // charter + hard rules). Always injected regardless of query relevance, but
    // bounded by a reserved slot budget and ranked inside it, so it can never
    // crowd out the prompt. A "never email before 9am" rule must be present even
    // when the task never mentions email.
    const constitutionalCap = Math.min(limit, CONSTITUTIONAL_MAX);
    const charter = this.#loadConstitutionalAtoms(args.workspaceId, constitutionalCap);
    const charterIds = new Set(charter.map((c) => c.id));

    // Tier 2 — relevance: everything else, retrieved semantically, filling the
    // budget the charter did not consume. Deduped against the charter.
    const remaining = Math.max(0, limit - charter.length);
    let relevant: BrainSearchResult[] = [];
    if (remaining > 0) {
      const rawHits = await this.searchAtoms({
        workspaceId: args.workspaceId,
        scopeId,
        query: args.taskDescription,
        scope: scopeId ? 'both' : 'workspace',
        limit: Math.max(remaining * 3, remaining),
        minConfidence: 0,
      });
      relevant = rawHits
        .filter((hit) => !charterIds.has(hit.id))
        .filter((hit) => hit.score >= DISPATCH_MIN_RELEVANCE || hit.confidence >= 0.74)
        .slice(0, remaining);
    }

    // With no classic atoms AND no CORA layer there is nothing to compose.
    // When CORA is wired, fall through — organizational claims can ground a
    // dispatch even before the workspace Brain has formed any atoms.
    if (charter.length === 0 && relevant.length === 0 && !(this.#coraComposer && args.agentId)) {
      return { block: '', atomIds: [] };
    }

    const atomIds: string[] = [];
    const recordInjected = (entry: BrainSearchResult, tier: 'constitutional' | 'relevance') => {
      atomIds.push(entry.id);
      this.recordQualityEvent({
        workspaceId: args.workspaceId,
        scopeId,
        agentId: args.agentId ?? null,
        runId: args.runId ?? null,
        eventType: 'atom_injected',
        atomId: entry.id,
        metadata: { atomKind: entry.kind, confidence: entry.confidence, retrievalScore: entry.score, tier },
      });
    };
    const renderLine = (entry: BrainSearchResult) => `- [${entry.kind}] ${entry.title}: ${entry.content.split('\n').join(' - ')}`;

    const scopeLabel = scopeId ? 'scope + workspace' : 'workspace';
    const capacity = this.#capacityStatus(args.workspaceId);
    const degradedPrefix = embeddingStatus.degraded ? 'degraded - hashing embeddings | ' : '';
    const total = charter.length + relevant.length;
    const header = `WORKSPACE BRAIN [${degradedPrefix}${total} atoms | scope: ${scopeLabel} | retrieval: graph | capacity: ${capacity.percent}%${capacity.recommended ? ' - compression recommended' : ''}]`;

    const sections: string[] = [header];
    if (charter.length > 0) {
      for (const entry of charter) recordInjected(entry, 'constitutional');
      sections.push(`WORKSPACE RULES & CONTEXT (operator-authored — always honor these):\n${charter.map(renderLine).join('\n')}`);
    }
    if (relevant.length > 0) {
      for (const entry of relevant) recordInjected(entry, 'relevance');
      const synthesis = synthesizePreTaskContext(relevant.map((r) => `${r.title}\n${r.content}`));
      sections.push(`PRE-TASK SYNTHESIS\n${synthesis}\n\nRelevant knowledge from past runs — apply it, but verify against the current task:\n${relevant.map(renderLine).join('\n')}`);
    }
    // Surfacing an episode into a live dispatch is the strongest possible signal
    // that it is still useful. Bump lastAccessedAt so adaptive forgetting
    // (BrainMaintenanceService) and compression don't stale-mark memory that the
    // engine actually relies on — the standalone graph view is not the only path
    // that should count as "accessed".
    this.#markEpisodesAccessed(relevant.filter((entry) => entry.kind === 'episode').map((entry) => entry.id));

    // Tier 3 — CORA organizational layer (workspace claims, grant-gated +
    // influence-audited). Sits BELOW the constitutional and relevance tiers in
    // the §12.2 composition order: workspace policy > owner instruction >
    // organizational knowledge. Failure here never breaks dispatch.
    if (this.#coraComposer && args.agentId) {
      try {
        const cora = this.#coraComposer.composeForDispatch({
          workspaceId: args.workspaceId,
          agentId: args.agentId,
          runId: args.runId ?? null,
          taskDescription: args.taskDescription,
        });
        if (cora.block) sections.push(cora.block);
      } catch (error) {
        this.logger.warn('brain.cora_context_failed', {
          workspaceId: args.workspaceId,
          agentId: args.agentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // Header-only (no atoms, no CORA content) composes to nothing.
    if (charter.length === 0 && relevant.length === 0 && sections.length <= 1) {
      return { block: '', atomIds: [] };
    }
    return { block: sections.join('\n'), atomIds };
  }

  /**
   * Bump `lastAccessedAt` for the given episodes. Centralized so every retrieval
   * path that surfaces an episode (dispatch context + the graph view) records
   * access consistently — the access signal adaptive forgetting depends on.
   */
  #markEpisodesAccessed(episodeIds: string[]): void {
    if (episodeIds.length === 0) return;
    this.db.update(schema.memoryEpisodes)
      .set({ lastAccessedAt: new Date().toISOString() })
      .where(inArray(schema.memoryEpisodes.id, episodeIds))
      .run();
  }

  /**
   * Constitutional atoms — operator-authored binding context that injects on
   * every dispatch. An atom qualifies when it is operator-sourced AND governing:
   * a hard `rule`, a high-importance statement (≥0.8), or tagged `charter`
   * (how authored workspace/decisions/workflow context is stored). Ranked by
   * importance × trust × recency and capped, so the most binding survive.
   */
  #loadConstitutionalAtoms(workspaceId: string, cap: number): BrainSearchResult[] {
    if (cap <= 0) return [];
    const rows = this.db.select().from(schema.workspaceMemory)
      .where(and(
        eq(schema.workspaceMemory.workspaceId, workspaceId),
        isNull(schema.workspaceMemory.scopeId),
        eq(schema.workspaceMemory.source, 'operator'),
      ))
      .orderBy(desc(schema.workspaceMemory.updatedAt))
      .limit(200)
      .all();
    const now = Date.now();
    return rows
      .filter((r) => {
        const tags = parseJsonArray<string>(r.tags);
        return (Number(r.importance) || 0) >= 0.8 || r.kind === 'rule' || tags.includes('charter');
      })
      .map((r) => {
        const importance = Number(r.importance) || 0;
        const trust = Number(r.trust) || 0;
        const ageDays = (now - Date.parse(r.reinforcedAt ?? r.updatedAt)) / 86_400_000;
        const recency = Number.isFinite(ageDays) ? (ageDays <= 30 ? 1 : ageDays <= 120 ? 0.9 : 0.8) : 0.9;
        const score = (0.5 + 0.5 * importance) * (0.5 + 0.5 * trust) * recency;
        return { r, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, cap)
      .map(({ r }) => ({
        id: r.id,
        kind: 'memory' as const,
        title: r.title,
        content: r.content,
        confidence: clamp01(Number(r.trust)),
        score: 1,
        scopeId: r.scopeId ?? null,
        tags: parseJsonArray<string>(r.tags),
        status: null,
        managed: null,
        updatedAt: r.updatedAt,
      }));
  }

  /**
   * Evaluator ? brain feedback loop (Gap14). At verdict time, look up which
   * atoms were injected into the run and nudge their confidence. This is the
   * gradient that makes the brain self-regulating rather than write-only.
   */
  applyEvaluatorVerdict(args: {
    workspaceId: string;
    runId: string;
    scopeId?: string | null;
    agentId?: string | null;
    verdict: 'pass' | 'fail' | 'partial';
    evaluatorConfidence?: number | null;
  }): { adjusted: number; archived: number } {
    if (args.verdict === 'partial') return { adjusted: 0, archived: 0 };
    const injected = this.db
      .select({ atomId: schema.brainQualityEvents.atomId })
      .from(schema.brainQualityEvents)
      .where(and(
        eq(schema.brainQualityEvents.workspaceId, args.workspaceId),
        eq(schema.brainQualityEvents.runId, args.runId),
        eq(schema.brainQualityEvents.eventType, 'atom_injected'),
      ))
      .all();
    const atomIds = [...new Set(injected.map((r) => r.atomId).filter((id): id is string => !!id))];
    if (atomIds.length === 0) return { adjusted: 0, archived: 0 };

    const strongPass = args.verdict === 'pass' && (args.evaluatorConfidence ?? 0) > 0.85;
    let adjusted = 0;
    let archived = 0;

    atomIds.forEach((atomId, index) => {
      let delta = args.verdict === 'pass' ? EVAL_DELTA_PASS : EVAL_DELTA_FAIL;
      if (strongPass && index < 3) delta = EVAL_DELTA_PASS_TOP;
      const now = new Date().toISOString();

      const episode = this.db.select().from(schema.memoryEpisodes)
        .where(and(eq(schema.memoryEpisodes.workspaceId, args.workspaceId), eq(schema.memoryEpisodes.id, atomId)))
        .get();
      if (episode) {
        const next = clamp01(Number(episode.confidence) + delta);
        const archiveIt = next < ARCHIVE_CONFIDENCE_FLOOR && episode.managed;
        this.db.update(schema.memoryEpisodes)
          .set({
            confidence: String(next),
            updatedAt: now,
            ...(archiveIt ? { status: 'archived', archivedAt: now } : {}),
          })
          .where(eq(schema.memoryEpisodes.id, atomId))
          .run();
        adjusted += 1;
        if (archiveIt) archived += 1;
        this.recordQualityEvent({
          workspaceId: args.workspaceId,
          scopeId: args.scopeId ?? null,
          agentId: args.agentId ?? null,
          runId: args.runId,
          eventType: 'atom_confidence_delta',
          atomId,
          delta,
        });
        return;
      }

      const memory = this.db.select().from(schema.workspaceMemory)
        .where(and(eq(schema.workspaceMemory.workspaceId, args.workspaceId), eq(schema.workspaceMemory.id, atomId)))
        .get();
      if (!memory) return;
      const nextTrust = clamp01(Number(memory.trust) + delta);
      const nextGlobalConfidence = clamp01(Number(memory.globalConfidence ?? 0) + delta);
      this.db.update(schema.workspaceMemory)
        .set({
          trust: String(nextTrust),
          globalConfidence: String(Math.max(nextGlobalConfidence, nextTrust * 0.75)),
          updatedAt: now,
        })
        .where(eq(schema.workspaceMemory.id, atomId))
        .run();
      adjusted += 1;
      this.recordQualityEvent({
        workspaceId: args.workspaceId,
        scopeId: args.scopeId ?? null,
        agentId: args.agentId ?? null,
        runId: args.runId,
        eventType: 'atom_confidence_delta',
        atomId,
        delta,
        metadata: { atomKind: 'memory' },
      });
    });

    this.recordQualityEvent({
      workspaceId: args.workspaceId,
      scopeId: args.scopeId ?? null,
      agentId: args.agentId ?? null,
      runId: args.runId,
      eventType: args.verdict === 'pass' ? 'evaluator_pass' : 'evaluator_fail',
    });

    if (adjusted || archived) {
      this.logger.info('collective_brain.evaluator_feedback.applied', {
        workspaceId: args.workspaceId,
        runId: args.runId,
        verdict: args.verdict,
        adjusted,
        archived,
      });
    }
    return { adjusted, archived };
  }

  /** Record a brain quality event (Appendix C). Never throws. */
  recordQualityEvent(event: {
    workspaceId: string;
    scopeId?: string | null;
    agentId?: string | null;
    runId?: string | null;
    eventType: string;
    atomId?: string | null;
    abilityId?: string | null;
    delta?: number | null;
    metadata?: Record<string, unknown> | null;
  }): void {
    try {
      this.db.insert(schema.brainQualityEvents).values({
        id: randomUUID(),
        workspaceId: event.workspaceId,
        scopeId: event.scopeId ?? null,
        agentId: event.agentId ?? null,
        eventType: event.eventType,
        atomId: event.atomId ?? null,
        abilityId: event.abilityId ?? null,
        runId: event.runId ?? null,
        delta: event.delta ?? null,
        metadata: event.metadata ?? {},
        createdAt: new Date().toISOString(),
      }).run();
    } catch (err) {
      this.logger.warn('collective_brain.quality_event.failed', { message: (err as Error).message });
    }
  }

  async searchAtoms(args: {
    workspaceId: string;
    scopeId?: string | null;
    query: string;
    scope?: 'workspace' | 'scoped' | 'both';
    limit?: number;
    minConfidence?: number;
  }): Promise<BrainSearchResult[]> {
    if (this.embeddingStatus(args.workspaceId).retrievalPaused) return [];
    const limit = Math.min(Math.max(args.limit ?? 5, 1), 25);
    const scopeId = args.scopeId ?? null;
    const graphScope: BrainGraphScope = args.scope === 'scoped' || (args.scope === 'both' && scopeId) ? 'scoped' : 'workspace';
    const atoms = this.loadAtoms(args.workspaceId, {
      scope: graphScope,
      scopeId,
      includeWorkspace: args.scope === 'both' || graphScope === 'workspace',
      limit: MAX_GRAPH_LIMIT,
      minConfidence: args.minConfidence ?? 0,
    });
    if (atoms.length === 0) return [];

    let queryVec: number[] | null = null;
    try {
      queryVec = await embedText(this.#resolveEmbeddingProvider(args.workspaceId), args.query);
    } catch {
      queryVec = null;
    }

    const episodeVecs = new Map<string, number[]>();
    if (queryVec) {
      for (const row of this.db.select({
        id: schema.memoryEpisodes.id,
        embedding: schema.memoryEpisodes.embedding,
      }).from(schema.memoryEpisodes).where(eq(schema.memoryEpisodes.workspaceId, args.workspaceId)).all()) {
        const vec = parseEmbedding(row.embedding);
        if (vec) episodeVecs.set(row.id, vec);
      }
    }

    const ranked = atoms
      .map((atom) => {
        const vec = atom.kind === 'episode' ? episodeVecs.get(atom.id) ?? null : null;
        const score = queryVec && vec && vec.length === queryVec.length
          ? cosineSimilarity(queryVec, vec)
          : similarity(args.query, atom.text);
        return { atom, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    this.#markEpisodesAccessed(ranked.filter(({ atom }) => atom.kind === 'episode').map(({ atom }) => atom.id));

    return ranked.map(({ atom, score }) => ({
      id: atom.id,
      kind: atom.kind,
      title: atom.node.label,
      content: atom.node.summary ?? atom.text,
      confidence: atom.node.confidence,
      score,
      scopeId: atom.node.scopeId ?? null,
      tags: parseJsonArray<string>(atom.node.metadata.tags),
      status: atom.node.status ?? null,
      managed: atom.node.managed ?? null,
      updatedAt: atom.node.updatedAt,
    }));
  }

  async addAtom(args: {
    workspaceId: string;
    scopeId?: string | null;
    workflowId?: string | null;
    runId?: string | null;
    agentId?: string | null;
    content: string;
    title?: string;
    tags?: string[];
    confidence?: number;
    source?: 'agent_write' | 'operator_write' | 'system_write' | 'run_promotion' | 'evaluator_write';
    managed?: boolean;
    metadata?: Record<string, unknown>;
    compressionTier?: number | null;
    compressedFrom?: string[] | null;
  }): Promise<BrainSearchResult> {
    const provider = this.#resolveEmbeddingProvider(args.workspaceId);
    let embedding: number[] | null = null;
    try {
      embedding = await embedText(provider, args.content);
    } catch {
      embedding = null;
    }

    const episode = this.episodes.write({
      workspaceId: args.workspaceId,
      scopeId: args.scopeId ?? null,
      workflowId: args.workflowId ?? null,
      runId: args.runId ?? null,
      agentId: args.agentId ?? null,
      type: 'distilled_lesson',
      title: args.title ?? titleFromFact(args.content),
      summary: args.content,
      source: args.source ?? 'agent_write',
      confidence: clamp01(args.confidence ?? 0.7),
      importance: 0.6,
      trust: 0.65,
      tags: args.tags ?? [],
      entities: [],
      outcomeStatus: 'mixed',
      metadata: args.metadata ?? {},
    });

    const update: Record<string, unknown> = {
      managed: args.managed ?? (args.source !== 'operator_write'),
      ...(embedding ? { embedding } : {}),
      ...(args.compressionTier ? { compressionTier: args.compressionTier } : {}),
      ...(args.compressedFrom ? { compressedFrom: args.compressedFrom } : {}),
    };
    this.db.update(schema.memoryEpisodes)
      .set(update)
      .where(eq(schema.memoryEpisodes.id, episode.id))
      .run();

    const node = episodeToGraphNode({ ...episode, metadata: args.metadata ?? {} }, 1);
    this.publishAtom(args.workspaceId, REALTIME_EVENTS.BRAIN_ATOM_CREATED, node);
    return {
      id: episode.id,
      kind: 'episode',
      title: episode.title,
      content: episode.summary,
      confidence: episode.confidence,
      score: 1,
      scopeId: episode.scopeId ?? null,
      tags: episode.tags,
      status: 'active',
      managed: update.managed as boolean,
      updatedAt: episode.updatedAt,
    };
  }

  async reembedWorkspaceAtoms(workspaceId: string, requestId: string | null = null): Promise<{ atomsReembedded: number; failed: number }> {
    const startedAt = new Date().toISOString();
    this.#setEmbeddingMigration(workspaceId, {
      status: 'running',
      requestId,
      startedAt,
      atomsReembedded: 0,
      failed: 0,
    });
    this.bus.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.BRAIN_EMBEDDING_MIGRATION_STARTED, {
      workspaceId,
      requestId,
      startedAt,
    });
    this.invalidateEmbeddingProvider(workspaceId);
    const provider = this.#resolveEmbeddingProvider(workspaceId);
    const rows = this.db.select().from(schema.memoryEpisodes)
      .where(and(eq(schema.memoryEpisodes.workspaceId, workspaceId), isNull(schema.memoryEpisodes.archivedAt)))
      .all()
      .filter((row) => row.status !== 'archived');
    let atomsReembedded = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const embedding = await embedText(provider, `${row.title} ${row.summary}`);
        this.db.update(schema.memoryEpisodes)
          .set({ embedding, updatedAt: new Date().toISOString() })
          .where(eq(schema.memoryEpisodes.id, row.id))
          .run();
        atomsReembedded += 1;
      } catch (err) {
        failed += 1;
        this.logger.warn('collective_brain.reembed_atom_failed', { workspaceId, atomId: row.id, message: (err as Error).message });
      }
    }
    this.#setEmbeddingMigration(workspaceId, {
      status: failed > 0 ? 'completed_with_errors' : 'completed',
      requestId,
      startedAt,
      completedAt: new Date().toISOString(),
      atomsReembedded,
      failed,
    });
    this.recordQualityEvent({
      workspaceId,
      eventType: 'brain_embedding_migration_completed',
      metadata: { requestId, atomsReembedded, failed },
    });
    this.bus.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.BRAIN_EMBEDDING_MIGRATION_COMPLETED, {
      workspaceId,
      requestId,
      atomsReembedded,
      failed,
    });
    return { atomsReembedded, failed };
  }

  summarize(args: { workspaceId: string; scopeId?: string | null; sessionId?: string | null }): BrainSummary {
    const rows = this.db.select().from(schema.memoryEpisodes)
      .where(and(eq(schema.memoryEpisodes.workspaceId, args.workspaceId), isNull(schema.memoryEpisodes.archivedAt)))
      .all()
      .filter((row) => row.status !== 'archived');
    const scopedRows = args.scopeId ? rows.filter((row) => row.scopeId === args.scopeId) : [];
    const workspaceRows = rows.filter((row) => !row.scopeId);
    const sessionRows = args.sessionId
      ? this.db.select().from(schema.sessionMoments)
          .where(and(eq(schema.sessionMoments.workspaceId, args.workspaceId), eq(schema.sessionMoments.sessionId, args.sessionId)))
          .all()
      : [];
    const maintenance = this.db.select().from(schema.brainQualityEvents)
      .where(and(
        eq(schema.brainQualityEvents.workspaceId, args.workspaceId),
        eq(schema.brainQualityEvents.eventType, 'brain_maintenance_completed'),
      ))
      .orderBy(desc(schema.brainQualityEvents.createdAt))
      .limit(1)
      .get();
    const maintenanceMeta = parseJsonRecord(maintenance?.metadata);
    return {
      workspaceIntelligence: summarizeRows(workspaceRows),
      scopedBrain: summarizeRows(scopedRows),
      SessionMoments: {
        count: sessionRows.length,
        capacityTokens: estimateTokens(sessionRows.map((row) => row.content).join('\n')),
      },
      compressionStatus: {
        lastRunAt: maintenance?.createdAt ?? null,
        atomsArchived: typeof maintenanceMeta.atomsArchived === 'number' ? maintenanceMeta.atomsArchived : 0,
        nextTriggerAt: typeof maintenanceMeta.nextTriggerAt === 'string' ? maintenanceMeta.nextTriggerAt : null,
      },
    };
  }

  flagDispute(args: {
    workspaceId: string;
    atomIdA: string;
    atomIdB: string;
    reason: string;
    scopeId?: string | null;
  }): { linkId: string | null } {
    const now = new Date().toISOString();
    const link = this.createLink({
      workspaceId: args.workspaceId,
      sourceId: args.atomIdA,
      sourceKind: 'episode',
      targetId: args.atomIdB,
      targetKind: 'episode',
      relation: 'contradicts',
      confidence: 0.78,
      scopeId: args.scopeId ?? null,
    });
    this.db.update(schema.memoryEpisodes)
      .set({ isDisputed: true, disputeReason: args.reason, updatedAt: now })
      .where(and(eq(schema.memoryEpisodes.workspaceId, args.workspaceId), or(eq(schema.memoryEpisodes.id, args.atomIdA), eq(schema.memoryEpisodes.id, args.atomIdB))!))
      .run();
    this.bus.publish(REALTIME_ROOMS.workspace(args.workspaceId), REALTIME_EVENTS.BRAIN_DISPUTE_FLAGGED, {
      workspaceId: args.workspaceId,
      scopeId: args.scopeId ?? null,
      atomIds: [args.atomIdA, args.atomIdB],
      reason: args.reason,
    });
    return { linkId: link?.id ?? null };
  }

  listDisputes(workspaceId: string, options: { scopeId?: string | null; includeSnoozed?: boolean } = {}) {
    const now = new Date().toISOString();
    const links = this.db.select().from(schema.knowledgeLinks)
      .where(and(
        eq(schema.knowledgeLinks.workspaceId, workspaceId),
        eq(schema.knowledgeLinks.relation, 'contradicts'),
        isNull(schema.knowledgeLinks.invalidAt),
      ))
      .orderBy(desc(schema.knowledgeLinks.updatedAt))
      .all()
      .filter((link) => !link.contextSplit && !link.resolvedAt)
      .filter((link) => !options.scopeId || !link.scopeId || link.scopeId === options.scopeId);
    const out = [];
    for (const link of links) {
      const a = this.db.select().from(schema.memoryEpisodes)
        .where(and(eq(schema.memoryEpisodes.workspaceId, workspaceId), eq(schema.memoryEpisodes.id, link.sourceId)))
        .get();
      const b = this.db.select().from(schema.memoryEpisodes)
        .where(and(eq(schema.memoryEpisodes.workspaceId, workspaceId), eq(schema.memoryEpisodes.id, link.targetId)))
        .get();
      if (!a || !b) continue;
      if (a.status === 'archived' || b.status === 'archived') continue;
      if (!options.includeSnoozed) {
        const snoozedA = a.disputeSnoozedUntil && a.disputeSnoozedUntil > now;
        const snoozedB = b.disputeSnoozedUntil && b.disputeSnoozedUntil > now;
        if (snoozedA || snoozedB) continue;
      }
      out.push({
        id: link.id,
        scopeId: link.scopeId,
        reason: a.disputeReason ?? b.disputeReason ?? 'Contradicting brain atoms need review.',
        createdAt: link.createdAt,
        updatedAt: link.updatedAt,
        atomA: disputeAtom(a),
        atomB: disputeAtom(b),
      });
    }
    return out;
  }

  async resolveDispute(args: {
    workspaceId: string;
    disputeId: string;
    action: 'keep_a' | 'keep_b' | 'merge' | 'context_split' | 'snooze';
    contextA?: string | null;
    contextB?: string | null;
    snoozeDays?: number;
  }): Promise<{ resolved: boolean; newAtomId?: string | null }> {
    const link = this.db.select().from(schema.knowledgeLinks)
      .where(and(eq(schema.knowledgeLinks.workspaceId, args.workspaceId), eq(schema.knowledgeLinks.id, args.disputeId)))
      .get();
    if (!link || link.relation !== 'contradicts') return { resolved: false };
    const now = new Date().toISOString();
    const atomA = this.db.select().from(schema.memoryEpisodes)
      .where(and(eq(schema.memoryEpisodes.workspaceId, args.workspaceId), eq(schema.memoryEpisodes.id, link.sourceId)))
      .get();
    const atomB = this.db.select().from(schema.memoryEpisodes)
      .where(and(eq(schema.memoryEpisodes.workspaceId, args.workspaceId), eq(schema.memoryEpisodes.id, link.targetId)))
      .get();
    if (!atomA || !atomB) return { resolved: false };

    const clearBoth = () => {
      this.db.update(schema.memoryEpisodes)
        .set({ isDisputed: false, disputeResolvedAt: now, disputeSnoozedUntil: null, updatedAt: now })
        .where(and(eq(schema.memoryEpisodes.workspaceId, args.workspaceId), or(eq(schema.memoryEpisodes.id, atomA.id), eq(schema.memoryEpisodes.id, atomB.id))!))
        .run();
    };

    let newAtomId: string | null = null;
    if (args.action === 'keep_a' || args.action === 'keep_b') {
      const loser = args.action === 'keep_a' ? atomB : atomA;
      this.db.update(schema.memoryEpisodes)
        .set({ status: 'archived', archivedAt: now, isDisputed: false, disputeResolvedAt: now, updatedAt: now })
        .where(eq(schema.memoryEpisodes.id, loser.id))
        .run();
      clearBoth();
      this.db.update(schema.knowledgeLinks)
        .set({ resolvedAt: now, invalidAt: now, updatedAt: now })
        .where(eq(schema.knowledgeLinks.id, link.id))
        .run();
      this.db.update(schema.knowledgeLinks)
        .set({ invalidAt: now, updatedAt: now })
        .where(and(
          eq(schema.knowledgeLinks.workspaceId, args.workspaceId),
          or(eq(schema.knowledgeLinks.sourceId, loser.id), eq(schema.knowledgeLinks.targetId, loser.id))!,
          isNull(schema.knowledgeLinks.invalidAt),
        ))
        .run();
    } else if (args.action === 'merge') {
      const merged = await this.addAtom({
        workspaceId: args.workspaceId,
        scopeId: link.scopeId ?? atomA.scopeId ?? atomB.scopeId ?? null,
        agentId: atomA.agentId ?? atomB.agentId ?? null,
        content: mergeDisputeContent(atomA.summary, atomB.summary),
        title: titleFromFact(atomA.title.length >= atomB.title.length ? atomA.title : atomB.title),
        tags: uniqueByNormalized([...parseJsonArray<string>(atomA.tags), ...parseJsonArray<string>(atomB.tags)]),
        confidence: Math.min(0.95, Math.max(Number(atomA.confidence), Number(atomB.confidence)) + 0.05),
        source: 'system_write',
        managed: true,
        metadata: { source: 'curator_distilled', disputeId: link.id },
        compressionTier: 3,
        compressedFrom: [atomA.id, atomB.id],
      });
      newAtomId = merged.id;
      this.db.update(schema.memoryEpisodes)
        .set({ status: 'archived', archivedAt: now, isDisputed: false, disputeResolvedAt: now, updatedAt: now })
        .where(and(eq(schema.memoryEpisodes.workspaceId, args.workspaceId), or(eq(schema.memoryEpisodes.id, atomA.id), eq(schema.memoryEpisodes.id, atomB.id))!))
        .run();
      this.db.update(schema.knowledgeLinks)
        .set({ resolvedAt: now, invalidAt: now, updatedAt: now })
        .where(eq(schema.knowledgeLinks.id, link.id))
        .run();
      this.db.update(schema.knowledgeLinks)
        .set({ invalidAt: now, updatedAt: now })
        .where(and(
          eq(schema.knowledgeLinks.workspaceId, args.workspaceId),
          or(
            eq(schema.knowledgeLinks.sourceId, atomA.id),
            eq(schema.knowledgeLinks.targetId, atomA.id),
            eq(schema.knowledgeLinks.sourceId, atomB.id),
            eq(schema.knowledgeLinks.targetId, atomB.id),
          )!,
          isNull(schema.knowledgeLinks.invalidAt),
        ))
        .run();
    } else if (args.action === 'context_split') {
      this.db.update(schema.memoryEpisodes)
        .set({ isDisputed: false, disputeResolvedAt: now, disputeSnoozedUntil: null, contextCondition: args.contextA ?? 'Context A', updatedAt: now })
        .where(eq(schema.memoryEpisodes.id, atomA.id))
        .run();
      this.db.update(schema.memoryEpisodes)
        .set({ isDisputed: false, disputeResolvedAt: now, disputeSnoozedUntil: null, contextCondition: args.contextB ?? 'Context B', updatedAt: now })
        .where(eq(schema.memoryEpisodes.id, atomB.id))
        .run();
      this.db.update(schema.knowledgeLinks)
        .set({ contextSplit: true, resolvedAt: now, updatedAt: now })
        .where(eq(schema.knowledgeLinks.id, link.id))
        .run();
    } else {
      const days = Math.min(Math.max(args.snoozeDays ?? 30, 1), 365);
      const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
      this.db.update(schema.memoryEpisodes)
        .set({ disputeSnoozedUntil: until, updatedAt: now })
        .where(and(eq(schema.memoryEpisodes.workspaceId, args.workspaceId), or(eq(schema.memoryEpisodes.id, atomA.id), eq(schema.memoryEpisodes.id, atomB.id))!))
        .run();
      this.bus.publish(REALTIME_ROOMS.workspace(args.workspaceId), REALTIME_EVENTS.BRAIN_DISPUTE_RESOLVED, {
        workspaceId: args.workspaceId,
        disputeId: args.disputeId,
        action: args.action,
        snoozedUntil: until,
      });
      return { resolved: true };
    }

    this.bus.publish(REALTIME_ROOMS.workspace(args.workspaceId), REALTIME_EVENTS.BRAIN_DISPUTE_RESOLVED, {
      workspaceId: args.workspaceId,
      disputeId: args.disputeId,
      action: args.action,
      newAtomId,
    });
    return { resolved: true, newAtomId };
  }

  #capacityStatus(workspaceId: string): { percent: number; recommended: boolean } {
    const settings = this.db.select({ brainSettings: schema.workspaces.brainSettings })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .get();
    const parsed = parseJsonRecord(settings?.brainSettings);
    const threshold = typeof parsed.compressionThreshold === 'number' ? parsed.compressionThreshold : 2000;
    const count = this.db.select().from(schema.memoryEpisodes)
      .where(and(eq(schema.memoryEpisodes.workspaceId, workspaceId), isNull(schema.memoryEpisodes.archivedAt)))
      .all()
      .filter((row) => row.status !== 'archived').length;
    const percent = Math.max(0, Math.round((count / Math.max(1, threshold)) * 100));
    return { percent, recommended: percent >= 80 };
  }

  #setEmbeddingMigration(workspaceId: string, migration: Record<string, unknown>): void {
    const row = this.db.select({ brainSettings: schema.workspaces.brainSettings })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .get();
    const settings = parseJsonRecord(row?.brainSettings);
    this.db.update(schema.workspaces)
      .set({ brainSettings: { ...settings, embeddingMigration: migration } })
      .where(eq(schema.workspaces.id, workspaceId))
      .run();
  }

  /**
   * Load active episode atoms with parsed embedding vectors for a workspace,
   * scoped to a workspace when given. Archived/superseded rows are excluded.
   */
  #loadEpisodeVectors(
    workspaceId: string,
    scopeId: string | null,
  ): Array<{ id: string; vec: number[] | null; text: string }> {
    const rows = this.db.select().from(schema.memoryEpisodes)
      .where(and(
        eq(schema.memoryEpisodes.workspaceId, workspaceId),
        isNull(schema.memoryEpisodes.archivedAt),
        ...(scopeId
          ? [or(eq(schema.memoryEpisodes.scopeId, scopeId), isNull(schema.memoryEpisodes.scopeId))!]
          : []),
      ))
      .orderBy(desc(schema.memoryEpisodes.updatedAt))
      .limit(MAX_GRAPH_LIMIT)
      .all();
    return rows
      .filter((row) => row.status !== 'archived')
      .map((row) => ({
        id: row.id,
        vec: parseEmbedding(row.embedding),
        text: `${row.title}\n${row.summary}`,
      }));
  }

  extractAndPromote(input: CollectiveCognitivePromotionInput): { created: number; reinforced: number; linked: number } {
    const resolvedAgent = input.agentId ? this.resolveAgent(input.workspaceId, input.agentId) : null;
    const adapterType = input.adapterType ?? resolvedAgent?.adapterType ?? null;
    const candidates = extractPromotableFacts(input.taskOutput);
    if (candidates.length === 0) return { created: 0, reinforced: 0, linked: 0 };

    let created = 0;
    let reinforced = 0;
    let linked = 0;
    const existingAtoms = this.loadAtoms(input.workspaceId, {
      scope: input.scopeId ? 'scoped' : 'workspace',
      scopeId: input.scopeId ?? null,
      limit: MAX_GRAPH_LIMIT,
    });

    for (const fact of candidates) {
      const best = this.findBestSimilar(existingAtoms, fact);
      if (best && best.score >= HIGH_SIMILARITY) {
        const node = this.reinforceAtom(input.workspaceId, best.atom.kind, best.atom.id, {
          agentId: input.agentId ?? null,
          adapterType,
          runId: input.runId ?? null,
          scopeId: input.scopeId ?? null,
        });
        if (node) {
          reinforced += 1;
          this.publishAtom(input.workspaceId, REALTIME_EVENTS.BRAIN_ATOM_REINFORCED, node);
        }
        continue;
      }

      const episode = this.episodes.write({
        workspaceId: input.workspaceId,
        scopeId: input.scopeId ?? null,
        workflowId: input.workflowId ?? null,
        runId: input.runId ?? null,
        agentId: input.agentId ?? null,
        type: 'distilled_lesson',
        title: titleFromFact(fact),
        summary: fact,
        source: 'run_promotion',
        confidence: 0.58,
        importance: 0.62,
        trust: 0.55,
        tags: ['collective_brain', ...(adapterType ? [adapterType] : [])],
        entities: input.nodeId ? [input.nodeId] : [],
        outcomeStatus: 'mixed',
        metadata: {
          adapterType,
          nodeId: input.nodeId ?? null,
          origin: 'agent_task_output',
          taskInputPreview: compactValue(input.taskInput),
        },
      });
      created += 1;
      const createdNode = episodeToGraphNode(episode, 1);
      this.publishAtom(input.workspaceId, REALTIME_EVENTS.BRAIN_ATOM_CREATED, createdNode);

      const createdAtom: AtomCandidate = {
        id: episode.id,
        kind: 'episode',
        text: `${episode.title}\n${episode.summary}\n${episode.details ?? ''}`,
        node: createdNode,
      };
      existingAtoms.push(createdAtom);

      if (best && best.score >= RELATED_SIMILARITY) {
        const link = this.createLink({
          workspaceId: input.workspaceId,
          sourceId: episode.id,
          sourceKind: 'episode',
          targetId: best.atom.id,
          targetKind: best.atom.kind,
          relation: relationFor(fact, best.atom.text),
          confidence: Math.max(0.45, Math.min(0.85, best.score)),
          agentId: input.agentId ?? null,
          adapterType,
          runId: input.runId ?? null,
          scopeId: input.scopeId ?? null,
        });
        linked += link ? 1 : 0;
      }
    }

    if (created || reinforced || linked) {
      this.logger.info('collective_brain.promotion.applied', {
        workspaceId: input.workspaceId,
        runId: input.runId,
        agentId: input.agentId,
        created,
        reinforced,
        linked,
      });
    }
    return { created, reinforced, linked };
  }

  createLink(input: KnowledgeLinkInput): BrainGraphLink | null {
    if (input.sourceId === input.targetId && input.sourceKind === input.targetKind) return null;
    const sourceAtom = this.loadAtomById(input.workspaceId, input.sourceKind, input.sourceId);
    const targetAtom = this.loadAtomById(input.workspaceId, input.targetKind, input.targetId);
    if (!sourceAtom || !targetAtom) return null;
    if (input.scopeId && (!atomVisibleInScope(sourceAtom.node, input.scopeId) || !atomVisibleInScope(targetAtom.node, input.scopeId))) {
      return null;
    }

    const existing = this.db.select().from(schema.knowledgeLinks)
      .where(and(
        eq(schema.knowledgeLinks.workspaceId, input.workspaceId),
        eq(schema.knowledgeLinks.sourceId, input.sourceId),
        eq(schema.knowledgeLinks.sourceKind, input.sourceKind),
        eq(schema.knowledgeLinks.targetId, input.targetId),
        eq(schema.knowledgeLinks.targetKind, input.targetKind),
        eq(schema.knowledgeLinks.relation, input.relation),
        isNull(schema.knowledgeLinks.invalidAt),
      ))
      .get();

    if (existing) {
      const now = new Date().toISOString();
      const confidence = clamp01(Number(existing.confidence) + (1 - Number(existing.confidence)) * 0.12);
      const reinforceCount = (existing.reinforceCount ?? 1) + 1;
      this.db.update(schema.knowledgeLinks)
        .set({ confidence, reinforceCount, updatedAt: now })
        .where(eq(schema.knowledgeLinks.id, existing.id))
        .run();
      const link = linkRowToGraph({ ...existing, confidence, reinforceCount, updatedAt: now });
      this.publishLink(input.workspaceId, link);
      return link;
    }

    const now = new Date().toISOString();
    const row = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      sourceKind: input.sourceKind,
      targetId: input.targetId,
      targetKind: input.targetKind,
      relation: input.relation,
      confidence: clamp01(input.confidence ?? 0.5),
      reinforceCount: 1,
      agentId: input.agentId ?? null,
      adapterType: input.adapterType ?? null,
      runId: input.runId ?? null,
      scopeId: input.scopeId ?? null,
      contextSplit: false,
      resolvedAt: null,
      validFrom: now,
      invalidAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(schema.knowledgeLinks).values(row).run();
    const link = linkRowToGraph(row);
    this.publishLink(input.workspaceId, link);
    return link;
  }

  getGraph(workspaceId: string, options: BrainGraphOptions = {}): BrainGraph {
    const scope = options.scope ?? 'workspace';
    const scopeId = options.scopeId ?? null;
    const includeWorkspace = options.includeWorkspace ?? scope !== 'scoped';
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_GRAPH_LIMIT, 1), MAX_GRAPH_LIMIT);
    const minConfidence = clamp01(options.minConfidence ?? 0);
    const kindFilter = options.kinds && options.kinds.length > 0 ? new Set(options.kinds) : null;

    const atoms = this.loadAtoms(workspaceId, { scope, scopeId, includeWorkspace, limit, kinds: options.kinds, minConfidence });
    const atomByKey = new Map(atoms.map((atom) => [atomKey(atom.kind, atom.id), atom] as const));

    const linkRows = this.db.select().from(schema.knowledgeLinks)
      .where(and(
        eq(schema.knowledgeLinks.workspaceId, workspaceId),
        isNull(schema.knowledgeLinks.invalidAt),
        ...(scope === 'scoped' && scopeId
          ? [includeWorkspace ? or(eq(schema.knowledgeLinks.scopeId, scopeId), isNull(schema.knowledgeLinks.scopeId))! : eq(schema.knowledgeLinks.scopeId, scopeId)]
          : []),
      ))
      .orderBy(desc(schema.knowledgeLinks.updatedAt))
      .limit(limit * 4)
      .all();

    for (const row of linkRows) {
      const sourceKind = row.sourceKind as KnowledgeAtomKind;
      const targetKind = row.targetKind as KnowledgeAtomKind;
      if (kindFilter && (!kindFilter.has(sourceKind) || !kindFilter.has(targetKind))) continue;
      const sourceKey = atomKey(sourceKind, row.sourceId);
      const targetKey = atomKey(targetKind, row.targetId);
      if (!atomByKey.has(sourceKey)) {
        const source = this.loadAtomById(workspaceId, sourceKind, row.sourceId);
        if (source && atomAllowedInGraph(source.node, scope, scopeId, includeWorkspace)) atomByKey.set(sourceKey, source);
      }
      if (!atomByKey.has(targetKey)) {
        const target = this.loadAtomById(workspaceId, targetKind, row.targetId);
        if (target && atomAllowedInGraph(target.node, scope, scopeId, includeWorkspace)) atomByKey.set(targetKey, target);
      }
    }

    const graphLinks = linkRows
      .map(linkRowToGraph)
      .filter((link) => atomByKey.has(atomKey(link.sourceKind, link.sourceAtomId)) && atomByKey.has(atomKey(link.targetKind, link.targetAtomId)))
      .filter((link) => link.confidence >= minConfidence)
      .slice(0, limit * 2);

    const reinforceByNode = new Map<string, number>();
    for (const link of graphLinks) {
      reinforceByNode.set(link.source, (reinforceByNode.get(link.source) ?? 0) + link.reinforceCount);
      reinforceByNode.set(link.target, (reinforceByNode.get(link.target) ?? 0) + link.reinforceCount);
    }

    const nodes = [coreNode(workspaceId, scope, scopeId)];
    const atomNodes = [...atomByKey.values()]
      .map((atom) => ({ ...atom.node, reinforceCount: Math.max(atom.node.reinforceCount, reinforceByNode.get(atom.node.id) ?? 1) }))
      .filter((node) => node.confidence >= minConfidence)
      .sort((a, b) => scoreNode(b) - scoreNode(a))
      .slice(0, limit);
    nodes.push(...atomNodes);

    const visible = new Set(nodes.map((node) => node.id));
    const visibleLinks = graphLinks.filter((link) => visible.has(link.source) && visible.has(link.target));
    const lastActivityAt = latestActivity(nodes, visibleLinks);
    const adapterTypes = new Set<string>();
    for (const node of nodes) if (node.adapterType) adapterTypes.add(node.adapterType);
    for (const link of visibleLinks) if (link.adapterType) adapterTypes.add(link.adapterType);

    return {
      nodes,
      links: visibleLinks,
      meta: {
        workspaceId,
        scope,
        scopeId,
        atomCount: nodes.length - 1,
        linkCount: visibleLinks.length,
        lastActivityAt,
        adapterTypes: [...adapterTypes].sort(),
      },
    };
  }

  getNode(workspaceId: string, graphNodeId: string, options: BrainGraphOptions = {}) {
    const graph = this.getGraph(workspaceId, { ...options, limit: MAX_GRAPH_LIMIT });
    const node = graph.nodes.find((candidate) => candidate.id === graphNodeId || candidate.atomId === graphNodeId);
    if (!node) return null;
    const links = graph.links.filter((link) => link.source === node.id || link.target === node.id);
    const relatedIds = new Set<string>();
    for (const link of links) {
      relatedIds.add(link.source === node.id ? link.target : link.source);
    }
    return {
      node,
      links,
      relatedNodes: graph.nodes.filter((candidate) => relatedIds.has(candidate.id)),
      content: this.getAtomDetail(workspaceId, node)?.content ?? node.summary ?? '',
      provenance: this.provenanceForAtom(workspaceId, node),
      usedBy: this.usedByForAtom(workspaceId, node),
    };
  }

  /**
   * Read-only iteration of every active atom for a workspace, returned as
   * lightweight tokenised candidates suitable for similarity scoring.
   *
   * Used by KnowledgeAutoLinker — exposed here (rather than re-querying
   * the tables in the linker) so all atom-kind ordering, scope filters,
   * and per-kind row mappers stay in one place.
   */
  listLinkCandidates(
    workspaceId: string,
    options: { scopeId?: string | null; includeWorkspace?: boolean; limit?: number } = {},
  ): Array<{ id: string; kind: KnowledgeAtomKind; label: string; text: string; tokens: Set<string> }> {
    const atoms = this.loadAtoms(workspaceId, {
      scope: options.scopeId ? 'scoped' : 'workspace',
      scopeId: options.scopeId ?? null,
      includeWorkspace: options.includeWorkspace ?? false,
      limit: options.limit ?? MAX_GRAPH_LIMIT,
    });
    return atoms.map((atom) => ({
      id: atom.id,
      kind: atom.kind,
      label: atom.node.label,
      text: atom.text,
      tokens: new Set(tokenize(atom.text)),
    }));
  }

  /**
   * Inline edit of an atom's primary text. Only `episode`, `memory`,
   * `pattern`, `knowledge_chunk`, and `kb_chunk` are editable. Returns the
   * updated graph node so the caller can echo it back to the UI.
   */
  updateAtomContent(
    workspaceId: string,
    kind: KnowledgeAtomKind,
    id: string,
    patch: { title?: string; content?: string },
  ): BrainGraphNode | null {
    if (patch.title === undefined && patch.content === undefined) return null;
    const now = new Date().toISOString();
    let changes = 0;
    switch (kind) {
      case 'episode': {
        const update: Record<string, unknown> = { updatedAt: now };
        if (patch.title !== undefined) update.title = patch.title;
        if (patch.content !== undefined) update.summary = patch.content;
        changes = this.db.update(schema.memoryEpisodes)
          .set(update)
          .where(and(eq(schema.memoryEpisodes.workspaceId, workspaceId), eq(schema.memoryEpisodes.id, id)))
          .run().changes;
        break;
      }
      case 'memory': {
        const update: Record<string, unknown> = { updatedAt: now };
        if (patch.title !== undefined) update.title = patch.title;
        if (patch.content !== undefined) update.content = patch.content;
        changes = this.db.update(schema.workspaceMemory)
          .set(update)
          .where(and(eq(schema.workspaceMemory.workspaceId, workspaceId), eq(schema.workspaceMemory.id, id)))
          .run().changes;
        break;
      }
      case 'pattern': {
        const update: Record<string, unknown> = { updatedAt: now };
        if (patch.title !== undefined) update.title = patch.title;
        if (patch.content !== undefined) update.summary = patch.content;
        changes = this.db.update(schema.promotedPatterns)
          .set(update)
          .where(and(eq(schema.promotedPatterns.workspaceId, workspaceId), eq(schema.promotedPatterns.id, id)))
          .run().changes;
        break;
      }
      case 'knowledge_chunk': {
        const update: Record<string, unknown> = { updatedAt: now };
        if (patch.title !== undefined) update.title = patch.title;
        if (patch.content !== undefined) update.content = patch.content;
        changes = this.db.update(schema.knowledgeChunks)
          .set(update)
          .where(and(eq(schema.knowledgeChunks.workspaceId, workspaceId), eq(schema.knowledgeChunks.id, id)))
          .run().changes;
        break;
      }
      case 'kb_chunk': {
        if (patch.content !== undefined) {
          changes = this.db.update(schema.kbChunks)
            .set({ content: patch.content })
            .where(and(eq(schema.kbChunks.workspaceId, workspaceId), eq(schema.kbChunks.id, id)))
            .run().changes;
        }
        break;
      }
    }
    if (changes === 0) return null;
    const atom = this.loadAtomById(workspaceId, kind, id);
    return atom?.node ?? null;
  }

  archiveAtom(
    workspaceId: string,
    kind: KnowledgeAtomKind,
    id: string,
    options: { scopeId?: string | null } = {},
  ): boolean {
    const atom = this.loadAtomById(workspaceId, kind, id);
    if (!atom) return false;
    if (options.scopeId && !atomVisibleInScope(atom.node, options.scopeId)) return false;

    const now = new Date().toISOString();
    let changes = 0;
    switch (kind) {
      case 'episode':
        changes = this.db.update(schema.memoryEpisodes)
          .set({ archivedAt: now, status: 'archived', updatedAt: now })
          .where(and(eq(schema.memoryEpisodes.workspaceId, workspaceId), eq(schema.memoryEpisodes.id, id)))
          .run().changes;
        break;
      case 'memory':
        changes = this.db.delete(schema.workspaceMemory)
          .where(and(eq(schema.workspaceMemory.workspaceId, workspaceId), eq(schema.workspaceMemory.id, id)))
          .run().changes;
        break;
      case 'pattern':
        changes = this.db.delete(schema.promotedPatterns)
          .where(and(eq(schema.promotedPatterns.workspaceId, workspaceId), eq(schema.promotedPatterns.id, id)))
          .run().changes;
        break;
      case 'knowledge_chunk':
        changes = this.db.delete(schema.knowledgeChunks)
          .where(and(eq(schema.knowledgeChunks.workspaceId, workspaceId), eq(schema.knowledgeChunks.id, id)))
          .run().changes;
        break;
      case 'kb_chunk':
        changes = this.db.delete(schema.kbChunks)
          .where(and(eq(schema.kbChunks.workspaceId, workspaceId), eq(schema.kbChunks.id, id)))
          .run().changes;
        break;
    }

    if (changes > 0) this.deleteLinksForAtom(workspaceId, kind, id);
    return changes > 0;
  }

  private getAtomDetail(workspaceId: string, node: BrainGraphNode): BrainAtomDetail | null {
    if (node.atomKind === 'core') {
      return {
        content: node.summary ?? '',
        source: 'Agentis',
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
      };
    }
    if (node.atomKind === 'warning' || node.atomKind === 'gap') return null;
    // Organizational overlay nodes resolve through /v1/cora, not the atom store.
    if (node.atomKind === 'cora_source' || node.atomKind === 'cora_entity' || node.atomKind === 'cora_claim') return null;

    switch (node.atomKind) {
      case 'episode': {
        const row = this.db.select().from(schema.memoryEpisodes)
          .where(and(eq(schema.memoryEpisodes.workspaceId, workspaceId), eq(schema.memoryEpisodes.id, node.atomId)))
          .get();
        if (!row) return null;
        return {
          content: [row.summary, row.details].filter(Boolean).join('\n\n'),
          source: sourceLabel(row.source, 'Agent output'),
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          agentId: row.agentId,
          workflowId: row.workflowId,
          runId: row.runId,
        };
      }
      case 'memory': {
        const row = this.db.select().from(schema.workspaceMemory)
          .where(and(eq(schema.workspaceMemory.workspaceId, workspaceId), eq(schema.workspaceMemory.id, node.atomId)))
          .get();
        if (!row) return null;
        return {
          content: row.content,
          source: sourceLabel(row.source, 'Scoped memory'),
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        };
      }
      case 'pattern': {
        const row = this.db.select().from(schema.promotedPatterns)
          .where(and(eq(schema.promotedPatterns.workspaceId, workspaceId), eq(schema.promotedPatterns.id, node.atomId)))
          .get();
        if (!row) return null;
        const payload = parseJsonRecord(row.payload);
        const payloadText = Object.keys(payload).length > 0 ? `\n\n${JSON.stringify(payload, null, 2)}` : '';
        return {
          content: `${row.summary}${payloadText}`,
          source: 'Promoted pattern',
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        };
      }
      case 'knowledge_chunk': {
        const row = this.db.select().from(schema.knowledgeChunks)
          .where(and(eq(schema.knowledgeChunks.workspaceId, workspaceId), eq(schema.knowledgeChunks.id, node.atomId)))
          .get();
        if (!row) return null;
        return {
          content: row.content,
          source: sourceLabel(row.source, 'Knowledge import'),
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        };
      }
      case 'kb_chunk': {
        const row = this.db.select().from(schema.kbChunks)
          .where(and(eq(schema.kbChunks.workspaceId, workspaceId), eq(schema.kbChunks.id, node.atomId)))
          .get();
        if (!row) return null;
        const metadata = parseJsonRecord(row.metadata);
        const document = this.db.select({ name: schema.kbDocuments.name, archivedAt: schema.kbDocuments.archivedAt }).from(schema.kbDocuments)
          .where(and(eq(schema.kbDocuments.workspaceId, workspaceId), eq(schema.kbDocuments.id, row.documentId)))
          .get();
        if (!document || document.archivedAt) return null;
        const metadataSource = typeof metadata.source === 'string' ? metadata.source : null;
        return {
          content: row.content,
          source: document?.name ?? metadataSource ?? 'Knowledge document',
          createdAt: row.createdAt,
          updatedAt: row.createdAt,
        };
      }
    }
  }

  private provenanceForAtom(workspaceId: string, node: BrainGraphNode) {
    const detail = this.getAtomDetail(workspaceId, node);
    const agentId = detail?.agentId ?? node.agentId ?? null;
    const agent = agentId ? this.resolveAgent(workspaceId, agentId) : null;
    const metadataProvenance = parseJsonRecord(node.metadata.provenance);
    const createdByFromProvenance = typeof metadataProvenance.userDisplayName === 'string' && metadataProvenance.userDisplayName.trim()
      ? metadataProvenance.userDisplayName.trim()
      : null;
    return {
      createdBy: agent?.name ?? createdByFromProvenance ?? creatorLabelFor(node.atomKind, detail?.source),
      agentId,
      adapterType: node.adapterType ?? agent?.adapterType ?? null,
      createdAt: detail?.createdAt ?? node.createdAt,
      updatedAt: detail?.updatedAt ?? node.updatedAt,
      source: detail?.source ?? sourceLabel(node.metadata.source, 'Agent output'),
      reinforced: node.reinforceCount,
    };
  }

  private usedByForAtom(workspaceId: string, node: BrainGraphNode): BrainUsageSummary[] {
    const detail = this.getAtomDetail(workspaceId, node);
    const out: BrainUsageSummary[] = [];
    const agentId = detail?.agentId ?? node.agentId ?? null;
    if (agentId) {
      const agent = this.resolveAgent(workspaceId, agentId);
      out.push({
        id: agentId,
        type: 'agent',
        name: agent?.name ?? `Agent ${agentId.slice(0, 8)}`,
        count: Math.max(1, node.reinforceCount),
      });
    }

    let workflowId = detail?.workflowId ?? null;
    const runId = detail?.runId ?? node.runId ?? null;
    if (!workflowId && runId) {
      const run = this.db.select({ workflowId: schema.workflowRuns.workflowId }).from(schema.workflowRuns)
        .where(and(eq(schema.workflowRuns.workspaceId, workspaceId), eq(schema.workflowRuns.id, runId)))
        .get();
      workflowId = run?.workflowId ?? null;
    }
    if (workflowId) {
      const workflow = this.db.select({ title: schema.workflows.title }).from(schema.workflows)
        .where(and(eq(schema.workflows.workspaceId, workspaceId), eq(schema.workflows.id, workflowId)))
        .get();
      out.push({
        id: workflowId,
        type: 'workflow',
        name: workflow?.title ?? `Workflow ${workflowId.slice(0, 8)}`,
        count: 1,
      });
    }
    return out;
  }

  private deleteLinksForAtom(workspaceId: string, kind: KnowledgeAtomKind, id: string): void {
    this.db.delete(schema.knowledgeLinks)
      .where(and(
        eq(schema.knowledgeLinks.workspaceId, workspaceId),
        or(
          and(eq(schema.knowledgeLinks.sourceKind, kind), eq(schema.knowledgeLinks.sourceId, id)),
          and(eq(schema.knowledgeLinks.targetKind, kind), eq(schema.knowledgeLinks.targetId, id)),
        )!,
      ))
      .run();
  }

  private reinforceAtom(
    workspaceId: string,
    kind: KnowledgeAtomKind,
    id: string,
    provenance: { agentId?: string | null; adapterType?: string | null; runId?: string | null; scopeId?: string | null },
  ): BrainGraphNode | null {
    if (kind === 'episode') {
      const updated = this.episodes.reinforce(workspaceId, id, { confidenceDelta: 0.06, trustDelta: 0.04 });
      if (!updated) return null;
      return episodeToGraphNode(updated, 2);
    }

    if (kind === 'memory') {
      const row = this.db.select().from(schema.workspaceMemory)
        .where(and(eq(schema.workspaceMemory.workspaceId, workspaceId), eq(schema.workspaceMemory.id, id)))
        .get();
      if (!row) return null;
      const now = new Date().toISOString();
      const trust = clamp01(Number(row.trust) + 0.04);
      const globalConfidence = clamp01(Number(row.globalConfidence ?? 0) + (1 - Number(row.globalConfidence ?? 0)) * 0.15);
      this.db.update(schema.workspaceMemory)
        .set({
          trust: String(trust),
          globalConfidence: String(globalConfidence),
          adapterType: provenance.adapterType ?? row.adapterType ?? null,
          reinforcedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.workspaceMemory.id, id))
        .run();
      return memoryRowToGraphNode({ ...row, trust: String(trust), globalConfidence: String(globalConfidence), adapterType: provenance.adapterType ?? row.adapterType, reinforcedAt: now, updatedAt: now }, 2);
    }

    return this.loadAtomById(workspaceId, kind, id)?.node ?? null;
  }

  private findBestSimilar(atoms: AtomCandidate[], fact: string): SimilarAtom | null {
    let best: SimilarAtom | null = null;
    for (const atom of atoms) {
      const score = similarity(fact, atom.text);
      if (!best || score > best.score) best = { atom, score };
    }
    return best;
  }

  private loadAtoms(workspaceId: string, options: BrainGraphOptions): AtomCandidate[] {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_GRAPH_LIMIT, 1), MAX_GRAPH_LIMIT);
    const perKind = Math.max(12, Math.ceil(limit / 4));
    const scopeId = options.scopeId ?? null;
    const scope = options.scope ?? 'workspace';
    const includeWorkspace = options.includeWorkspace ?? scope !== 'scoped';
    const kindFilter = options.kinds && options.kinds.length > 0 ? new Set(options.kinds) : null;
    const minConfidence = clamp01(options.minConfidence ?? 0);
    const out: AtomCandidate[] = [];

    if (!kindFilter || kindFilter.has('episode')) {
      const rows = this.db.select().from(schema.memoryEpisodes)
        .where(and(
          eq(schema.memoryEpisodes.workspaceId, workspaceId),
          isNull(schema.memoryEpisodes.archivedAt),
          // Hide unconsolidated episodic traces (staged run output + outcome
          // markers) from the graph — only formed/durable memory is shown.
          sql`${schema.memoryEpisodes.tags} NOT LIKE '%unconsolidated%'`,
          ...(scope === 'scoped' && scopeId
            ? [includeWorkspace ? or(eq(schema.memoryEpisodes.scopeId, scopeId), isNull(schema.memoryEpisodes.scopeId))! : eq(schema.memoryEpisodes.scopeId, scopeId)]
            : []),
        ))
        .orderBy(desc(schema.memoryEpisodes.updatedAt))
        .limit(perKind)
        .all();
      for (const row of rows) {
        const node = episodeRowToGraphNode(row, 1);
        if (node.confidence >= minConfidence) out.push({ id: row.id, kind: 'episode', text: `${row.title}\n${row.summary}\n${row.details ?? ''}`, node });
      }
    }

    if (!kindFilter || kindFilter.has('memory')) {
      const rows = this.db.select().from(schema.workspaceMemory)
        .where(and(
          eq(schema.workspaceMemory.workspaceId, workspaceId),
	          ...(scope === 'scoped' && scopeId
	            ? [includeWorkspace ? or(eq(schema.workspaceMemory.scopeId, scopeId), isNull(schema.workspaceMemory.scopeId), eq(schema.workspaceMemory.scopeId, ''))! : eq(schema.workspaceMemory.scopeId, scopeId)]
	            : []),
        ))
        .orderBy(desc(schema.workspaceMemory.updatedAt))
        .limit(perKind)
        .all();
      for (const row of rows) {
        const node = memoryRowToGraphNode(row, 1);
        if (node.confidence >= minConfidence) out.push({ id: row.id, kind: 'memory', text: `${row.title}\n${row.content}`, node });
      }
    }

    if (!kindFilter || kindFilter.has('pattern')) {
      const rows = this.db.select().from(schema.promotedPatterns)
        .where(and(
          eq(schema.promotedPatterns.workspaceId, workspaceId),
	          ...(scope === 'scoped' && scopeId
	            ? [includeWorkspace ? or(eq(schema.promotedPatterns.scopeId, scopeId), isNull(schema.promotedPatterns.scopeId))! : eq(schema.promotedPatterns.scopeId, scopeId)]
	            : []),
        ))
        .orderBy(desc(schema.promotedPatterns.updatedAt))
        .limit(perKind)
        .all();
      for (const row of rows) {
        const node = patternRowToGraphNode(row);
        if (node.confidence >= minConfidence) out.push({ id: row.id, kind: 'pattern', text: `${row.title}\n${row.summary}`, node });
      }
    }

    if (!kindFilter || kindFilter.has('knowledge_chunk')) {
      const rows = this.db.select().from(schema.knowledgeChunks)
        .where(and(
          eq(schema.knowledgeChunks.workspaceId, workspaceId),
	          ...(scope === 'scoped' && scopeId
	            ? [includeWorkspace ? or(eq(schema.knowledgeChunks.scopeId, scopeId), isNull(schema.knowledgeChunks.scopeId))! : eq(schema.knowledgeChunks.scopeId, scopeId)]
	            : []),
        ))
        .orderBy(desc(schema.knowledgeChunks.updatedAt))
        .limit(perKind)
        .all();
      for (const row of rows) {
        const node = knowledgeChunkRowToGraphNode(row);
        if (node.confidence >= minConfidence) out.push({ id: row.id, kind: 'knowledge_chunk', text: `${row.title}\n${row.content}`, node });
      }
    }

    if ((!kindFilter || kindFilter.has('kb_chunk')) && scope === 'workspace') {
      const rows = this.db.select().from(schema.kbChunks)
        .where(eq(schema.kbChunks.workspaceId, workspaceId))
        .orderBy(desc(schema.kbChunks.createdAt))
        .limit(perKind)
        .all();
      for (const row of rows) {
        if (!this.isKbDocumentActive(workspaceId, row.documentId)) continue;
        const node = kbChunkRowToGraphNode(row);
        if (node.confidence >= minConfidence) out.push({ id: row.id, kind: 'kb_chunk', text: row.content, node });
      }
    }

    return out;
  }

  private loadAtomById(workspaceId: string, kind: KnowledgeAtomKind, id: string): AtomCandidate | null {
    switch (kind) {
      case 'episode': {
        const row = this.db.select().from(schema.memoryEpisodes)
          .where(and(eq(schema.memoryEpisodes.workspaceId, workspaceId), eq(schema.memoryEpisodes.id, id)))
          .get();
        if (!row) return null;
        const node = episodeRowToGraphNode(row, 1);
        return { id: row.id, kind, text: `${row.title}\n${row.summary}\n${row.details ?? ''}`, node };
      }
      case 'memory': {
        const row = this.db.select().from(schema.workspaceMemory)
          .where(and(eq(schema.workspaceMemory.workspaceId, workspaceId), eq(schema.workspaceMemory.id, id)))
          .get();
        if (!row) return null;
        const node = memoryRowToGraphNode(row, 1);
        return { id: row.id, kind, text: `${row.title}\n${row.content}`, node };
      }
      case 'pattern': {
        const row = this.db.select().from(schema.promotedPatterns)
          .where(and(eq(schema.promotedPatterns.workspaceId, workspaceId), eq(schema.promotedPatterns.id, id)))
          .get();
        if (!row) return null;
        const node = patternRowToGraphNode(row);
        return { id: row.id, kind, text: `${row.title}\n${row.summary}`, node };
      }
      case 'knowledge_chunk': {
        const row = this.db.select().from(schema.knowledgeChunks)
          .where(and(eq(schema.knowledgeChunks.workspaceId, workspaceId), eq(schema.knowledgeChunks.id, id)))
          .get();
        if (!row) return null;
        const node = knowledgeChunkRowToGraphNode(row);
        return { id: row.id, kind, text: `${row.title}\n${row.content}`, node };
      }
      case 'kb_chunk': {
        const row = this.db.select().from(schema.kbChunks)
          .where(and(eq(schema.kbChunks.workspaceId, workspaceId), eq(schema.kbChunks.id, id)))
          .get();
        if (!row) return null;
        if (!this.isKbDocumentActive(workspaceId, row.documentId)) return null;
        const node = kbChunkRowToGraphNode(row);
        return { id: row.id, kind, text: row.content, node };
      }
    }
  }

  private isKbDocumentActive(workspaceId: string, documentId: string): boolean {
    const document = this.db.select({ archivedAt: schema.kbDocuments.archivedAt })
      .from(schema.kbDocuments)
      .where(and(eq(schema.kbDocuments.workspaceId, workspaceId), eq(schema.kbDocuments.id, documentId)))
      .get();
    return Boolean(document && !document.archivedAt);
  }

  private resolveAgent(workspaceId: string, agentId: string): { id: string; name: string; adapterType: string } | null {
    const row = this.db.select({ id: schema.agents.id, name: schema.agents.name, adapterType: schema.agents.adapterType })
      .from(schema.agents)
      .where(and(eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.id, agentId)))
      .get();
    return row ?? null;
  }

  private publishAtom(workspaceId: string, event: typeof REALTIME_EVENTS.BRAIN_ATOM_CREATED | typeof REALTIME_EVENTS.BRAIN_ATOM_REINFORCED, node: BrainGraphNode): void {
    this.bus.publish(REALTIME_ROOMS.workspace(workspaceId), event, {
      workspaceId,
      scopeId: node.scopeId ?? null,
      node,
    });
  }

  private publishLink(workspaceId: string, link: BrainGraphLink): void {
    this.bus.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.BRAIN_LINK_CREATED, {
      workspaceId,
      scopeId: link.scopeId ?? null,
      link,
    });
  }
}

function linkRowToGraph(row: typeof schema.knowledgeLinks.$inferSelect): BrainGraphLink {
  const sourceKind = row.sourceKind as KnowledgeAtomKind;
  const targetKind = row.targetKind as KnowledgeAtomKind;
  return {
    id: row.id,
    source: atomKey(sourceKind, row.sourceId),
    target: atomKey(targetKind, row.targetId),
    sourceAtomId: row.sourceId,
    sourceKind,
    targetAtomId: row.targetId,
    targetKind,
    relation: row.relation as KnowledgeLinkRelation,
    confidence: Number(row.confidence) || 0.5,
    reinforceCount: row.reinforceCount ?? 1,
    agentId: row.agentId,
    adapterType: row.adapterType,
    scopeId: row.scopeId,
    runId: row.runId,
    contextSplit: Boolean(row.contextSplit),
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function episodeToGraphNode(row: ReturnType<EpisodicMemoryStore['write']>, reinforceCount: number): BrainGraphNode {
  return {
    id: atomKey('episode', row.id),
    atomId: row.id,
    atomKind: 'episode',
    label: row.title,
    summary: row.summary,
    confidence: clamp01(row.confidence),
    trust: row.trust,
    reinforceCount,
    agentId: row.agentId ?? null,
    adapterType: typeof row.metadata.adapterType === 'string' ? row.metadata.adapterType : null,
    scopeId: row.scopeId ?? null,
    runId: row.runId ?? null,
    isDisputed: Boolean(row.metadata.disputed),
    status: 'active',
    managed: true,
    pinnedAt: null,
    lastAccessedAt: null,
    compressedFrom: null,
    compressionTier: null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    metadata: {
      ...row.metadata,
      type: row.type,
      source: row.source,
      tags: row.tags,
      outcomeStatus: row.outcomeStatus ?? null,
      workflowId: row.workflowId ?? null,
    },
  };
}

function episodeRowToGraphNode(row: typeof schema.memoryEpisodes.$inferSelect, reinforceCount: number): BrainGraphNode {
  const metadata = parseJsonRecord(row.metadata);
  return {
    id: atomKey('episode', row.id),
    atomId: row.id,
    atomKind: 'episode',
    label: row.title,
    summary: row.summary,
    confidence: clamp01(Number(row.confidence)),
    trust: Number(row.trust),
    reinforceCount,
    agentId: row.agentId,
    adapterType: typeof metadata.adapterType === 'string' ? metadata.adapterType : null,
    scopeId: row.scopeId,
    runId: row.runId,
    isDisputed: Boolean(row.isDisputed),
    isStale: isStale(row.updatedAt),
    status: row.status,
    managed: Boolean(row.managed),
    pinnedAt: row.pinnedAt,
    lastAccessedAt: row.lastAccessedAt,
    disputeReason: row.disputeReason,
    disputeResolvedAt: row.disputeResolvedAt,
    disputeSnoozedUntil: row.disputeSnoozedUntil,
    contextCondition: row.contextCondition,
    compressedFrom: parseJsonArray<string>(row.compressedFrom),
    compressionTier: row.compressionTier,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    metadata: {
      ...metadata,
      type: row.type,
      source: row.source,
      tags: parseJsonArray<string>(row.tags),
      outcomeStatus: row.outcomeStatus ?? null,
      workflowId: row.workflowId ?? null,
    },
  };
}

function memoryRowToGraphNode(row: typeof schema.workspaceMemory.$inferSelect, reinforceCount: number): BrainGraphNode {
  const trust = clamp01(Number(row.trust));
  const globalConfidence = clamp01(Number(row.globalConfidence ?? 0));
  return {
    id: atomKey('memory', row.id),
    atomId: row.id,
    atomKind: 'memory',
    label: row.title,
    summary: row.content,
    confidence: Math.max(globalConfidence, trust * 0.85),
    trust,
    reinforceCount,
    adapterType: row.adapterType,
    scopeId: row.scopeId,
    isStale: isStale(row.updatedAt),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    metadata: {
      kind: row.kind,
      source: row.source,
      tags: parseJsonArray<string>(row.tags),
      provenance: parseJsonRecord(row.provenance),
      globalConfidence,
      workspaceGlobal: globalConfidence >= GLOBAL_CONFIDENCE_THRESHOLD,
    },
  };
}

function patternRowToGraphNode(row: typeof schema.promotedPatterns.$inferSelect): BrainGraphNode {
  return {
    id: atomKey('pattern', row.id),
    atomId: row.id,
    atomKind: 'pattern',
    label: row.title,
    summary: row.summary,
    confidence: clamp01(Number(row.confidence)),
    trust: Number(row.trust),
    reinforceCount: row.evidenceCount,
    scopeId: row.scopeId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    metadata: {
      kind: row.kind,
      provenance: parseJsonRecord(row.provenance),
      evidenceCount: row.evidenceCount,
    },
  };
}

function knowledgeChunkRowToGraphNode(row: typeof schema.knowledgeChunks.$inferSelect): BrainGraphNode {
  return {
    id: atomKey('knowledge_chunk', row.id),
    atomId: row.id,
    atomKind: 'knowledge_chunk',
    label: row.title,
    summary: truncate(row.content, 180),
    confidence: clamp01(Number(row.trust)),
    trust: Number(row.trust),
    reinforceCount: 1,
    scopeId: row.scopeId,
    isStale: isStale(row.updatedAt),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    metadata: {
      source: row.source,
      tags: parseJsonArray<string>(row.tags),
      provenance: parseJsonRecord(row.provenance),
    },
  };
}

function kbChunkRowToGraphNode(row: typeof schema.kbChunks.$inferSelect): BrainGraphNode {
  const metadata = parseJsonRecord(row.metadata);
  const source = typeof metadata.source === 'string' ? metadata.source : 'Knowledge document';
  return {
    id: atomKey('kb_chunk', row.id),
    atomId: row.id,
    atomKind: 'kb_chunk',
    label: source,
    summary: truncate(row.content, 180),
    confidence: 0.82,
    trust: 0.82,
    reinforceCount: 1,
    createdAt: row.createdAt,
    updatedAt: row.createdAt,
    metadata: {
      ...metadata,
      documentId: row.documentId,
      knowledgeBaseId: row.knowledgeBaseId,
      chunkIndex: row.chunkIndex,
      tokenCount: row.tokenCount,
    },
  };
}

function coreNode(workspaceId: string, scope: BrainGraphScope, scopeId: string | null): BrainGraphNode {
  const now = new Date().toISOString();
  return {
    id: 'core',
    atomId: 'core',
    atomKind: 'core',
    label: scope === 'scoped' ? 'Scoped brain' : 'Workspace brain',
    summary: 'Collective intelligence shared by every agent adapter',
    confidence: 1,
    trust: 1,
    reinforceCount: 1,
    scopeId,
    createdAt: now,
    updatedAt: now,
    metadata: { workspaceId, scope },
  };
}

function atomVisibleInScope(node: BrainGraphNode, scopeId: string): boolean {
  return !node.scopeId || node.scopeId === scopeId;
}

function atomAllowedInGraph(node: BrainGraphNode, scope: BrainGraphScope, scopeId: string | null, includeWorkspace: boolean): boolean {
  if (scope !== 'scoped' || !scopeId) return true;
  if (node.scopeId === scopeId) return true;
  return includeWorkspace && !node.scopeId;
}

function creatorLabelFor(kind: BrainGraphNode['atomKind'], source?: string | null): string {
  if (kind === 'core') return 'Agentis';
  if (source) {
    if (/operator/i.test(source)) return 'Operator';
    if (/seed/i.test(source)) return 'Seeded knowledge';
    if (/promotion|agent output|agent|run/i.test(source)) return 'Agent output';
    if (/system/i.test(source)) return 'System';
    if (/document|import|knowledge/i.test(source)) return 'Knowledge import';
  }
  if (kind === 'kb_chunk' || kind === 'knowledge_chunk') return 'Knowledge import';
  return 'Agent output';
}

function sourceLabel(source: unknown, fallback: string): string {
  if (typeof source !== 'string' || source.trim().length === 0) return fallback;
  switch (source) {
    case 'kb_chunk': return 'Knowledge document';
    case 'knowledge_chunk': return 'Knowledge chunk';
    case 'seed': return 'Seeded knowledge';
    case 'import': return 'Knowledge import';
    case 'promotion': return 'Promotion';
    case 'operator':
    case 'operator_write': return 'Operator';
    case 'agent_write':
    case 'run_promotion': return 'Agent output';
    case 'evaluator_write': return 'Evaluator';
    case 'system_write': return 'System';
    case 'harness_ingest': return 'Harness import';
    default: return source.replace(/_/g, ' ');
  }
}

// Accepts the widened link-kind union; cora_* kinds never resolve to atoms
// here (the organizational overlay is served by /v1/cora/graph), so their
// keys simply never match and the links filter out.
function atomKey(kind: KnowledgeAtomKind | 'cora_source' | 'cora_entity' | 'cora_claim', id: string): string {
  return `${kind}:${id}`;
}

/**
 * Extract candidate facts from agent task output.
 *
 * BL11a interim fix: agent outputs are Markdown with code blocks, JSON
 * payloads, and reasoning traces. Splitting on `. ` inside JSON is
 * catastrophically wrong, so fenced code and JSON blocks are stripped before
 * sentence splitting. The max-6 cap is gone (it silently dropped facts), the
 * length window is widened (25–500 chars) so short high-value rules like
 * "Never use em dashes" survive.
 */
/**
 * Legacy synchronous extractor (used by `extractAndPromote`). Now delegates to
 * the hardened deterministic formation gate so the sync path benefits from the
 * same garbage rejection as `promote()`. Returns plain statement strings.
 */
function extractPromotableFacts(value: unknown): string[] {
  return extractCandidateStatements(value).map((c) => c.text);
}

/** One-line outcome marker for a transient (episodic_only) run. */
function episodicMarkerSummary(input: CollectiveCognitivePromotionInput): string | null {
  const flat = extractFlatText(input.taskOutput);
  const firstSentence = flat
    .split(/(?:\r?\n|(?<=[.!?])\s+)/)
    .map((s) => s.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s+)/, '').trim().replace(/\s+/g, ' '))
    .find((s) => s.length >= 8 && s.length <= 180);
  const label = input.taskTitle?.trim() || 'Task';
  if (firstSentence) return truncate(`${label} ran — ${firstSentence}`, 200);
  return `${truncate(label, 160)} ran.`;
}

/** Flatten output to plain text (used only by the marker summarizer). */
function extractFlatText(value: unknown, depth = 0): string {
  if (depth > 4 || value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return '';
  if (Array.isArray(value)) return value.map((e) => extractFlatText(e, depth + 1)).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    const out: string[] = [];
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (/token|secret|password|authorization|cookie/i.test(key)) continue;
      const t = extractFlatText(entry, depth + 1);
      if (t) out.push(t);
    }
    return out.join('\n');
  }
  return '';
}

/** ISO timestamp `days` in the future — used for episodic-trace TTL. */
function ttlIso(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

/** Outcome polarity for a judged episode type. */
function outcomeFor(type: RuntimeEpisodeType): 'good' | 'bad' | 'mixed' {
  if (type === 'failure') return 'bad';
  if (type === 'success_pattern' || type === 'recovery') return 'good';
  return 'mixed';
}

function titleFromFact(fact: string): string {
  const clean = fact.replace(/^[-*\d.)\s]+/, '').trim();
  return truncate(clean, 92);
}

function relationFor(fact: string, target: string): KnowledgeLinkRelation {
  const lower = `${fact}\n${target}`.toLowerCase();
  if (/contradict|instead|not true|actually|but actual|differs|mismatch/.test(lower)) return 'contradicts';
  if (/because|therefore|derived|from/.test(lower)) return 'derived_from';
  return 'refines';
}

interface EpisodeVector {
  id: string;
  vec: number[] | null;
  text: string;
}

interface ScoredEpisode {
  entry: EpisodeVector;
  score: number;
}

/** Best cosine match among episodes that carry a comparable embedding. */
function bestCosine(entries: EpisodeVector[], vec: number[]): ScoredEpisode | null {
  let best: ScoredEpisode | null = null;
  for (const entry of entries) {
    if (!entry.vec || entry.vec.length !== vec.length) continue;
    const score = cosineSimilarity(vec, entry.vec);
    if (!best || score > best.score) best = { entry, score };
  }
  return best;
}

/** Lexical fallback when no embedding is available for a candidate. */
function bestLexical(entries: EpisodeVector[], fact: string): ScoredEpisode | null {
  let best: ScoredEpisode | null = null;
  for (const entry of entries) {
    const score = similarity(fact, entry.text);
    if (!best || score > best.score) best = { entry, score };
  }
  return best;
}

/** Parse a stored embedding column (JSON array or already-parsed array). */
function parseEmbedding(raw: unknown): number[] | null {
  if (Array.isArray(raw)) return raw.every((n) => typeof n === 'number') ? (raw as number[]) : null;
  if (typeof raw !== 'string') return null;
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) && value.every((n) => typeof n === 'number') ? value : null;
  } catch {
    return null;
  }
}

function similarity(a: string, b: string): number {
  const aTokens = new Set(tokenize(a));
  const bTokens = new Set(tokenize(b));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of aTokens) if (bTokens.has(token)) overlap += 1;
  const union = new Set([...aTokens, ...bTokens]).size;
  const jaccard = overlap / union;
  const containment = overlap / Math.min(aTokens.size, bTokens.size);
  return jaccard * 0.65 + containment * 0.35;
}

function tokenize(input: string): string[] {
  const out: string[] = [];
  const cleaned = input.toLowerCase().replace(/[^a-z0-9_\s]+/g, ' ');
  for (const raw of cleaned.split(/\s+/)) {
    if (!raw || raw.length < 2 || STOP_WORDS.has(raw)) continue;
    out.push(raw);
  }
  return out;
}

function uniqueByNormalized(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = tokenize(item).slice(0, 18).join(' ');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function compactValue(value: unknown): unknown {
  if (value == null || typeof value !== 'object') return value ?? null;
  if (Array.isArray(value)) return { type: 'array', count: value.length };
  return { type: 'object', keys: Object.keys(value as Record<string, unknown>).slice(0, 8) };
}

function latestActivity(nodes: BrainGraphNode[], links: BrainGraphLink[]): string | null {
  let latest = 0;
  for (const node of nodes) latest = Math.max(latest, Date.parse(node.updatedAt) || 0);
  for (const link of links) latest = Math.max(latest, Date.parse(link.updatedAt) || 0);
  return latest > 0 ? new Date(latest).toISOString() : null;
}

function scoreNode(node: BrainGraphNode): number {
  return node.confidence * 3 + Math.log1p(node.reinforceCount) + Date.parse(node.updatedAt) / 10_000_000_000_000;
}

function isStale(iso: string): boolean {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return false;
  return Date.now() - at > 1000 * 60 * 60 * 24 * 90;
}

function synthesizePreTaskContext(texts: string[]): string {
  const rules = texts
    .map((text) => text.split('\n').map((line) => line.trim()).filter(Boolean).join(' - '))
    .filter(Boolean)
    .slice(0, 3);
  if (rules.length === 0) return '- No stable prior signal matched this task.';
  return rules.map((rule) => `- Carry forward: ${truncate(rule, 180)}`).join('\n');
}

function summarizeRows(rows: Array<typeof schema.memoryEpisodes.$inferSelect>) {
  const count = rows.length;
  const totalConfidence = rows.reduce((sum, row) => sum + clamp01(Number(row.confidence)), 0);
  const text = rows.map((row) => `${row.title} ${row.summary}`).join('\n');
  return {
    count,
    averageConfidence: count === 0 ? 0 : totalConfidence / count,
    capacityTokens: estimateTokens(text),
  };
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function disputeAtom(row: typeof schema.memoryEpisodes.$inferSelect) {
  return {
    id: row.id,
    title: row.title,
    content: row.summary,
    confidence: clamp01(Number(row.confidence)),
    reinforceCount: 1,
    source: row.source,
    tags: parseJsonArray<string>(row.tags),
    contextCondition: row.contextCondition,
    disputeSnoozedUntil: row.disputeSnoozedUntil,
    updatedAt: row.updatedAt,
  };
}

function mergeDisputeContent(a: string, b: string): string {
  if (a.trim() === b.trim()) return a.trim();
  return `Context-aware synthesis: ${a.trim()} In a different context, ${b.trim()}`;
}

function parseJsonArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (typeof raw !== 'string') return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value as T[] : [];
  } catch {
    return [];
  }
}

function parseJsonRecord(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return `${input.slice(0, Math.max(0, max - 1))}...`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
