/**
 * BrainPage — the workspace Brain surface.
 *
 * The Brain is everything your agents know about your workspace: the context
 * files + memory log, the knowledge bases they retrieve from, per-workflow
 * memory, and each agent's personal memory. The Overview tab composes the live
 * picture from `/v1/brain`; the Documents / Knowledge Bases tabs manage sources.
 */

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import type { BrainOverview } from '@agentis/core';
import {
  Brain as BrainIcon,
  BookOpen,
  FileText,
  Database,
  Repeat,
  Sparkles,
  AlertTriangle,
} from 'lucide-react';
import { Tabs } from '../components/shared/Tabs';
import { Button } from '../components/shared/Button';
import { Skeleton } from '../components/shared/Skeleton';
import { EmptyState } from '../components/shared/EmptyState';
import { api, apiErrorMessage } from '../lib/api';
import { useToast } from '../components/shared/Toast';
import { WorkspaceKnowledgePanels } from '../components/knowledge/WorkspaceKnowledgePanels';

type BrainTab = 'overview' | 'documents' | 'bases';

function normalizeTab(raw: string | null): BrainTab {
  if (raw === 'documents' || raw === 'bases') return raw;
  return 'overview';
}

export function BrainPage() {
  const [searchParams] = useSearchParams();
  const tab = normalizeTab(searchParams.get('tab'));

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line px-6 py-4">
        <h1 className="text-display text-text-primary">Brain</h1>
        <p className="mt-1 max-w-2xl text-[13px] text-text-secondary">
          Everything your agents know about your workspace — documents, references, and operating
          guidelines they can retrieve before acting, plus the memory they accumulate as they run.
        </p>
      </div>
      <Tabs
        param="tab"
        value={tab}
        defaultValue="overview"
        tabs={[
          { value: 'overview', label: 'Overview' },
          { value: 'documents', label: 'Documents' },
          { value: 'bases', label: 'Knowledge Bases' },
        ]}
        className="px-6"
      />
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {tab === 'overview' ? <BrainOverviewPanel /> : <WorkspaceKnowledgePanels tab={tab} />}
      </div>
    </div>
  );
}

