import { describe, expect, it } from 'vitest';
import type { TurnToolObservation } from '../../src/services/conversation/conversationTurnLease.js';
import { guardCompletionClaims, resultProvidesCompletionEvidence } from '../../src/services/chat/completionEvidence.js';

const observation = (overrides: Partial<TurnToolObservation>): TurnToolObservation => ({
  index: 1,
  name: 'agentis.unknown',
  args: {},
  result: {},
  ok: true,
  mutating: true,
  repeats: 1,
  durationMs: 5,
  ...overrides,
});

describe('completion evidence gate', () => {
  it('distinguishes transport success from explicit semantic failure', () => {
    expect(resultProvidesCompletionEvidence({ created: false, warning: 'runtime unavailable' })).toBe(false);
    expect(resultProvidesCompletionEvidence({ dispatched: false, reason: 'agent_paused', agentId: 'a1' })).toBe(false);
    expect(resultProvidesCompletionEvidence({ passed: false, workflowId: 'wf1' })).toBe(false);
    expect(resultProvidesCompletionEvidence({ created: false, reused: true, agent: { id: 'a1' } })).toBe(true);
    expect(resultProvidesCompletionEvidence({ created: true, workflowId: 'wf1' })).toBe(true);
  });

  it('withholds a Portuguese agent + workflow + verification claim with no ledger evidence', () => {
    const verdict = guardCompletionClaims({
      userMessage: 'Crie um especialista Hermes e um terceiro workflow para pesquisar negócios.',
      assistantText: 'Criei o especialista Hermes Business Researcher e o 3º workflow Pesquisar negócios com Hermes. Dry-run verde: 3/3 cenários aprovados.',
      observations: [],
    });

    expect(verdict.allowed).toBe(false);
    expect(verdict.missing).toEqual(expect.arrayContaining(['agent', 'workflow', 'verification']));
    expect(verdict.replacement).toMatch(/ledger deste turno não comprova/i);
  });

  it('requires evidence for every resource claimed, not merely one successful mutation', () => {
    const verdict = guardCompletionClaims({
      userMessage: 'Create a specialist and build a workflow, then verify it.',
      assistantText: 'Created the specialist and built the workflow. Tests passed.',
      observations: [observation({
        name: 'agentis.agents.create',
        result: { created: true, agent: { id: 'agent-1' } },
      })],
    });

    expect(verdict.allowed).toBe(false);
    expect(verdict.missing).toEqual(expect.arrayContaining(['workflow', 'verification']));
    expect(verdict.missing).not.toContain('agent');
  });

  it('accepts resource claims backed by persisted IDs and passed functional proof', () => {
    const verdict = guardCompletionClaims({
      userMessage: 'Create a specialist and build a workflow, then verify it.',
      assistantText: 'Created the specialist and built the workflow. Dry-run passed.',
      observations: [
        observation({ name: 'agentis.agents.create', result: { created: true, agent: { id: 'agent-1' } } }),
        observation({ index: 2, name: 'agentis.build_workflow', result: { workflowId: 'wf-1', appId: 'app-1' } }),
        observation({ index: 3, name: 'agentis.workflow.dry_run', mutating: false, result: { passed: true, workflowId: 'wf-1' } }),
      ],
    });

    expect(verdict).toMatchObject({ allowed: true, missing: [] });
  });

  it('does not treat a normal handler return with created:false and a warning as persistence', () => {
    const verdict = guardCompletionClaims({
      userMessage: 'Create an agent for this research.',
      assistantText: 'Created the research agent.',
      observations: [observation({
        name: 'agentis.agents.create',
        result: { created: false, warning: 'No healthy runtime is currently available.' },
      })],
    });

    expect(verdict.allowed).toBe(false);
    expect(verdict.missing).toContain('agent');
  });

  it('does not interfere with explanations or future-tense progress narration', () => {
    expect(guardCompletionClaims({
      userMessage: 'Explain how workflow verification works.',
      assistantText: 'A workflow is persisted before verification runs.',
      observations: [],
    }).allowed).toBe(true);

    expect(guardCompletionClaims({
      userMessage: 'Create a workflow.',
      assistantText: 'I will create the workflow after you approve the external send.',
      observations: [],
    }).allowed).toBe(true);
  });
});
