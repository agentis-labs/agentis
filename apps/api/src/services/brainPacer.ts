/**
 * brainPacer — the PACER routing layer.
 *
 * PACER is NOT a new storage engine (see the proposition's §3.4). It is a
 * deterministic, model-free CLASSIFIER that tags every memory the Brain forms
 * with *what kind of knowledge it is*, so the rest of the pipeline can route it:
 * how long it lives, how hard it resists decay, which scope it belongs in, and
 * how aggressively compression may touch it.
 *
 *   P — Procedural : execution rules, repair steps, tool constraints, conventions.
 *   A — Analogical : "this looks like that" — derived later, rarely ingested raw.
 *   C — Conceptual : generalized rules, decisions-with-rationale, invariants.
 *   E — Evidence   : grounded observations, run-local facts, retrieved passages.
 *   R — Reference  : stable lookup material — paths, identifiers, config, docs.
 *
 * Two design constraints that the original proposition got right and we honor:
 *
 *  1. **Classify BEFORE structure is stripped.** `brainFormation.stripNonProse`
 *     deletes code fences and JSON — exactly where procedural/reference signals
 *     (paths, code refs, identifiers) live. So PACER reads the raw-ish candidate
 *     text + source signals, never the post-strip survivor only.
 *
 *  2. **Source surface is a first-class signal.** The same sentence means
 *     something different coming from operator chat vs a tool dump vs a doc
 *     ingest. `SourceSurface` is threaded from the enqueue site, not guessed.
 *
 * Pure functions, no DB, no model — unit-tested in tests/brainPacer.test.ts.
 */

import type { RuntimeEpisodeType } from '@agentis/core';

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

export type PacerClass =
  | 'procedural'
  | 'analogical'
  | 'conceptual'
  | 'evidence'
  | 'reference';

/** Where a memory candidate originated. Threaded from the enqueue site. */
export type SourceSurface =
  | 'tool_output'           // a tool/integration result inside a run
  | 'run_completion'        // an agent task's final output
  | 'operator_chat'         // a human stating a rule/preference/fact in chat
  | 'session_conversation'  // session-local conversational trace
  | 'knowledge_ingest'      // uploaded/imported document chunk
  | 'agent_reflection';     // a reflective/repair job (Feynman) output

export interface PacerSignals {
  /** Pre-strip candidate text — keep code refs/paths/identifiers intact. */
  text: string;
  /** Where the content came from. */
  surface?: SourceSurface | null;
  /** Workflow node kind (e.g. 'agent_task', 'http_request'). */
  nodeKind?: string | null;
  /** Agent role, if bound. */
  agentRole?: string | null;
  /** Episode type assigned by the FormationJudge, when available. */
  episodeType?: RuntimeEpisodeType | null;
  /** Tags already on the candidate. */
  tags?: string[];
}

export interface PacerVerdict {
  pacerClass: PacerClass;
  /** 0..1 — how confident the classifier is in the class. */
  confidence: number;
  /** Short machine-readable reason for observability. */
  reason: string;
}

/**
 * Routing policy derived from a PACER class. This is what the promotion,
 * maintenance, and compression passes consult — they never branch on the class
 * directly, they ask for routing.
 */
export interface PacerRouting {
  pacerClass: PacerClass;
  /** TTL (days) for a STAGED (unconsolidated) trace of this class. */
  stagedTtlDays: number;
  /** Importance floor when writing a formed atom of this class. */
  importanceFloor: number;
  /**
   * True when this class should resist automated forgetting/merging:
   * procedural/conceptual/reference are durable; evidence/analogical are cold.
   */
  decayResistant: boolean;
  /**
   * Cosine threshold above which compression's tier-2 may MERGE two atoms of
   * this class. Procedural rules merge only when nearly identical (a small
   * wording delta can be a different rule); evidence merges freely.
   */
  mergeSimilarity: number;
  /** Curator-pass priority: higher = distilled first when clusters grow. */
  curatorPriority: number;
}

// ────────────────────────────────────────────────────────────
// Episode-type prior (when the FormationJudge already typed the memory)
// ────────────────────────────────────────────────────────────

