import { useMemo } from 'react';
import type {
  ComposerContextAgent,
  ComposerContextRun,
  ComposerRecentCompletion,
  ComposerUser,
} from '../components/home/homeCanvasTypes';
import type { WorkspaceApproval } from '../lib/workspaceData';

export function useComposerContext(ctx: {
  agents: ComposerContextAgent[];
  activeRuns: ComposerContextRun[];
  pendingApprovals: WorkspaceApproval[];
  recentCompletions: ComposerRecentCompletion[];
  user: ComposerUser | null;
}): { greeting: string; placeholder: string; chips: string[] } {
  return useMemo(() => {
    const { agents, activeRuns, pendingApprovals, recentCompletions, user } = ctx;
    const orchestrator = agents.find((agent) => normalizeRole(agent) === 'orchestrator');
    const activeAgents = agents.filter((agent) => isActiveAgent(agent.status));
    const hour = new Date().getHours();
    const timeGreet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const firstName = user?.firstName ?? user?.name?.split(/\s+/)[0] ?? 'operator';

    const greeting = !orchestrator
      ? 'Set up your orchestrator to get started.'
      : pendingApprovals.length > 0
        ? `${orchestrator.name} is waiting for your approval.`
        : activeAgents.length > 1
          ? `${activeAgents.length} agents working right now.`
          : activeAgents.length === 1
            ? `${activeAgents[0]?.name ?? 'An agent'} is working.`
            : `${timeGreet}, ${firstName}. Everything is quiet.`;

    const placeholder = activeRuns[0]
      ? `Ask about ${activeRuns[0].workflowName}...`
      : pendingApprovals.length > 0
        ? 'Review pending approval or ask the orchestrator...'
        : 'Ask the orchestrator...';

    const chips: string[] = [];
    if (pendingApprovals.length > 0) chips.push('Review pending approval');
    if (activeRuns[0]) chips.push(`Status on ${activeRuns[0].workflowName}`);
    const recent = recentCompletions[0];
    if (recent && Date.now() - recent.completedAt < 3_600_000) {
      chips.push(`Results from ${recent.workflowName}`);
    }
    if (chips.length < 3) chips.push('What should we work on today?');
    return { greeting, placeholder, chips: chips.slice(0, 3) };
  }, [ctx]);
}

function normalizeRole(agent: ComposerContextAgent): string {
  const role = agent.role?.toLowerCase();
  if (role) return role;
  return /orchestrator/i.test(agent.name) ? 'orchestrator' : 'worker';
}

function isActiveAgent(status: string | undefined): boolean {
  return status === 'active' || status === 'running' || status === 'busy' || status === 'online';
}