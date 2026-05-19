import { useEffect, useMemo } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import type { AgentisSurface, ViewportContext } from '@agentis/core';
import { emitRealtime } from './realtime';
import { useSpaces } from '../hooks/useSpaces';
import { useAgentisStore } from '../store/agentisStore';

export function useViewportAwareness(): { context: ViewportContext; label: string } {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const workspaceId = useAgentisStore((s) => s.workspaceId);
  const ambientId = useAgentisStore((s) => s.ambientId);
  const activeRuns = useAgentisStore((s) => s.activeRuns);
  const { spaces } = useSpaces();

  const context = useMemo(() => {
    const route = `${location.pathname}${location.search}${location.hash}`;
    const derived = deriveSurface(location.pathname);
    const activeRun = derived.resourceKind === 'workflow'
      ? Object.values(activeRuns).find((run) => run.workflowId === derived.resourceId && ['queued', 'running', 'paused'].includes(run.status))
      : null;
    const spaceId = searchParams.get('space');
    const activeSpace = spaceId ? spaces.find((space) => space.id === spaceId) ?? null : null;
    return {
      surface: derived.surface,
      route,
      title: derived.title,
      workspaceId: workspaceId ?? undefined,
      ambientId: ambientId ?? null,
      resourceId: derived.resourceId,
      resourceKind: derived.resourceKind,
      activeRunId: activeRun?.runId ?? null,
      spaceId: spaceId ?? null,
      spaceName: activeSpace?.name ?? null,
    } satisfies ViewportContext;
  }, [activeRuns, ambientId, location.hash, location.pathname, location.search, searchParams, spaces, workspaceId]);

  useEffect(() => {
    const timer = window.setTimeout(() => emitRealtime('viewport_context', context), 100);
    return () => window.clearTimeout(timer);
  }, [context]);

  return { context, label: formatViewportLabel(context) };
}

function deriveSurface(pathname: string): Pick<ViewportContext, 'surface' | 'resourceId' | 'resourceKind' | 'title'> {
  const parts = pathname.split('/').filter(Boolean);
  const [root, id] = parts;
  if (!root || root === 'home') return { surface: 'home', title: 'Home' };
  if (root === 'workflows' && id) return { surface: 'workflow_detail', resourceKind: 'workflow', resourceId: id, title: 'Workflow canvas' };
  if (root === 'workflows') return { surface: 'workflows', title: 'Workflows' };
  if (root === 'runs' && id) return { surface: 'run_detail', resourceKind: 'run', resourceId: id, title: 'Run detail' };
  if (root === 'history') return { surface: 'history', title: 'History' };
  if (root === 'agents' && id) return { surface: 'agent_detail', resourceKind: 'agent', resourceId: id, title: 'Agent detail' };
  if (root === 'agents') return { surface: 'agents', title: 'Agents' };
  if (root === 'teams' && id) return { surface: 'team_detail', resourceKind: 'team', resourceId: id, title: 'Team detail' };
  if (root === 'teams') return { surface: 'teams', title: 'Teams' };
  if (root === 'artifacts' && id) return { surface: 'artifact_detail', resourceKind: 'artifact', resourceId: id, title: 'Artifact detail' };
  if (root === 'artifacts') return { surface: 'artifacts', title: 'Artifacts' };
  if (root === 'packages') return { surface: 'packages', title: 'Packages' };
  if (root === 'skills') return { surface: 'skills', title: 'Skills' };
  if (root === 'data') return { surface: 'ledger', title: 'Data' };
  if (root === 'settings') return { surface: 'settings', title: 'Settings' };
  if (root === 'chat') return { surface: 'chat', title: 'Chat' };
  return { surface: 'unknown' as AgentisSurface, title: root };
}

function formatViewportLabel(context: ViewportContext): string {
  const base = context.title ?? context.surface;
  const id = context.resourceId ? ` ${context.resourceId.slice(0, 8)}` : '';
  const space = context.spaceName ? ` - ${context.spaceName}` : '';
  const run = context.activeRunId ? ` · ${context.activeRunId.slice(0, 8)} running` : '';
  return `${base}${id}${space}${run}`;
}
