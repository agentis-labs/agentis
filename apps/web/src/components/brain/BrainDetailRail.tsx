/**
 * BrainDetailRail — selection-aware detail panel.
 *
 * Spec: docs/memory/THE-BRAIN-UX-ARCHITECTURE.md §11.
 *
 * The stage gets attention. The rail creates trust. (§11.1)
 *
 * Switches on node.type to render type-appropriate content (§11.2). All
 * action buttons are wired to either:
 *   - navigation (open run, view in canvas, browse source)
 *   - data fetches (fill gap → suggest dataset import)
 *   - app-level memory actions (mark stale, promote lesson — V2)
 *
 * Per §11.3 we keep the action set small; "no giant button soup".
 */

import { useNavigate } from 'react-router-dom';
import {
  ArrowUpRight, FileSearch, ExternalLink, Database, Brain, Lightbulb,
  Gauge, ScrollText, AlertTriangle, CircleDashed, Sparkles, Layers,
} from 'lucide-react';
import type { BrainNode, BrainResponse } from '@agentis/core';
import { Button } from '../shared/Button';

interface RailProps {
  brain: BrainResponse;
  node: BrainNode | null;
  /** Slug used by drill-down links. Workspace-scope brain leaves this null. */
  appSlug: string | null;
}

export function BrainDetailRail({ brain, node, appSlug }: RailProps) {
  const nav = useNavigate();

  if (!node) {
    return (
      <div className="flex h-full w-80 shrink-0 flex-col border-l border-line bg-surface">
        <div className="border-b border-line px-4 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Inspector
          </div>
        </div>
        <div className="flex flex-1 items-center justify-center px-6 py-8 text-center text-[12px] text-text-muted">
          Select any node on the stage to see what it knows, where it came from, and where it's used.
        </div>
        {brain.warnings.length > 0 && (
          <div className="border-t border-line p-3">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
              Issues
            </div>
            <div className="space-y-1.5">
              {brain.warnings.slice(0, 5).map((w, i) => (
                <div key={i} className="flex items-start gap-2 text-[11px]">
                  <AlertTriangle size={11} className="mt-0.5 shrink-0 text-amber-300" />
                  <div>
                    <div className="font-mono text-[10px] text-text-muted">[{w.code}]</div>
                    <div className="text-text-secondary">{w.message}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  const m = node.metadata;

  return (
    <div className="flex h-full w-80 shrink-0 flex-col border-l border-line bg-surface">
      <div className="border-b border-line px-4 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
              {humanType(node.type)}
            </div>
            <div className="mt-0.5 truncate text-[14px] font-semibold text-text-primary">{node.label}</div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3 text-[12px]">
        {node.description && (
          <p className="text-text-secondary">{node.description}</p>
        )}

        {/* Type-specific details — §11.2 */}
        {node.type === 'core' && (
          <Group title="Health">
            <Stat label="Knowledge" value={String(m.knowledge ?? 0)} />
            <Stat label="Memory" value={String(m.memory ?? 0)} />
            <Stat label="Evaluators" value={String(m.evaluators ?? 0)} />
            <Stat label="Baseline" value={
              typeof m.baselineConfidence === 'number'
                ? `${Math.round(m.baselineConfidence * 100)}% confident`
                : '—'
            } />
          </Group>
        )}

        {node.type === 'dataset' && (
          <>
            <Group title="Source">
              <Stat label="Key" value={String(m.key ?? '—')} mono />
              <Stat label="Wedge role" value={String(m.wedgeRole ?? '—')} />
              <Stat label="Status" value={String(m.status ?? '—')} />
              <Stat label="Items" value={`${m.storedItems ?? 0} of ${m.totalItems ?? 0}`} />
              {node.freshness && <Stat label="Freshness" value={node.freshness} />}
            </Group>
            {appSlug && (
              <Button
                variant="secondary" size="sm"
                iconLeft={<Database size={12} />}
                onClick={() => nav(`/apps/${appSlug}?layer=output&tab=config`)}
              >
                Browse source
              </Button>
            )}
          </>
        )}

        {node.type === 'knowledge_cluster' && (
          <Group title="Cluster">
            <Stat label="Source" value={String(m.source ?? '—')} />
            <Stat label="Count" value={String(m.count ?? 0)} />
          </Group>
        )}

        {node.type === 'memory_pattern' && (
          <Group title="Pattern">
            <Stat label="Kind" value={String(m.kind ?? '—')} />
            <Stat label="Evidence" value={`${m.evidenceCount ?? 0} run${m.evidenceCount === 1 ? '' : 's'}`} />
            {node.confidence != null && <Stat label="Confidence" value={`${Math.round(node.confidence * 100)}%`} />}
            {node.trust != null && <Stat label="Trust" value={`${Math.round(node.trust * 100)}%`} />}
            {m.reinforcedAt ? <Stat label="Last seen" value={relativeTime(String(m.reinforcedAt))} /> : null}
          </Group>
        )}

        {node.type === 'memory_episode' && (
          <>
            <Group title="Episode">
              <Stat label="Type" value={String(m.episodeType ?? '—')} />
              {m.outcomeStatus ? <Stat label="Outcome" value={String(m.outcomeStatus)} /> : null}
              {node.confidence != null && <Stat label="Confidence" value={`${Math.round(node.confidence * 100)}%`} />}
              {node.trust != null && <Stat label="Trust" value={`${Math.round(node.trust * 100)}%`} />}
              {m.createdAt ? <Stat label="Created" value={relativeTime(String(m.createdAt))} /> : null}
            </Group>
            {m.runId && (
              <Button
                variant="secondary" size="sm"
                iconLeft={<ExternalLink size={12} />}
                onClick={() => nav(`/runs/${m.runId}`)}
              >
                Inspect run
              </Button>
            )}
          </>
        )}

        {node.type === 'evaluator' && (
          <Group title="Evaluator">
            <Stat label="Key" value={String(m.evaluatorKey ?? '—')} mono />
            <Stat label="Examples" value={String(m.exampleCount ?? 0)} />
            {node.confidence != null && (
              <Stat label="Confidence" value={`${Math.round(node.confidence * 100)}%`} />
            )}
          </Group>
        )}

        {node.type === 'baseline' && (
          <Group title="Baseline">
            <Stat label="Workflow" value={String(m.workflowId ?? '—')} mono />
            <Stat label="Sample size" value={String(m.sampleSize ?? 0)} />
            {m.successRate != null && <Stat label="Success rate" value={`${Math.round(Number(m.successRate) * 100)}%`} />}
            {m.p50DurationMs != null && <Stat label="p50 latency" value={`${Math.round(Number(m.p50DurationMs) / 1000)}s`} />}
            {m.p95DurationMs != null && <Stat label="p95 latency" value={`${Math.round(Number(m.p95DurationMs) / 1000)}s`} />}
            {m.costCentsPerRun != null && <Stat label="Avg cost" value={`$${(Number(m.costCentsPerRun) / 100).toFixed(2)}`} />}
          </Group>
        )}

        {node.type === 'gap' && (
          <Group title="Gap">
            <p className="text-text-secondary">{node.description}</p>
          </Group>
        )}

        {node.type === 'warning' && (
          <Group title="Warning">
            <p className="text-rose-300">{node.description}</p>
          </Group>
        )}

        {/* Footer link to canvas drill-down — keeps the parallel navigation
            promise of §9.2 of APP-CANVAS. */}
        {appSlug && node.type !== 'core' && (
          <div className="pt-2">
            <Button
              variant="ghost" size="sm" iconLeft={<ArrowUpRight size={12} />}
              onClick={() => nav(`/apps/${appSlug}?layer=canvas`)}
            >
              View in canvas
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">{title}</div>
      <div className="rounded-card border border-line bg-bg-base p-2 space-y-1">{children}</div>
    </div>
  );
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2 text-[11px]">
      <span className="text-text-muted">{label}</span>
      <span className={mono ? 'truncate font-mono text-text-primary' : 'truncate text-text-primary'}>{value}</span>
    </div>
  );
}

function humanType(t: string): string {
  return t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function relativeTime(iso: string): string {
  try {
    const d = Date.now() - new Date(iso).getTime();
    if (d < 60000) return 'just now';
    if (d < 3600_000) return `${Math.floor(d / 60000)}m ago`;
    if (d < 86_400_000) return `${Math.floor(d / 3600_000)}h ago`;
    return `${Math.floor(d / 86_400_000)}d ago`;
  } catch { return iso; }
}
