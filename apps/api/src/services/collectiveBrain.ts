import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import {
  REALTIME_EVENTS,
  REALTIME_ROOMS,
  type BrainGraph,
  type BrainGraphLink,
  type BrainGraphNode,
  type BrainGraphScope,
  type KnowledgeAtomKind,
  type KnowledgeLinkRelation,
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

export interface CollectiveBrainPromotionInput {
  workspaceId: string;
  workflowId?: string | null;
  runId?: string | null;
  nodeId?: string | null;
  agentId?: string | null;
  adapterType?: string | null;
  appId?: string | null;
  taskInput?: unknown;
  taskOutput: unknown;
}

export interface BrainGraphOptions {
  scope?: BrainGraphScope;
  appId?: string | null;
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
  appId?: string | null;
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
  appId: string | null;
  tags: string[];
  status?: string | null;
  managed?: boolean | null;
  updatedAt: string;
}

export interface BrainSummary {
  workspaceBrain: { count: number; averageConfidence: number; capacityTokens: number };
  appBrain: { count: number; averageConfidence: number; capacityTokens: number };
  sessionAtoms: { count: number; capacityTokens: number };
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
const EMBED_RELATED_SIMILARITY = 0.62;
/** Minimum cosine relevance for an atom to enter a dispatch context block. */
const DISPATCH_MIN_RELEVANCE = 0.32;
/** Evaluator → brain confidence deltas (Gap14). */
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

export class CollectiveBrainService {
  /** Per-workspace embedding provider cache (resolved from workspace config). */
  readonly #embeddingProviders = new Map<string, EmbeddingProvider>();

  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly bus: EventBus,
    private readonly episodes: EpisodicMemoryStore,
    private readonly logger: Logger,
  ) {}

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
   * Embedding-aware promotion (B4 + B10). The durable queue worker calls this
   * — unlike the synchronous `extractAndPromote`, it uses real semantic
   * embeddings so paraphrased duplicates reinforce rather than fork the graph.
   */
  async promote(input: CollectiveBrainPromotionInput): Promise<{ created: number; reinforced: number; linked: number }> {
    const facts = extractPromotableFacts(input.taskOutput);
    if (facts.length === 0) return { created: 0, reinforced: 0, linked: 0 };

    const provider = this.#resolveEmbeddingProvider(input.workspaceId);
    const resolvedAgent = input.agentId ? this.resolveAgent(input.workspaceId, input.agentId) : null;
    const adapterType = input.adapterType ?? resolvedAgent?.adapterType ?? null;
    const existing = this.#loadEpisodeVectors(input.workspaceId, input.appId ?? null);

    let created = 0;
    let reinforced = 0;
    let linked = 0;

    for (const fact of facts) {
      let vec: number[] | null = null;
      try {
        vec = await embedText(provider, fact);
      } catch (err) {
        this.logger.warn('collective_brain.embed.failed', {
          workspaceId: input.workspaceId,
          message: (err as Error).message,
        });
      }

      const best = vec ? bestCosine(existing, vec) : bestLexical(existing, fact);
      if (best && best.score >= EMBED_HIGH_SIMILARITY) {
        const node = this.reinforceAtom(input.workspaceId, 'episode', best.entry.id, {
          agentId: input.agentId ?? null,
          adapterType,
          runId: input.runId ?? null,
          appId: input.appId ?? null,
        });
        if (node) {
          reinforced += 1;
          this.publishAtom(input.workspaceId, REALTIME_EVENTS.BRAIN_ATOM_REINFORCED, node);
        }
        continue;
      }

      const episode = this.episodes.write({
        workspaceId: input.workspaceId,
        appId: input.appId ?? null,
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
          embeddingProvider: provider.dimension,
        },
      });
      created += 1;

      if (vec) {
        this.db.update(schema.memoryEpisodes)
          .set({ embedding: vec as unknown as null })
          .where(eq(schema.memoryEpisodes.id, episode.id))
          .run();
      }

      const createdNode = episodeToGraphNode(episode, 1);
      this.publishAtom(input.workspaceId, REALTIME_EVENTS.BRAIN_ATOM_CREATED, createdNode);
      existing.push({ id: episode.id, vec, text: `${episode.title}\n${episode.summary}` });

      if (best && best.score >= EMBED_RELATED_SIMILARITY) {
        const link = this.createLink({
          workspaceId: input.workspaceId,
          sourceId: episode.id,
          sourceKind: 'episode',
          targetId: best.entry.id,
          targetKind: 'episode',
          relation: relationFor(fact, best.entry.text),
          confidence: Math.max(0.45, Math.min(0.85, best.score)),
          agentId: input.agentId ?? null,
          adapterType,
          runId: input.runId ?? null,
          appId: input.appId ?? null,
        });
        linked += link ? 1 : 0;
      }
    }

    if (created || reinforced || linked) {
      this.logger.info('collective_brain.promote.applied', {
        workspaceId: input.workspaceId,
        runId: input.runId,
        provider: provider.dimension,
        created,
        reinforced,
        linked,
      });
    }
    return { created, reinforced, linked };
  }

  /**
   * Build the frozen brain context block injected at agent dispatch (B2 + B7).
   * Records an `atom_injected` quality event per atom so the evaluator
   * feedback loop (Gap14) can later find which atoms shaped the run.
   */
  async buildDispatchContext(args: {
    workspaceId: string;
    appId?: string | null;
    agentId?: string | null;
    runId?: string | null;
    taskDescription: string;
    limit?: number;
  }): Promise<{ block: string; atomIds: string[] }> {
    const limit = Math.min(Math.max(args.limit ?? 6, 1), 12);
    const appId = args.appId ?? null;
    const embeddingStatus = this.embeddingStatus(args.workspaceId);
    if (embeddingStatus.retrievalPaused) {
      return {
        block: `WORKSPACE BRAIN [embedding migration running | retrieval paused | capacity: ${this.#capacityStatus(args.workspaceId).percent}%]\nBrain retrieval is paused while atoms are re-embedded for the configured provider.`,
        atomIds: [],
      };
    }
    const provider = this.#resolveEmbeddingProvider(args.workspaceId);
    const episodes = this.#loadEpisodeVectors(args.workspaceId, appId);
    if (episodes.length === 0) return { block: '', atomIds: [] };

    let queryVec: number[] | null = null;
    try {
      queryVec = await embedText(provider, args.taskDescription);
    } catch {
      queryVec = null;
    }

    const ranked = episodes
      .map((entry) => ({
        entry,
        score: queryVec && entry.vec
          ? cosineSimilarity(queryVec, entry.vec)
          : similarity(args.taskDescription, entry.text),
      }))
      .filter((r) => r.score >= DISPATCH_MIN_RELEVANCE)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    if (ranked.length === 0) return { block: '', atomIds: [] };

    const now = new Date().toISOString();
    const atomIds: string[] = [];
    const lines: string[] = [];
    for (const { entry } of ranked) {
      atomIds.push(entry.id);
      lines.push(`- ${entry.text.split('\n').join(' — ')}`);
      this.db.update(schema.memoryEpisodes)
        .set({ lastAccessedAt: now })
        .where(eq(schema.memoryEpisodes.id, entry.id))
        .run();
      this.recordQualityEvent({
        workspaceId: args.workspaceId,
        appId,
        agentId: args.agentId ?? null,
        runId: args.runId ?? null,
        eventType: 'atom_injected',
        atomId: entry.id,
      });
    }

    const scopeLabel = appId ? 'app + workspace' : 'workspace';
    const capacity = this.#capacityStatus(args.workspaceId);
    const degradedPrefix = embeddingStatus.degraded ? 'degraded - hashing embeddings | ' : '';
    const header = `WORKSPACE BRAIN [${degradedPrefix}${ranked.length} of ${episodes.length} atoms | scope: ${scopeLabel} | retrieval: ${queryVec ? 'semantic' : 'lexical'} | capacity: ${capacity.percent}%${capacity.recommended ? ' - compression recommended' : ''}]`;
    const synthesis = synthesizePreTaskContext(ranked.map((r) => r.entry.text));
    const block = `${header}\nPRE-TASK SYNTHESIS\n${synthesis}\n\nRelevant knowledge from past runs - apply it, but verify against the current task:\n${lines.join('\n')}`;
    return { block, atomIds };
  }

  /**
   * Evaluator → brain feedback loop (Gap14). At verdict time, look up which
   * atoms were injected into the run and nudge their confidence. This is the
   * gradient that makes the brain self-regulating rather than write-only.
   */
  applyEvaluatorVerdict(args: {
    workspaceId: string;
    runId: string;
    appId?: string | null;
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
      const row = this.db.select().from(schema.memoryEpisodes)
        .where(and(eq(schema.memoryEpisodes.workspaceId, args.workspaceId), eq(schema.memoryEpisodes.id, atomId)))
        .get();
      if (!row) return;
      let delta = args.verdict === 'pass' ? EVAL_DELTA_PASS : EVAL_DELTA_FAIL;
      if (strongPass && index < 3) delta = EVAL_DELTA_PASS_TOP;
      const next = clamp01(Number(row.confidence) + delta);
      const now = new Date().toISOString();
      const archiveIt = next < ARCHIVE_CONFIDENCE_FLOOR && row.managed;
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
        appId: args.appId ?? null,
        agentId: args.agentId ?? null,
        runId: args.runId,
        eventType: 'atom_confidence_delta',
        atomId,
        delta,
      });
    });

    this.recordQualityEvent({
      workspaceId: args.workspaceId,
      appId: args.appId ?? null,
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
    appId?: string | null;
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
        appId: event.appId ?? null,
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
    appId?: string | null;
    query: string;
    scope?: 'workspace' | 'app' | 'both';
    limit?: number;
    minConfidence?: number;
  }): Promise<BrainSearchResult[]> {
    if (this.embeddingStatus(args.workspaceId).retrievalPaused) return [];
    const limit = Math.min(Math.max(args.limit ?? 5, 1), 25);
    const appId = args.appId ?? null;
    const graphScope: BrainGraphScope = args.scope === 'app' || (args.scope === 'both' && appId) ? 'app' : 'workspace';
    const atoms = this.loadAtoms(args.workspaceId, {
      scope: graphScope,
      appId,
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

    const now = new Date().toISOString();
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

    for (const { atom } of ranked) {
      if (atom.kind === 'episode') {
        this.db.update(schema.memoryEpisodes)
          .set({ lastAccessedAt: now })
          .where(eq(schema.memoryEpisodes.id, atom.id))
          .run();
      }
    }

    return ranked.map(({ atom, score }) => ({
      id: atom.id,
      kind: atom.kind,
      title: atom.node.label,
      content: atom.node.summary ?? atom.text,
      confidence: atom.node.confidence,
      score,
      appId: atom.node.appId ?? null,
      tags: parseJsonArray<string>(atom.node.metadata.tags),
      status: atom.node.status ?? null,
      managed: atom.node.managed ?? null,
      updatedAt: atom.node.updatedAt,
    }));
  }

  async addAtom(args: {
    workspaceId: string;
    appId?: string | null;
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
      appId: args.appId ?? null,
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
      appId: episode.appId ?? null,
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

  summarize(args: { workspaceId: string; appId?: string | null; sessionId?: string | null }): BrainSummary {
    const rows = this.db.select().from(schema.memoryEpisodes)
      .where(and(eq(schema.memoryEpisodes.workspaceId, args.workspaceId), isNull(schema.memoryEpisodes.archivedAt)))
      .all()
      .filter((row) => row.status !== 'archived');
    const appRows = args.appId ? rows.filter((row) => row.appId === args.appId) : [];
    const workspaceRows = rows.filter((row) => !row.appId);
    const sessionRows = args.sessionId
      ? this.db.select().from(schema.sessionAtoms)
          .where(and(eq(schema.sessionAtoms.workspaceId, args.workspaceId), eq(schema.sessionAtoms.sessionId, args.sessionId)))
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
      workspaceBrain: summarizeRows(workspaceRows),
      appBrain: summarizeRows(appRows),
      sessionAtoms: {
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
    appId?: string | null;
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
      appId: args.appId ?? null,
    });
    this.db.update(schema.memoryEpisodes)
      .set({ isDisputed: true, disputeReason: args.reason, updatedAt: now })
      .where(and(eq(schema.memoryEpisodes.workspaceId, args.workspaceId), or(eq(schema.memoryEpisodes.id, args.atomIdA), eq(schema.memoryEpisodes.id, args.atomIdB))!))
      .run();
    this.bus.publish(REALTIME_ROOMS.workspace(args.workspaceId), REALTIME_EVENTS.BRAIN_DISPUTE_FLAGGED, {
      workspaceId: args.workspaceId,
      appId: args.appId ?? null,
      atomIds: [args.atomIdA, args.atomIdB],
      reason: args.reason,
    });
    return { linkId: link?.id ?? null };
  }

  listDisputes(workspaceId: string, options: { appId?: string | null; includeSnoozed?: boolean } = {}) {
    const now = new Date().toISOString();
    const links = this.db.select().from(schema.knowledgeLinks)
      .where(and(
        eq(schema.knowledgeLinks.workspaceId, workspaceId),
        eq(schema.knowledgeLinks.relation, 'contradicts'),
      ))
      .orderBy(desc(schema.knowledgeLinks.updatedAt))
      .all()
      .filter((link) => !link.contextSplit && !link.resolvedAt)
      .filter((link) => !options.appId || !link.appId || link.appId === options.appId);
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
        appId: link.appId,
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
        .set({ resolvedAt: now, updatedAt: now })
        .where(eq(schema.knowledgeLinks.id, link.id))
        .run();
    } else if (args.action === 'merge') {
      const merged = await this.addAtom({
        workspaceId: args.workspaceId,
        appId: link.appId ?? atomA.appId ?? atomB.appId ?? null,
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
        .set({ resolvedAt: now, updatedAt: now })
        .where(eq(schema.knowledgeLinks.id, link.id))
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
   * scoped to an app when given. Archived/superseded rows are excluded.
   */
  #loadEpisodeVectors(
    workspaceId: string,
    appId: string | null,
  ): Array<{ id: string; vec: number[] | null; text: string }> {
    const rows = this.db.select().from(schema.memoryEpisodes)
      .where(and(
        eq(schema.memoryEpisodes.workspaceId, workspaceId),
        isNull(schema.memoryEpisodes.archivedAt),
        ...(appId
          ? [or(eq(schema.memoryEpisodes.appId, appId), isNull(schema.memoryEpisodes.appId))!]
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

  extractAndPromote(input: CollectiveBrainPromotionInput): { created: number; reinforced: number; linked: number } {
    const resolvedAgent = input.agentId ? this.resolveAgent(input.workspaceId, input.agentId) : null;
    const adapterType = input.adapterType ?? resolvedAgent?.adapterType ?? null;
    const candidates = extractPromotableFacts(input.taskOutput);
    if (candidates.length === 0) return { created: 0, reinforced: 0, linked: 0 };

    let created = 0;
    let reinforced = 0;
    let linked = 0;
    const existingAtoms = this.loadAtoms(input.workspaceId, {
      scope: input.appId ? 'app' : 'workspace',
      appId: input.appId ?? null,
      limit: MAX_GRAPH_LIMIT,
    });

    for (const fact of candidates) {
      const best = this.findBestSimilar(existingAtoms, fact);
      if (best && best.score >= HIGH_SIMILARITY) {
        const node = this.reinforceAtom(input.workspaceId, best.atom.kind, best.atom.id, {
          agentId: input.agentId ?? null,
          adapterType,
          runId: input.runId ?? null,
          appId: input.appId ?? null,
        });
        if (node) {
          reinforced += 1;
          this.publishAtom(input.workspaceId, REALTIME_EVENTS.BRAIN_ATOM_REINFORCED, node);
        }
        continue;
      }

      const episode = this.episodes.write({
        workspaceId: input.workspaceId,
        appId: input.appId ?? null,
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
          appId: input.appId ?? null,
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
    if (input.appId && (!atomVisibleInApp(sourceAtom.node, input.appId) || !atomVisibleInApp(targetAtom.node, input.appId))) {
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
      appId: input.appId ?? null,
      contextSplit: false,
      resolvedAt: null,
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
    const appId = options.appId ? this.resolveAppId(workspaceId, options.appId) : null;
    const includeWorkspace = options.includeWorkspace ?? scope !== 'app';
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_GRAPH_LIMIT, 1), MAX_GRAPH_LIMIT);
    const minConfidence = clamp01(options.minConfidence ?? 0);
    const kindFilter = options.kinds && options.kinds.length > 0 ? new Set(options.kinds) : null;

    const atoms = this.loadAtoms(workspaceId, { scope, appId, includeWorkspace, limit, kinds: options.kinds, minConfidence });
    const atomByKey = new Map(atoms.map((atom) => [atomKey(atom.kind, atom.id), atom] as const));

    const linkRows = this.db.select().from(schema.knowledgeLinks)
      .where(and(
        eq(schema.knowledgeLinks.workspaceId, workspaceId),
        ...(scope === 'app' && appId
          ? [includeWorkspace ? or(eq(schema.knowledgeLinks.appId, appId), isNull(schema.knowledgeLinks.appId))! : eq(schema.knowledgeLinks.appId, appId)]
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
        if (source && atomAllowedInGraph(source.node, scope, appId, includeWorkspace)) atomByKey.set(sourceKey, source);
      }
      if (!atomByKey.has(targetKey)) {
        const target = this.loadAtomById(workspaceId, targetKind, row.targetId);
        if (target && atomAllowedInGraph(target.node, scope, appId, includeWorkspace)) atomByKey.set(targetKey, target);
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

    const nodes = [coreNode(workspaceId, scope, appId)];
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
        appId,
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
    options: { appId?: string | null; includeWorkspace?: boolean; limit?: number } = {},
  ): Array<{ id: string; kind: KnowledgeAtomKind; label: string; tokens: Set<string> }> {
    const atoms = this.loadAtoms(workspaceId, {
      scope: options.appId ? 'app' : 'workspace',
      appId: options.appId ?? null,
      includeWorkspace: options.includeWorkspace ?? false,
      limit: options.limit ?? MAX_GRAPH_LIMIT,
    });
    return atoms.map((atom) => ({
      id: atom.id,
      kind: atom.kind,
      label: atom.node.label,
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
        changes = this.db.update(schema.appMemory)
          .set(update)
          .where(and(eq(schema.appMemory.workspaceId, workspaceId), eq(schema.appMemory.id, id)))
          .run().changes;
        break;
      }
      case 'pattern': {
        const update: Record<string, unknown> = { updatedAt: now };
        if (patch.title !== undefined) update.title = patch.title;
        if (patch.content !== undefined) update.summary = patch.content;
        changes = this.db.update(schema.appPromotedPatterns)
          .set(update)
          .where(and(eq(schema.appPromotedPatterns.workspaceId, workspaceId), eq(schema.appPromotedPatterns.id, id)))
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
    options: { appId?: string | null } = {},
  ): boolean {
    const atom = this.loadAtomById(workspaceId, kind, id);
    if (!atom) return false;
    if (options.appId && !atomVisibleInApp(atom.node, options.appId)) return false;

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
        changes = this.db.delete(schema.appMemory)
          .where(and(eq(schema.appMemory.workspaceId, workspaceId), eq(schema.appMemory.id, id)))
          .run().changes;
        break;
      case 'pattern':
        changes = this.db.delete(schema.appPromotedPatterns)
          .where(and(eq(schema.appPromotedPatterns.workspaceId, workspaceId), eq(schema.appPromotedPatterns.id, id)))
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
        const row = this.db.select().from(schema.appMemory)
          .where(and(eq(schema.appMemory.workspaceId, workspaceId), eq(schema.appMemory.id, node.atomId)))
          .get();
        if (!row) return null;
        return {
          content: row.content,
          source: sourceLabel(row.source, 'App memory'),
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        };
      }
      case 'pattern': {
        const row = this.db.select().from(schema.appPromotedPatterns)
          .where(and(eq(schema.appPromotedPatterns.workspaceId, workspaceId), eq(schema.appPromotedPatterns.id, node.atomId)))
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
    return {
      createdBy: agent?.name ?? creatorLabelFor(node.atomKind, detail?.source),
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
    provenance: { agentId?: string | null; adapterType?: string | null; runId?: string | null; appId?: string | null },
  ): BrainGraphNode | null {
    if (kind === 'episode') {
      const updated = this.episodes.reinforce(workspaceId, id, { confidenceDelta: 0.06, trustDelta: 0.04 });
      if (!updated) return null;
      return episodeToGraphNode(updated, 2);
    }

    if (kind === 'memory') {
      const row = this.db.select().from(schema.appMemory)
        .where(and(eq(schema.appMemory.workspaceId, workspaceId), eq(schema.appMemory.id, id)))
        .get();
      if (!row) return null;
      const now = new Date().toISOString();
      const trust = clamp01(Number(row.trust) + 0.04);
      const globalConfidence = clamp01(Number(row.globalConfidence ?? 0) + (1 - Number(row.globalConfidence ?? 0)) * 0.15);
      this.db.update(schema.appMemory)
        .set({
          trust: String(trust),
          globalConfidence: String(globalConfidence),
          adapterType: provenance.adapterType ?? row.adapterType ?? null,
          reinforcedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.appMemory.id, id))
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
    const appId = options.appId ?? null;
    const scope = options.scope ?? 'workspace';
    const includeWorkspace = options.includeWorkspace ?? scope !== 'app';
    const kindFilter = options.kinds && options.kinds.length > 0 ? new Set(options.kinds) : null;
    const minConfidence = clamp01(options.minConfidence ?? 0);
    const out: AtomCandidate[] = [];

    if (!kindFilter || kindFilter.has('episode')) {
      const rows = this.db.select().from(schema.memoryEpisodes)
        .where(and(
          eq(schema.memoryEpisodes.workspaceId, workspaceId),
          isNull(schema.memoryEpisodes.archivedAt),
          ...(scope === 'app' && appId
            ? [includeWorkspace ? or(eq(schema.memoryEpisodes.appId, appId), isNull(schema.memoryEpisodes.appId))! : eq(schema.memoryEpisodes.appId, appId)]
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
      const rows = this.db.select().from(schema.appMemory)
        .where(and(
          eq(schema.appMemory.workspaceId, workspaceId),
          ...(scope === 'app' && appId ? [eq(schema.appMemory.appId, appId)] : []),
        ))
        .orderBy(desc(schema.appMemory.updatedAt))
        .limit(perKind)
        .all();
      for (const row of rows) {
        const node = memoryRowToGraphNode(row, 1);
        if (node.confidence >= minConfidence) out.push({ id: row.id, kind: 'memory', text: `${row.title}\n${row.content}`, node });
      }
    }

    if (!kindFilter || kindFilter.has('pattern')) {
      const rows = this.db.select().from(schema.appPromotedPatterns)
        .where(and(
          eq(schema.appPromotedPatterns.workspaceId, workspaceId),
          ...(scope === 'app' && appId ? [eq(schema.appPromotedPatterns.appId, appId)] : []),
        ))
        .orderBy(desc(schema.appPromotedPatterns.updatedAt))
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
          ...(scope === 'app' && appId ? [eq(schema.knowledgeChunks.appId, appId)] : []),
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
        const row = this.db.select().from(schema.appMemory)
          .where(and(eq(schema.appMemory.workspaceId, workspaceId), eq(schema.appMemory.id, id)))
          .get();
        if (!row) return null;
        const node = memoryRowToGraphNode(row, 1);
        return { id: row.id, kind, text: `${row.title}\n${row.content}`, node };
      }
      case 'pattern': {
        const row = this.db.select().from(schema.appPromotedPatterns)
          .where(and(eq(schema.appPromotedPatterns.workspaceId, workspaceId), eq(schema.appPromotedPatterns.id, id)))
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

  private resolveAppId(workspaceId: string, appIdOrSlug: string): string {
    const row = this.db.select({ id: schema.appInstances.id })
      .from(schema.appInstances)
      .where(and(
        eq(schema.appInstances.workspaceId, workspaceId),
        or(eq(schema.appInstances.id, appIdOrSlug), eq(schema.appInstances.slug, appIdOrSlug))!,
      ))
      .get();
    return row?.id ?? appIdOrSlug;
  }

  private publishAtom(workspaceId: string, event: typeof REALTIME_EVENTS.BRAIN_ATOM_CREATED | typeof REALTIME_EVENTS.BRAIN_ATOM_REINFORCED, node: BrainGraphNode): void {
    this.bus.publish(REALTIME_ROOMS.workspace(workspaceId), event, {
      workspaceId,
      appId: node.appId ?? null,
      node,
    });
  }

  private publishLink(workspaceId: string, link: BrainGraphLink): void {
    this.bus.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.BRAIN_LINK_CREATED, {
      workspaceId,
      appId: link.appId ?? null,
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
    appId: row.appId,
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
    appId: row.appId ?? null,
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
    appId: row.appId,
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

function memoryRowToGraphNode(row: typeof schema.appMemory.$inferSelect, reinforceCount: number): BrainGraphNode {
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
    appId: row.appId,
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

function patternRowToGraphNode(row: typeof schema.appPromotedPatterns.$inferSelect): BrainGraphNode {
  return {
    id: atomKey('pattern', row.id),
    atomId: row.id,
    atomKind: 'pattern',
    label: row.title,
    summary: row.summary,
    confidence: clamp01(Number(row.confidence)),
    trust: Number(row.trust),
    reinforceCount: row.evidenceCount,
    appId: row.appId,
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
    appId: row.appId,
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

function coreNode(workspaceId: string, scope: BrainGraphScope, appId: string | null): BrainGraphNode {
  const now = new Date().toISOString();
  return {
    id: 'core',
    atomId: 'core',
    atomKind: 'core',
    label: scope === 'app' ? 'App brain' : 'Workspace brain',
    summary: scope === 'app' ? 'App-scoped intelligence plus global workspace memory' : 'Collective intelligence shared by every agent adapter',
    confidence: 1,
    trust: 1,
    reinforceCount: 1,
    appId,
    createdAt: now,
    updatedAt: now,
    metadata: { workspaceId, scope },
  };
}

function atomVisibleInApp(node: BrainGraphNode, appId: string): boolean {
  return !node.appId || node.appId === appId;
}

function atomAllowedInGraph(node: BrainGraphNode, scope: BrainGraphScope, appId: string | null, includeWorkspace: boolean): boolean {
  if (scope !== 'app' || !appId) return true;
  if (node.appId === appId) return true;
  return includeWorkspace && !node.appId;
}

function creatorLabelFor(kind: BrainGraphNode['atomKind'], source?: string | null): string {
  if (kind === 'core') return 'Agentis';
  if (source) {
    if (/operator/i.test(source)) return 'Operator';
    if (/seed/i.test(source)) return 'App seed';
    if (/promotion|agent output|run/i.test(source)) return 'Agent output';
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
    case 'seed': return 'App seed';
    case 'import': return 'Knowledge import';
    case 'promotion': return 'Promotion';
    case 'operator':
    case 'operator_write': return 'Operator';
    case 'agent_write':
    case 'run_promotion': return 'Agent output';
    case 'evaluator_write': return 'Evaluator';
    case 'system_write': return 'System';
    default: return source.replace(/_/g, ' ');
  }
}

function atomKey(kind: KnowledgeAtomKind, id: string): string {
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
function extractPromotableFacts(value: unknown): string[] {
  const raw = stripNonProse(flattenText(value).join('\n'));
  const sentences = raw
    .split(/(?:\r?\n|(?<=[.!?])\s+)/)
    .map((part) => stripMarkdownPrefix(part).trim().replace(/\s+/g, ' '))
    .filter((part) => part.length >= 25 && part.length <= 500)
    .filter((part) => !looksSensitive(part))
    .filter((part) => hasUsefulSignal(part));
  return uniqueByNormalized(sentences);
}

/** Remove fenced code blocks and bracket-balanced JSON objects/arrays. */
function stripNonProse(text: string): string {
  let out = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
  // Drop balanced JSON-looking blocks ({...} / [...]) that span >1 token.
  out = out.replace(/(\{[\s\S]{40,}?\}|\[[\s\S]{40,}?\])/g, (block) => {
    const looksJson = /["']\s*:/.test(block) || /^\s*\[/.test(block);
    return looksJson ? ' ' : block;
  });
  return out;
}

/** Strip leading Markdown headers / list markers before length checks. */
function stripMarkdownPrefix(line: string): string {
  return line.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s+)/, '');
}

function flattenText(value: unknown, depth = 0): string[] {
  if (depth > 4 || value == null) return [];
  if (typeof value === 'string') return [value];
  if (typeof value === 'number' || typeof value === 'boolean') return [];
  if (Array.isArray(value)) return value.flatMap((entry) => flattenText(entry, depth + 1));
  if (typeof value === 'object') {
    const out: string[] = [];
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (/token|secret|password|authorization|cookie/i.test(key)) continue;
      if (/summary|result|output|content|message|error|reason|lesson|observation|finding|conclusion/i.test(key)) {
        out.push(...flattenText(entry, depth + 1));
      } else if (depth < 2) {
        out.push(...flattenText(entry, depth + 1));
      }
    }
    return out;
  }
  return [];
}

function hasUsefulSignal(text: string): boolean {
  const lower = text.toLowerCase();
  return /learned|observed|found|confirmed|failed|succeeded|requires|should|must|because|resolved|rate|limit|error|policy|rule|pattern|use|avoid|returns|returned/.test(lower)
    || tokenize(text).length >= 8;
}

function looksSensitive(text: string): boolean {
  return /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)
    || /\b(?:sk|pk|ghp|gho|xoxb|xoxp)_[A-Za-z0-9_\-]{16,}\b/.test(text)
    || /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/.test(text);
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
