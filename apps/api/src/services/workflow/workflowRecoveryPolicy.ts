/**
 * Pure policy for the workflow recovery ladder.
 *
 * The planner proposes a repair and the engine executes it, but neither decides
 * whether a human must be asked. Keeping that decision here prevents the old
 * approve/autonomous branches from drifting apart.
 */

import { createHash } from 'node:crypto';
import {
  assessWorkflowRepairImpact,
  type WorkflowGraph,
  type WorkflowRecoveryMode,
  type WorkflowRecoveryTier,
  type WorkflowRepairImpactAssessment,
} from '@agentis/core';

export interface RecoveryPolicyDecision {
  requiresApproval: boolean;
  impact: WorkflowRepairImpactAssessment;
}

export function decideRecoveryPolicy(
  mode: WorkflowRecoveryMode,
  before: WorkflowGraph,
  after: WorkflowGraph,
): RecoveryPolicyDecision {
  const impact = assessWorkflowRepairImpact(before, after);
  return {
    impact,
    requiresApproval: mode === 'guarded' && impact.impact !== 'internal',
  };
}

/** Canonical, stable fingerprint for duplicate-plan circuit breaking. */
export function repairPlanFingerprint(value: unknown): string {
  return fingerprint(stableJson(value));
}

/** Normalizes volatile details so the same root cause survives retries/restarts. */
export function recoveryFailureFingerprint(nodeId: string, error: string): string {
  const normalized = error
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<id>')
    .replace(/\b\d{4}-\d\d-\d\d[T ][^\s]+/g, '<time>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return fingerprint(`${nodeId}\n${normalized}`);
}

/** First model repair is narrow; later distinct plans may reconstruct the frontier. */
export function recoveryTierForPlan(planCount: number): Extract<WorkflowRecoveryTier, 'minimal_patch' | 'rebuild'> {
  return planCount === 0 ? 'minimal_patch' : 'rebuild';
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}
