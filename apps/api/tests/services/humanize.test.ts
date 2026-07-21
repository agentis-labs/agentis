import { describe, expect, it } from 'vitest';
import { resolveHumanize, normalizePersona, typingDelayMs, chunkText } from '../../src/services/conversation/humanize.js';

describe('humanize', () => {
  it('resolves personas, defaulting unknown to instant', () => {
    expect(resolveHumanize('human').enabled).toBe(true);
    expect(resolveHumanize('warm').enabled).toBe(true);
    expect(resolveHumanize('instant').enabled).toBe(false);
    expect(resolveHumanize(undefined).enabled).toBe(false);
    expect(resolveHumanize('nonsense').enabled).toBe(false);
    expect(normalizePersona('WARM')).toBe('warm');
    expect(normalizePersona('x')).toBe('instant');
  });

  it('instant persona has zero typing delay', () => {
    expect(typingDelayMs(500, resolveHumanize('instant'))).toBe(0);
  });

  it('scales typing delay with length and clamps to the ceiling', () => {
    const cfg = resolveHumanize('human');
    const short = typingDelayMs(1, cfg, () => 0.5); // jitter neutral-ish
    const long = typingDelayMs(100_000, cfg, () => 0.5);
    expect(short).toBeGreaterThan(0);
    expect(long).toBeGreaterThan(short);
    expect(long).toBeLessThanOrEqual(Math.round(cfg.maxDelayMs * 1.15));
  });

  it('does not chunk short text or when disabled', () => {
    expect(chunkText('hello world', resolveHumanize('human'))).toEqual(['hello world']);
    const long = 'x'.repeat(2000);
    expect(chunkText(long, resolveHumanize('instant'))).toEqual([long]);
  });

  it('splits long multi-paragraph text into multiple bounded chunks', () => {
    const cfg = resolveHumanize('human');
    const para = 'This is a sentence. '.repeat(60); // ~1200 chars
    const chunks = chunkText(`${para}\n\n${para}`, cfg);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(cfg.maxChunkChars + 40);
  });

  it('returns no chunks for empty text', () => {
    expect(chunkText('   ', resolveHumanize('human'))).toEqual([]);
  });
});
