export interface WorkflowStageTarget {
  workflowId: string;
  runId?: string;
  agentId?: string | null;
}

export function workflowStageTargetFromBuildPayload(payload: unknown): WorkflowStageTarget | null {
  if (!payload || typeof payload !== 'object') return null;

  const value = payload as {
    workflowId?: unknown;
    runId?: unknown;
    agentId?: unknown;
  };
  if (typeof value.workflowId !== 'string' || !value.workflowId.trim()) return null;

  return {
    workflowId: value.workflowId,
    ...(typeof value.runId === 'string' && value.runId.trim() ? { runId: value.runId } : {}),
    ...(typeof value.agentId === 'string' || value.agentId === null ? { agentId: value.agentId } : {}),
  };
}

export function mergeWorkflowStageTarget(
  current: WorkflowStageTarget | null,
  next: WorkflowStageTarget,
): WorkflowStageTarget {
  if (current?.workflowId !== next.workflowId) return next;
  return {
    ...current,
    ...next,
    runId: next.runId ?? current.runId,
    agentId: next.agentId ?? current.agentId,
  };
}
