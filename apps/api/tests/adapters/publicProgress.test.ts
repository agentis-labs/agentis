import { describe, expect, it } from 'vitest';
import { compactPublicProgress, PUBLIC_PROGRESS_MAX_CHARS } from '../../src/adapters/publicProgress.js';

describe('compactPublicProgress', () => {
  it('keeps only the first sentence of a progress paragraph', () => {
    expect(compactPublicProgress('I found the cause. I am checking the repair now.')).toBe('I found the cause.');
  });

  it('hard-caps a long sentence without splitting into a verbose log', () => {
    const result = compactPublicProgress('Working through the relevant implementation details '.repeat(20));
    expect(result.length).toBe(PUBLIC_PROGRESS_MAX_CHARS);
    expect(result.endsWith('…')).toBe(true);
  });
});
