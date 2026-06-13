import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { BookOpen, Network, Plug, Settings, Sparkles } from 'lucide-react';
import { REALTIME_EVENTS } from '@agentis/core';
import { api } from '../lib/api';
import { useRealtime } from '../lib/realtime';
import { BrainView } from '../components/brain/BrainView';
import { ConfigDrawer } from '../components/brain/ConfigDrawer';
import { InsightsTab } from '../components/brain/InsightsTab';
import { KnowledgeTab } from '../components/knowledge/KnowledgeTab';
import { PersonalBrainPanel } from '../components/brain/PersonalBrainPanel';
import { AgentBrainPanel } from '../components/brain/AgentBrainPanel';
import { SourcesTab } from '../components/brain/SourcesTab';

type BrainTab = 'map' | 'knowledge' | 'sources' | 'insights';
type BrainScope = 'workspace' | 'agent' | 'personal';

interface IntelligenceStatus {
  degraded: boolean;
}

function destination(pathname: string, search: string): { tab: BrainTab; canonical: string } {
  if (pathname.endsWith('/health') || pathname.endsWith('/config') || pathname.endsWith('/disputes')) {
    return { tab: 'insights', canonical: '/brain?tab=insights' };
  }
  const raw = new URLSearchParams(search).get('tab');
  if (pathname === '/knowledge' && raw === null) {
    return { tab: 'knowledge', canonical: '/brain?tab=knowledge' };
  }
  if (raw === 'documents' || raw === 'bases' || raw === 'knowledge') {
    return { tab: 'knowledge', canonical: '/brain?tab=knowledge' };
  }
  if (raw === 'health' || raw === 'config' || raw === 'disputes' || raw === 'memory' || raw === 'episodes' || raw === 'insights') {
    return { tab: 'insights', canonical: '/brain?tab=insights' };
  }
  if (raw === 'sources' || raw === 'learning') {
    return { tab: 'sources', canonical: '/brain?tab=sources' };
  }
  return { tab: 'map', canonical: '/brain' };
}

export function UnifiedBrainPage() {
  const location = useLocation();
  const nav = useNavigate();
  const resolved = useMemo(() => destination(location.pathname, location.search), [location.pathname, location.search]);
  const [tab, setTab] = useState<BrainTab>(resolved.tab);
  const [scope, setScope] = useState<BrainScope>('workspace');
  const [configDrawerOpen, setConfigDrawerOpen] = useState(false);
  const [intelligence, setIntelligence] = useState<IntelligenceStatus | null>(null);

  const loadIntelligence = useCallback(() => {
    void api<IntelligenceStatus>('/v1/workspace/intelligence')
      .then(setIntelligence)
      .catch(() => {});
  }, []);

  useEffect(() => {
    setTab(resolved.tab);
    const current = `${location.pathname}${location.search}`;
    if (current !== resolved.canonical) nav(resolved.canonical, { replace: true });
  }, [location.pathname, location.search, nav, resolved]);

  useEffect(() => { loadIntelligence(); }, [loadIntelligence]);
  useRealtime([
    REALTIME_EVENTS.BRAIN_CONFIG_DEGRADED,
    REALTIME_EVENTS.BRAIN_EMBEDDING_MIGRATION_COMPLETED,
  ], loadIntelligence);

  function changeTab(next: BrainTab) {
    setTab(next);
    nav(next === 'map' ? '/brain' : `/brain?tab=${next}`);
  }

  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 border-b border-line bg-surface px-6 py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-display text-text-primary">
                {scope === 'workspace' ? 'Workspace Brain' : scope === 'agent' ? 'Agent Brain' : 'Personal Brain'}
              </h1>
              <button
                type="button"
                aria-label="Configure Brain"
                onClick={() => setConfigDrawerOpen(true)}
                className="inline-flex items-center justify-center rounded-btn p-1.5 text-text-muted transition-colors hover:bg-surface-3 hover:text-text-primary relative"
                title="Brain setup"
              >
                <Settings size={16} />
                {intelligence?.degraded && (
                  <span className="absolute right-0 top-0 h-1.5 w-1.5 rounded-full bg-amber-400" />
                )}
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex rounded-pill border border-line bg-surface-2 p-1 text-[12px]">
              {(['workspace', 'agent', 'personal'] as const).map((next) => (
              <button
                key={next}
                type="button"
                onClick={() => setScope(next)}
                className={`rounded-pill px-3 py-1.5 capitalize transition-colors ${scope === next ? 'bg-accent-soft text-accent' : 'text-text-muted hover:text-text-primary'}`}
              >
                {next}
              </button>
              ))}
            </div>
          </div>
        </div>
      </header>
      {scope === 'workspace' && (
        <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-line bg-surface px-6">
          <span className="text-[12px] font-semibold text-text-muted">Workspace space explorer</span>
          <div className="flex items-center gap-1.5 text-[12px]">
            <button
              type="button"
              onClick={() => changeTab('map')}
              className={`inline-flex items-center gap-1.5 rounded-pill px-3 py-1 ${
                tab === 'map' ? 'bg-accent-soft text-accent' : 'text-text-muted hover:text-text-primary'
              }`}
            >
              <Network size={12} /> Map
            </button>
            <button
              type="button"
              onClick={() => changeTab('knowledge')}
              className={`inline-flex items-center gap-1.5 rounded-pill px-3 py-1 ${
                tab === 'knowledge' ? 'bg-accent-soft text-accent' : 'text-text-muted hover:text-text-primary'
              }`}
            >
              <BookOpen size={12} /> Knowledge
            </button>
            <button
              type="button"
              onClick={() => changeTab('sources')}
              className={`inline-flex items-center gap-1.5 rounded-pill px-3 py-1 ${
                tab === 'sources' ? 'bg-accent-soft text-accent' : 'text-text-muted hover:text-text-primary'
              }`}
            >
              <Plug size={12} /> Sources
            </button>
            <button
              type="button"
              onClick={() => changeTab('insights')}
              className={`inline-flex items-center gap-1.5 rounded-pill px-3 py-1 ${
                tab === 'insights' ? 'bg-accent-soft text-accent' : 'text-text-muted hover:text-text-primary'
              }`}
            >
              <Sparkles size={12} /> Insights
            </button>
          </div>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        {scope === 'personal' && <PersonalBrainPanel />}
        {scope === 'agent' && <AgentBrainPanel />}
        {scope === 'workspace' && tab === 'map' && <BrainView onManage={() => changeTab('knowledge')} onOpenConfig={() => setConfigDrawerOpen(true)} />}
        {scope === 'workspace' && tab === 'knowledge' && <KnowledgeTab />}
        {scope === 'workspace' && tab === 'sources' && <SourcesTab />}
        {scope === 'workspace' && tab === 'insights' && <InsightsTab onOpenConfig={() => setConfigDrawerOpen(true)} />}
      </div>
      <ConfigDrawer
        open={configDrawerOpen}
        onClose={() => setConfigDrawerOpen(false)}
        onFinished={loadIntelligence}
      />
    </div>
  );
}
