/**
 * HarnessMemoryIngestionService — the agent's "transition" into Agentis.
 *
 * When an agent backed by an external harness (Claude Code, Codex, Cursor,
 * Hermes) is connected to Agentis, it does not arrive empty-handed. It has
 * accumulated knowledge in its own memory surfaces — the operator-authored
 * instruction files every CLI runtime reads at startup (CLAUDE.md, AGENTS.md,
 * .cursorrules, GEMINI.md, …). This service distils that knowledge into the
 * agent's private Brain so the agent *feels continuous*: it carries forward
 * what it already knew instead of starting from zero (Principle #2).
 *
 * Design constraints that shaped this service:
 *
 *   1. NO PARALLEL STORE. Candidates are written through the canonical
 *      `EpisodicMemoryStore` (the same table the rest of the Brain reads from),
 *      scoped to the agent (`scopeId = agentId`) exactly like
 *      `AgentMemoryService`. The only new thing here is the *source layer*:
 *      reading + distilling + quality-gating harness-native memory.
 *
 *   2. NO GARBAGE. Raw instruction files are full of boilerplate, headings,
 *      code fences and environment noise. A deterministic quality gate scores
 *      every candidate atom and drops anything below threshold. The default
 *      flow is preview → human review → commit, so the operator is the final
 *      gate. Committing all candidates above threshold is opt-in.
 *
 *   3. SAFE TO RE-RUN (recurrent). Every atom carries a content hash in its
 *      metadata. Re-ingesting an unchanged file is a no-op; a semantically
 *      near-duplicate reinforces the existing episode instead of duplicating
 *      it. This lets ingestion run once at onboarding *and* periodically as the
 *      harness files evolve, without polluting the Brain.
 *
 * The service is intentionally thin: it orchestrates `agentInstructionFiles`
 * (source) and `EpisodicMemoryStore` (sink). It owns the distillation and the
 * quality gate, nothing else.
 */

import { createHash } from 'node:crypto';
import type { RuntimeEpisode, RuntimeEpisodeType } from '@agentis/core';
import type { Logger } from '../../logger.js';
import type { EpisodicMemoryStore } from '../episodicMemoryStore.js';
import { listAgentInstructionFiles, type AgentInstructionFile } from '../agent/agentInstructionFiles.js';
import type { ImportMemoryFile, ImportScopeHint } from '../harnessImport/types.js';

/** The minimal agent shape ingestion needs. Matches the `agents` row. */
export interface IngestibleAgent {
  id: string;
  workspaceId: string;
  adapterType?: string | null;
  config?: unknown;
  instructions?: string | null;
}

/** One distilled, quality-scored unit of harness knowledge. */
export interface HarnessMemoryCandidate {
  /** Stable id = content hash; also used for exact-idempotency dedup. */
  hash: string;
  /** Short, retrieval-friendly title. */
  title: string;
  /** The atom body — the actual remembered statement. */
  summary: string;
  /** Episode type this atom maps to. */
  type: RuntimeEpisodeType;
  /** Logical Brain section (e.g. "Conventions", "Decisions"). */
  section: string;
  /** 0..1 quality gate score; only atoms ≥ threshold are ingestible. */
  quality: number;
  /** Suggested trust for the written episode (source-derived). */
  trust: number;
  /** Suggested importance (rule-strength derived). */
  importance: number;
  tags: string[];
  /**
   * Where this atom should land. 'agent' → the agent's private Brain
   * (scopeId = agentId); 'workspace' → the shared workspace Brain (scopeId null).
   * Scope = applicability, not source location (Brain B7).
   */
  scopeHint: ImportScopeHint;
  /** Provenance: which harness file this came from. */
  origin: {
    adapterType: string;
    fileKey: string;
    fileName: string;
    instructionSource: AgentInstructionFile['source'];
  };
  /** Dedup verdict against the agent's existing Brain (filled by preview/commit). */
  duplicateOf?: { episodeId: string; kind: 'exact' | 'semantic' } | null;
}

export interface IngestionPreview {
  agentId: string;
  /** Harness files that were read (whether or not they yielded candidates). */
  scannedFiles: Array<{ fileName: string; source: string; candidateCount: number; skipped: boolean }>;
  candidates: HarnessMemoryCandidate[];
  /** Default quality threshold applied. */
  minQuality: number;
}

export interface IngestionCommitResult {
  agentId: string;
  written: number;
  reinforced: number;
  skipped: number;
  /** Episode ids that were created this run. */
  episodeIds: string[];
}

