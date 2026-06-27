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

import type { MemoryStore } from './memoryStore.js';

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
