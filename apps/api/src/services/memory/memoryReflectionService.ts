/**
 * memoryReflectionService — Brain 10x §C1, the cross-session Reflection Engine
 * reflection pass for MEMORY (not peer cards — that is `ReflectionService`).
 *
 * The frontier wow-moment (Honcho/BEAM) is asynchronous reasoning over
 * ACCUMULATED experience: "the same correction keeps recurring → make it a
 * standing rule"; "this belief no longer matches reality → retire it". Agentis
 * had per-run promotion (Feynman) and per-peer reflection (ReflectionService) but
 * NO cross-session reflection over the memory plane. This is that.
 *
 * Two grounded passes (model-graded, never fabricating):
 *
 *   1. DEDUCTION — read a window of durable episodes for a scope, cluster by
 *      topic, and for a cluster supported by ≥2 DISTINCT runs/sessions, derive a
 *      generalized, reusable rule. Committed as a `conceptual` atom with
 *      provenance (`generalizedFrom: [ids]`). Grounded: the generalization must
 *      lexically overlap the supporting evidence or it is dropped.
 *
 *   2. UPWARD GENERALIZATION (ties to §B7.4) — a NARROW-scoped atom (agent /
 *      workflow) whose lesson recurs across ≥2 distinct scopes is re-expressed as
 *      a workspace-level generalization linked to its instances, so narrow-write
 *      never loses knowledge and deleting an agent never strands a durable rule.
 *
 *   3. RECONCILIATION (self-cleaning) — fold near-duplicate generalizations into
 *      one (reinforce, supersede the rest) so the durable plane does not bloat.
 *
 * Strictly async + budgeted + idempotent. Runs as a queue job (`memory_reflection`),
 * NEVER on the hot path. Without a completer it degrades to deterministic
 * recurrence-reinforcement only — it never invents a rule from thin air.
 */

import { and, desc, eq, gte, isNull, ne, sql } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../../logger.js';
import type { SharedIntelligenceService } from '../sharedIntelligence.js';
import type { StructuredCompleter } from '../structuredCompleter.js';
import { tokenize } from '../brain/brainText.js';
import { classifyPacer } from '../brain/brainPacer.js';

/** §C6 — propose compiling a reinforced procedural rule into an Ability. */
export type SkillProposer = (args: { workspaceId: string; scopeId: string | null; intent: string; title: string }) => void;

export interface MemoryReflectionPayload {
  workspaceId: string;
  /** Restrict to one intelligence scope; null/absent = workspace-wide. */
  scopeId?: string | null;
  /** Lookback window in days (default 30). */
  windowDays?: number;
  trigger?: 'scheduled' | 'episode_threshold' | 'manual';
}

export interface MemoryReflectionResult {
  workspaceId: string;
  episodesScanned: number;
  clusters: number;
  generalizations: number;
  upwardGeneralizations: number;
  reconciled: number;
  /** §C3 — contradicting durable atoms discovered + routed to dispute resolution. */
  contradictionsFlagged: number;
  /** §C6 — reinforced procedural rules proposed for compilation into Abilities. */
  skillsProposed: number;
}

/** Durable types worth generalizing — execution lessons, not raw observations. */
const DURABLE_TYPES = new Set(['success_pattern', 'recovery', 'decision', 'distilled_lesson', 'failure']);
/** A cluster needs this many DISTINCT runs/sessions before it can generalize. */
const MIN_DISTINCT_SOURCES = 2;
/** A cluster needs at least this many member episodes. */
const MIN_CLUSTER_SIZE = 2;
/** Minimum lexical grounding between a generalization and its evidence (0..1). */
const MIN_GROUNDING = 0.16;
/** Cap clusters processed per pass (budget). */
const MAX_CLUSTERS = 12;

interface EpisodeRow {
  id: string;
  scopeId: string | null;
  runId: string | null;
  workflowId: string | null;
  type: string;
  title: string;
  summary: string;
  tags: string[];
  trust: number;
  importance: number;
  createdAt: string;
}

interface DeducedRule {
  statement: string;
  title: string;
  confidence: number;
}

