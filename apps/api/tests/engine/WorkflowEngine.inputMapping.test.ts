import { describe, expect, it } from 'vitest';
import { mapInputs } from '../../src/engine/WorkflowEngine.js';

describe('WorkflowEngine input mappings', () => {
  it('accepts literal structured values without treating them as string paths', () => {
    const literal = { mode: 'strict', retries: 2 };
    const result = mapInputs(
      {
        config: literal,
        enabled: true,
        threshold: 0.8,
        empty: null,
        candidateId: 'inputs.candidate.id',
        checkpoint: 'scratchpad.progress.checkpoint',
      },
      { candidate: { id: 'lead-1' } },
      { progress: { checkpoint: 3 } },
    );

    expect(result).toEqual({
      config: literal,
      enabled: true,
      threshold: 0.8,
      empty: null,
      candidateId: 'lead-1',
      checkpoint: 3,
    });
  });
});