export interface IngestionCommitOptions {
  /**
   * When provided, only candidates whose hash is in this set are committed
   * (human-reviewed subset). When omitted, every candidate ≥ `minQuality` is
   * committed.
   */
  acceptHashes?: string[];
  /** Override the quality threshold (default `DEFAULT_MIN_QUALITY`). */
  minQuality?: number;
}

/** Default quality bar. Conservative: better to drop a weak atom than pollute. */
export const DEFAULT_MIN_QUALITY = 0.55;

/** Semantic-dedup cosine threshold (matches EpisodicMemoryStore.findSimilar). */
const SEMANTIC_DEDUP_THRESHOLD = 0.82;

/**
 * The canonical formation pipeline, narrowed to what import needs. Satisfied by
 * `SharedIntelligenceService.promote`. When wired, imported memory is FORMED
 * exactly like natively-captured memory (third-person rewrite, typed,
 * reconciled ADD/UPDATE/NOOP against existing) instead of written verbatim.
 */
export interface FormationPromoter {
  promote(input: {
    workspaceId: string;
    agentId?: string | null;
    scopeId?: string | null;
    adapterType?: string | null;
    taskOutput: unknown;
    taskTitle?: string | null;
  }): Promise<{ created: number; reinforced: number; linked: number }>;
}

export class HarnessMemoryIngestionService {
  #formationPromoter: FormationPromoter | null = null;

  constructor(
    private readonly episodes: EpisodicMemoryStore,
    private readonly logger: Logger,
  ) {}

  /**
   * Wire the formation pipeline (AGENT-TRANSITION §5). Optional: without it,
   * import falls back to the deterministic quality-gate write (operator-curated,
   * always safe). Set once at bootstrap after SharedIntelligence is built.
   */
  setFormationPromoter(promoter: FormationPromoter | null): void {
    this.#formationPromoter = promoter;
  }

  /**
   * Read + distil + quality-gate the agent's harness memory, then annotate each
   * candidate with its dedup verdict against the agent's existing Brain. Pure
   * read — nothing is written.
   */
  preview(agent: IngestibleAgent, minQuality = DEFAULT_MIN_QUALITY): IngestionPreview {
    const files = listAgentInstructionFiles(agent).filter((f) => f.content.trim().length > 0);
    const adapterType = typeof agent.adapterType === 'string' ? agent.adapterType : 'unknown';

    const scannedFiles: IngestionPreview['scannedFiles'] = [];
    const candidates: HarnessMemoryCandidate[] = [];
    const batchHashes = new Set<string>();

    for (const file of files) {
      const fileCandidates = distillFile(file, adapterType, minQuality, batchHashes);
      scannedFiles.push({
        fileName: file.name,
        source: file.source,
        candidateCount: fileCandidates.length,
        skipped: fileCandidates.length === 0,
      });
      candidates.push(...fileCandidates);
    }

    // Annotate dedup verdicts so the UI can show "already known" vs "new".
    for (const cand of candidates) {
      cand.duplicateOf = this.#findDuplicate(agent, cand);
    }

    return { agentId: agent.id, scannedFiles, candidates, minQuality };
  }

  /**
   * Commit accepted candidates into the agent's private Brain. Idempotent:
   * exact-hash and semantic duplicates reinforce the existing episode rather
   * than writing a new one.
   */
  commit(agent: IngestibleAgent, options: IngestionCommitOptions = {}): IngestionCommitResult {
    const minQuality = options.minQuality ?? DEFAULT_MIN_QUALITY;
    const { candidates } = this.preview(agent, minQuality);
    return this.#commitCandidates(agent, candidates, { ...options, minQuality });
  }

  /**
   * Dedup against the agent's existing Brain: exact content-hash match first
   * (cheap, authoritative), then semantic near-duplicate via the store's
   * embedding search.
   */
  #findDuplicate(agent: IngestibleAgent, cand: HarnessMemoryCandidate): { episodeId: string; kind: 'exact' | 'semantic' } | null {
    // Dedup within the scope the candidate will land in: agent-private atoms
    // dedup against the agent scope, workspace atoms against the workspace scope.
    const scopeId = cand.scopeHint === 'workspace' ? undefined : agent.id;

    // Exact: a prior ingest of the same line, identified by stored content hash.
    const existing = this.episodes.list({ workspaceId: agent.workspaceId, scopeId, limit: 500 });
    for (const ep of existing) {
      const hash = harnessContentHash(ep);
      if (hash && hash === cand.hash) return { episodeId: ep.id, kind: 'exact' };
    }

