import { useEffect, useMemo, useState } from 'react';
import { api, workspace as workspaceStore } from '../../lib/api';

export interface ChatPrimaryScope {
  id: string;
  name: string;
  role: 'orchestrator' | 'manager';
  status?: string | null;
  colorHex?: string | null;
  spaceName?: string | null;
}

interface OrchestratorResponse {
  agent: {
    id: string;
    name: string;
    role?: string | null;
    status?: string | null;
    colorHex?: string | null;
  };
}

interface ManagerResponse {
  agents: Array<{
    id: string;
    name: string;
    role?: string | null;
    status?: string | null;
    colorHex?: string | null;
    spaceName?: string | null;
  }>;
}

interface WorkspaceDetailResponse {
  workspace: {
    id: string;
    name: string;
  };
}

export function usePrimaryChatScopes() {
  const [loading, setLoading] = useState(true);
  const [orchestrator, setOrchestrator] = useState<ChatPrimaryScope | null>(null);
  const [managers, setManagers] = useState<ChatPrimaryScope[]>([]);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [missingOrchestrator, setMissingOrchestrator] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      const workspaceId = workspaceStore.get();
      const [orchestratorResult, managerResult, workspaceResult] = await Promise.allSettled([
        api<OrchestratorResponse>('/v1/conversations/orchestrator'),
        api<ManagerResponse>('/v1/agents?role=manager'),
        workspaceId ? api<WorkspaceDetailResponse>(`/v1/workspaces/${workspaceId}`) : Promise.resolve(null),
      ]);

      if (cancelled) return;

      const orchestratorAgent = orchestratorResult.status === 'fulfilled'
        ? orchestratorResult.value?.agent
        : null;

      setWorkspaceName(
        workspaceResult.status === 'fulfilled'
          ? workspaceResult.value?.workspace?.name ?? null
          : null,
      );

      if (orchestratorAgent?.id && orchestratorAgent.name) {
        setMissingOrchestrator(false);
        setOrchestrator({
          id: orchestratorAgent.id,
          name: orchestratorAgent.name,
          role: 'orchestrator',
          status: orchestratorAgent.status ?? null,
          colorHex: orchestratorAgent.colorHex ?? null,
        });
      } else {
        setMissingOrchestrator(true);
        setOrchestrator(null);
      }

      if (managerResult.status === 'fulfilled') {
        setManagers(
          (managerResult.value.agents ?? []).map((agent) => ({
            id: agent.id,
            name: agent.name,
            role: 'manager',
            status: agent.status ?? null,
            colorHex: agent.colorHex ?? null,
            spaceName: agent.spaceName ?? null,
          })),
        );
      } else {
        setManagers([]);
      }

      setLoading(false);
    }

    void load();
    const onWorkspaceChanged = () => setReloadKey((current) => current + 1);
    window.addEventListener('agentis:workspace-changed', onWorkspaceChanged);
    return () => {
      cancelled = true;
      window.removeEventListener('agentis:workspace-changed', onWorkspaceChanged);
    };
  }, [reloadKey]);

  const scopes = useMemo(() => {
    const next: ChatPrimaryScope[] = [];
    if (orchestrator) next.push(orchestrator);
    next.push(...managers);
    return next;
  }, [managers, orchestrator]);

  return {
    loading,
    orchestrator,
    managers,
    scopes,
    workspaceName,
    missingOrchestrator,
    refresh: () => setReloadKey((current) => current + 1),
  };
}