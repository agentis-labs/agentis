/**
 * opsApi — runs + approvals client for the App live-operations plane
 * (APP-INTERFACE-10X §2.2). Thin typed wrappers over `/v1/runs` and
 * `/v1/approvals`, shared by the RunMonitor / AgentFeed / ApprovalsInbox blocks
 * and the App Shell ops drawer.
 */
import { api } from './api';

/** Subset of the server's `presentRunSummary` the ops blocks consume. */
export interface RunSummary {
  id: string;
  workflowId: string;
  workflowName?: string;
  status: string;
  createdAt: string;
  startedAt: string;
  completedAt: string | null;
  durationMs?: number | null;
  currentStep?: string;
  totalSteps?: number;
  stepIndex?: number;
  failedNode?: string;
  failureReason?: string | null;
  agents?: Array<{ id: string; name: string }>;
  tokenUsage?: { input: number; output: number };
}

export interface ApprovalRequest {
  id: string;
  runId: string | null;
  taskId?: string | null;
  targetId?: string | null;
  source: string;
  title: string;
  summary: string;
  status: string;
  createdAt: string;
  confidence?: number | null;
  payload?: Record<string, unknown> | null;
  workflowId?: string | null;
  workflowName?: string | null;
  agentName?: string | null;
  nodeTitle?: string | null;
  nodeType?: string | null;
}

/** Statuses that mean a run is still in flight. */
export const ACTIVE_RUN_STATUSES = new Set(['RUNNING', 'WAITING', 'PAUSED', 'running', 'waiting', 'paused']);

export function isActiveRunStatus(status: string): boolean {
  return ACTIVE_RUN_STATUSES.has(status) || ACTIVE_RUN_STATUSES.has(status.toUpperCase());
}

export const opsApi = {
  listRuns: (opts: { workflowId?: string; limit?: number; status?: string } = {}) => {
    const params = new URLSearchParams();
    if (opts.workflowId) params.set('workflowId', opts.workflowId);
    if (opts.status) params.set('status', opts.status);
    params.set('limit', String(opts.limit ?? 50));
    return api<{ runs: RunSummary[] }>(`/v1/runs?${params.toString()}`).then((r) => r.runs);
  },
  cancelRun: (id: string) => api(`/v1/runs/${id}/cancel`, { method: 'POST' }),
  pauseRun: (id: string) => api(`/v1/runs/${id}/pause`, { method: 'POST' }),
  resumeRun: (id: string) => api(`/v1/runs/${id}/resume`, { method: 'POST' }),

  listApprovals: () => api<{ approvals: ApprovalRequest[] }>('/v1/approvals?status=pending').then((r) => r.approvals),
  resolveApproval: (id: string, decision: 'approve' | 'reject', reason?: string) =>
    api(`/v1/approvals/${id}/resolve`, { method: 'POST', body: JSON.stringify({ decision, ...(reason ? { reason } : {}) }) }),
};
