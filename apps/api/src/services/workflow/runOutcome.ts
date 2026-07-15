/**
 * One authoritative interpretation of workflow settlement.
 *
 * A graph stopping is not the same thing as accomplishing its objective. Every
 * orchestration consumer (App dependencies, event rules, conversations, UI)
 * must use this module instead of inventing its own list of "successful"
 * statuses.
 */

export type RunVerdictOutcome = 'accomplished' | 'partial' | 'hollow' | 'failed_checks';

export interface EffectiveRunOutcome {
  status: string;
  terminal: boolean;
  executionCompleted: boolean;
  verified: boolean;
  verdict: RunVerdictOutcome | null;
  /** Safe eligibility for a rule whose semantic is "after success". */
  canAdvanceOnSuccess: boolean;
  /** Stronger, world-verified business accomplishment. */
  accomplished: boolean;
  reason: 'in_flight' | 'failed' | 'contract_violation' | 'unverified_completion' | 'legacy_completion' | RunVerdictOutcome;
}

const TERMINAL = new Set([
  'COMPLETED',
  'COMPLETED_WITH_CONTRACT_VIOLATION',
  'COMPLETED_WITH_ERRORS',
  'FAILED',
  'CANCELLED',
]);

export function readRunVerdictOutcome(runState: unknown): RunVerdictOutcome | null {
  if (!runState || typeof runState !== 'object') return null;
  const verdict = (runState as { verdict?: unknown }).verdict;
  if (!verdict || typeof verdict !== 'object') return null;
  const outcome = (verdict as { outcome?: unknown }).outcome;
  return outcome === 'accomplished' || outcome === 'partial' || outcome === 'hollow' || outcome === 'failed_checks'
    ? outcome
    : null;
}

export function evaluateRunOutcome(args: {
  status: string;
  runState?: unknown;
  hasDefinitionOfDone?: boolean;
}): EffectiveRunOutcome {
  const verdict = readRunVerdictOutcome(args.runState);
  const terminal = TERMINAL.has(args.status);
  const executionCompleted = args.status === 'COMPLETED';
  const accomplished = executionCompleted && verdict === 'accomplished';
  const legacyCompletion = executionCompleted && !args.hasDefinitionOfDone;
  const canAdvanceOnSuccess = accomplished || legacyCompletion;

  let reason: EffectiveRunOutcome['reason'];
  if (!terminal) reason = 'in_flight';
  else if (args.status === 'COMPLETED_WITH_CONTRACT_VIOLATION') reason = 'contract_violation';
  else if (!executionCompleted) reason = 'failed';
  else if (verdict) reason = verdict;
  else if (args.hasDefinitionOfDone) reason = 'unverified_completion';
  else reason = 'legacy_completion';

  return {
    status: args.status,
    terminal,
    executionCompleted,
    verified: verdict !== null,
    verdict,
    canAdvanceOnSuccess,
    accomplished,
    reason,
  };
}

