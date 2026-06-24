import { describe, expect, it } from 'vitest';
import {
  compactRuntimeProgressLabel,
  runtimeProgressActivity,
} from '../../src/adapters/runtimeProgress.js';

describe('runtime progress normalization', () => {
  it('keeps long progress text for responsive frontend truncation', () => {
    const label = compactRuntimeProgressLabel(
      'I will inspect the entire workspace configuration and compare every runtime adapter before applying the shared protocol fix',
    );

    expect(label).toBe(
      'Inspecting the entire workspace configuration and compare every runtime adapter before applying the shared protocol fix',
    );
    expect(label.length).toBeGreaterThan(84);
  });

  it('turns private reasoning into a safe high-level activity', () => {
    expect(runtimeProgressActivity({
      id: 'reasoning',
      runtimeName: 'Hermes',
      text: 'I should inspect the workspace files and repository context.',
      reasoning: true,
    })).toMatchObject({
      type: 'activity',
      phase: 'runtime',
      status: 'running',
      label: 'Reviewing workspace context',
    });
  });
});
