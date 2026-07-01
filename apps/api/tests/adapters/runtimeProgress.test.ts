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

  it('surfaces the REAL reasoning text by default (operator-facing legibility)', () => {
    expect(runtimeProgressActivity({
      id: 'reasoning',
      runtimeName: 'Hermes',
      text: 'I should inspect the workspace files and repository context.',
      reasoning: true,
    })).toMatchObject({
      type: 'activity',
      phase: 'runtime',
      status: 'running',
      label: 'I should inspect the workspace files and repository context.',
    });
  });

  it('redacts reasoning to a high-level phase when AGENTIS_REDACT_REASONING is set', () => {
    const prev = process.env.AGENTIS_REDACT_REASONING;
    process.env.AGENTIS_REDACT_REASONING = '1';
    try {
      expect(runtimeProgressActivity({
        id: 'reasoning',
        runtimeName: 'Hermes',
        text: 'I should inspect the workspace files and repository context.',
        reasoning: true,
      }).label).toBe('Reviewing workspace context');
    } finally {
      if (prev === undefined) delete process.env.AGENTIS_REDACT_REASONING;
      else process.env.AGENTIS_REDACT_REASONING = prev;
    }
  });

  it('scrubs secrets from surfaced reasoning text', () => {
    const label = runtimeProgressActivity({
      id: 'reasoning',
      runtimeName: 'Codex',
      text: 'Calling the API with sk-abcd1234efgh5678ijkl now.',
      reasoning: true,
    }).label;
    expect(label).not.toContain('sk-abcd1234efgh5678ijkl');
    expect(label).toContain('sk-***');
  });
});