    // Semantic: a paraphrase already in the Brain (from a prior file, a manual
    // note, or a promoted lesson). Reinforce rather than duplicate.
    const similar = this.episodes.findSimilar(
      agent.workspaceId,
      { title: cand.title, summary: cand.summary, scopeId: scopeId ?? null },
      SEMANTIC_DEDUP_THRESHOLD,
    );
    if (similar.length > 0) return { episodeId: similar[0]!.id, kind: 'semantic' };
    return null;
  }

  // ────────────────────────────────────────────────────────────
  // Import path — ingest arbitrary scope-hinted files (AGENT-TRANSITION L3)
  // ────────────────────────────────────────────────────────────

  /**
   * Preview distillation of explicit import files (instruction + real memory
   * stores), each carrying a scope hint. Pure read; annotates dedup verdicts.
   */
  previewImport(agent: IngestibleAgent, files: ImportMemoryFile[], minQuality = DEFAULT_MIN_QUALITY): IngestionPreview {
    const adapterType = typeof agent.adapterType === 'string' ? agent.adapterType : 'unknown';
    const scannedFiles: IngestionPreview['scannedFiles'] = [];
    const candidates: HarnessMemoryCandidate[] = [];
    const batchHashes = new Set<string>();

    for (const file of files) {
      if (!file.content || file.content.trim().length === 0) {
        scannedFiles.push({ fileName: file.name, source: file.scopeHint, candidateCount: 0, skipped: true });
        continue;
      }
      const fileCandidates = distillImportFile(file, adapterType, minQuality, batchHashes);
      scannedFiles.push({ fileName: file.name, source: file.scopeHint, candidateCount: fileCandidates.length, skipped: fileCandidates.length === 0 });
      candidates.push(...fileCandidates);
    }

    // Perf: annotate EXACT dedup only, with the existing content hashes loaded
    // ONCE per scope. The old per-candidate path listed 500 episodes AND computed
    // a semantic embedding for every candidate — minutes on a large brain. The
    // real semantic dedup runs at commit (`#commitCandidates`), where it matters;
    // a semantic paraphrase shown as "new" here is simply reinforced on import,
    // never duplicated.
    const exact = this.#buildExactHashIndex(agent);
    for (const cand of candidates) {
      const scopeHashes = cand.scopeHint === 'workspace' ? exact.workspace : exact.agent;
      const episodeId = scopeHashes.get(cand.hash);
      cand.duplicateOf = episodeId ? { episodeId, kind: 'exact' } : null;
    }
    return { agentId: agent.id, scannedFiles, candidates, minQuality };
  }

  /** Content-hash → episodeId maps for the workspace and agent scopes, built in a
   *  single pass each so preview dedup is O(existing + candidates), not O(product). */
  #buildExactHashIndex(agent: IngestibleAgent): { workspace: Map<string, string>; agent: Map<string, string> } {
    const build = (scopeId?: string): Map<string, string> => {
      const map = new Map<string, string>();
      for (const ep of this.episodes.list({ workspaceId: agent.workspaceId, scopeId, limit: 20000 })) {
        const hash = harnessContentHash(ep);
        if (hash) map.set(hash, ep.id);
      }
      return map;
    };
    return { workspace: build(undefined), agent: build(agent.id) };
  }

  /**
   * Commit accepted import candidates, scope-routed + idempotent. When a
   * formation promoter is wired, the accepted set is FORMED through the canonical
   * pipeline (per scope group); otherwise the deterministic write is used. The
   * deterministic path is also the fallback if formation forms nothing, so an
   * operator-curated atom is never silently lost.
   */
  async commitImport(agent: IngestibleAgent, files: ImportMemoryFile[], options: IngestionCommitOptions = {}): Promise<IngestionCommitResult> {
    const minQuality = options.minQuality ?? DEFAULT_MIN_QUALITY;
    const { candidates } = this.previewImport(agent, files, minQuality);

    if (this.#formationPromoter) {
      const accept = options.acceptHashes ? new Set(options.acceptHashes) : null;
      const accepted = candidates.filter((c) => (!accept || accept.has(c.hash)) && c.quality >= minQuality);
      if (accepted.length > 0) {
        const formed = await this.#formViaPromoter(agent, accepted);
        if (formed) return formed;
      }
    }
    return this.#commitCandidates(agent, candidates, { ...options, minQuality });
  }

  /**
   * Route accepted candidates through the formation pipeline, grouped by scope.
   * Returns null (→ deterministic fallback) when formation forms nothing, so
   * curated content is protected.
   */
  async #formViaPromoter(agent: IngestibleAgent, accepted: HarnessMemoryCandidate[]): Promise<IngestionCommitResult | null> {
    const promoter = this.#formationPromoter;
    if (!promoter) return null;
    const adapterType = typeof agent.adapterType === 'string' ? agent.adapterType : null;
    const groups: Array<{ scopeId: string | null; cands: HarnessMemoryCandidate[] }> = [
      { scopeId: null, cands: accepted.filter((c) => c.scopeHint === 'workspace') },
      { scopeId: agent.id, cands: accepted.filter((c) => c.scopeHint === 'agent') },
    ];

    let created = 0;
    let reinforced = 0;
    for (const group of groups) {
      if (group.cands.length === 0) continue;
      const taskOutput = group.cands.map((c) => `- ${c.summary}`).join('\n');
      try {
        const r = await promoter.promote({
          workspaceId: agent.workspaceId,
          agentId: agent.id,
          scopeId: group.scopeId,
          adapterType,
          taskOutput,
          taskTitle: `Transitioned memory from ${adapterType ?? 'harness'}`,
        });
        created += r.created;
        reinforced += r.reinforced;
      } catch (err) {
        this.logger.warn('harness.memory.formation_failed', { agentId: agent.id, message: (err as Error).message });
        return null; // fall back to deterministic write
      }
    }

    // The judge is strict; if it formed nothing from a curated set, fall back so
    // the operator's reviewed atoms still land.
    if (created === 0 && reinforced === 0) return null;

    this.logger.info('harness.memory.formed', { agentId: agent.id, workspaceId: agent.workspaceId, created, reinforced });
    return { agentId: agent.id, written: created, reinforced, skipped: Math.max(0, accepted.length - created - reinforced), episodeIds: [] };
  }

  /** Shared commit core for both the instruction-file and import paths. */
  #commitCandidates(agent: IngestibleAgent, candidates: HarnessMemoryCandidate[], options: IngestionCommitOptions & { minQuality: number }): IngestionCommitResult {
    const accept = options.acceptHashes ? new Set(options.acceptHashes) : null;
    const result: IngestionCommitResult = { agentId: agent.id, written: 0, reinforced: 0, skipped: 0, episodeIds: [] };

    for (const cand of candidates) {
      if (accept && !accept.has(cand.hash)) continue;
      if (cand.quality < options.minQuality) { result.skipped += 1; continue; }

      const dup = cand.duplicateOf ?? this.#findDuplicate(agent, cand);
      if (dup) {
        this.episodes.reinforce(agent.workspaceId, dup.episodeId, { confidenceDelta: 0.03, trustDelta: 0.02 });
        result.reinforced += 1;
        continue;
      }

      const episode = this.episodes.write({
        workspaceId: agent.workspaceId,
        scopeId: cand.scopeHint === 'workspace' ? null : agent.id,
        agentId: agent.id,
        type: cand.type,
        title: cand.title,
        summary: cand.summary,
        source: 'harness_ingest',
        confidence: clamp01(0.45 + 0.4 * cand.quality),
        importance: cand.importance,
        trust: cand.trust,
        tags: cand.tags,
        metadata: {
          section: cand.section,
          privateScope: cand.scopeHint,
          harness: {
            adapterType: cand.origin.adapterType,
            fileKey: cand.origin.fileKey,
            fileName: cand.origin.fileName,
            instructionSource: cand.origin.instructionSource,
            contentHash: cand.hash,
          },
        },
      });
      result.written += 1;
      result.episodeIds.push(episode.id);
    }

    this.logger.info('harness.memory.ingested', {
      agentId: agent.id,
      workspaceId: agent.workspaceId,
      written: result.written,
      reinforced: result.reinforced,
      skipped: result.skipped,
    });
    return result;
  }
}

