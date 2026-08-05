import { describe, expect, it } from 'vitest';
import {
  runtimeProgressActivity,
  toolActivityLabel,
} from '../../src/adapters/runtimeProgress.js';

describe('runtime progress normalization', () => {
  it('shows only the underlying gateway operation, never tool inputs', () => {
    const label = toolActivityLabel('Using', 'agentis.tools.call', {
      name: 'agentis.workflow.patch_graph',
      arguments: { workflowId: 'wf-1', apiKey: 'should-never-render' },
    });
    expect(label).toContain('agentis workflow patch graph');
    expect(label).not.toContain('agentis tools call');
    expect(label).not.toContain('should-never-render');
    expect(label).toBe('Using agentis workflow patch graph');
  });

  it('never exposes or paraphrases runtime reasoning', () => {
    expect(runtimeProgressActivity({
      id: 'reasoning',
      runtimeName: 'Hermes',
      text: 'I should inspect the workspace files and repository context.',
      reasoning: true,
    })).toMatchObject({
      type: 'activity',
      phase: 'runtime',
      status: 'running',
      label: 'Hermes is reasoning',
    });
  });

  it('keeps reasoning private regardless of legacy redaction configuration', () => {
    const prev = process.env.AGENTIS_REDACT_REASONING;
    process.env.AGENTIS_REDACT_REASONING = '1';
    try {
      expect(runtimeProgressActivity({
        id: 'reasoning',
        runtimeName: 'Hermes',
        text: 'I should inspect the workspace files and repository context.',
        reasoning: true,
      }).label).toBe('Hermes is reasoning');
    } finally {
      if (prev === undefined) delete process.env.AGENTIS_REDACT_REASONING;
      else process.env.AGENTIS_REDACT_REASONING = prev;
    }
  });

  it('never exposes progress narration or secrets', () => {
    const label = runtimeProgressActivity({
      id: 'reasoning',
      runtimeName: 'Codex',
      text: 'Calling the API with sk-abcd1234efgh5678ijkl now.',
      reasoning: false,
    }).label;
    expect(label).not.toContain('sk-abcd1234efgh5678ijkl');
    expect(label).toBe('Codex is working');
  });
});
