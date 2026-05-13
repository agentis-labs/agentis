/**
 * EmbeddingProvider — pluggable embedding generation for vector retrieval.
 *
 * Spec: docs/APP-KNOWLEDGE-WEDGE-ARCHITECTURE.md §10
 * "Vector retrieval is reserved on the schema (`embedding` column). The swap
 *  is a single retriever change."
 *
 * This module provides:
 *
 *   1. `EmbeddingProvider` interface — inject any embedding model (OpenAI,
 *      Cohere, local ONNX, etc.) by implementing two methods.
 *
 *   2. `HashingEmbeddingProvider` — built-in, dependency-free, 512-dimensional
 *      feature-hashing provider. Uses a polynomial rolling hash to map tokens
 *      into a fixed-size vector, then L2-normalises. Produces valid cosine
 *      similarity scores without any external model calls.
 *
 *      Properties:
 *        - Deterministic: same text → same vector, always.
 *        - Corpus-independent: no IDF table, no global state.
 *        - Zero dependencies: uses only the tokeniser already in KnowledgeStore.
 *        - Swappable: drop-in replacement for any float[] embedding provider.
 *
 *      Limitations:
 *        - No semantic understanding (still lexical at heart).
 *        - Hash collisions introduce mild noise (manageable at 512 dims for
 *          vocabularies < 50k tokens).
 *        - Semantic retrieval requires an external model (OpenAI, Cohere, …).
 *
 * Usage:
 *
 *   // Built-in (zero deps):
 *   const provider = new HashingEmbeddingProvider();
 *
 *   // External (OpenAI-compatible, pseudo-code):
 *   const provider: EmbeddingProvider = {
 *     dimension: 1536,
 *     embed: async (text) => callOpenAIEmbeddings(text),
 *   };
 *
 *   const store = new KnowledgeStore(db, logger, provider);
 */

import { KnowledgeStore } from './knowledgeStore.js';

// ────────────────────────────────────────────────────────────
// Interface
// ────────────────────────────────────────────────────────────

export interface EmbeddingProvider {
  /** Output dimension (all vectors must have exactly this length). */
  readonly dimension: number;
  /**
   * Embed `text` and return a float[] of length `dimension`.
   *
   * The returned vector MUST be L2-normalised so that cosine similarity
   * reduces to a dot product (the fast path in `KnowledgeStore.search()`).
   * If your provider returns un-normalised embeddings, wrap it:
   *
   *   embed: async (text) => l2Normalize(await rawEmbed(text))
   */
  embed(text: string): number[] | Promise<number[]>;
}

// ────────────────────────────────────────────────────────────
// Built-in: HashingEmbeddingProvider
// ────────────────────────────────────────────────────────────

/** Number of dimensions. 512 is a common choice for feature-hashing models. */
const HASHING_DIMS = 512;

/**
 * Dependency-free 512-dimensional feature-hashing embedding provider.
 *
 * Algorithm:
 *   1. Tokenise text using `KnowledgeStore.tokenize()` (shared with the
 *      lexical retriever so the two paths are comparable).
 *   2. For each token, compute `slot = polynomialHash(token) % DIMS`.
 *      Accumulate frequency counts per slot.
 *   3. L2-normalise the count vector → unit vector.
 *
 * Cosine similarity between two unit vectors is their dot product, which is
 * O(DIMS) regardless of document length — significantly faster than the
 * current TF-IDF path once embeddings are pre-computed at write time.
 */
export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly dimension = HASHING_DIMS;

  embed(text: string): number[] {
    const tokens = KnowledgeStore.tokenize(text);
    if (tokens.length === 0) return new Array<number>(HASHING_DIMS).fill(0);

    const vec = new Float64Array(HASHING_DIMS);
    for (const token of tokens) {
      const slot = polynomialHash(token, HASHING_DIMS);
      // Float64Array[i] is always a number (TypedArray guarantees initialisation to 0).
      vec[slot] = (vec[slot] ?? 0) + 1;
    }

    // L2-normalise: compute norm then divide each element.
    let sumSq = 0;
    for (let i = 0; i < HASHING_DIMS; i++) sumSq += (vec[i] ?? 0) * (vec[i] ?? 0);
    const norm = Math.sqrt(sumSq);
    if (norm === 0) return Array.from(vec);
    // Build result via push to avoid `noUncheckedIndexedAccess` on `result[i]`.
    const result: number[] = [];
    for (let i = 0; i < HASHING_DIMS; i++) result.push((vec[i] ?? 0) / norm);
    return result;
  }
}

// ────────────────────────────────────────────────────────────
// Math helpers (exported for use by KnowledgeStore and tests)
// ────────────────────────────────────────────────────────────

/**
 * Dot product of two equal-length vectors.
 *
 * When both vectors are L2-normalised this equals cosine similarity. Clamps
 * to [-1, 1] to absorb floating-point rounding errors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return Math.max(-1, Math.min(1, dot));
}

/**
 * Polynomial rolling hash: maps a token to a slot in [0, dims).
 *
 * Uses the same base-31 polynomial as Java's String.hashCode(). The
 * `| 0` cast keeps arithmetic in signed 32-bit land to stay fast; Math.abs
 * converts negative hashes to valid indices.
 */
function polynomialHash(token: string, dims: number): number {
  let h = 0;
  for (let i = 0; i < token.length; i++) {
    h = (Math.imul(31, h) + token.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % dims;
}

/**
 * L2-normalise a float array in place. Returns the same array.
 * Exported for providers that return raw (un-normalised) embeddings.
 */
export function l2Normalize(vec: number[]): number[] {
  let sumSq = 0;
  for (const x of vec) sumSq += x * x;
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return vec;
  for (let i = 0; i < vec.length; i++) vec[i] = vec[i]! / norm;
  return vec;
}
