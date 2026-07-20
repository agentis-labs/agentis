import { describe, expect, it } from 'vitest';
import { DEDUP_CANDIDATE_FLOOR, resolveDuplicate, type EpisodeVector } from '../../src/services/util/brainDedup.js';
import { directivePolarity, directiveTopicSignature } from '../../src/services/memory/memoryReflectionService.js';
import { redactForMemory, segment, tokenize } from '../../src/services/brain/brainText.js';

/**
 * Calibration facts measured against the real bundled embedding model
 * (Xenova/multilingual-e5-small, `query:` prefix, mean-pooled, normalized —
 * exactly what LocalEmbeddingProvider produces). Recorded here so the numbers
 * that justify the dedup design are checked, not just commented.
 *
 *   unrelated text             0.7627 – 0.8004
 *   TRUE duplicates            0.9209 – 0.9739
 *   same topic, DIFFERENT rule 0.8921 – 0.9688
 *   CONTRADICTIONS             0.9347 – 0.9763   ← the highest band of all
 *
 * The load-bearing consequence: the non-duplicate ceiling (0.9763) is ABOVE the
 * duplicate floor (0.9209), so duplicate-vs-contradiction is NOT separable by
 * any cosine threshold. Anything that reintroduces a "score >= X → merge" rule
 * will fail these tests.
 */
const MEASURED = {
  unrelatedMax: 0.8004,
  duplicateMin: 0.9209,
  nearMissMax: 0.9688,
  contradictionMax: 0.9763,
};

/** Two unit vectors with an exact known cosine, so tests assert on the rule, not on a model. */
function vectorPairAt(cosine: number): { a: number[]; b: number[] } {
  const angle = Math.acos(Math.min(1, Math.max(-1, cosine)));
  return { a: [1, 0], b: [Math.cos(angle), Math.sin(angle)] };
}

function entry(id: string, text: string, vec: number[] | null): EpisodeVector {
  return { id, vec, text };
}

describe('dedup calibration — cosine is a candidate signal, never a decision', () => {
  it('records that duplicates and non-duplicates OVERLAP, so no threshold can separate them', () => {
    expect(MEASURED.contradictionMax).toBeGreaterThan(MEASURED.duplicateMin);
    expect(MEASURED.nearMissMax).toBeGreaterThan(MEASURED.duplicateMin);
  });

  it('treats an unrelated neighbour as distinct', () => {
    const { a, b } = vectorPairAt(MEASURED.unrelatedMax);
    const verdict = resolveDuplicate({
      text: 'Rotate the API key every 90 days',
      vec: a,
      existing: [entry('e1', 'Traffic was heavy this morning', b)],
    });
    expect(verdict.kind).toBe('distinct');
  });

  it('does NOT merge a contradiction, even at the highest measured similarity', () => {
    const { a, b } = vectorPairAt(MEASURED.contradictionMax);
    const verdict = resolveDuplicate({
      text: 'nunca faça deploy na sexta',
      vec: a,
      existing: [entry('e1', 'sempre faça deploy na sexta', b)],
    });
    expect(verdict.kind).toBe('contested');
    if (verdict.kind === 'contested') expect(verdict.reason).toBe('polarity_conflict');
  });

  it('does NOT merge a same-topic different rule (the near-miss band)', () => {
    const { a, b } = vectorPairAt(MEASURED.nearMissMax);
    const verdict = resolveDuplicate({
      text: 'Retry failed webhooks five times',
      vec: a,
      existing: [entry('e1', 'Retry failed webhooks three times', b)],
    });
    expect(verdict.kind).toBe('contested');
  });

  it('merges only a provably identical restatement', () => {
    const { a, b } = vectorPairAt(0.99);
    const verdict = resolveDuplicate({
      text: 'Always use HTTPS for API endpoints.',
      vec: a,
      existing: [entry('e1', 'Always use HTTPS for API endpoints.', b)],
    });
    expect(verdict.kind).toBe('duplicate');
  });

  it('matches an identical statement across the title/summary composite shape', () => {
    // Stored atoms are `title\nsummary`; callers pass a bare statement or
    // `title\ncontent`. A literal restatement must still collapse.
    const { a, b } = vectorPairAt(0.99);
    const verdict = resolveDuplicate({
      text: 'Always use HTTPS for API endpoints.',
      vec: a,
      existing: [entry('e1', 'Always use HTTPS for API endpoints.\nAlways use HTTPS for API endpoints.', b)],
    });
    expect(verdict.kind).toBe('duplicate');
  });

  it('does not collapse two agent notes merely because they share a section heading', () => {
    const verdict = resolveDuplicate({
      text: 'Notes\nThe staging cluster runs an older Postgres than prod',
      vec: null,
      existing: [entry('e1', 'Notes\nRotate the signing key every quarter', null)],
    });
    expect(verdict.kind).not.toBe('duplicate');
  });

  it('keeps the candidate floor above the measured unrelated ceiling', () => {
    expect(DEDUP_CANDIDATE_FLOOR).toBeGreaterThan(MEASURED.unrelatedMax);
  });
});

