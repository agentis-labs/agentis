/**
 * pursuitControl — the pure, side-effect-free brain of the Pursuit primitive
 * (the cognitive loop). Deliberately dependency-free so it is trivially unit
 * tested and can be shared by BOTH the `pursue`/`converge` node loop in
 * WorkflowEngine AND (future) the agent inner tool loop. See
 * docs/COGNITIVE-LOOPING-RFC.md §6 (stagnation), §3.2 (progress), §8 (reflect).
 *
 * Nothing here reads the clock, the DB, or the model — it turns an iteration's
 * observable facts (a structural signature + a progress trajectory) into a
 * decision: keep going, or we're stuck and must pivot.
 */

/** The continuation decision an iteration produced, as far as progress cares. */
export interface IterationDecision {
  /** true → keep iterating (goal not yet met); false → done. */
  continue: boolean;
  /** Judge score in 0..10 when the done-check is an LLM judge; else undefined. */
  score?: number;
}

export interface StagnationInput {
  /** Order-independent structural signature of THIS iteration's output. */
  signature: string;
  /** Signature of the previous iteration (undefined on the first pass). */
  prevSignature?: string;
  /** Recent-K signatures (excluding the current one) for oscillation detection. */
  signatureRing: readonly string[];
  /** Progress 0..1 per iteration, current pass last. */
  deltaTrajectory: readonly number[];
  /** Consecutive-no-change window that trips a structural stall (>=1). */
  window: number;
  /** The structural stall streak carried from the previous iteration. */
  prevStallStreak: number;
  /**
   * Pursue mode: enables the structural EXTRA signal (oscillation). Off for a
   * plain `converge` node, so its behaviour is unchanged (single-signal s1).
   */
  assess: boolean;
  /**
   * The done-check is a graded judge, so the progress trajectory is meaningful:
   * enables plateau (s3) + regression (s4). A deterministic/signal check has no
   * graded distance, so these stay off to avoid false stalls.
   */
  graded: boolean;
  /** s3: max |Δn − Δn−1| across the window to count as a plateau. Default 0.02. */
  plateauEps?: number;
  /** s4: drop in progress vs. the previous iteration that counts as regression. Default 0.05. */
  regressionDelta?: number;
}

export interface StagnationResult {
  /** The loop is stuck and should pivot (or, if pivots are spent, settle stalled). */
  stalled: boolean;
  /** Updated structural stall streak, to carry into the next iteration. */
  stallStreak: number;
  /** Which signals fired — surfaced in the iteration record + realtime event. */
  reasons: string[];
}

/**
 * Multi-signal stagnation detector (RFC §6). Signals:
 *   s1 structural_repeat — identical output signature (always on)
 *   s5 oscillation       — a signature seen before but not last (A→B→A); assess mode
 *   s3 plateau           — progress flat across the window; graded only
 *   s4 regression        — progress dropped vs. last iteration; graded only
 * `stalled` is a vote: s1 reaching the window, OR any enabled extra signal.
 */
export function detectStagnation(inp: StagnationInput): StagnationResult {
  const reasons: string[] = [];
  const window = Math.max(1, inp.window);

  // s1 — exact structural repeat.
  let stallStreak = 0;
  if (inp.prevSignature !== undefined && inp.signature === inp.prevSignature) {
    stallStreak = inp.prevStallStreak + 1;
    reasons.push('structural_repeat');
  }
  const s1 = stallStreak + 1 >= window;

  // s5 — oscillation: this exact state was visited before, but not immediately prior.
  let s5 = false;
  if (inp.assess && inp.signature !== inp.prevSignature && inp.signatureRing.includes(inp.signature)) {
    s5 = true;
    reasons.push('oscillation');
  }

  // s3/s4 — need a graded (continuous) progress signal to be meaningful.
  let s3 = false;
  let s4 = false;
  if (inp.graded) {
    const dt = inp.deltaTrajectory;
    const n = dt.length;
    if (n >= 2) {
      const last = dt[n - 1] as number;
      const prev = dt[n - 2] as number;
      if (last < prev - (inp.regressionDelta ?? 0.05)) {
        s4 = true;
        reasons.push('regression');
      }
    }
    const w = Math.max(2, window);
    if (n >= w + 1) {
      const recent = dt.slice(n - (w + 1));
      const flat = recent.every((v, i) => i === 0 || Math.abs(v - (recent[i - 1] as number)) < (inp.plateauEps ?? 0.02));
      // Being DONE (progress ≈ 1) held flat is success, not a stall.
      if (flat && (dt[n - 1] as number) < 0.98) {
        s3 = true;
        reasons.push('plateau');
      }
    }
  }

  const stalled = s1 || (inp.assess && s5) || (inp.graded && (s3 || s4));
  return { stalled, stallStreak, reasons };
}

