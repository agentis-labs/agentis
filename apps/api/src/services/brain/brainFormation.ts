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
import { tokenize, looksSensitive, directivePolarity } from './brainText.js';
import type { StructuredCompleter } from '../structuredCompleter.js';

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

/** Scripts that pack meaning densely and lack whitespace word boundaries. */
const CJK_DENSE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;

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
    // §3.5 — CJK/Thai/etc. carry far more meaning per character than Latin, so a
    // 25-char floor silently rejects substantial non-Latin statements. Drop the
    // floor for scripts without whitespace word boundaries (measured in code
    // points, not UTF-16 units). Latin stays at 25.
    const len = [...text].length;
    const minLen = CJK_DENSE.test(text) ? 10 : 25;
    if (len < minLen || len > 500) continue;
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
 * Extract candidate statements from AUTHORITATIVE OPERATOR speech (a chat turn).
 *
 * The operator is the source of truth, speaks in first person, and is terse —
 * so the strict agent-output gate (`extractCandidateStatements`) is WRONG here:
 * it drops "I am the CTO" (first-person), "Use HTTPS always" (too short), and
 * "My company is Acme" (no durable-knowledge cue word). Those are exactly the
 * things the operator complains aren't remembered. This gate is deliberately
 * permissive — it keeps first-person and short statements and assigns a passing
 * base score — and only drops what is clearly NOT a memory: questions, pure
 * task commands ("create a workflow"), sensitive secrets, and empties. The
 * FormationJudge downstream is the real quality + reconciliation gate.
 */
export function extractOperatorCandidates(text: string): ScoredStatement[] {
  const seen = new Set<string>();
  const out: ScoredStatement[] = [];
  for (const rawLine of String(text ?? '').split(/\r?\n|(?<=[.!?])\s+/)) {
    const statement = stripMarkdownPrefix(rawLine).trim().replace(/\s+/g, ' ');
    const len = [...statement].length;
    const minLen = CJK_DENSE.test(statement) ? 4 : 8; // terse operator lines are valid
    if (len < minLen || len > 500) continue;
    if (isOperatorQuestion(statement)) continue;
    if (isPureTaskCommand(statement)) continue;
    if (looksSensitive(statement)) continue;
    const key = tokenize(statement).slice(0, 18).join(' ');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    // Operator speech is authoritative — start above the formation threshold so
    // it always reaches the judge; cue words still raise it.
    let score = 0.6;
    if (/\b(always|never|must|should|do not|don'?t|avoid|prefer|require|only|i am|i'?m|my|our|we use|we prefer)\b/i.test(statement)) score += 0.2;
    out.push({ text: statement, score: clamp01(score) });
  }
  return out;
}

