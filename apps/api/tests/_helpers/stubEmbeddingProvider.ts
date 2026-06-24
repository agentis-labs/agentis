import type { EmbeddingProvider } from '../../src/services/embeddingProvider.js';

/**
 * Deterministic, dependency-free embedding provider for TESTS ONLY.
 *
 * Production no longer ships a non-semantic provider (hashing was deleted — the
 * real default is the local ONNX `multilingual-e5-small`). But unit tests must
 * stay fast and offline, so they inject this fixed-dimension feature-hash stub
 * instead of downloading a model. It is intentionally NOT exported from `src`.
 */
const STUB_DIMS = 384;

export class StubEmbeddingProvider implements EmbeddingProvider {
  readonly dimension = STUB_DIMS;
  readonly modelId = `stub-test-${STUB_DIMS}`;

  embed(text: string): number[] {
    const tokens = text.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
    const vec = new Float64Array(STUB_DIMS);
    for (const token of tokens) {
      let h = 0;
      for (let i = 0; i < token.length; i++) h = (Math.imul(31, h) + token.charCodeAt(i)) | 0;
      const slot = Math.abs(h) % STUB_DIMS;
      vec[slot] = (vec[slot] ?? 0) + 1;
    }
    let sumSq = 0;
    for (let i = 0; i < STUB_DIMS; i++) sumSq += (vec[i] ?? 0) * (vec[i] ?? 0);
    const norm = Math.sqrt(sumSq);
    const out: number[] = [];
    for (let i = 0; i < STUB_DIMS; i++) out.push(norm === 0 ? 0 : (vec[i] ?? 0) / norm);
    return out;
  }
}
