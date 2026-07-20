import { beforeEach, describe, expect, it } from 'vitest';
import {
  embedText,
  embeddingLatencyStats,
  resetEmbeddingLatencyStats,
} from '../../src/services/embedding/embeddingProvider.js';
import type { EmbeddingProvider } from '../../src/services/embedding/embeddingProvider.js';

/**
 * §B5.10 — every brain write awaits an embedding inline and nothing measured
 * it, so "what does storing a memory cost?" was unanswerable. These assert the
 * meter exists and separates the cold model load from steady-state cost.
 */
function providerTaking(ms: number): EmbeddingProvider {
  return {
    type: 'local',
    dimension: 3,
    modelId: 'local:test',
    async embed() {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return [1, 0, 0];
    },
  } as unknown as EmbeddingProvider;
}

beforeEach(() => resetEmbeddingLatencyStats());

describe('embedding latency instrumentation', () => {
  it('starts empty', () => {
    const stats = embeddingLatencyStats();
    expect(stats.count).toBe(0);
    expect(stats.coldStartMs).toBeNull();
  });

  it('attributes the FIRST embed to cold start so it never skews the percentiles', async () => {
    const provider = providerTaking(1);
    await embedText(provider, 'first — stands in for the model load');
    const afterFirst = embeddingLatencyStats();
    expect(afterFirst.coldStartMs).not.toBeNull();
    expect(afterFirst.count).toBe(0);

    await embedText(provider, 'second');
    expect(embeddingLatencyStats().count).toBe(1);
  });

  it('records steady-state cost after the cold start', async () => {
    const provider = providerTaking(1);
    for (let i = 0; i < 5; i += 1) await embedText(provider, `text ${i}`);
    const stats = embeddingLatencyStats();
    expect(stats.count).toBe(4); // 5 calls − 1 cold start
    expect(stats.p50Ms).toBeGreaterThanOrEqual(0);
    expect(stats.maxMs).toBeGreaterThanOrEqual(stats.p50Ms);
    expect(stats.meanMs).toBeLessThanOrEqual(stats.maxMs);
  });

  it('counts failures without recording them as latency samples', async () => {
    const failing = {
      type: 'local', dimension: 3, modelId: 'local:test',
      embed: () => Promise.reject(new Error('model unavailable')),
    } as unknown as EmbeddingProvider;

    await expect(embedText(failing, 'boom')).rejects.toThrow('model unavailable');
    const stats = embeddingLatencyStats();
    expect(stats.errorCount).toBe(1);
    expect(stats.count).toBe(0);
    expect(stats.coldStartMs).toBeNull();
  });

  it('reports the slow threshold so a caller can explain a slow write', () => {
    expect(embeddingLatencyStats().slowThresholdMs).toBeGreaterThan(0);
  });
});
