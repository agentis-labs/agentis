import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { REALTIME_EVENTS } from '@agentis/core/events';
import { invalidateCache, workspace as workspaceStore } from './api';
import { rtSubscribe, useRealtime } from './realtime';

export type ResourceDomain =
  | 'agents' | 'apps' | 'workflows' | 'interfaces' | 'appData' | 'artifacts'
  | 'approvals' | 'runs' | 'spaces' | 'packages' | 'conversations' | 'brain' | 'history' | 'builds';

const ALL_EVENTS = [...new Set(Object.values(REALTIME_EVENTS))];
const revisions = new Map<ResourceDomain, number>();
const listeners = new Set<() => void>();
const pending = new Set<ResourceDomain>();
let flushTimer: number | null = null;

const CACHE_MATCHES: Record<ResourceDomain, string[]> = {
  agents: ['/v1/agents', '/v1/dashboard'],
  apps: ['/v1/apps', '/v1/dashboard'],
  workflows: ['/v1/workflows', '/v1/apps', '/v1/dashboard'],
  interfaces: ['/interface', '/v1/apps'],
  appData: ['/data', '/v1/apps'],
  artifacts: ['/v1/artifacts', '/v1/dashboard'],
  approvals: ['/v1/approvals', '/v1/dashboard'],
  runs: ['/v1/runs', '/v1/dashboard'],
  spaces: ['/v1/spaces', '/v1/dashboard'],
  packages: ['/v1/packages', '/v1/extensions', '/v1/skills'],
  conversations: ['/v1/conversations', '/v1/rooms', '/v1/channels', '/v1/tasks/spines'],
  brain: ['/v1/brain', '/v1/memory', '/v1/knowledge'],
  history: ['/v1/history', '/v1/activity', '/v1/observability', '/v1/dashboard'],
  builds: ['/v1/build-sessions', '/v1/apps', '/v1/tasks/spines'],
};

export function resourceDomainsForEvent(event: string): ResourceDomain[] {
  const domains = new Set<ResourceDomain>();
  if (event.startsWith('agent.')) domains.add('agents');
  if (event.startsWith('app.')) domains.add('apps');
  if (event.startsWith('build.') || event === REALTIME_EVENTS.APP_BLUEPRINT_UPDATED) domains.add('builds');
  if (event.startsWith('workflow.')) domains.add('workflows');
  if (event.startsWith('app.interface_') || event.startsWith('app.surface_')) domains.add('interfaces');
  if (event === REALTIME_EVENTS.DATA_CHANGED) domains.add('appData');
  if (event.startsWith('artifact.')) domains.add('artifacts');
  if (event.startsWith('approval.')) domains.add('approvals');
  if (/^(?:run|node|phase|loop|budget|listener|schedule|event_chain|watchdog)\./.test(event)) domains.add('runs');
  if (event.startsWith('space.')) domains.add('spaces');
  if (/^(?:package|extension|skill_registry|harness\.import)\./.test(event)) domains.add('packages');
  if (/^(?:conversation|channel|room|task\.spine)\./.test(event)) domains.add('conversations');
  if (/^(?:scratchpad|ledger|command\.index|blackboard|instinct)\./.test(event)) domains.add('brain');
  if (event === REALTIME_EVENTS.ACTIVITY_CREATED || event === REALTIME_EVENTS.OBSERVABILITY_EVENT) domains.add('history');
  if (domains.has('runs')) domains.add('history');
  return [...domains];
}

function scheduleDomains(domains: ResourceDomain[]): void {
  domains.forEach((domain) => pending.add(domain));
  if (flushTimer !== null) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    for (const domain of pending) {
      revisions.set(domain, (revisions.get(domain) ?? 0) + 1);
      CACHE_MATCHES[domain].forEach((match) => invalidateCache(match));
    }
    pending.clear();
    listeners.forEach((listener) => listener());
  }, 100);
}

export function WorkspaceRealtimeProvider({ children }: { children: ReactNode }) {
  const [workspaceId, setWorkspaceId] = useState(() => workspaceStore.get());
  useEffect(() => {
    const changed = () => setWorkspaceId(workspaceStore.get());
    window.addEventListener('agentis:workspace-changed', changed);
    return () => window.removeEventListener('agentis:workspace-changed', changed);
  }, []);
  useEffect(() => workspaceId ? rtSubscribe('workspace', { workspaceId }) : undefined, [workspaceId]);
  useRealtime(ALL_EVENTS, (envelope) => scheduleDomains(resourceDomainsForEvent(envelope.event)));
  return children;
}

/** Lazy shell mount: owns the same provider lifecycle without gating first paint. */
export function WorkspaceRealtimeMount() {
  return <WorkspaceRealtimeProvider>{null}</WorkspaceRealtimeProvider>;
}

export function useResourceRevision(domains: ResourceDomain | ResourceDomain[]): number {
  const keys = Array.isArray(domains) ? domains : [domains];
  const signature = keys.slice().sort().join('|');
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => signature.split('|').reduce((total, key) => total + (revisions.get(key as ResourceDomain) ?? 0), 0),
    () => 0,
  );
}
