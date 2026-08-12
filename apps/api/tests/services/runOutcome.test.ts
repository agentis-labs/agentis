import { describe, expect, it } from 'vitest';
import { buildRunSettlement, evaluateRunOutcome, normalizeRunOutcomeStatus } from '../../src/services/workflow/runOutcome.js';

describe('evaluateRunOutcome', () => {
  it('allows legacy clean completion while keeping it explicitly unverified', () => {
    expect(evaluateRunOutcome({ status: 'COMPLETED' })).toMatchObject({
      canAdvanceOnSuccess: true,
      accomplished: false,
      verified: false,
      reason: 'legacy_completion',
    });
  });

  it('requires an accomplished verdict when a definition of done exists', () => {
    expect(evaluateRunOutcome({
      status: 'COMPLETED',
      hasDefinitionOfDone: true,
      runState: { verdict: { outcome: 'failed_checks' } },
    })).toMatchObject({ canAdvanceOnSuccess: false, accomplished: false, reason: 'failed_checks' });
    expect(evaluateRunOutcome({
      status: 'COMPLETED',
      hasDefinitionOfDone: true,
      runState: { verdict: { outcome: 'accomplished' } },
    })).toMatchObject({ canAdvanceOnSuccess: true, accomplished: true, reason: 'accomplished' });
  });

  it('never treats contract violation as success', () => {
    expect(evaluateRunOutcome({
      status: 'COMPLETED_WITH_CONTRACT_VIOLATION',
      runState: { verdict: { outcome: 'accomplished' } },
    })).toMatchObject({ canAdvanceOnSuccess: false, accomplished: false, reason: 'contract_violation' });
  });

  it('settles execution and business outcome independently with evidence', () => {
    const settlement = buildRunSettlement({
      status: 'COMPLETED',
      revisionId: 'rev-1',
      semanticHash: 'hash-1',
      settledAt: '2026-01-01T00:00:00.000Z',
      runState: {
        verdict: {
          outcome: 'failed_checks',
          checks: [{ checkId: 'delivered', evidence: 'Provider receipt was absent.' }],
          deficiencies: [{ checkId: 'delivered', detail: 'Delivery was not proven.', producingNodeIds: ['send'] }],
        },
      },
    });
    expect(settlement).toMatchObject({
      executionStatus: 'completed',
      outcomeStatus: 'not_accomplished',
      revisionId: 'rev-1',
      semanticHash: 'hash-1',
      evidence: [{ kind: 'check', id: 'delivered', summary: 'Provider receipt was absent.' }],
      deficiencies: [{ code: 'delivered', detail: 'Delivery was not proven.', producingNodeIds: ['send'] }],
    });
  });

  it('normalizes legacy terminal outcomes into the three-state public contract', () => {
    expect(normalizeRunOutcomeStatus('partial')).toBe('blocked');
    expect(normalizeRunOutcomeStatus('failed')).toBe('not_accomplished');
    expect(normalizeRunOutcomeStatus('failed_checks')).toBe('not_accomplished');
    expect(normalizeRunOutcomeStatus('accomplished')).toBe('accomplished');
  });
});