const TYPE_PRIOR: Record<RuntimeEpisodeType, PacerClass> = {
  success_pattern: 'procedural',
  recovery: 'procedural',
  decision: 'conceptual',
  distilled_lesson: 'conceptual',
  incident: 'conceptual',
  failure: 'conceptual',
  approval: 'evidence',
  evaluator_outcome: 'evidence',
  artifact_outcome: 'evidence',
  observation: 'evidence',
};

// ────────────────────────────────────────────────────────────
// Surface prior (where the content came from)
// ────────────────────────────────────────────────────────────

const SURFACE_PRIOR: Record<SourceSurface, { cls: PacerClass; weight: number }> = {
  knowledge_ingest: { cls: 'reference', weight: 0.5 },
  session_conversation: { cls: 'evidence', weight: 0.45 },
  tool_output: { cls: 'evidence', weight: 0.4 },
  run_completion: { cls: 'conceptual', weight: 0.2 },
  operator_chat: { cls: 'procedural', weight: 0.25 },
  agent_reflection: { cls: 'procedural', weight: 0.45 },
};

// ────────────────────────────────────────────────────────────
// Text cues
// ────────────────────────────────────────────────────────────

const PROCEDURAL_CUES = /\b(always|never|must|should|do not|don't|avoid|ensure|prefer|instead of|before retrying|retry|step \d|first,|then,|finally,|make sure|use .+ (not|instead)|when .+ (fails?|errors?|times out))\b/i;
/**
 * Strong directive cues. An imperative rule ("always X", "never Y") is
 * procedural EVEN when it includes a rationale ("…because…"); the directive must
 * outweigh the conceptual "because" cue, so it gets its own boost.
 */
const DIRECTIVE_CUES = /\b(always|never|must|should|do not|don't|avoid|ensure|make sure to|before retrying)\b/i;
const CONCEPTUAL_CUES = /\b(because|therefore|so that|due to|in general|the (reason|cause|root cause)|results? in|leads? to|implies|the underlying|as a rule|tends to|generally)\b/i;
const REFERENCE_CUES = /\b(is (located|defined|stored|configured) (at|in)|the (endpoint|path|file|table|column|key|id|token name|env(ironment)? var(iable)?|setting) (is|are)|see (the )?(docs?|reference|spec)|api (key|base|url) is|version \d)\b/i;
const ANALOGICAL_CUES = /\b(resembles|similar to|looks like (the|that|an earlier)|same (pattern|shape|kind) as|analogous to|reminiscent of|like the (previous|earlier|prior))\b/i;
const EVIDENCE_CUES = /\b(found|observed|returned|reported|measured|the (result|response|output) (was|showed)|as of|on \d|contained|listed)\b/i;

/** Identifiers / paths / code refs — strong REFERENCE signal density. */
function referenceDensity(text: string): number {
  const hits = [
    /[`][^`]+[`]/g,                    // inline code
    /\b[\w.-]+\/[\w./-]+/g,            // paths
    /\b[A-Z_]{3,}\b/g,                 // CONSTANT_NAMES
    /\bhttps?:\/\/\S+/g,               // urls
    /\b\w+\(\)/g,                      // fn()
    /\b[a-z]+[A-Z]\w+\b/g,            // camelCaseIdentifiers
  ].reduce((sum, re) => sum + (text.match(re)?.length ?? 0), 0);
  const words = Math.max(1, text.split(/\s+/).length);
  return hits / words;
}

// ────────────────────────────────────────────────────────────
// Classifier
// ────────────────────────────────────────────────────────────

/**
 * Classify a candidate into a PACER class. Deterministic: combines an
 * episode-type prior (if the judge typed it), a source-surface prior, and
 * text-cue scoring. Returns the winning class with a confidence and reason.
 */
export function classifyPacer(signals: PacerSignals): PacerVerdict {
  const text = signals.text ?? '';
  const lower = text.toLowerCase();
  const scores: Record<PacerClass, number> = {
    procedural: 0,
    analogical: 0,
    conceptual: 0,
    evidence: 0.15, // evidence is the humble default
    reference: 0,
  };
  const reasons: string[] = [];

  // 1. Episode-type prior (strongest when present — the judge already reasoned).
  if (signals.episodeType && TYPE_PRIOR[signals.episodeType]) {
    scores[TYPE_PRIOR[signals.episodeType]] += 0.4;
    reasons.push(`type:${signals.episodeType}`);
  }

  // 2. Surface prior.
  if (signals.surface && SURFACE_PRIOR[signals.surface]) {
    const prior = SURFACE_PRIOR[signals.surface];
    scores[prior.cls] += prior.weight;
    reasons.push(`surface:${signals.surface}`);
  }

  // 3. Operator-chat tag refinement (rule/preference/fact carry strong intent).
  const tags = signals.tags ?? [];
  if (tags.includes('rule')) { scores.procedural += 0.35; reasons.push('tag:rule'); }
  if (tags.includes('preference')) { scores.conceptual += 0.3; reasons.push('tag:preference'); }
  if (tags.includes('fact')) { scores.reference += 0.3; reasons.push('tag:fact'); }
  if (tags.includes('lesson')) { scores.conceptual += 0.25; reasons.push('tag:lesson'); }

  // 4. Text cues.
  if (PROCEDURAL_CUES.test(lower)) { scores.procedural += 0.3; reasons.push('cue:procedural'); }
  if (DIRECTIVE_CUES.test(lower)) { scores.procedural += 0.3; reasons.push('cue:directive'); }
  if (CONCEPTUAL_CUES.test(lower)) { scores.conceptual += 0.25; reasons.push('cue:conceptual'); }
  if (ANALOGICAL_CUES.test(lower)) { scores.analogical += 0.4; reasons.push('cue:analogical'); }
  if (REFERENCE_CUES.test(lower)) { scores.reference += 0.3; reasons.push('cue:reference'); }
  if (EVIDENCE_CUES.test(lower)) { scores.evidence += 0.2; reasons.push('cue:evidence'); }

  // 5. Identifier/path density → reference (only when not already strongly a rule).
  const density = referenceDensity(text);
  if (density >= 0.18 && !PROCEDURAL_CUES.test(lower)) {
    scores.reference += Math.min(0.35, density);
    reasons.push(`ref_density:${density.toFixed(2)}`);
  }

  // Winner.
  let best: PacerClass = 'evidence';
  let bestScore = -1;
  for (const cls of Object.keys(scores) as PacerClass[]) {
    if (scores[cls] > bestScore) { best = cls; bestScore = scores[cls]; }
  }
  const total = Object.values(scores).reduce((a, b) => a + b, 0) || 1;
  const confidence = Math.max(0.2, Math.min(1, bestScore / total));
  return { pacerClass: best, confidence, reason: reasons.join(',') || 'default' };
}

// ────────────────────────────────────────────────────────────
// Routing
// ────────────────────────────────────────────────────────────

const ROUTING: Record<PacerClass, PacerRouting> = {
  procedural: { pacerClass: 'procedural', stagedTtlDays: 60, importanceFloor: 0.6, decayResistant: true, mergeSimilarity: 0.96, curatorPriority: 3 },
  conceptual: { pacerClass: 'conceptual', stagedTtlDays: 60, importanceFloor: 0.58, decayResistant: true, mergeSimilarity: 0.93, curatorPriority: 3 },
  reference: { pacerClass: 'reference', stagedTtlDays: 45, importanceFloor: 0.5, decayResistant: true, mergeSimilarity: 0.97, curatorPriority: 1 },
  analogical: { pacerClass: 'analogical', stagedTtlDays: 30, importanceFloor: 0.5, decayResistant: false, mergeSimilarity: 0.9, curatorPriority: 2 },
  evidence: { pacerClass: 'evidence', stagedTtlDays: 14, importanceFloor: 0.4, decayResistant: false, mergeSimilarity: 0.88, curatorPriority: 0 },
};

/** Routing policy for a PACER class. Never throws; defaults to evidence. */
export function pacerRouting(cls: PacerClass): PacerRouting {
  return ROUTING[cls] ?? ROUTING.evidence;
}

/** Coerce an arbitrary stored value back to a PacerClass (UI / read paths). */
export function coercePacerClass(value: unknown): PacerClass | null {
  return typeof value === 'string' && value in ROUTING ? (value as PacerClass) : null;
}
