/**
 * Agent transition & import client (AGENT-TRANSITION §8).
 * Detect external agents on the machine, preview their scope-routed memory,
 * and import them (commission + ingest). Plus runtime rebind (Track R).
 */

import { api } from './api';
import type { IngestCandidate } from './connections';

export interface DiscoveredAgentRow {
  adapterType: string;
  externalId: string;
  name: string;
  role?: string | null;
  persona?: string | null;
  detectedModel?: string | null;
  origin: { harness: string; rootPath: string };
  summary: { memoryFiles: number; workspaceFiles: number; agentFiles: number; skills: number };
  alreadyImported: { agentId: string } | null;
}

export interface SkillCandidate {
  path: string;
  name: string;
  description?: string | null;
  origin: 'user' | 'project' | 'marketplace';
  alreadyImported: boolean;
}

export interface AgentImportPreview {
  agent: DiscoveredAgentRow;
  candidates: Array<IngestCandidate & { scopeHint: 'workspace' | 'agent' }>;
  skills: SkillCandidate[];
  scannedFiles: Array<{ fileName: string; source: string; candidateCount: number; skipped: boolean }>;
}

export interface ImportAgentSpec {
  externalId: string;
  overrides?: { name?: string; role?: string | null; reportsTo?: string | null };
  acceptedHashes?: string[];
  acceptedSkillPaths?: string[];
  minQuality?: number;
}

export interface ImportAgentOutcome {
  externalId: string;
  agentId: string;
  created: boolean;
  name: string;
  adapterType: string;
  memory: { written: number; reinforced: number; skipped: number; episodeIds: string[] };
  abilities: { created: number; reused: number };
}

export interface ImportBatchResult {
  imported: ImportAgentOutcome[];
  totalAtoms: number;
  totalAbilities: number;
}

export function discoverImportableAgents() {
  return api<{ agents: DiscoveredAgentRow[] }>('/v1/harness/agents');
}

export interface ImportUpdate {
  agentId: string;
  externalId: string;
  name: string;
  adapterType: string;
  pendingNew: number;
  pendingMemory: number;
  pendingSkills: number;
}

export type AgentSyncMode = 'manual_review' | 'auto_trusted' | 'disabled';
export type AgentSyncItemStatus = 'pending' | 'applied' | 'rejected' | 'quarantined' | 'deleted';

export interface AgentSyncPolicy {
  memory: 'review' | 'auto_quality' | 'disabled';
  skills: 'review' | 'auto_owned' | 'disabled';
  identity: 'review' | 'auto_trusted' | 'disabled';
  deletions: 'review' | 'auto' | 'ignore';
  minAutoQuality: number;
}

export interface AgentSyncSource {
  id: string;
  agentId: string;
  adapterType: string;
  externalId: string;
  mode: AgentSyncMode;
  policyJson: AgentSyncPolicy;
  lastScanAt?: Date | string | null;
  lastSuccessAt?: Date | string | null;
  lastError?: string | null;
}

export interface AgentSyncItem {
  id: string;
  itemType: 'memory' | 'skill' | 'identity';
  sourcePath?: string | null;
  status: AgentSyncItemStatus;
  qualityScore?: number | null;
  reason?: string | null;
  payloadJson?: Record<string, unknown> | null;
  firstSeenAt: Date | string;
  lastSeenAt: Date | string;
  appliedAt?: Date | string | null;
}

export interface AgentSyncRun {
  id: string;
  trigger: 'manual' | 'scheduled' | 'watch';
  mode: AgentSyncMode;
  status: 'running' | 'completed' | 'failed' | 'skipped';
  detectedCount: number;
  appliedCount: number;
  error?: string | null;
  startedAt: Date | string;
  completedAt?: Date | string | null;
}

export interface AgentSyncState {
  source: AgentSyncSource | null;
  items: AgentSyncItem[];
  history: AgentSyncRun[];
}

export function getAgentSync(agentId: string) {
  return api<AgentSyncState>(`/v1/harness/sync/${encodeURIComponent(agentId)}`);
}

export function updateAgentSyncPolicy(agentId: string, input: { mode?: AgentSyncMode; policy?: Partial<AgentSyncPolicy> }) {
  return api<{ source: AgentSyncSource }>(`/v1/harness/sync/${encodeURIComponent(agentId)}/policy`, {
    method: 'PUT', body: JSON.stringify(input),
  });
}

export function scanAgentSync(agentId: string) {
  return api<{ run: AgentSyncRun; items: AgentSyncItem[] }>(`/v1/harness/sync/${encodeURIComponent(agentId)}/scan`, { method: 'POST' });
}

export function applyAgentSync(agentId: string, itemIds: string[]) {
  return api<{ memories: number; skills: number; identities: number; deleted: number }>(`/v1/harness/sync/${encodeURIComponent(agentId)}/apply`, {
    method: 'POST', body: JSON.stringify({ itemIds }),
  });
}

export function rejectAgentSync(agentId: string, itemIds: string[], reason?: string) {
  return api<{ rejected: number }>(`/v1/harness/sync/${encodeURIComponent(agentId)}/reject`, {
    method: 'POST', body: JSON.stringify({ itemIds, reason }),
  });
}

/** P4: new memory accrued by already-imported agents (approval-gated pull). */
export function checkImportUpdates() {
  return api<{ updates: ImportUpdate[] }>('/v1/harness/import/updates');
}

export function previewAgentImport(externalId: string) {
  return api<AgentImportPreview>('/v1/harness/agents/preview', {
    method: 'POST',
    body: JSON.stringify({ externalId }),
  });
}

export type MemoryDisposition = 'promote' | 'delete' | 'transfer';

/** Delete an agent, deciding the fate of its memory (B11). */
export function deleteAgentWithMemory(agentId: string, disposition: MemoryDisposition, targetAgentId?: string) {
  const params = new URLSearchParams({ memoryDisposition: disposition });
  if (disposition === 'transfer' && targetAgentId) params.set('targetAgentId', targetAgentId);
  return api<{ ok: boolean; memoryMoved: number; memoryDeleted: number }>(`/v1/agents/${agentId}?${params.toString()}`, {
    method: 'DELETE',
  });
}

export function importAgents(agents: ImportAgentSpec[]) {
  return api<ImportBatchResult>('/v1/harness/import', {
    method: 'POST',
    body: JSON.stringify({ agents }),
  });
}

export interface SwitchRuntimeResult {
  id: string;
  adapterType: string;
  runtimeModel: string | null;
  status: 'online' | 'paused' | 'error';
}

/** Rebind an existing agent to a different runtime, keeping identity + memory. */
export function switchAgentRuntime(agentId: string, input: { adapterType: string; config?: Record<string, unknown>; runtimeModel?: string | null }) {
  return api<SwitchRuntimeResult>(`/v1/agents/${agentId}/runtime`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}



