/**
 * brainFormation — the memory FORMATION gate.
 *
 * This is the wall between "an agent produced text" and "the Brain commits a
 * memory". It exists because the old promotion path (`extractPromotableFacts` +
 * `hasUsefulSignal`) was a regex sentence-splitter whose only quality bar was
 * "≥8 tokens", which admitted digest rows, URLs, ranking keys, and the agent
 * narrating its own choices straight into the semantic graph.
 *
 * Three exported capabilities, cheap → expensive:
 *
 *   1. `extractCandidateStatements(taskOutput)` — deterministic, model-free.
 *      Flattens output, strips non-prose, splits into statements, and DROPS the
 *      structural garbage (URLs, table rows, ranking keys, first-person process
 *      narration, framing wrappers, boilerplate). Returns scored survivors.
 *      This alone removes the bulk of the pollution.
 *
 *   2. `classifyOutputShape(taskOutput)` — what KIND of output is this? A
 *      rendered document / a homogeneous list of rows is transient work product
 *      (a digest, a report) and must not form semantic memory. Feeds the
 *      write-policy resolver.
 *
 *   3. `FormationJudge` — the Mem0-style two-phase LLM step. Given the
 *      deterministic survivors + the workspace's existing nearby memories, it
 *      extracts the genuinely durable, reusable statements, types each one, and
 *      decides ADD / UPDATE / NOOP. Model-agnostic (any StructuredCompleter);
 *      callers fall back to episodic staging when no model is configured.
 *
 * No DB access here — pure functions + one stateless judge. That keeps the gate
 * unit-testable in isolation (see test/brain/brainFormation.test.ts).
 */

import type { RuntimeEpisodeType } from '@agentis/core';
import { tokenize, looksSensitive } from './brainText.js';
import type { StructuredCompleter } from './structuredCompleter.js';

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

export interface ScoredStatement {
  /** The cleaned statement text. */
  text: string;
  /** 0..1 deterministic quality score. Higher = more memory-like. */
  score: number;
}

export type OutputShape =
  | 'empty'      // nothing worth looking at
  | 'document'   // a rendered deliverable (newsletter, report, long doc)
  | 'list_rows'  // a homogeneous list of records/rows (a digest, a table)
  | 'prose';     // free-form prose that MAY contain durable lessons

/** What the run is allowed to write to the Brain. */
export type MemoryWritePolicy =
  | 'form'           // may form semantic memory (subject to the gate + judge)
  | 'episodic_only'  // may write at most one episodic outcome marker
  | 'none';          // writes nothing

/** A durable memory the FormationJudge decided to commit. */
export interface FormedMemory {
  operation: 'ADD' | 'UPDATE' | 'NOOP';
  /** Episode type the statement maps to. */
  type: RuntimeEpisodeType;
  title: string;
  /** The generalized, reusable, non-first-person statement. */
  statement: string;
  /** workspace | agent. */
  scope: 'workspace' | 'agent';
  confidence: number;
  /** For UPDATE/NOOP: which existing atom this reconciles against. */
  targetAtomId?: string | null;
  reason?: string;
}

export interface FormationNeighbor {
  id: string;
  title: string;
  summary: string;
}

export interface FormationContext {
  /** Lets a dynamic completer select this workspace's default harness. */
  workspaceId?: string;
  taskTitle?: string | null;
  agentScopeId?: string | null;
  /** Existing nearby memories the candidate should reconcile against. */
  neighbors: FormationNeighbor[];
}

// ────────────────────────────────────────────────────────────
// 1. Deterministic gate
// ────────────────────────────────────────────────────────────

/** Minimum deterministic score for a statement to survive the gate. */
export const FORMATION_MIN_SCORE = 0.5;

/**
 * Extract candidate memory statements from raw task output, dropping structural
 * garbage. Deterministic and model-free — safe to run on every promotion.
 */
