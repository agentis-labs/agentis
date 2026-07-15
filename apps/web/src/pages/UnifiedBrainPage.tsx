import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Search, Settings, X } from 'lucide-react';
import clsx from 'clsx';
import { REALTIME_EVENTS } from '@agentis/core';
import { apiCached, peekCached } from '../lib/api';
import { useRealtime } from '../lib/realtime';
import { BrainView } from '../components/brain/BrainView';
import { ConfigDrawer } from '../components/brain/ConfigDrawer';
import { InsightsTab } from '../components/brain/InsightsTab';
import { KnowledgeTab } from '../components/knowledge/KnowledgeTab';
import { SkillsTab } from '../components/brain/SkillsTab';
import { ExamplesTab } from '../components/brain/ExamplesTab';
import { PersonalBrainPanel } from '../components/brain/PersonalBrainPanel';
import { BrainSectionNav } from '../components/brain/BrainSectionNav';

type BrainTab = 'map' | 'knowledge' | 'skills' | 'examples' | 'insights';
type BrainScope = 'workspace' | 'personal';

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
  if (raw === 'skills') return { tab: 'skills', canonical: '/brain?tab=skills' };
  if (raw === 'examples') return { tab: 'examples', canonical: '/brain?tab=examples' };
  if (raw === 'health' || raw === 'config' || raw === 'disputes' || raw === 'memory' || raw === 'episodes' || raw === 'insights') {
    return { tab: 'insights', canonical: '/brain?tab=insights' };
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
  // Node search lives in the left toolbar (one bar, like /agents) and drives BrainView.
  const [mapSearch, setMapSearch] = useState('');
  const [mapSearchOpen, setMapSearchOpen] = useState(false);
  const [intelligence, setIntelligence] = useState<IntelligenceStatus | null>(
    () => peekCached<IntelligenceStatus>('/v1/workspace/intelligence') ?? null,
  );

  const loadIntelligence = useCallback(() => {
    void apiCached<IntelligenceStatus>('/v1/workspace/intelligence')
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

  const settingsButton = (
    <button
      type="button"
      aria-label="Configure Brain"
      title="Brain setup"
      onClick={() => setConfigDrawerOpen(true)}
      className="relative inline-flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-3 hover:text-text-primary"
    >
      <Settings size={15} />
      {intelligence?.degraded && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-amber-400" />}
    </button>
  );

  // Left cluster — search (map only) · view tabs (workspace only) · settings,
  // all in one connected bar like the Agents and Apps pages.
  const showMapSearch = scope === 'workspace' && tab === 'map';
  const controlsCluster = (
    <div className="flex h-9 items-center gap-1 rounded-lg border border-line bg-surface-2/90 px-1 backdrop-blur-md">
      {showMapSearch && (
        <>
          {mapSearchOpen ? (
            <div className="flex items-center gap-1.5 pl-1.5">
              <Search size={14} className="shrink-0 text-text-muted" />
              <input
                autoFocus
                value={mapSearch}
                onChange={(e) => setMapSearch(e.target.value)}
                onBlur={() => { if (!mapSearch.trim()) setMapSearchOpen(false); }}
                onKeyDown={(e) => { if (e.key === 'Escape') { setMapSearch(''); setMapSearchOpen(false); } }}
                placeholder="Search the brain…"
                aria-label="Search the brain"
                className="w-40 bg-transparent text-[12px] text-text-primary outline-none placeholder:text-text-muted"
              />
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => { setMapSearch(''); setMapSearchOpen(false); }}
                className="inline-flex h-6 w-6 items-center justify-center rounded-md text-text-muted hover:bg-surface-3 hover:text-text-primary"
              >
                <X size={13} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              aria-label="Search the brain"
              onClick={() => setMapSearchOpen(true)}
              className={clsx(
                'inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-surface-3',
                mapSearch.trim() ? 'text-accent' : 'text-text-muted hover:text-text-primary',
              )}
            >
              <Search size={15} />
            </button>
          )}
          <span className="h-4 w-px shrink-0 bg-line" />
        </>
      )}
      {scope === 'workspace' && (
        <>
          <BrainSectionNav compact value={tab} onChange={changeTab} />
          <span className="h-4 w-px shrink-0 bg-line" />
        </>
      )}
      {settingsButton}
    </div>
  );

  // Right cluster — the Workspace ↔ Personal scope toggle.
  const scopeCluster = (
    <div className="flex h-9 items-center gap-0.5 rounded-lg border border-line bg-surface-2/90 p-0.5 backdrop-blur-md">
      {(['workspace', 'personal'] as const).map((next) => (
        <button
          key={next}
          type="button"
          onClick={() => setScope(next)}
          className={clsx(
            'inline-flex h-7 items-center rounded-md px-2.5 text-[12px] capitalize transition-colors',
            scope === next ? 'bg-surface-3 text-text-primary' : 'text-text-muted hover:bg-surface-3 hover:text-text-primary',
          )}
        >
          {next}
        </button>
      ))}
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-hidden">
        {scope === 'personal' ? (
          <PersonalBrainPanel settingsSlot={settingsButton} scopeSlot={scopeCluster} />
        ) : tab === 'map' ? (
          <div className="relative h-full">
            <BrainView
              onManage={() => changeTab('knowledge')}
              onOpenConfig={() => setConfigDrawerOpen(true)}
              search={mapSearch}
              onSearchChange={setMapSearch}
              intelligence={intelligence}
            />
            <div className="pointer-events-none absolute left-3 top-3 z-30">
              <div className="pointer-events-auto">{controlsCluster}</div>
            </div>
            <div className="pointer-events-none absolute right-3 top-3 z-30">
              <div className="pointer-events-auto">{scopeCluster}</div>
            </div>
          </div>
        ) : (
          <div className="flex h-full flex-col">
            <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
              <div className="flex min-w-0 items-center gap-2">{controlsCluster}</div>
              <div className="ml-auto flex shrink-0 items-center gap-2">{scopeCluster}</div>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              {tab === 'knowledge' && <KnowledgeTab />}
              {tab === 'skills' && <SkillsTab />}
              {tab === 'examples' && <ExamplesTab />}
              {tab === 'insights' && <InsightsTab onOpenConfig={() => setConfigDrawerOpen(true)} />}
            </div>
          </div>
        )}
      </div>
      <ConfigDrawer
        open={configDrawerOpen}
        onClose={() => setConfigDrawerOpen(false)}
        onFinished={loadIntelligence}
      />
    </div>
  );
}