/** A question is operator intent to be answered, not a durable statement. */
function isOperatorQuestion(text: string): boolean {
  const t = text.trim();
  if (/\?\s*$/.test(t)) return true;
  if (/^(do not|don'?t)\b/i.test(t)) return false; // imperative rule, not a question
  return /^(how|what|why|when|where|who|which|whose|whom|can|could|would|should|will|is|are|do|does|did)\b/i.test(t);
}

/**
 * Standing modality — the signal that an imperative is a recurring RULE rather
 * than a one-off job.
 *
 * The previous version matched a closed list of English phrases, so
 * "Configure retries to 3 every deploy" was discarded as a task: `configure`
 * matched the verb list and "every deploy" was not among `every time|each time|
 * by default|…`. Two fixes: recognise the productive "every/each/any + noun"
 * construction instead of enumerating instances of it, and cover the other
 * languages the product ships in.
 */
const STANDING_MODALITY = new RegExp(
  [
    // Productive construction: every/each/any <noun>, all <noun>s.
    String.raw`\b(every|each|any)\s+\w+`,
    String.raw`\ball\s+\w+s\b`,
    // English closed-class.
    String.raw`\b(always|never|whenever|by default|going forward|from now on)\b`,
    // Portuguese / Spanish.
    String.raw`\b(sempre|siempre|nunca|jamais|cada|todo|toda|todos|todas|a cada|por padrão|por defecto|de agora em diante)\b`,
    // French / Italian / German.
    String.raw`\b(toujours|chaque|par défaut|désormais|sempre|ogni|per impostazione|immer|jede[srmn]?|standardmäßig|ab sofort)\b`,
    // Russian.
    String.raw`(всегда|никогда|каждый|каждую|по умолчанию)`,
  ].join('|'),
  'iu',
);

/** CJK standing markers — no word boundaries exist, so matched as substrings. */
const STANDING_MODALITY_CJK = /(每次|每个|总是|始终|务必|默认|今后|必ず|常に|毎回|デフォルト|항상|매번|기본적으로)/u;

/**
 * A one-off task command ("create a workflow that…", "send the report") is work
 * to DO now, not a durable memory — UNLESS it carries standing modality
 * ("always create a backup before deploy"), which is a recurring rule and kept.
 */
function isPureTaskCommand(text: string): boolean {
  const t = text.trim().toLowerCase()
    .replace(/^(please|kindly|can you|could you|now|go ahead and|i need you to|i want you to)\s+/i, '');
  const TASK_VERB = /^(create|build|make|set ?up|add|generate|watch|monitor|schedule|draft|write|design|deploy|run|fetch|scrape|email|send|post|publish|find|search|look up|check|update|delete|remove|configure|connect|integrate|summari[sz]e|analy[sz]e|review|compile|export|import|download|upload)\b/;
  if (!TASK_VERB.test(t)) return false;
  return !STANDING_MODALITY.test(t) && !STANDING_MODALITY_CJK.test(t);
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

  // §3.5 — the durable-knowledge CUES below are English regexes; on non-Latin
  // text none can fire, so a substantive statement is stuck at the base and
  // never clears the threshold (CJK personas formed almost no memory). For
  // predominantly non-Latin text we can't pattern-match cues, so we lean on the
  // reject-gate it already cleared + the FormationJudge downstream, and start
  // from a passing base. English text is all-Latin → base unchanged → the 27
  // English formation tests are unaffected.
  const letters = lower.match(/\p{L}/gu) ?? [];
  const latin = lower.match(/\p{Script=Latin}/gu) ?? [];
  const predominantlyNonLatin = letters.length >= 4 && latin.length / letters.length < 0.5;

  let score = predominantlyNonLatin ? 0.5 : 0.35;

  // Durable-knowledge cues: rules, causes, learnings, constraints.
  if (/\b(always|never|must|should|do not|don't|avoid|prefer|require|ensure|only|instead of)\b/.test(lower)) score += 0.22;
  if (/\b(because|therefore|so that|due to|results? in|leads? to|caused?|in order to)\b/.test(lower)) score += 0.12;
  if (/\b(learned|observed|confirmed|discovered|turns out|works? when|fails? when|the trick is)\b/.test(lower)) score += 0.16;
  if (/\b(rate limit|timeout|retry|threshold|policy|constraint|invariant|edge case|gotcha|pitfall)\b/.test(lower)) score += 0.12;
  // Additive durable-rule cues for the major Latin-script languages (es/pt/fr/
  // de/it) so non-English personas aren't mute. Purely additive — English text
  // won't match these and the English cues above still fire, so English scoring
  // is unchanged.
  if (/\b(siempre|sempre|toujours|immer|nunca|jamais|niemals|debe|deve|doit|muss|evitar|vermeiden|porque|weil|portanto|donc|deshalb)\b/i.test(lower)
    || /(parce que|por lo tanto|éviter)/i.test(lower)) score += 0.2;

  // §B5.8 — language-independent directive signal.
  //
  // The cue lists above are, unavoidably, enumerations of phrasings, and every
  // enumeration has an outside. A statement carrying directive POLARITY is a
  // rule by construction, in any of the scripts `directivePolarity` covers, so
  // it earns the same standing a matched English cue does. This is what lets
  // "部署前请务必备份数据库" or "Configure retries to 3 every deploy" clear the
  // threshold without an English cue and without a classifier — measured: e5
  // prototype-argmax scores 48% on this decision, i.e. worse than chance, so a
  // deterministic polarity signal is strictly better than a semantic one here.
  if (directivePolarity(text) !== 0) score += 0.2;

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
