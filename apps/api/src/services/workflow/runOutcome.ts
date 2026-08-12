/**
 * One authoritative interpretation of workflow settlement.
 *
 * A graph stopping is not the same thing as accomplishing its objective. Every
 * orchestration consumer (App dependencies, event rules, conversations, UI)
 * must use this module instead of inventing its own list of "successful"
 * statuses.
 */

import type { RunExecutionStatus, RunOutcomeStatus, RunSettlement } from '@agentis/core';

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

export function executionStatusFor(status: string): RunExecutionStatus {
  if (status === 'RUNNING') return 'running';
  if (status === 'PAUSED' || status === 'WAITING') return 'waiting';
  if (status === 'FAILED') return 'failed';
  if (status === 'CANCELLED') return 'cancelled';
  if (status === 'COMPLETED' || status === 'COMPLETED_WITH_ERRORS' || status === 'COMPLETED_WITH_CONTRACT_VIOLATION') return 'completed';
  return 'queued';
}

export function outcomeStatusFor(status: string, verdict: RunVerdictOutcome | null): RunOutcomeStatus {
  if (status === 'CANCELLED') return 'blocked';
  if (status === 'FAILED' || status === 'COMPLETED_WITH_ERRORS' || status === 'COMPLETED_WITH_CONTRACT_VIOLATION') return 'not_accomplished';
  if (status !== 'COMPLETED') return 'unverified';
  if (verdict === 'accomplished') return 'accomplished';
  // `partial` is the legacy internal verdict for unavailable proof. Publicly it
  // is a recoverable blocker, never a partially successful delivery.
  if (verdict === 'partial') return 'blocked';
  if (verdict === 'hollow' || verdict === 'failed_checks') return 'not_accomplished';
  return 'unverified';
}

/** Backward-compatible reader for rows written before terminal outcome V2. */
export function normalizeRunOutcomeStatus(value: unknown): RunOutcomeStatus {
  if (value === 'accomplished' || value === 'blocked' || value === 'not_accomplished' || value === 'unverified') return value;
  if (value === 'partial' || value === 'cancelled') return 'blocked';
  if (value === 'failed' || value === 'failed_checks' || value === 'hollow') return 'not_accomplished';
  return 'unverified';
}

export function buildRunSettlement(args: {
  status: string;
  runState?: unknown;
  revisionId?: string | null;
  semanticHash?: string | null;
  settledAt?: string | null;
}): RunSettlement {
  const verdict = readRunVerdictOutcome(args.runState);
  const rawVerdict = args.runState && typeof args.runState === 'object'
    ? (args.runState as { verdict?: { checks?: unknown[]; deficiencies?: unknown[] } }).verdict
    : undefined;
  const checks = Array.isArray(rawVerdict?.checks) ? rawVerdict.checks : [];
  const deficiencies = Array.isArray(rawVerdict?.deficiencies) ? rawVerdict.deficiencies : [];
  return {
    executionStatus: executionStatusFor(args.status),
    outcomeStatus: outcomeStatusFor(args.status, verdict),
    revisionId: args.revisionId ?? null,
    semanticHash: args.semanticHash ?? null,
    evidence: checks.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const check = entry as { checkId?: unknown; evidence?: unknown };
      return [{ kind: 'check' as const, ...(typeof check.checkId === 'string' ? { id: check.checkId } : {}), summary: typeof check.evidence === 'string' ? check.evidence : 'Acceptance check evaluated.' }];
    }),
    deficiencies: deficiencies.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const deficiency = entry as { checkId?: unknown; detail?: unknown; producingNodeIds?: unknown };
      return [{
        code: typeof deficiency.checkId === 'string' ? deficiency.checkId : 'OUTCOME_DEFICIENT',
        detail: typeof deficiency.detail === 'string' ? deficiency.detail : 'The requested outcome was not proven.',
        ...(Array.isArray(deficiency.producingNodeIds) ? { producingNodeIds: deficiency.producingNodeIds.filter((id): id is string => typeof id === 'string') } : {}),
      }];
    }),
    settledAt: args.settledAt ?? (TERMINAL.has(args.status) ? new Date().toISOString() : null),
  };
}
