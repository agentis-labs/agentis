/**
 * Surface-agnostic step projection. The agent's task spine emits TASK_SPINE_*
 * events whose payload carries the linear `steps[]` + current/total (see
 * planService.publishTaskEvent). We index the live activity feed by the keys a
 * WorkSession can be matched on (conversation / run / task) and resolve the
 * track per session — first-class when a spine exists, derived from the
 * session's own progress otherwise.
 */

import type { WorkStep, WorkStepStatus, WorkStepTrack } from '@agentis/core';
import type { RealtimeActivity } from './realtimeActivity';
import type { WorkSession } from './workSessions';

const STEP_STATUSES: WorkStepStatus[] = ['pending', 'running', 'done', 'failed'];

/** Parse a structured step track from a TASK_SPINE_* event payload, if present. */
export function readPlanStepTrack(raw: Record<string, unknown> | undefined): WorkStepTrack | null {
  if (!raw) return null;
  const rawSteps = raw.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) return null;
  const steps: WorkStep[] = [];
  for (const entry of rawSteps) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const label = typeof record.label === 'string' ? record.label : null;
    if (!label) continue;
    const status = STEP_STATUSES.includes(record.status as WorkStepStatus)
      ? (record.status as WorkStepStatus)
      : 'pending';
    steps.push({
      id: typeof record.id === 'string' ? record.id : `${steps.length}`,
      label,
      status,
      ...(typeof record.detail === 'string' ? { detail: record.detail } : {}),
    });
  }
  if (steps.length === 0) return null;
  const total = typeof raw.stepTotal === 'number' ? raw.stepTotal : steps.length;
  const current = typeof raw.stepCurrent === 'number'
    ? raw.stepCurrent
    : steps.filter((step) => step.status === 'done' || step.status === 'failed').length;
  return { steps, current: Math.min(current, total), total };
}

export type StepIndex = Map<string, WorkStepTrack>;

function indexKeys(activity: RealtimeActivity): string[] {
  const keys: string[] = [];
  if (activity.taskId) keys.push(`task:${activity.taskId}`);
  if (activity.conversationId) keys.push(`conv:${activity.conversationId}`);
  const agentId = activity.agentId ?? (typeof activity.raw?.agentId === 'string' ? activity.raw.agentId : undefined);
  if (agentId) keys.push(`agent:${agentId}`);
  const runIds = activity.raw?.runIds;
  if (Array.isArray(runIds)) for (const id of runIds) if (typeof id === 'string') keys.push(`run:${id}`);
  if (activity.runId) keys.push(`run:${activity.runId}`);
  return keys;
}

/**
 * Build a lookup of the freshest step track per key. The feed is newest-first,
 * so the first track seen for a key wins.
 */
export function buildStepIndex(activity: RealtimeActivity[]): StepIndex {
  const index: StepIndex = new Map();
  for (const item of activity) {
    if (item.kind !== 'task') continue;
    const track = readPlanStepTrack(item.raw);
    if (!track) continue;
    for (const key of indexKeys(item)) {
      if (!index.has(key)) index.set(key, track);
    }
  }
  return index;
}

/** Resolve the structured track for a session, if one was published. */
export function sessionStepTrack(session: WorkSession, index: StepIndex): WorkStepTrack | null {
  const candidates = [
    session.conversationId && `conv:${session.conversationId}`,
    session.runId && `run:${session.runId}`,
    session.agentId && `agent:${session.agentId}`,
    ...session.participantAgentIds.map((id) => `agent:${id}`),
  ].filter(Boolean) as string[];
  for (const key of candidates) {
    const track = index.get(key);
    if (track) return track;
  }
  return null;
}