export function extractCandidateStatements(taskOutput: unknown): ScoredStatement[] {
  const raw = stripNonProse(flattenText(taskOutput).join('\n'));
  const seen = new Set<string>();
  const out: ScoredStatement[] = [];

  for (const rawLine of raw.split(/\r?\n|(?<=[.!?])\s+/)) {
    const text = stripMarkdownPrefix(rawLine).trim().replace(/\s+/g, ' ');
    if (text.length < 25 || text.length > 500) continue;
    if (isRejectable(text)) continue;
    if (looksSensitive(text)) continue;

    const key = tokenize(text).slice(0, 18).join(' ');
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const score = scoreStatement(text);
    if (score < FORMATION_MIN_SCORE) continue;
    out.push({ text, score });
  }
  return out;
}

/**
 * The reject list — text that is structurally NOT a memory. This is the heart
 * of the P0 fix. Each predicate maps to a class of pollution seen in production.
 */
export function isRejectable(text: string): boolean {
  const t = text.trim();
  const lower = t.toLowerCase();

  // A line that is mostly a URL, or "Link: <url>" / "Source: <url>".
  if (/^(link|source|url|href)\s*[:\-]/i.test(t)) return true;
  if (/^https?:\/\/\S+$/i.test(t)) return true;
  if (urlShare(t) > 0.4) return true;

  // Table rows / ranking keys: "| 8 | hn:48446141 | 3.70 | …", "#3 …", "1) …| …".
  if (/^\|.*\|/.test(t)) return true;
  if (pipeCount(t) >= 2) return true;
  if (/\bhn:\d{4,}\b/i.test(t)) return true;                 // HN item keys
  if (/^\s*#?\d+\s*[|\-–—:.)]\s/.test(t) && pipeCount(t) >= 1) return true;
  if (/^\s*\d+\s*\|\s*\d/.test(t)) return true;              // "8 | 3.70 …"

  // First-person PROCESS narration — the agent describing its own actions, not
  // a durable rule about the world. "I selected 8 stories because…",
  // "I will now…", "We chose to skip…".
  if (/^(i|we)\s+(selected|chose|picked|decided|will|am|have|was|did|ran|generated|produced|found|am going to|'m going to|'ll|noticed|see|think|believe|set|used|am setting)\b/i.test(lower)) return true;
  if (/^(here('| i)s|below is|the following|as requested|as you asked)\b/i.test(lower)) return true;

  // Empty-result / status chatter from a transient run.
  if (/^(no\s+(fresh|new|unsent|relevant|matching|additional)\b)/i.test(lower)) return true;
  if (/\bfor (today|this week|this run)('s)?\s+(digest|report|summary|newsletter)\b/i.test(lower)) return true;
  if (/^(done|completed|finished|success|ok|okay|n\/?a|none|nothing to report)\b[.!]?$/i.test(lower)) return true;

  // Framing wrappers with no content of their own.
  if (/^(summary|overview|note|tip|reminder|fyi|disclaimer|actionable insight|key takeaway|next steps?)\s*[:\-]\s*$/i.test(t)) return true;

  // Separators / table rules / markup-only lines.
  if (/^[#`>|=_*\-\s.]+$/.test(t)) return true;

  // Pure pointer fluff.
  if (/^(see|refer to|read|check out|visit)\b/i.test(lower) && tokenize(t).length < 8) return true;

  return false;
}

/**
 * Deterministic 0..1 quality score for a survivor. NOTE: there is deliberately
 * NO "≥N tokens ⇒ pass" escape hatch — length is not signal.
 */
export function scoreStatement(text: string): number {
  const lower = text.toLowerCase();
  const words = tokenize(text);
  if (words.length < 4) return 0;

  let score = 0.35;

  // Durable-knowledge cues: rules, causes, learnings, constraints.
  if (/\b(always|never|must|should|do not|don't|avoid|prefer|require|ensure|only|instead of)\b/.test(lower)) score += 0.22;
  if (/\b(because|therefore|so that|due to|results? in|leads? to|caused?|in order to)\b/.test(lower)) score += 0.12;
  if (/\b(learned|observed|confirmed|discovered|turns out|works? when|fails? when|the trick is)\b/.test(lower)) score += 0.16;
  if (/\b(rate limit|timeout|retry|threshold|policy|constraint|invariant|edge case|gotcha|pitfall)\b/.test(lower)) score += 0.12;

  // Specificity: concrete identifiers, paths, code refs, numbers-in-context.
  if (/[`/]\w|\.\w{1,4}\b|--?\w|\b\w+\(\)/.test(text)) score += 0.08;

  // Penalties for low-signal phrasing / transient framing.
  if (/^(this|that|it|here|there|note that|for example|e\.g\.|currently|today)\b/i.test(text)) score -= 0.12;
  if (/\b(todo|tbd|wip|placeholder|lorem ipsum)\b/i.test(lower)) score -= 0.3;

  return clamp01(score);
}

// ────────────────────────────────────────────────────────────
// 2. Output-shape classification (feeds the write-policy resolver)
// ────────────────────────────────────────────────────────────

/**
 * Classify the SHAPE of a task's output. A homogeneous list of rows or a
 * rendered document is transient work product — a digest, a newsletter, a
 * report — and should not be mined for semantic memory.
 */
export function classifyOutputShape(taskOutput: unknown): OutputShape {
  const text = flattenText(taskOutput).join('\n').trim();
  if (text.length === 0) return 'empty';

  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return 'empty';

  // Homogeneous rows: many lines share a row-like prefix (bullet/number/pipe).
  const rowLike = lines.filter((l) =>
    /^([-*+]\s|\d+[.):]\s|\|)/.test(l) || pipeCount(l) >= 1 || /\bhn:\d{4,}\b/i.test(l),
  ).length;
  if (lines.length >= 4 && rowLike / lines.length >= 0.6) return 'list_rows';

  // Rendered document: long, headed, multi-paragraph deliverable.
  const headings = lines.filter((l) => /^#{1,6}\s/.test(l)).length;
  if (text.length >= 1200 && (headings >= 2 || lines.length >= 25)) return 'document';

  return 'prose';
}

// ────────────────────────────────────────────────────────────
// 3. The Formation Judge (Mem0-style extract + classify + reconcile)
// ────────────────────────────────────────────────────────────

const JUDGE_TYPES: readonly RuntimeEpisodeType[] = [
  'success_pattern', 'failure', 'recovery', 'decision', 'distilled_lesson',
];

export class FormationJudge {
  constructor(private readonly completer: StructuredCompleter) {}

  /**
   * Judge a batch of deterministic survivors. Returns the memories worth
   * committing, typed and reconciled. Returns `null` when the model is
   * unavailable/failed so the caller can fall back to episodic staging.
   */
  async judge(candidates: ScoredStatement[], context: FormationContext): Promise<FormedMemory[] | null> {
    if (candidates.length === 0) return [];

    const neighborBlock = context.neighbors.length > 0
      ? context.neighbors.map((n, i) => `[${i}] (id=${n.id}) ${n.title}: ${truncate(n.summary, 180)}`).join('\n')
      : '(none)';
    const candidateBlock = candidates.map((c, i) => `[${i}] ${c.text}`).join('\n');

    const system = [
      'You are the memory-formation judge for an autonomous-agent platform.',
      'You decide what a workspace should DURABLY REMEMBER from one task run.',
      'A memory must be GENERALIZABLE and REUSABLE on FUTURE, DIFFERENT tasks.',
      'REJECT: transient work product (digests, reports, lists of items), the agent narrating its own choices, one-off results, raw data, URLs, restated instructions.',
      'KEEP: durable rules, recurring patterns, confirmed lessons, decisions with rationale, failure→fix knowledge.',
      'For each KEPT statement, rewrite it as a concise, third-person, context-free rule (no "I"/"we", no "today").',
      'Reconcile against EXISTING memories: if one already says this, NOOP it (cite its id); if this refines/corrects one, UPDATE it (cite its id); otherwise ADD.',
      'Be strict. Most candidates from a routine run should be dropped. Returning an empty list is correct and expected.',
    ].join(' ');

    const user = [
      context.taskTitle ? `TASK: ${context.taskTitle}` : '',
      '',
      'EXISTING NEARBY MEMORIES:',
      neighborBlock,
      '',
      'CANDIDATE STATEMENTS:',
      candidateBlock,
      '',
      'Return JSON ONLY:',
      '{"memories":[{"operation":"ADD|UPDATE|NOOP","type":"success_pattern|failure|recovery|decision|distilled_lesson","title":"<=80 chars","statement":"third-person reusable rule","scope":"workspace|agent","confidence":0.0,"targetIndex":null,"reason":"<=120 chars"}]}',
      'targetIndex refers to the [n] index of an EXISTING memory for UPDATE/NOOP, else null. Omit dropped candidates entirely.',
    ].join('\n');

    let parsed: { memories?: unknown } | null = null;
    try {
      parsed = await this.completer.completeStructured<{ memories?: unknown }>({
        system,
        user,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        maxTokens: 900,
        maxAttempts: 2,
      });
    } catch {
      return null;
    }
    if (!parsed) return null;

    const rows = Array.isArray(parsed.memories) ? parsed.memories : [];
    const out: FormedMemory[] = [];
    for (const raw of rows) {
      const formed = coerceFormed(raw, context);
      if (formed) out.push(formed);
    }
    return out;
  }
}

function coerceFormed(raw: unknown, context: FormationContext): FormedMemory | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const operation = r.operation === 'UPDATE' ? 'UPDATE' : r.operation === 'NOOP' ? 'NOOP' : 'ADD';
  const type = JUDGE_TYPES.includes(r.type as RuntimeEpisodeType)
    ? (r.type as RuntimeEpisodeType)
    : 'distilled_lesson';
  const statement = typeof r.statement === 'string' ? r.statement.trim() : '';
  if (statement.length < 12) return null;
  // Reject anything the judge let slip that still reads as first-person narration.
  if (/^(i|we)\s/i.test(statement) || isRejectable(statement)) return null;

  const title = typeof r.title === 'string' && r.title.trim()
    ? truncate(r.title.trim(), 92)
    : truncate(statement, 92);
  const scope = r.scope === 'agent' && context.agentScopeId ? 'agent' : 'workspace';
  const confidence = clamp01(typeof r.confidence === 'number' ? r.confidence : 0.6);

  let targetAtomId: string | null = null;
  if (operation !== 'ADD') {
    const idx = typeof r.targetIndex === 'number' ? r.targetIndex : -1;
    targetAtomId = context.neighbors[idx]?.id ?? null;
    // An UPDATE/NOOP with no resolvable target is meaningless — drop it.
    if (!targetAtomId) return null;
  }

  return {
    operation,
    type,
    title,
    statement: truncate(statement, 480),
    scope,
    confidence,
    targetAtomId,
    reason: typeof r.reason === 'string' ? truncate(r.reason, 160) : undefined,
  };
}

// ────────────────────────────────────────────────────────────
// Shared text helpers (self-contained so the gate stays testable)
// ────────────────────────────────────────────────────────────

/** Flatten arbitrary task output into candidate text fragments. */
export function flattenText(value: unknown, depth = 0): string[] {
  if (depth > 4 || value == null) return [];
  if (typeof value === 'string') return [value];
  if (typeof value === 'number' || typeof value === 'boolean') return [];
  if (Array.isArray(value)) return value.flatMap((entry) => flattenText(entry, depth + 1));
  if (typeof value === 'object') {
    const out: string[] = [];
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (/token|secret|password|authorization|cookie/i.test(key)) continue;
      if (/summary|result|output|content|message|error|reason|lesson|observation|finding|conclusion/i.test(key)) {
        out.push(...flattenText(entry, depth + 1));
      } else if (depth < 2) {
        out.push(...flattenText(entry, depth + 1));
      }
    }
    return out;
  }
  return [];
}

/** Remove fenced code blocks and bracket-balanced JSON objects/arrays. */
export function stripNonProse(text: string): string {
  let out = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
  out = out.replace(/(\{[\s\S]{40,}?\}|\[[\s\S]{40,}?\])/g, (block) => {
    const looksJson = /["']\s*:/.test(block) || /^\s*\[/.test(block);
    return looksJson ? ' ' : block;
  });
  return out;
}

function stripMarkdownPrefix(line: string): string {
  return line.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s+)/, '');
}

function pipeCount(text: string): number {
  return (text.match(/\|/g) ?? []).length;
}

function urlShare(text: string): number {
  const urls = text.match(/https?:\/\/\S+/g) ?? [];
  if (urls.length === 0) return 0;
  const urlChars = urls.reduce((sum, u) => sum + u.length, 0);
  return urlChars / Math.max(1, text.length);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
