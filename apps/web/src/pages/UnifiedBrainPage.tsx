/**
 * UnifiedBrainPage — single surface that hosts the Brain graph alongside
 * the workspace knowledge management panels (Documents, Bases, Memory,
 * Episodes). The two used to live on separate routes (/brain and
 * /knowledge); merging them removes the orchestration confusion described
 * in docs/UIUX-refactor/BRAIN-PAGE-REDESIGN.md §4.
 *
 * Tab state is mirrored to the URL (?tab=) via the shared Tabs component,
 * so deep-links from the deprecated /knowledge route survive.
 */

import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Activity, Brain as BrainIcon, BookOpen, Database, FileText, GitCompare, History, Network, Settings2 } from 'lucide-react';
import { Tabs } from '../components/shared/Tabs';
import { BrainView } from '../components/brain/BrainView';
import { BrainHealthDashboard } from '../components/brain/BrainHealthDashboard';
import { DisputeResolutionPanel } from '../components/brain/DisputeResolutionPanel';
import { BrainConfigWizard } from '../components/brain/BrainConfigWizard';
import { WorkspaceKnowledgePanels, type WorkspaceKnowledgeTab } from '../components/knowledge/WorkspaceKnowledgePanels';

type BrainTab = 'graph' | 'health' | 'config' | 'disputes' | WorkspaceKnowledgeTab;

const VALID_TABS: ReadonlyArray<BrainTab> = ['graph', 'health', 'config', 'disputes', 'documents', 'bases', 'memory', 'episodes'];

function readTab(pathname: string, search: string): BrainTab {
  if (pathname.endsWith('/health')) return 'health';
  if (pathname.endsWith('/config')) return 'config';
  if (pathname.endsWith('/disputes')) return 'disputes';
  const raw = new URLSearchParams(search).get('tab');
  return (VALID_TABS as readonly string[]).includes(raw ?? '') ? (raw as BrainTab) : 'graph';
}

export function UnifiedBrainPage() {
  const location = useLocation();
  const nav = useNavigate();
  // Read once per location change — Tabs syncs ?tab= back on its own.
  const initial = useMemo(() => readTab(location.pathname, location.search), [location.pathname, location.search]);
  const [tab, setTab] = useState<BrainTab>(initial);
  const [counts, setCounts] = useState<{ documentCount: number; baseCount: number }>({ documentCount: 0, baseCount: 0 });

  useEffect(() => {
    setTab(initial);
  }, [initial]);

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-line bg-surface px-6 py-4">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-card bg-fuchsia-500/15 text-fuchsia-300">
            <BrainIcon size={18} />
          </span>
          <div>
            <h1 className="text-display text-text-primary">The Brain</h1>
            <div className="mt-0.5 text-[12px] text-text-muted">
              Workspace orchestrator · cross-app intelligence map · shared knowledge
            </div>
          </div>
        </div>
      </header>
      <Tabs
        value={tab}
        onChange={(next) => {
          setTab(next);
          if (next === 'graph') nav('/brain');
          else if (next === 'health' || next === 'config' || next === 'disputes') nav(`/brain/${next}`);
          else nav(`/brain?tab=${next}`);
        }}
        defaultValue="graph"
        className="px-6"
        tabs={[
          { value: 'graph', label: 'Graph', icon: <Network size={13} /> },
          { value: 'health', label: 'Health', icon: <Activity size={13} /> },
          { value: 'config', label: 'Config', icon: <Settings2 size={13} /> },
          { value: 'disputes', label: 'Disputes', icon: <GitCompare size={13} /> },
          { value: 'documents', label: 'Documents', count: counts.documentCount || undefined, icon: <FileText size={13} /> },
          { value: 'bases', label: 'Knowledge Bases', count: counts.baseCount || undefined, icon: <BookOpen size={13} /> },
          { value: 'memory', label: 'Memory', icon: <Database size={13} /> },
          { value: 'episodes', label: 'Episodes', icon: <History size={13} /> },
        ]}
      />
      <div className="flex-1 overflow-hidden">
        {tab === 'graph' ? (
          <BrainView slug={null} />
        ) : tab === 'health' ? (
          <BrainHealthDashboard slug={null} />
        ) : tab === 'config' ? (
          <BrainConfigWizard />
        ) : tab === 'disputes' ? (
          <DisputeResolutionPanel slug={null} />
        ) : (
          <main className="h-full overflow-y-auto px-6 py-5">
            <div className="mx-auto max-w-6xl">
              <WorkspaceKnowledgePanels tab={tab} onCounts={setCounts} />
            </div>
          </main>
        )}
      </div>
    </div>
  );
}
