/**
 * Self-improving Workflow Playbook (WORKFLOW-DESIGN-10X Phase 5).
 *
 * The doctrine (Phase 1) and pattern library (Phase 4) are STATIC knowledge. The
 * playbook is the LIVING half: workspace-scoped "failure-mode → fix" lessons that
 * the agent (or the repair loop) records after a novel run failure, and that are
 * recalled into the synthesis brief so the NEXT build avoids the same mistake —
 * exactly how a hand-maintained protocol accrues "common failure modes" over time,
 * but wired to real runs.
 *
 * Storage rides the existing typed workspace-memory substrate (MemoryStore) — a
 * 'lesson' atom tagged `workflow_playbook` — so there is no new table/migration.
 */

import type { MemoryStore } from '../memory/memoryStore.js';

export const WORKFLOW_PLAYBOOK_TAG = 'workflow_playbook';

export interface WorkflowLesson {
  /** The situation/failure that triggered the lesson ("Instagram sidecar posts hide media from basic scrapers"). */
  failureMode: string;
  /** What to do about it next time ("validate the raw post payload first; fall back to screenshots only if usable"). */
  fix: string;
  /** Optional id of the robust pattern that addresses it (workflowPatterns.ts). */
  patternId?: string;
}

/** Record a learned lesson into the workspace playbook. Returns the memory id, or null if memory is unavailable. */
export function recordWorkflowLesson(
  memory: MemoryStore | undefined,
  workspaceId: string,
  lesson: WorkflowLesson,
  agentId?: string | null,
): string | null {
  if (!memory) return null;
  const failureMode = lesson.failureMode.trim();
  const fix = lesson.fix.trim();
  if (!failureMode || !fix) return null;
  const content = [
    `WHEN: ${failureMode}`,
    `DO: ${fix}`,
    ...(lesson.patternId ? [`PATTERN: ${lesson.patternId}`] : []),
  ].join('\n');
  // DEDUP BY TITLE (centralized so every caller benefits): re-learning the same
  // failure mode UPDATES the existing lesson instead of piling rows the
  // operator can only tell apart by uuid.
  const normalizedTitle = failureMode.slice(0, 120).toLowerCase().replace(/\s+/g, ' ').trim();
  try {
    const existing = memory
      .list({ workspaceId, scopeId: null, kind: 'lesson', limit: 200 })
      .find((episode) =>
        episode.tags.includes(WORKFLOW_PLAYBOOK_TAG)
        && episode.title.toLowerCase().replace(/\s+/g, ' ').trim() === normalizedTitle);
    if (existing) {
      memory.update(workspaceId, null, existing.id, { content });
      return existing.id;
    }
  } catch {
    /* dedup is best-effort — fall through to a fresh write */
  }
  return memory.write({
    workspaceId,
    scopeId: null,
    kind: 'lesson',
    source: 'agent',
    title: failureMode.slice(0, 120),
    content,
    tags: [WORKFLOW_PLAYBOOK_TAG],
    importance: 0.7,
    trust: 0.7,
    provenance: { source: 'workflow_playbook', agentId: agentId ?? null },
  });
}

/**
 * Does this failure teach a durable DESIGN lesson (a guard / precondition /
 * validation / contract / business-rule rejection that dead-ended the run), as
 * opposed to a transient infra failure (self-heal's territory, not a lesson)?
 * The "fail-forward, don't dead-end" law (COGNITIVE-LOOPING / WORKFLOW-DESIGN):
 * a run that hard-stops at a guard should have been built as a corrective loop.
 */
export function isInstructiveFailure(error: string | undefined | null): boolean {
  if (!error) return false;
  const e = error.toLowerCase();
  // Transient / runtime-class — NOT a design lesson.
  if (/\b(timeout|timed out|econnrefused|enotfound|enoent|socket hang|rate.?limit|429|credits?|quota|out of memory|oom|network error|fetch failed|aborted|econnreset|etimedout)\b/.test(e)) {
    return false;
  }
  // Instructive: an explicit guard block, precondition, validation, or contract gap.
  return /\b(block(ed)?|must (be|have|first|not)|before |require[ds]?|precondition|unresolved|missing|expected|invalid|validation|not allowed|forbidden|sufficiency|contract|placeholder|out of scope|dead[- ]?end)\b/.test(e)
    || /(^|[^A-Z])[A-Z][A-Z0-9]{3,}(_[A-Z0-9]+)+\s*:/.test(error); // a CODE: message (BLOCKED_UNRESOLVED_BIO_LINK: …)
}

/**
 * Distill a node failure into a workspace playbook lesson (failureMode → fix).
 * Deterministic + non-throwing: the error text usually states the requirement,
 * so the fix reads it back and prescribes the fail-forward correction. Covers
 * both a fixable precondition (loop back) and a genuine out-of-scope input
 * (filter/route earlier) — never wrong advice.
 */
export function distillFailureLesson(args: { workflowTitle?: string | null; nodeTitle: string; error: string }): WorkflowLesson {
  const error = args.error.trim().replace(/\s+/g, ' ');
  const where = args.workflowTitle ? `In "${args.workflowTitle}", ` : '';
  const failureMode = `${where}the step "${args.nodeTitle}" hard-stopped the run: ${error}`.slice(0, 280);
  const fix = (
    'This step DEAD-ENDED the run instead of failing forward. Either (a) if the block is a fixable precondition, '
    + 'wire a corrective loop — a `pursue` (or a correction edge back to the producing step) that re-runs it with THIS '
    + 'feedback until the precondition holds; or (b) if it is a genuinely out-of-scope input, filter/route it earlier so '
    + `the run never reaches a hard stop here. Requirement stated by the guard: ${error}`
  ).slice(0, 500);
  return { failureMode, fix };
}

export interface RecalledLesson {
  title: string;
  content: string;
}

/** Recall the most relevant recent playbook lessons for injection into a build. */
export function recallWorkflowLessons(
  memory: MemoryStore | undefined,
  workspaceId: string,
  limit = 8,
): RecalledLesson[] {
  if (!memory) return [];
  try {
    return memory
      .list({ workspaceId, scopeId: null, kind: 'lesson', limit: 50 })
      .filter((episode) => episode.tags.includes(WORKFLOW_PLAYBOOK_TAG))
      .slice(0, limit)
      .map((episode) => ({ title: episode.title, content: episode.content }));
  } catch {
    return [];
  }
}

/** Render recalled lessons as a synthesis-prompt block, or '' when there are none. */
export function renderPlaybookLessons(lessons: RecalledLesson[]): string {
  if (lessons.length === 0) return '';
  return [
    'LEARNED LESSONS FROM PAST RUNS (this workspace already hit these — design around them):',
    ...lessons.map((l) => `- ${l.content.replace(/\n/g, ' ')}`),
  ].join('\n');
}
