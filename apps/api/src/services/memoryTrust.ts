/**
 * MemoryTrust — trust/confidence/importance scoring policy.
 *
 * Spec: docs/memory/MEMORY-ARCHITECTURE.md §7.6 + §11.
 *
 * Pure functions. No DB, no logger, no state. The promotion pipeline calls
 * these to compute the final scores stored on a memory episode.
 *
 * Design philosophy (§11.1):
 *   "Agents should be allowed to propose memory, not dominate memory."
 *
 * Defaults (§11.2):
 *   operator/system/evaluator confirmed:  trust 0.9 - 1.0
 *   repeated successful pattern:          trust 0.7 - 0.9
 *   single agent-authored lesson:         trust 0.3 - 0.6
 *
 * High-risk memory (§11.3) requires elevated thresholds before promotion.
 */

import type {
  PromotionCandidate,
  RuntimeEpisodeSource,
  RuntimeEpisodeType,
} from '@agentis/core';

/**
 * Compute the initial trust score for a new episode.
 *
 * Inputs:
 *   - source: where the episode came from (operator > evaluator > agent)
 *   - signals: human approval, evaluator validation, repeated count
 *
 * Returns 0..1.
 */
export function computeTrust(
  source: RuntimeEpisodeSource,
  signals: PromotionCandidate['signals'] = {},
): number {
  // Base trust from source.
  let base = baseTrustForSource(source);

  // Operator / evaluator validation lifts trust to the high band.
  if (signals.humanApproved) base = Math.max(base, 0.95);
  else if (signals.evaluatorValidated) base = Math.max(base, 0.85);

  // Repetition lifts trust gradually.
  if (signals.repeatedCount && signals.repeatedCount > 1) {
    const lift = Math.min(0.2, 0.04 * Math.log2(1 + signals.repeatedCount));
    base = Math.min(0.95, base + lift);
  }

  return clamp01(base);
}

/**
 * Compute confidence: how likely the memory is factually correct.
 *
 * Distinct from trust (which is "how much should we rely on it"). A memory
 * can be highly trusted (operator-written) but low confidence if the
 * underlying data is sparse, and vice versa.
 */
export function computeConfidence(
  source: RuntimeEpisodeSource,
  signals: PromotionCandidate['signals'] = {},
): number {
  let base = 0.5;
  if (source === 'evaluator_write') base = 0.85;
  else if (source === 'operator_write') base = 0.9;
  else if (source === 'seed') base = 0.8;
  else if (source === 'system_write') base = 0.75;
  else if (source === 'run_promotion') base = 0.7;
  else if (source === 'agent_write') base = 0.45;

  if (signals.confidenceHint !== undefined) {
    base = Math.max(base, clamp01(signals.confidenceHint));
  }
  if (signals.evaluatorValidated) base = Math.max(base, 0.85);
  if (signals.humanApproved) base = Math.max(base, 0.9);
  if (signals.repeatedCount && signals.repeatedCount >= 3) {
    base = Math.max(base, 0.8);
  }

  return clamp01(base);
}

/**
 * Compute importance: how consequential the lesson is.
 *
 * Heuristics:
 *   - failure / incident / approval-rejection → high importance
 *   - distilled lesson / success_pattern     → moderate importance
 *   - decision / artifact_outcome            → context-dependent
 */
export function computeImportance(
  type: RuntimeEpisodeType,
  signals: PromotionCandidate['signals'] = {},
): number {
  let base = 0.5;
  switch (type) {
    case 'failure':
    case 'incident':
      base = 0.85;
      break;
    case 'recovery':
    case 'distilled_lesson':
      base = 0.7;
      break;
    case 'success_pattern':
    case 'approval':
      base = 0.65;
      break;
    case 'evaluator_outcome':
      base = 0.6;
      break;
    case 'decision':
    case 'artifact_outcome':
      base = 0.5;
      break;
  }

  if (signals.importanceHint !== undefined) {
    base = Math.max(base, clamp01(signals.importanceHint));
  }
  if (signals.repeatedCount && signals.repeatedCount >= 5) base = Math.min(0.95, base + 0.1);
  if (signals.humanApproved) base = Math.max(base, 0.7);

  return clamp01(base);
}

/**
 * Decide whether the candidate meets promotion thresholds (§10.4).
 *
 * Returns the primary `reason` if it should be promoted, or null if it
 * should be rejected. Multiple criteria may apply; we return the strongest.
 */
export function shouldPromote(
  candidate: PromotionCandidate,
  computed: { trust: number; confidence: number; importance: number },
): { ok: true; reason: NonNullable<ReturnType<typeof reasonOrNull>> } | { ok: false; reason: 'low_importance' | 'low_confidence' } {
  const r = reasonOrNull(candidate, computed);
  if (r) return { ok: true, reason: r };
  if (computed.confidence < 0.4) return { ok: false, reason: 'low_confidence' };
  return { ok: false, reason: 'low_importance' };
}

/**
 * Find the strongest promotion reason that matches. Order matters — operator
 * approval beats evaluator validation beats repeated pattern beats threshold.
 */
function reasonOrNull(
  candidate: PromotionCandidate,
  computed: { trust: number; confidence: number; importance: number },
):
  | 'human_approved'
  | 'evaluator_validated'
  | 'repeated_pattern'
  | 'major_failure'
  | 'major_success'
  | 'importance_threshold'
  | 'operator_written'
  | null {
  const s = candidate.signals;
  if (candidate.source === 'operator_distillation') return 'operator_written';
  if (s.humanApproved) return 'human_approved';
  if (s.evaluatorValidated) return 'evaluator_validated';
  if (s.repeatedCount && s.repeatedCount >= 3) return 'repeated_pattern';
  if (candidate.type === 'failure' && computed.importance >= 0.8) return 'major_failure';
  if (candidate.type === 'success_pattern' && computed.importance >= 0.8) return 'major_success';
  if (computed.importance >= 0.75 && computed.confidence >= 0.6) return 'importance_threshold';
  return null;
}

/**
 * High-risk memory check (§11.3). Returns true if this memory has tags or
 * payload that would affect compliance, security, irreversible actions,
 * budget, or approval routing — and therefore needs human confirmation
 * before promotion.
 */
export function isHighRiskMemory(candidate: PromotionCandidate): boolean {
  const tagSet = new Set((candidate.tags ?? []).map((t) => t.toLowerCase()));
  const HIGH_RISK_TAGS = [
    'compliance', 'pii', 'security', 'irreversible',
    'budget', 'approval_policy', 'production', 'finance',
  ];
  for (const t of HIGH_RISK_TAGS) if (tagSet.has(t)) return true;

  // Title-based heuristic.
  const titleLower = candidate.title.toLowerCase();
  if (/(delete|drop|wire|transfer|production database|spend|budget cap)/.test(titleLower)) {
    return true;
  }
  return false;
}

/**
 * Base trust per source (§11.2).
 */
function baseTrustForSource(source: RuntimeEpisodeSource): number {
  switch (source) {
    case 'operator_write': return 0.95;
    case 'evaluator_write': return 0.85;
    case 'seed':            return 0.8;  // package author trusted but not operator-validated
    case 'system_write':    return 0.7;
    case 'run_promotion':   return 0.6;
    case 'agent_write':     return 0.4;
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}
