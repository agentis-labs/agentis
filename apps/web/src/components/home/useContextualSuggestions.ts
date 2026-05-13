export interface Suggestion {
  id: string;
  label: string;
  prompt: string;
  recipient?: { kind: 'general' | 'agent' | 'team' | 'broadcast'; id: string };
  href?: string;
}

export interface SuggestionContext {
  activeRuns: Array<{ id: string; workflowId?: string; agentId?: string | null; workflowName?: string; status: string }> | null;
  recentArtifacts: Array<{ id: string; title: string; agentId?: string | null; workflowId?: string | null }> | null;
  pendingApprovals: Array<{ id: string; title?: string; summary?: string; source?: string; agentId?: string | null }> | null;
  agents: Array<{ id: string; name: string; defaultSuggestion?: string | null }>;
  teams: Array<{ id: string; name: string }>;
  workspaceAgeDays: number | null;
  lastActivityAt: Date | null;
}

export function computeSuggestions(ctx: SuggestionContext): Suggestion[] {
  const suggestions: Suggestion[] = [];
  const usedAgents = new Set<string>();

  const agentName = (id?: string | null) => ctx.agents.find((agent) => agent.id === id)?.name ?? 'agent';

  if (ctx.pendingApprovals && ctx.pendingApprovals.length > 0) {
    for (const approval of ctx.pendingApprovals) {
      if (approval.agentId && usedAgents.has(approval.agentId)) continue;
      if (approval.agentId) usedAgents.add(approval.agentId);
      const who = approval.agentId ? agentName(approval.agentId) : approval.source ?? 'agent';
      suggestions.push({
        id: `approval-${approval.id}`,
        label: `Review ${who}'s request`,
        prompt: `/approve ${approval.id}`,
        recipient: approval.agentId ? { kind: 'agent', id: approval.agentId } : undefined,
      });
      break;
    }
  }

  if (ctx.activeRuns && ctx.activeRuns.length > 0) {
    if (ctx.activeRuns.length > 2) {
      suggestions.push({
        id: 'broadcast-status',
        label: 'Ask the team for an update',
        prompt: '/broadcast status update from everyone',
        recipient: { kind: 'broadcast', id: 'all' },
      });
    }
    for (const run of ctx.activeRuns) {
      if (run.agentId && usedAgents.has(run.agentId)) continue;
      if (run.agentId) usedAgents.add(run.agentId);
      const who = run.agentId ? agentName(run.agentId) : run.workflowName ?? 'run';
      suggestions.push({
        id: `run-${run.id}`,
        label: `Ask ${who} for a status update`,
        prompt: '/status',
        recipient: run.agentId ? { kind: 'agent', id: run.agentId } : undefined,
      });
      break;
    }
  }

  const firstArtifact = ctx.recentArtifacts?.[0];
  if (firstArtifact) {
    suggestions.push({
      id: `artifact-improve-${firstArtifact.id}`,
      label: `Improve '${firstArtifact.title}'`,
      prompt: `Improve this artifact: ${firstArtifact.title}`,
      recipient: firstArtifact.agentId ? { kind: 'agent', id: firstArtifact.agentId } : undefined,
    });
  }

  const workflowArtifact = ctx.recentArtifacts?.find((artifact) => artifact.workflowId);
  if (workflowArtifact?.workflowId) {
    suggestions.push({
      id: `artifact-rerun-${workflowArtifact.id}`,
      label: `Run '${workflowArtifact.title}' again`,
      prompt: `/run ${workflowArtifact.workflowId}`,
    });
  }

  for (const agent of ctx.agents) {
    if (!agent.defaultSuggestion || usedAgents.has(agent.id)) continue;
    usedAgents.add(agent.id);
    suggestions.push({
      id: `default-${agent.id}`,
      label: agent.defaultSuggestion,
      prompt: agent.defaultSuggestion,
      recipient: { kind: 'agent', id: agent.id },
    });
    if (suggestions.length >= 4) break;
  }

  if ((ctx.workspaceAgeDays ?? 0) < 1 && (ctx.activeRuns?.length ?? 0) === 0) {
    suggestions.push({ id: 'cold-workflow', label: 'Create your first workflow', prompt: '/create workflow' });
  }

  if (ctx.agents.length === 0) {
    suggestions.push({ id: 'cold-agent', label: 'Set up an agent', prompt: 'Create a new agent', href: '/agents' });
  }

  const unique = new Map<string, Suggestion>();
  for (const suggestion of suggestions) {
    if (!unique.has(suggestion.id)) unique.set(suggestion.id, suggestion);
  }
  return [...unique.values()].slice(0, 4);
}