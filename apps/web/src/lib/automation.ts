/**
 * Self-healing workflow + operating-manual settings client (AGENT-AUTONOMY W7/W2).
 */

import { api, workspace } from './api';

export interface SelfHealConfig {
  enabled: boolean;
  mode: 'guarded' | 'bypass';
  maxRepairPlans: number;
  /** Agent that grounds repairs + is the reroute target. null = orchestrator (default). */
  healerAgentId: string | null;
}

function wsId(): string {
  const id = workspace.get();
  if (!id) throw new Error('No workspace selected');
  return id;
}

export function getSelfHealConfig() {
  return api<SelfHealConfig>(`/v1/workspaces/${wsId()}/self-heal`);
}

export function setSelfHealConfig(patch: Partial<SelfHealConfig>) {
  return api<SelfHealConfig>(`/v1/workspaces/${wsId()}/self-heal`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
}