// ────────────────────────────────────────────────────────────
// Distillation + quality gate
// ────────────────────────────────────────────────────────────

/** Boilerplate section headings that never carry durable knowledge. */
const BOILERPLATE_HEADINGS = new Set([
  'table of contents', 'contents', 'license', 'changelog', 'getting started',
  'installation', 'install', 'setup', 'prerequisites', 'usage', 'index',
]);

/** Imperative cues that mark a durable rule/convention (raise quality). */
const RULE_CUES = [
  'always', 'never', 'must', 'must not', 'should', 'should not', 'do not', "don't",
  'avoid', 'prefer', 'require', 'ensure', 'use ', 'only ', 'instead of',
];

/** Decision cues that mark a recorded choice. */
const DECISION_CUES = ['we chose', 'we decided', 'decided to', 'chosen', 'rationale', 'because we', 'trade-off', 'tradeoff'];

/**
 * Distil one instruction file into quality-gated candidates.
 *
 * Strategy: walk the markdown, tracking the current heading as the section.
 * Treat each list item or non-empty prose line as a candidate atom. Merge
 * wrapped continuation lines. Score, classify, and gate.
 */
function distillFile(
  file: AgentInstructionFile,
  adapterType: string,
  minQuality: number,
  batchHashes: Set<string>,
): HarnessMemoryCandidate[] {
  // Source-derived base trust: operator-authored project/platform files are
  // trusted more than machine-global runtime defaults.
  const baseTrust = file.source === 'platform' ? 0.82
    : file.source === 'workspace' ? 0.78
    : 0.68; // runtime (home-dir) files
  return distillContent(file.content, {
    adapterType,
    minQuality,
    batchHashes,
    baseTrust,
    // Instruction-file ingestion stays agent-scoped (preserves existing panel).
    scopeHint: 'agent',
    origin: { adapterType, fileKey: file.key, fileName: file.name, instructionSource: file.source },
    extraTags: [],
  });
}

