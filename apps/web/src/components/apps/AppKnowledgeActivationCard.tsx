import { useEffect, useState } from 'react';
import { Brain, ArrowRight, X } from 'lucide-react';
import { api } from '../../lib/api';
import { Button } from '../shared/Button';

interface IntelligenceResponse {
  summary?: {
    seedCount?: number;
    importedDatasetCount?: number;
    knowledgeClusterCount?: number;
    promotedMemoryCount?: number;
    evaluatorExampleCount?: number;
  };
}

interface ResultsResponse { runCount?: number; }

export function AppKnowledgeActivationCard({ appSlug, entryWorkflowId, onManage }: { appSlug: string; entryWorkflowId?: string; onManage: () => void }) {
  const storageKey = `agentis.appKnowledgeActivation.dismissed.${appSlug}`;
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (localStorage.getItem(storageKey) === '1') return;
    void Promise.all([
      api<IntelligenceResponse>(`/v1/apps/${appSlug}/intelligence`),
      api<ResultsResponse>(`/v1/apps/${appSlug}/results?window=30d`),
    ]).then(([intelligence, results]) => {
      if (cancelled) return;
      const summary = intelligence.summary ?? {};
      const knowledgeCount = (summary.seedCount ?? 0) + (summary.importedDatasetCount ?? 0) + (summary.promotedMemoryCount ?? 0) + (summary.evaluatorExampleCount ?? 0);
      setVisible(knowledgeCount === 0 && (results.runCount ?? 0) === 0);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [appSlug, storageKey]);

  if (!visible) return null;

  function dismiss() {
    localStorage.setItem(storageKey, '1');
    setVisible(false);
  }

  return (
    <section className="mb-5 rounded-card border border-line bg-surface p-4">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-card border border-line bg-surface-2 text-accent"><Brain size={16} /></span>
        <div className="min-w-0 flex-1">
          <h2 className="text-subheading text-text-primary">Before you run this app, teach it about your business</h2>
          <p className="mt-1 text-[12px] leading-relaxed text-text-muted">Import data sources and add a few memory rules so the first run starts with domain context.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="primary" size="sm" iconRight={<ArrowRight size={12} />} onClick={onManage}>Go to Brain Manage</Button>
            {entryWorkflowId && <Button variant="secondary" size="sm" onClick={() => { window.location.href = `/workflows/${entryWorkflowId}`; }}>Open workflow</Button>}
          </div>
        </div>
        <button type="button" onClick={dismiss} aria-label="Dismiss" className="rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"><X size={13} /></button>
      </div>
    </section>
  );
}