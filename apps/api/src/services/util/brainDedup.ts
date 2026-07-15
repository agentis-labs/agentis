import { cosineSimilarity } from '../embedding/embeddingProvider.js';
import { similarity } from '../brain/sharedIntelligenceUtils.js';

/**
 * Above this cosine similarity, a new candidate is treated as the SAME memory
 * as an existing one and reinforces it instead of writing a duplicate. Shared
 * across every write path that can create a durable atom (the Formation
 * Judge's ADD path, the no-model staging fallback, and explicit-write paths
 * like App Brain and an agent's own `memory_append`) so "which surface wrote
 * this" never determines whether duplicate-detection exists at all.
 */
export const EMBED_HIGH_SIMILARITY = 0.88;

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
