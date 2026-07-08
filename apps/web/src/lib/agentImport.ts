/**
 * Agent transition & import client (AGENT-TRANSITION Â§8).
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