export class MemoryReflectionService {
  #completer: StructuredCompleter | null = null;
  #modelAssistedRuntimeEnabled: (workspaceId: string) => boolean = () => true;

  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly shared: SharedIntelligenceService,
    private readonly logger: Logger,
  ) {}

  #proposeSkill: SkillProposer | null = null;

  /** Wire (or clear) the grading model. Mirrors Feynman/SharedIntelligence. */
  setCompleter(completer: StructuredCompleter | null): void {
    this.#completer = completer;
  }

  setModelAssistedRuntimeEnabled(resolver: (workspaceId: string) => boolean): void {
    this.#modelAssistedRuntimeEnabled = resolver;
  }

  /** §C6 — wire the ability proposer (the memory→skill flywheel). */
  setSkillProposer(proposer: SkillProposer | null): void {
    this.#proposeSkill = proposer;
  }

  async run(payload: MemoryReflectionPayload): Promise<MemoryReflectionResult> {
    const result: MemoryReflectionResult = {
      workspaceId: payload.workspaceId,
      episodesScanned: 0,
      clusters: 0,
      generalizations: 0,
      upwardGeneralizations: 0,
      reconciled: 0,
      contradictionsFlagged: 0,
      skillsProposed: 0,
    };

    const windowDays = Math.max(1, Math.min(payload.windowDays ?? 30, 180));
    const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();
    const episodes = this.#loadWindow(payload.workspaceId, payload.scopeId ?? null, since);
    result.episodesScanned = episodes.length;
    if (episodes.length < MIN_CLUSTER_SIZE) return result;

    const clusters = this.#cluster(episodes);
    result.clusters = clusters.length;

    for (const cluster of clusters.slice(0, MAX_CLUSTERS)) {
      const distinctSources = new Set(
        cluster.map((e) => e.runId ?? e.workflowId ?? e.id).filter(Boolean),
      ).size;
      if (cluster.length < MIN_CLUSTER_SIZE || distinctSources < MIN_DISTINCT_SOURCES) continue;

      // Already generalized? (idempotency — don't re-commit each pass.)
      if (this.#alreadyGeneralized(payload.workspaceId, cluster)) continue;

      const rule = this.#modelAssistedRuntimeEnabled(payload.workspaceId)
        ? await this.#deduce(payload.workspaceId, cluster)
        : null;
      if (!rule) continue;

      // Grounding gate: the rule must reference the evidence, not invent it.
      if (this.#groundingOverlap(rule.statement, cluster) < MIN_GROUNDING) {
        this.logger.info('memory_reflection.dropped_ungrounded', { workspaceId: payload.workspaceId, title: rule.title });
        continue;
      }

      const sourceIds = cluster.map((e) => e.id);
      // §B7.4 — narrow-scoped cluster spanning ≥2 scopes generalizes to workspace.
      const narrowScopes = new Set(cluster.map((e) => e.scopeId).filter((s): s is string => Boolean(s)));
      const upward = narrowScopes.size >= MIN_DISTINCT_SOURCES;
      const targetScope = upward ? null : (cluster[0]!.scopeId ?? payload.scopeId ?? null);

      await this.shared.addAtom({
        workspaceId: payload.workspaceId,
        scopeId: targetScope,
        content: rule.statement,
        title: rule.title,
        confidence: clamp01(rule.confidence),
        source: 'system_write',
        managed: true,
        tags: ['generalization', 'reflection', 'pacer:conceptual', ...(upward ? ['upward_generalized'] : [])],
        metadata: {
          reflection: true,
          generalizedFrom: sourceIds,
          distinctSources,
          upward,
          appliesTo: [...narrowScopes],
        },
      });
      result.generalizations += 1;
      if (upward) result.upwardGeneralizations += 1;

      // §C6 — memory→skill flywheel: a strongly-reinforced PROCEDURAL rule (≥3
      // distinct sources) is a candidate to compile into an Ability. Propose it
      // — review-gated and never auto-activated — so one-offs never propose.
      if (this.#proposeSkill && distinctSources >= 3 && classifyPacer({ text: rule.statement }).pacerClass === 'procedural') {
        try {
          this.#proposeSkill({ workspaceId: payload.workspaceId, scopeId: targetScope, intent: rule.statement, title: rule.title });
          result.skillsProposed += 1;
        } catch { /* best effort */ }
      }
    }

    // RECONCILIATION — fold near-duplicate reflection generalizations.
    result.reconciled = this.#reconcile(payload.workspaceId, payload.scopeId ?? null);

    // §C3 — contradiction discovery sweep. Routes discovered pairs to the
    // EXISTING dispute machinery (flagDispute → resolveDispute/context_split).
    result.contradictionsFlagged = this.#contradictionSweep(payload.workspaceId, payload.scopeId ?? null);

    // §C2 — sleep-time precompute: refresh the per-scope working-set cache so the
    // injector can serve core knowledge cheaply on the next dispatch.
    try { this.shared.rebuildWorkingSet(payload.workspaceId, payload.scopeId ?? null); } catch { /* best effort */ }

    this.shared.recordQualityEvent({
      workspaceId: payload.workspaceId,
      scopeId: payload.scopeId ?? null,
      eventType: 'memory_reflection',
      metadata: { ...result, trigger: payload.trigger ?? 'manual', windowDays },
    });
    this.logger.info('memory_reflection.completed', { ...result, trigger: payload.trigger ?? 'manual' });
    return result;
  }

  // ── Window load ───────────────────────────────────────────

  #loadWindow(workspaceId: string, scopeId: string | null, since: string): EpisodeRow[] {
    const conds = [
      eq(schema.memoryEpisodes.workspaceId, workspaceId),
      isNull(schema.memoryEpisodes.archivedAt),
      gte(schema.memoryEpisodes.createdAt, since),
      // Don't reflect over plane-tagged typed memory or prior reflections.
      sql`${schema.memoryEpisodes.tags} NOT LIKE '%generalization%'`,
      sql`${schema.memoryEpisodes.tags} NOT LIKE '%plane:workspace_memory%'`,
    ];
    if (scopeId) conds.push(eq(schema.memoryEpisodes.scopeId, scopeId));
    const rows = this.db.select().from(schema.memoryEpisodes)
      .where(and(...conds))
      .orderBy(desc(schema.memoryEpisodes.createdAt))
      .limit(400)
      .all();
    return rows
      .filter((r) => DURABLE_TYPES.has(r.type))
      .map((r) => ({
        id: r.id,
        scopeId: r.scopeId,
        runId: r.runId,
        workflowId: r.workflowId,
        type: r.type,
        title: r.title,
        summary: r.summary,
        tags: parseTags(r.tags),
        trust: Number(r.trust) || 0,
        importance: Number(r.importance) || 0,
        createdAt: r.createdAt,
      }));
  }

  // ── Clustering (deterministic, token-overlap) ──────────────

  #cluster(episodes: EpisodeRow[]): EpisodeRow[][] {
    const remaining = [...episodes];
    const sigs = new Map<string, Set<string>>();
    for (const e of remaining) sigs.set(e.id, new Set(tokenize(`${e.title} ${e.summary}`).slice(0, 24)));
    const clusters: EpisodeRow[][] = [];
    const used = new Set<string>();
    for (const seed of remaining) {
      if (used.has(seed.id)) continue;
      const seedSig = sigs.get(seed.id)!;
      const group = [seed];
      used.add(seed.id);
      for (const other of remaining) {
        if (used.has(other.id)) continue;
        if (jaccard(seedSig, sigs.get(other.id)!) >= 0.25) {
          group.push(other);
          used.add(other.id);
        }
      }
      if (group.length >= MIN_CLUSTER_SIZE) clusters.push(group);
    }
    // Densest clusters first (more evidence = higher-value generalization).
    return clusters.sort((a, b) => b.length - a.length);
  }

  #alreadyGeneralized(workspaceId: string, cluster: EpisodeRow[]): boolean {
    const sourceIds = new Set(cluster.map((e) => e.id));
    const priors = this.db.select({ metadata: schema.memoryEpisodes.metadata })
      .from(schema.memoryEpisodes)
      .where(and(
        eq(schema.memoryEpisodes.workspaceId, workspaceId),
        isNull(schema.memoryEpisodes.archivedAt),
        sql`${schema.memoryEpisodes.tags} LIKE '%generalization%'`,
      ))
      .limit(200)
      .all();
    for (const p of priors) {
      const meta = (p.metadata ?? {}) as Record<string, unknown>;
      const from = Array.isArray(meta.generalizedFrom) ? meta.generalizedFrom as string[] : [];
      // If a prior generalization already covers most of this cluster, skip.
      const overlap = from.filter((id) => sourceIds.has(id)).length;
      if (overlap >= Math.ceil(cluster.length * 0.6)) return true;
    }
    return false;
  }

  // ── Deduction (model-graded) ───────────────────────────────

  async #deduce(workspaceId: string, cluster: EpisodeRow[]): Promise<DeducedRule | null> {
    const completer = this.#completer;
    if (!completer) {
      // No model → no fabrication. Reinforce the cluster's strongest atom instead
      // (handled implicitly by retrieval/access); emit nothing durable here.
      return null;
    }
    const evidence = cluster.slice(0, 8).map((e, i) => `[${i}] (${e.type}) ${e.title}: ${truncate(e.summary, 200)}`).join('\n');
    const system = [
      'You are the cross-session reflection engine for an autonomous-agent platform.',
      'You read several RELATED lessons captured across different runs and derive ONE generalized, reusable rule the workspace should remember.',
      'The rule must be supported by the evidence (cite nothing the evidence does not show), third-person, context-free (no "I"/"we"/"today"), and reusable on FUTURE different tasks.',
      'If the lessons do not share a real, generalizable pattern, return an empty statement — that is correct and expected.',
    ].join(' ');
    const user = [
      'RELATED LESSONS (same topic, different runs):',
      evidence,
      '',
      'Return JSON ONLY: {"statement":"<the generalized reusable rule, third-person>","title":"<=80 chars","confidence":0.0}',
      'Leave statement empty if there is no genuine generalization.',
    ].join('\n');
    try {
      const parsed = await completer.completeStructured<{ statement?: string; title?: string; confidence?: number }>({
        system, user, workspaceId, maxTokens: 300, maxAttempts: 2,
      });
      const statement = typeof parsed?.statement === 'string' ? parsed.statement.trim() : '';
      if (statement.length < 16 || /^(i|we)\s/i.test(statement)) return null;
      const title = typeof parsed?.title === 'string' && parsed.title.trim()
        ? truncate(parsed.title.trim(), 92)
        : truncate(statement, 92);
      return { statement: truncate(statement, 480), title, confidence: typeof parsed?.confidence === 'number' ? parsed.confidence : 0.6 };
    } catch {
      return null;
    }
  }

  /** Lexical overlap between the rule and the union of its evidence (grounding gate). */
  #groundingOverlap(statement: string, cluster: EpisodeRow[]): number {
    const ruleTokens = new Set(tokenize(statement));
    if (ruleTokens.size === 0) return 0;
    const evidenceTokens = new Set<string>();
    for (const e of cluster) for (const t of tokenize(`${e.title} ${e.summary}`)) evidenceTokens.add(t);
    let hits = 0;
    for (const t of ruleTokens) if (evidenceTokens.has(t)) hits += 1;
    return hits / ruleTokens.size;
  }

  // ── Reconciliation (fold near-duplicate generalizations) ───

  #reconcile(workspaceId: string, scopeId: string | null): number {
    const conds = [
      eq(schema.memoryEpisodes.workspaceId, workspaceId),
      isNull(schema.memoryEpisodes.archivedAt),
      isNull(schema.memoryEpisodes.supersededBy),
      sql`${schema.memoryEpisodes.tags} LIKE '%generalization%'`,
    ];
    if (scopeId) conds.push(eq(schema.memoryEpisodes.scopeId, scopeId));
    const rows = this.db.select().from(schema.memoryEpisodes).where(and(...conds))
      .orderBy(desc(schema.memoryEpisodes.createdAt)).limit(200).all();
    const sigs = rows.map((r) => ({ id: r.id, sig: new Set(tokenize(`${r.title} ${r.summary}`).slice(0, 20)) }));
    const superseded = new Set<string>();
    let count = 0;
    for (let i = 0; i < sigs.length; i++) {
      if (superseded.has(sigs[i]!.id)) continue;
      for (let j = i + 1; j < sigs.length; j++) {
        if (superseded.has(sigs[j]!.id)) continue;
        if (jaccard(sigs[i]!.sig, sigs[j]!.sig) >= 0.8) {
          // Keep the newer (i, listed first by createdAt desc); supersede the older.
          // §0.2 — also ARCHIVE it: superseding alone left supersededBy set but the
          // row un-archived, so it was still pulled into dispatch recall (loadAtoms
          // filters archivedAt, not supersededBy) AND never reclaimed. Archiving
          // removes it from recall and makes it eligible for disk reclamation.
          const nowIso = new Date().toISOString();
          this.db.update(schema.memoryEpisodes)
            .set({ supersededBy: sigs[i]!.id, status: 'archived', archivedAt: nowIso, updatedAt: nowIso })
            .where(eq(schema.memoryEpisodes.id, sigs[j]!.id))
            .run();
          superseded.add(sigs[j]!.id);
          count += 1;
        }
      }
    }
    void ne; // (kept for future scope-aware reconciliation)
    return count;
  }

  // ── §C3 contradiction discovery sweep ──────────────────────

  /**
   * Discover durable atoms that are topically similar yet carry OPPOSING
   * directives ("always X" vs "never X"), and route each pair to the existing
   * dispute machinery. Deterministic + bounded (no model needed), so it always
   * runs. Disputed atoms are skipped to avoid re-flagging; the resolver
   * (context_split / supersede) handles them downstream.
   */
  #contradictionSweep(workspaceId: string, scopeId: string | null): number {
    const conds = [
      eq(schema.memoryEpisodes.workspaceId, workspaceId),
      isNull(schema.memoryEpisodes.archivedAt),
      isNull(schema.memoryEpisodes.supersededBy),
      eq(schema.memoryEpisodes.isDisputed, false),
    ];
    if (scopeId) conds.push(eq(schema.memoryEpisodes.scopeId, scopeId));
    const rows = this.db.select().from(schema.memoryEpisodes).where(and(...conds))
      .orderBy(desc(schema.memoryEpisodes.updatedAt)).limit(150).all()
      .filter((r) => DURABLE_TYPES.has(r.type) && !parseTags(r.tags).includes('plane:workspace_memory'));
    const items = rows.map((r) => {
      const text = `${r.title} ${r.summary}`;
      return { id: r.id, sig: directiveTopicSignature(text), polarity: directivePolarity(text) };
    });
    let flagged = 0;
    const seen = new Set<string>();
    for (let i = 0; i < items.length; i++) {
      if (items[i]!.polarity === 0) continue;
      for (let j = i + 1; j < items.length; j++) {
        if (items[j]!.polarity === 0) continue;
        if (items[i]!.polarity === -items[j]!.polarity && jaccard(items[i]!.sig, items[j]!.sig) >= 0.4) {
          const key = [items[i]!.id, items[j]!.id].sort().join('|');
          if (seen.has(key)) continue;
          seen.add(key);
          try {
            this.shared.flagDispute({
              workspaceId,
              atomIdA: items[i]!.id,
              atomIdB: items[j]!.id,
              reason: 'Reflection sweep: topically similar durable atoms with opposing directives.',
              scopeId,
            });
            flagged += 1;
          } catch { /* best effort */ }
          if (flagged >= 20) return flagged;
        }
      }
    }
    return flagged;
  }
}

