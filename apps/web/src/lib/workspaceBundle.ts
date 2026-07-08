/**
 * Workspace bundle (`.agentis`) API client — export / preview / import the whole
 * workspace, plus the full-fidelity backup/restore path.
 */
import type { ExportProfile, WorkspaceBundleEnvelope, WorkspaceBundlePreview } from '@agentis/core';
import { api } from './api';

export interface BundleInstallResult {
  agents: number;
  apps: number;
  workflows: number;
  extensions: number;
  abilities: number;
  knowledgeSeeds: number;
  requiredCredentials: Array<{ key: string; service: string; label: string }>;
  warnings: string[];
}

export const workspaceBundleApi = {
  export: (body: { profile: Exclude<ExportProfile, 'backup'>; name?: string; description?: string | null; license?: string | null }) =>
    api<WorkspaceBundleEnvelope>('/v1/workspace/bundle/export', { method: 'POST', body: JSON.stringify(body) }),

  preview: (envelope: WorkspaceBundleEnvelope) =>
    api<WorkspaceBundlePreview>('/v1/workspace/bundle/preview', { method: 'POST', body: JSON.stringify({ envelope }) }),

  import: (envelope: WorkspaceBundleEnvelope) =>
    api<BundleInstallResult>('/v1/workspace/bundle/import', {
      method: 'POST',
      body: JSON.stringify({ envelope, permissionsAcknowledged: true }),
    }),

  backup: () =>
    api<{ outDir: string; files: string[]; note: string }>('/v1/workspace/bundle/backup', { method: 'POST', body: '{}' }),
};

/** Type guard: a parsed JSON file is a `.agentis` workspace bundle envelope. */
export function isWorkspaceBundle(json: Record<string, unknown>): json is WorkspaceBundleEnvelope {
  return json.format === '.agentis' && typeof json.manifest === 'object' && json.manifest !== null && 'agents' in (json.manifest as object);
}
