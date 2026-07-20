import { cosineSimilarity } from '../embedding/embeddingProvider.js';
import { similarity } from '../brain/sharedIntelligenceUtils.js';
import { segment, directivePolarity, directiveTopicSignature } from '../brain/brainText.js';
import { jaccard } from '../memory/memoryReflectionService.js';

/**
 * §B5.5 — cosine is a CANDIDATE signal, never a decision.
 *
 * Measured against the real bundled model (multilingual-e5-small, `query:`
 * prefix, mean-pooled, normalized — i.e. exactly what LocalEmbeddingProvider
 * produces):
 *
 *   unrelated text            0.7627 – 0.8004
 *   TRUE duplicates           0.9209 – 0.9739
 *   same topic, DIFFERENT rule 0.8921 – 0.9688   ← overlaps duplicates
 *   CONTRADICTIONS            0.9347 – 0.9763   ← HIGHER than duplicates
 *
 * The highest-scoring pair in the whole set was a contradiction:
 * "sempre faça deploy na sexta" ~ "nunca faça deploy na sexta" = 0.9763.
 * A contradiction is the MOST similar thing to the rule it overturns, so the
 * non-duplicate ceiling (0.9763) sits above the duplicate floor (0.9209) and
 * **no global cosine threshold can separate them.** The previous design —
 * `score >= 0.88 → reinforce the old atom and discard the new text` — therefore
 * fired hardest on exactly the writes that mattered most: an operator
 * correcting their agent reinforced the rule they were trying to overturn.
 *
 * The replacement never merges on similarity alone. Cosine only nominates a
 * candidate; a separate, decisive signal resolves it.
 */
export const DEDUP_CANDIDATE_FLOOR = 0.90;

/**
 * Retained for callers that still want the old constant's meaning (an
 * "unusually similar" marker). It is NOT a merge authority any more — use
 * `resolveDuplicate`.
 */
export const EMBED_HIGH_SIMILARITY = DEDUP_CANDIDATE_FLOOR;

export type DuplicateResolution =
  /** Nothing close enough to be the same memory — write it. */
  | { kind: 'distinct' }
  /** Provably the same statement — safe to reinforce instead of duplicating. */
  | { kind: 'duplicate'; entry: EpisodeVector; score: number; reason: string }
  /**
   * Close, but NOT provably the same — may be a refinement, a near-miss, or a
   * direct contradiction. Must never be silently merged: write it and let a
   * decider (the Formation Judge, the reflection sweep, or the operator via the
   * dispute machinery) resolve the pair.
   */
  | { kind: 'contested'; entry: EpisodeVector; score: number; reason: string };

/**
 * Normalized statement identity — the one duplicate test that cannot be fooled.
 *
 * Both sides arrive as composites: stored entries are `title\nsummary` and
 * callers pass `title\ncontent` or `section\ncontent`, where the title is
 * usually a truncation of the body. Comparing the composites verbatim therefore
 * never matches even for a literally identical restatement. Comparing the
 * LONGEST line isolates the substantive body on both sides, and avoids the
 * false match that per-line comparison would produce on a shared boilerplate
 * heading (every agent note starts with the section "Notes").
 */
function longestNormalizedLine(text: string): string {
  let best = '';
  for (const line of text.split('\n')) {
    const normalized = segment(line).join(' ');
    if (normalized.length > best.length) best = normalized;
  }
  return best;
}

function sameStatement(a: string, b: string): boolean {
  const left = longestNormalizedLine(a);
  const right = longestNormalizedLine(b);
  return left.length > 0 && left === right;
}

/**
 * Decide what a near-neighbour means. See DEDUP_CANDIDATE_FLOOR for why this
 * cannot be a threshold comparison.
 *
 * Order matters: polarity is checked BEFORE any merge, because opposing
 * directives are the highest-scoring neighbours of all.
 */
export function resolveDuplicate(args: {
  text: string;
  vec: number[] | null;
  existing: EpisodeVector[];
}): DuplicateResolution {
  const best = args.vec ? bestCosine(args.existing, args.vec) : bestLexical(args.existing, args.text);
  if (!best || best.score < DEDUP_CANDIDATE_FLOOR) return { kind: 'distinct' };

  // Identical after Unicode segmentation: genuinely the same statement restated.
  // This is the ONLY case where merging is provably lossless.
  if (sameStatement(args.text, best.entry.text)) {
    return { kind: 'duplicate', entry: best.entry, score: best.score, reason: 'identical_statement' };
  }

  // Opposing directive on the same topic — a correction, not a duplicate.
  const polarity = directivePolarity(args.text);
  if (
    polarity !== 0
    && directivePolarity(best.entry.text) === -polarity
    && jaccard(directiveTopicSignature(args.text), directiveTopicSignature(best.entry.text)) >= 0.4
  ) {
    return { kind: 'contested', entry: best.entry, score: best.score, reason: 'polarity_conflict' };
  }

  // Similar but unverified. Cannot be distinguished from a contradiction by any
  // embedding, so it is preserved rather than merged.
  return { kind: 'contested', entry: best.entry, score: best.score, reason: 'similar_unverified' };
}

export interface EpisodeVector {
  id: string;
  vec: number[] | null;
  text: string;
}

export interface ScoredEpisode {
  entry: EpisodeVector;
  score: number;
}

/** Best cosine match among episodes that carry a comparable embedding. */
export function bestCosine(entries: EpisodeVector[], vec: number[]): ScoredEpisode | null {
  let best: ScoredEpisode | null = null;
  for (const entry of entries) {
    if (!entry.vec || entry.vec.length !== vec.length) continue;
    const score = cosineSimilarity(vec, entry.vec);
    if (!best || score > best.score) best = { entry, score };
  }
  return best;
}

/** Lexical fallback when no embedding is available for a candidate. */
export function bestLexical(entries: EpisodeVector[], fact: string): ScoredEpisode | null {
  let best: ScoredEpisode | null = null;
  for (const entry of entries) {
    const score = similarity(fact, entry.text);
    if (!best || score > best.score) best = { entry, score };
  }
  return best;
}