/**
 * Distil an explicit import file (instruction or real memory store), honoring
 * its scope hint and frontmatter type hint (AGENT-TRANSITION L3).
 */
function distillImportFile(
  file: ImportMemoryFile,
  adapterType: string,
  minQuality: number,
  batchHashes: Set<string>,
): HarnessMemoryCandidate[] {
  // Memory-store entries the operator curated are trusted a touch higher than
  // raw instruction prose; workspace rules higher than agent-private notes.
  const baseTrust = file.kind === 'memory' ? 0.8 : file.scopeHint === 'workspace' ? 0.78 : 0.7;
  const instructionSource: AgentInstructionFile['source'] = file.scopeHint === 'workspace' ? 'workspace' : 'runtime';
  const extraTags = file.typeHint ? [`type:${file.typeHint}`] : [];
  return distillContent(file.content, {
    adapterType,
    minQuality,
    batchHashes,
    baseTrust,
    scopeHint: file.scopeHint,
    origin: { adapterType, fileKey: file.path, fileName: file.name, instructionSource },
    extraTags,
  });
}

interface DistillCtx {
  adapterType: string;
  minQuality: number;
  batchHashes: Set<string>;
  baseTrust: number;
  scopeHint: ImportScopeHint;
  origin: HarnessMemoryCandidate['origin'];
  extraTags: string[];
}

/**
 * Shared distillation: walk the markdown, tracking the current heading as the
 * section, treat each list item / prose line as a candidate atom, score, gate,
 * classify, and stamp scope. Used by both the instruction-file and import paths.
 */
function distillContent(content: string, ctx: DistillCtx): HarnessMemoryCandidate[] {
  const out: HarnessMemoryCandidate[] = [];
  const lines = content.split(/\r?\n/);
  let section = 'General';
  let inCodeFence = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('```')) { inCodeFence = !inCodeFence; continue; }
    if (inCodeFence || line.length === 0) continue;

    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      section = cleanHeading(heading[1] ?? 'General');
      continue;
    }

    const atomText = normalizeAtom(line);
    if (!atomText) continue;

    const quality = scoreAtom(atomText, section);
    if (quality < ctx.minQuality) continue;

    const hash = sha256(atomText.toLowerCase());
    if (ctx.batchHashes.has(hash)) continue; // de-dupe within this batch
    ctx.batchHashes.add(hash);

    out.push({
      hash,
      title: makeTitle(atomText, section),
      summary: atomText,
      type: classifyType(atomText),
      section,
      quality,
      trust: clamp01(ctx.baseTrust),
      importance: ruleStrength(atomText),
      scopeHint: ctx.scopeHint,
      tags: ['harness_ingest', 'harness_transition', ctx.adapterType, ...ctx.extraTags],
      origin: ctx.origin,
      duplicateOf: null,
    });
  }
  return out;
}

