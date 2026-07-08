import { useEffect, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import type { AgentisSurface, ViewportContext } from '@agentis/core';
import { emitRealtime } from './realtime';
import { useAgentisStore } from '../store/agentisStore';
import { useRunModalSnapshot } from './runModal';
import { shortRef } from './prettyRef';

export function useViewportAwareness(): { context: ViewportContext; label: string } {
  const location = useLocation();
  const workspaceId = useAgentisStore((s) => s.workspaceId);
  const ambientId = useAgentisStore((s) => s.ambientId);
  const activeRuns = useAgentisStore((s) => s.activeRuns);
  const runModal = useRunModalSnapshot();

  const context = useMemo(() => {
    const route = `${location.pathname}${location.search}${location.hash}`;
    const derived = deriveSurface(location.pathname, location.search);
    if (runModal.open) {
      return {
        surface: 'run_modal',
        route,
        title: 'Run modal',
        workspaceId: workspaceId ?? undefined,
        ambientId: ambientId ?? null,
        resourceId: runModal.runId ?? runModal.workflowId ?? undefined,
        resourceKind: runModal.runId ? 'run' : runModal.workflowId ? 'workflow' : 'unknown',
        activeRunId: runModal.runId ?? null,
        metadata: {
          runId: runModal.runId ?? null,
          workflowId: runModal.workflowId ?? null,
          focusNodeId: runModal.focusNodeId ?? null,
          parentRoute: runModal.parentRoute ?? route,
          source: runModal.source ?? null,
        },
      } satisfies ViewportContext;
    }
    const activeRun = derived.resourceKind === 'workflow'
      ? Object.values(activeRuns).find((run) => run.workflowId === derived.resourceId && ['queued', 'running', 'paused'].includes(run.status))
      : null;
    return {
      surface: derived.surface,
      route,
      title: derived.title,
      workspaceId: workspaceId ?? undefined,
      ambientId: ambientId ?? null,
      resourceId: derived.resourceId,
      resourceKind: derived.resourceKind,
      activeRunId: activeRun?.runId ?? null,
    } satisfies ViewportContext;
  }, [activeRuns, ambientId, location.hash, location.pathname, location.search, runModal, workspaceId]);

  useEffect(() => {
    const timer = window.setTimeout(() => emitRealtime('viewport_context', context), 100);
    return () => window.clearTimeout(timer);
  }, [context]);

  // Resolve the resource's real name from the registry so the label reads
  // "App · My Sales Dashboard" instead of "App · Workflow #efe2961f".
  const resolvedName = useAgentisStore((s) =>
    context.resourceId && context.resourceKind
      ? s.resourceNames[`${context.resourceKind}:${context.resourceId}`]
      : undefined,
  );

  return { context, label: formatViewportLabel(context, resolvedName) };
}

export function deriveSurface(pathname: string, search = ''): Pick<ViewportContext, 'surface' | 'resourceId' | 'resourceKind' | 'title'> {
  const parts = pathname.split('/').filter(Boolean);
  const [root, id] = parts;
  if (!root || root === 'home') return { surface: 'home', title: 'Home' };
  // Agentic Apps — a real surface (not 'unknown') so the chat keeps viewport
  // context active and the agent knows it is operating inside an App. The facet
  // (?facet=interface|workflow|data|brain) is folded into the title so the agent
  // lets chat tools resolve the open App (AGENTIC-APPS-10X §4).
  if (root === 'apps' && id === 'workflows' && parts[2]) {
    return { surface: 'workflow_detail', resourceKind: 'workflow', resourceId: parts[2], title: 'App logic' };
  }
  if (root === 'apps' && id) {
    const facet = new URLSearchParams(search).get('facet');
    const facetLabel = facet ? facet.charAt(0).toUpperCase() + facet.slice(1) : null;
    return { surface: 'app_detail', resourceKind: 'app', resourceId: id, title: facetLabel ? `App · ${facetLabel}` : 'App' };
  }
  if (root === 'apps') return { surface: 'apps', title: 'Apps' };
  if (root === 'workflows' && id) return { surface: 'workflow_detail', resourceKind: 'workflow', resourceId: id, title: 'Workflow' };
  if (root === 'workflows') return { surface: 'workflows', title: 'Workflows' };
  if (root === 'runs' && id) return { surface: 'run_detail', resourceKind: 'run', resourceId: id, title: 'Run detail' };
  if (root === 'history') return { surface: 'history', title: 'History' };
  if (root === 'agents' && id) return { surface: 'agent_detail', resourceKind: 'agent', resourceId: id, title: 'Agent detail' };
  if (root === 'agents') return { surface: 'agents', title: 'Agents' };
  if (root === 'artifacts' && id) return { surface: 'artifact_detail', resourceKind: 'artifact', resourceId: id, title: 'Artifact detail' };
  if (root === 'artifacts') return { surface: 'artifacts', title: 'Artifacts' };
  if (root === 'packages') return { surface: 'packages', title: 'Packages' };
  if (root === 'extensions') return { surface: 'extensions', title: 'extensions' };
  if (root === 'data') return { surface: 'ledger', title: 'Data' };
  if (root === 'settings') return { surface: 'settings', title: 'Settings' };
  if (root === 'chat') return { surface: 'chat', title: 'Chat' };
  return { surface: 'unknown' as AgentisSurface, title: root };
}

function formatViewportLabel(context: ViewportContext, resolvedName?: string): string {
  const base = context.title ?? context.surface;
  // Prefer the resolved human name; only fall back to a short reference.
  const ref = resolvedName?.trim()
    ? ` · ${resolvedName.trim()}`
    : context.resourceId ? ` ${shortRef(context.resourceId)}` : '';
  const run = context.activeRunId ? ` · ${shortRef(context.activeRunId)} running` : '';
  return `${base}${ref}${run}`;
}