describe('directive polarity is multilingual', () => {
  it('detects a Portuguese correction as an opposing directive', () => {
    expect(directivePolarity('sempre faça deploy na sexta')).toBe(1);
    expect(directivePolarity('nunca faça deploy na sexta')).toBe(-1);
  });

  it.each([
    ['Always back up before deploying', 'Never back up before deploying'],
    ['Siempre revisa los logs', 'Nunca revises los logs'],
    ['Immer vor dem Deploy sichern', 'Niemals vor dem Deploy sichern'],
    ['Всегда делай резервную копию', 'Никогда не делай резервную копию'],
  ])('opposes: %s / %s', (positive, negative) => {
    expect(directivePolarity(positive)).toBe(1);
    expect(directivePolarity(negative)).toBe(-1);
  });

  it('does not fire inside an unrelated word (Cyrillic boundary safety)', () => {
    // "не" is a prohibition marker; "неделя" (week) merely contains it.
    expect(directivePolarity('поставки каждую неделю')).toBe(0);
  });

  it('reduces an opposing pair to the same topic signature', () => {
    const a = directiveTopicSignature('sempre faça deploy na sexta');
    const b = directiveTopicSignature('nunca faça deploy na sexta');
    expect([...a].sort()).toEqual([...b].sort());
  });
});

describe('tokenization is Unicode-aware across the whole brain', () => {
  it.each([
    ['部署前请务必备份', 8],
    ['Никогда не деплой в пятницу', 5],
  ])('segments non-Latin text instead of deleting it: %s', (text, expected) => {
    expect(segment(text)).toHaveLength(expected);
  });

  it('preserves Portuguese accents instead of shattering the word', () => {
    expect(tokenize('configuração de segurança')).toEqual(['configuração', 'segurança']);
  });

  it('is byte-identical to the previous behaviour for ASCII input', () => {
    expect(tokenize('Always run the migration before deploying'))
      .toEqual(['always', 'run', 'migration', 'deploying']);
  });
});

describe('PII redaction for external-sender memory', () => {
  it.each([
    ['card', 'my card 4111 1111 1111 1111 was declined', 'redacted:card'],
    ['email', 'write to me at joao.silva@example.com', 'redacted:email'],
    ['phone', 'call me on +55 11 98765 4321 tomorrow', 'redacted:phone'],
    ['cpf', 'meu CPF é 123.456.789-09', 'redacted:cpf'],
    ['ssn', 'ssn 123-45-6789 on file', 'redacted:ssn'],
    ['token', 'the key is sk_live_ABCDEFGHIJKLMNOPQRS', 'redacted:token'],
  ])('redacts a %s', (_label, input, marker) => {
    const out = redactForMemory(input);
    expect(out).toContain(marker);
  });

  it('keeps the surrounding sentence — the statement is what is worth learning', () => {
    const out = redactForMemory('My card 4111 1111 1111 1111 was declined at checkout every time.');
    expect(out).toMatch(/was declined at checkout every time/);
  });

  it('leaves ordinary numbers alone', () => {
    // Redaction must not eat the specifics that make a memory useful.
    const text = 'Retry 3 times, timeout after 30 seconds, since the 2024 migration.';
    expect(redactForMemory(text)).toBe(text);
  });
});
