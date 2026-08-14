import { describe, expect, it } from 'vitest';
import { initialTurnActivityLabel } from '../src/chatProgress.js';

describe('initialTurnActivityLabel', () => {
  it('creates concise contextual states without using the model', () => {
    expect(initialTurnActivityLabel('do a quick check on the interface')).toBe('Starting the interface check');
    expect(initialTurnActivityLabel('review our workspace health')).toBe('Starting the workspace check');
    expect(initialTurnActivityLabel('fix the failed workflow')).toBe('Starting the diagnosis');
  });

  it('does not turn a greeting into a work trace', () => {
    expect(initialTurnActivityLabel('hello')).toBe('Request received');
  });
});