function BrainOverviewPanel() {
  const nav = useNavigate();
  const toast = useToast();
  const [overview, setOverview] = useState<BrainOverview | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setOverview(await api<BrainOverview>('/v1/brain'));
    } catch (err) {
      toast.error('Failed to load the Brain', apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loading && !overview) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (!overview) return null;

  const { stats, context, knowledge, workflowMemory, gaps } = overview;
  const totallyEmpty = stats.knowledgeBases === 0 && stats.contextFilesFilled === 0 && stats.memoryEntries === 0;

  if (totallyEmpty) {
    return (
      <EmptyState
        variant="page"
        icon={<BrainIcon size={40} />}
        title="Your workspace Brain is empty"
        body="Add documents your agents can retrieve when they run, and fill in your workspace context so every agent starts with facts about your stack and conventions."
        primaryAction={
          <Button variant="primary" size="sm" onClick={() => nav('/knowledge?tab=bases')}>
            Create knowledge base
          </Button>
        }
        secondaryAction={
          <Button variant="ghost" size="sm" onClick={() => nav('/settings?tab=context')}>
            Edit workspace context
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-6">
      <StatStrip stats={stats} />

      {gaps.length > 0 && (
        <div className="space-y-2">
          {gaps.map((gap) => (
            <GapBanner
              key={`${gap.code}-${gap.refId ?? ''}`}
              message={gap.message}
              action={gapAction(gap.code, nav)}
            />
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section title="Workspace Context" icon={<FileText size={14} />} subtitle="Durable facts and conventions every agent inherits.">
          {context.files.every((f) => !f.filled) ? (
            <p className="text-[12px] text-text-muted">No context written yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {context.files.map((f) => (
                <li key={f.name} className="flex items-center justify-between text-[12px]">
                  <span className="text-text-secondary">{f.name}</span>
                  <span className={f.filled ? 'text-emerald-500' : 'text-text-muted'}>
                    {f.filled ? `${f.bytes.toLocaleString()} chars` : 'blank'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Memory Log" icon={<Sparkles size={14} />} subtitle="What past runs learned — applied to future ones.">
          {context.memory.totalEntries === 0 ? (
            <p className="text-[12px] text-text-muted">No memories recorded yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {context.memory.recent.map((m, i) => (
                <li key={i} className="text-[12px] leading-snug text-text-secondary">
                  <span className="text-text-muted">[{m.section}]</span> {m.text.slice(0, 140)}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Knowledge Bases" icon={<Database size={14} />} subtitle="Indexed documents agents retrieve from." className="lg:col-span-2">
          {knowledge.bases.length === 0 ? (
            <p className="text-[12px] text-text-muted">No knowledge bases yet.</p>
          ) : (
            <div className="overflow-hidden rounded-card border border-line">
              <table className="w-full text-[12px]">
                <thead className="bg-surface-muted text-text-muted">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Base</th>
                    <th className="px-3 py-2 text-right font-medium">Documents</th>
                    <th className="px-3 py-2 text-right font-medium">Indexed chunks</th>
                    <th className="px-3 py-2 text-right font-medium">Last indexed</th>
                  </tr>
                </thead>
                <tbody>
                  {knowledge.bases.map((b) => (
                    <tr key={b.id} className="border-t border-line hover:bg-surface-muted/50">
                      <td className="px-3 py-2">
                        <button type="button" className="text-text-primary hover:text-accent" onClick={() => nav(`/knowledge/bases/${b.id}`)}>
                          {b.name}
                        </button>
                      </td>
                      <td className="px-3 py-2 text-right text-text-secondary">{b.documentCount}</td>
                      <td className={`px-3 py-2 text-right ${b.chunkCount === 0 ? 'text-amber-500' : 'text-text-secondary'}`}>{b.chunkCount}</td>
                      <td className="px-3 py-2 text-right text-text-muted">{b.lastIndexedAt ? new Date(b.lastIndexedAt).toLocaleDateString() : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {workflowMemory.workflows.length > 0 && (
          <Section title="Workflow Memory" icon={<Repeat size={14} />} subtitle="State recurring workflows remember across runs." className="lg:col-span-2">
            <ul className="space-y-1.5">
              {workflowMemory.workflows.map((w) => (
                <li key={w.workflowId} className="flex items-center justify-between text-[12px]">
                  <button type="button" className="text-text-secondary hover:text-accent" onClick={() => nav(`/workflows/${w.workflowId}`)}>
                    {w.workflowTitle ?? w.workflowId}
                  </button>
                  <span className="text-text-muted">{w.keyCount} key{w.keyCount === 1 ? '' : 's'}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </div>
  );
}

function StatStrip({ stats }: { stats: BrainOverview['stats'] }) {
  const items: Array<{ label: string; value: number; suffix?: string }> = [
    { label: 'Knowledge bases', value: stats.knowledgeBases },
    { label: 'Documents', value: stats.documents },
    { label: 'Indexed chunks', value: stats.chunks },
    { label: 'Memory entries', value: stats.memoryEntries },
    { label: 'Workflow keys', value: stats.workflowMemoryKeys },
    { label: 'Context files', value: stats.contextFilesFilled, suffix: '/3' },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {items.map((it) => (
        <div key={it.label} className="rounded-card border border-line bg-surface px-3 py-2.5">
          <div className="text-lg font-semibold text-text-primary">
            {it.value.toLocaleString()}{it.suffix ?? ''}
          </div>
          <div className="text-[11px] text-text-muted">{it.label}</div>
        </div>
      ))}
    </div>
  );
}

function GapBanner({ message, action }: { message: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-card border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
      <div className="flex items-center gap-2 text-[12px] text-text-secondary">
        <AlertTriangle size={14} className="shrink-0 text-amber-500" />
        <span>{message}</span>
      </div>
      {action && (
        <button type="button" className="shrink-0 text-[12px] font-medium text-accent hover:text-accent-hover" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}

function gapAction(code: BrainOverview['gaps'][number]['code'], nav: (to: string) => void): { label: string; onClick: () => void } | undefined {
  switch (code) {
    case 'no_knowledge_bases':
    case 'empty_knowledge_base':
      return { label: 'Add documents', onClick: () => nav('/knowledge?tab=bases') };
    case 'blank_workspace_context':
      return { label: 'Edit context', onClick: () => nav('/settings?tab=context') };
    default:
      return undefined;
  }
}

function Section({ title, subtitle, icon, children, className }: {
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-card border border-line bg-surface p-4 ${className ?? ''}`}>
      <div className="mb-3 flex items-start gap-2">
        <span className="mt-0.5 text-text-muted">{icon}</span>
        <div>
          <h2 className="text-[13px] font-medium text-text-primary">{title}</h2>
          {subtitle && <p className="text-[11px] text-text-muted">{subtitle}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}