/**
 * Progress 0..1 for this iteration (RFC §3.2 — the PRM-style signal).
 *   done              → 1
 *   judge in progress → score/10 (the judge's own graded distance)
 *   deterministic/signal in progress → 0 (distance unknown; not used for s3/s4)
 */
export function computeProgress(decision: IterationDecision): number {
  if (!decision.continue) return 1;
  if (typeof decision.score === 'number' && Number.isFinite(decision.score)) {
    return Math.max(0, Math.min(1, decision.score / 10));
  }
  return 0;
}

/**
 * The escalating pivot ladder (RFC §8). Each successive stall pushes the body
 * harder: reflect → reframe → switch strategy. Prose kept plain per the naming
 * doctrine. Index is clamped to the last rung.
 */
export const PIVOT_LADDER: readonly string[] = [
  'change approach; do NOT repeat the previous attempt.',
  'the previous change did not help — reframe the problem: question your assumptions and try a fundamentally different decomposition.',
  'several attempts have not advanced — switch strategy entirely: step back and fix the root cause, or use a different method/tool, before trying again.',
];

/**
 * Turn a stall into a forward-fed verbal self-critique (Reflexion, RFC §8).
 * Prefers the judge's own critique (free, specific); otherwise synthesizes a
 * structural hint from the signals that fired. `attempt` (1-based) climbs the
 * pivot ladder so repeated stalls escalate from "reflect" to "switch strategy".
 * Injected into the next iteration's body input so the cohort changes tack.
 */
// ─── s6 — tool-call loop guard (shared with the agent inner loop, RFC §6/§10.3) ──

/** Identical-tool-call count that counts as a loop. "Three identical tool calls is definitionally a loop." */
export const LOOP_GUARD_THRESHOLD = 3;

function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const norm = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v as object)) return '[circular]';
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(norm);
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])]),
    );
  };
  try {
    return JSON.stringify(norm(value)) ?? 'null';
  } catch {
    return String(value);
  }
}

/** Stable signature for a tool call (name + order-independent args). */
export function toolCallSignature(tool: string, args: unknown): string {
  return `${tool}(${stableStringify(args)})`;
}

/**
 * True when adding `signature` would make it the `threshold`-th identical call
 * in `executed` — the cheapest, highest-yield runaway guard in the literature.
 * Pure: the caller owns the executed-signature history.
 */
export function isRepeatedToolCall(executed: readonly string[], signature: string, threshold = LOOP_GUARD_THRESHOLD): boolean {
  let count = 1;
  for (const s of executed) if (s === signature) count += 1;
  return count >= threshold;
}

export function chooseReflection(critique: string | undefined, reasons: readonly string[], attempt = 1): string {
  const why = reasons.length ? reasons.join(', ') : 'no measurable progress';
  const rung = PIVOT_LADDER[Math.min(Math.max(1, attempt), PIVOT_LADDER.length) - 1] as string;
  const step = `${rung[0]!.toUpperCase()}${rung.slice(1)}`;
  const c = critique?.trim();
  const head = c
    ? `Reflection (attempt ${attempt}; stall: ${why}). The evaluator said: ${c}.`
    : `Reflection (attempt ${attempt}): the last iterations showed ${why}.`;
  return `${head} ${step}`;
}