// ── Helpers ───────────────────────────────────────────────────

/**
 * §C3 — directive polarity of a rule: +1 = positive directive (always/must/do/
 * prefer/ensure), −1 = prohibition (never/avoid/do not/don't/stop), 0 = none or
 * mixed (ambiguous). Two same-topic rules with opposite polarity contradict.
 */
export function directivePolarity(text: string): -1 | 0 | 1 {
  const lower = text.toLowerCase();
  // Prohibitions first (so "do not"/"must not" aren't double-counted as positive).
  const neg = (lower.match(/\b(never|avoid|do not|don't|dont|must not|should not|stop|disallow|forbid)\b/g) ?? []).length;
  // Positive directives — deliberately NOT the generic "do"/"use" (too noisy:
  // "do it off-peak" is not a positive directive about the subject).
  const pos = (lower.match(/\b(always|must|ensure|require|prefer|should)\b/g) ?? []).length
    - (lower.match(/\b(must not|should not)\b/g) ?? []).length;
  if (pos > neg) return 1;
  if (neg > pos) return -1;
  return 0;
}

/**
 * Topic signature for comparing directives after polarity has been classified.
 * Modal/prohibition tokens describe whether a rule permits or forbids an action;
 * retaining them in the topic signature makes opposite rules look artificially
 * unrelated (for example, "always escalate" versus "do not escalate").
 */
export function directiveTopicSignature(text: string): Set<string> {
  const polarityTokens = new Set([
    'always', 'never', 'avoid', 'not', 'dont', 'must', 'should', 'ensure',
    'require', 'prefer', 'stop', 'disallow', 'forbid',
  ]);
  return new Set(tokenize(text).filter((token) => !polarityTokens.has(token)).slice(0, 24));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw !== 'string') return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}
