import { describe, expect, it } from 'vitest';
import { evaluateRunOutcome } from '../../src/services/workflow/runOutcome.js';

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
});