/** Strip list markers, checkboxes, and surrounding emphasis from a line. */
function normalizeAtom(line: string): string | null {
  let t = line
    .replace(/^[-*+]\s+/, '')        // bullet
    .replace(/^\d+[.)]\s+/, '')      // ordered list
    .replace(/^\[[ xX]\]\s+/, '')    // checkbox
    .replace(/^>\s+/, '')            // blockquote
    .trim();
  // Drop wrapping bold/italic that some files use for whole-line emphasis.
  t = t.replace(/^\*\*(.+)\*\*$/, '$1').replace(/^_(.+)_$/, '$1').trim();
  if (t.length === 0) return null;
  return t;
}

/**
 * Quality gate: a 0..1 score combining length, informativeness, rule-cue
 * presence, and specificity, minus penalties for noise. The threshold check is
 * applied by the caller.
 */
function scoreAtom(text: string, section: string): number {
  const lower = text.toLowerCase();
  const words = text.split(/\s+/).filter(Boolean);

  // Hard rejects → quality 0.
  if (words.length < 4) return 0;                       // too short to be a fact
  if (text.length < 20) return 0;
  if (/^https?:\/\/\S+$/.test(text)) return 0;          // bare URL
  if (BOILERPLATE_HEADINGS.has(lower)) return 0;
  if (/^(see|refer to|read)\b/.test(lower) && words.length < 8) return 0; // pointer fluff
  if (/^[#`>|=_\-\s]+$/.test(text)) return 0;           // separators / table rules

  let score = 0.35;

  // Length sweet spot: substantive but not a paragraph dump.
  if (words.length >= 6 && words.length <= 40) score += 0.18;
  else if (words.length > 40) score += 0.05; // long lines are usually prose, lower value

  // Rule/convention cues — the highest-value harness knowledge.
  if (RULE_CUES.some((cue) => lower.includes(cue))) score += 0.22;

  // Decision cues.
  if (DECISION_CUES.some((cue) => lower.includes(cue))) score += 0.15;

  // Specificity: concrete identifiers, paths, code refs, commands.
  if (/[`/]\w|\.\w{1,4}\b|--?\w|\b\w+\(\)/.test(text)) score += 0.12;

  // A meaningful section (Conventions/Rules/Architecture/Decisions) boosts.
  if (/(convention|rule|guideline|architecture|decision|style|do|don'?t|must|never)/i.test(section)) {
    score += 0.1;
  }

  // Penalties for low-signal phrasing.
  if (/^(this|that|it|here|note that|for example|e\.g\.)/i.test(text)) score -= 0.1;
  if (/\b(todo|tbd|wip|placeholder|lorem ipsum)\b/i.test(lower)) score -= 0.3;

  return clamp01(score);
}

/** Map an atom to the closest runtime episode type. */
function classifyType(text: string): RuntimeEpisodeType {
  const lower = text.toLowerCase();
  if (DECISION_CUES.some((cue) => lower.includes(cue))) return 'decision';
  if (/\b(fail|broke|error|regress|pitfall|gotcha|caused)\b/.test(lower)) return 'failure';
  if (/\b(pattern|always works|reliable|standard approach)\b/.test(lower)) return 'success_pattern';
  // Default: an operator-authored convention is a distilled lesson.
  return 'distilled_lesson';
}

/** Rule strength → importance 0..1. Imperative rules are more consequential. */
function ruleStrength(text: string): number {
  const lower = text.toLowerCase();
  if (/\b(never|must not|do not|don'?t|always|must)\b/.test(lower)) return 0.78;
  if (/\b(should|prefer|avoid|ensure|require)\b/.test(lower)) return 0.62;
  return 0.5;
}

/** Build a compact title from the atom + section. */
function makeTitle(text: string, section: string): string {
  const firstClause = text.split(/[.;:]\s/)[0] ?? text;
  const trimmed = firstClause.length > 72 ? `${firstClause.slice(0, 69)}…` : firstClause;
  return section && section !== 'General' ? `${section}: ${trimmed}` : trimmed;
}

function cleanHeading(h: string): string {
  return h.replace(/[`*_#]/g, '').trim().slice(0, 60) || 'General';
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

/** Read the stored harness content hash off an episode (if it was harness-ingested). */
function harnessContentHash(ep: RuntimeEpisode): string | null {
  const harness = ep.metadata?.harness;
  if (harness && typeof harness === 'object' && !Array.isArray(harness)) {
    const h = (harness as Record<string, unknown>).contentHash;
    if (typeof h === 'string' && h.length > 0) return h;
  }
  return null;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
