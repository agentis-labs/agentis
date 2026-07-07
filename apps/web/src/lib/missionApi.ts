/**
 * Mission Control client (Agent-Native §3.6) — typed reads over /v1/mission for the
 * cross-agent command center: resident agents, the subject pipeline, and experiment
 * results.
 */
import { api } from './api';

export interface MissionSummary {
  residentAgents: number;
  subjects: number;
  activeSubjects: number;
  experiments: number;
}

export interface MissionAgent {
  id: string;
  name: string;
  role: string | null;
  status: string | null;
  resident: boolean;
  intervalMinutes: number | null;
  grants: number;
}

export interface MissionSubject {
  id: string;
  key: string;
  status: string;
  stage: string | null;
  name: string | null;
  parked: boolean;
  updatedAt: string;
}

export interface VariantResult {
  variant: string;
  assigned: number;
  withOutcome: number;
  outcomes: Record<string, number>;
  successRate: number;
}

export interface MissionExperiment {
  key: string;
  status: string;
  results: VariantResult[];
}

export const missionApi = {
  summary: () => api<MissionSummary>('/v1/mission/summary'),
  agents: () => api<{ agents: MissionAgent[]; residentCount: number }>('/v1/mission/agents'),
  subjects: () => api<{ subjects: MissionSubject[]; byStage: Record<string, number>; total: number }>('/v1/mission/subjects'),
  experiments: () => api<{ experiments: MissionExperiment[] }>('/v1/mission/experiments'),
};
