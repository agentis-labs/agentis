import { useEffect, useMemo, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  AlertTriangle,
  Archive,
  ArrowDownLeft,
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  Gauge,
  GitBranch,
  Link2,
  Pencil,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  TrendingDown,
  TrendingUp,
  X,
} from 'lucide-react';
import type {
  BrainGraphLink,
  BrainGraphNode,
  BrainNode,
  BrainNodeType,
  BrainResponse,
  KnowledgeAtomKind,
  KnowledgeLinkRelation,
} from '@agentis/core';
import { api, apiErrorMessage } from '../../lib/api';
import { Button, IconButton } from '../shared/Button';
import { useToast } from '../shared/Toast';
import { useConfirm } from '../shared/ConfirmDialog';

interface RailProps {
  brain: BrainResponse;
  node: BrainNode | null;
  candidateNodes: BrainNode[];
  detailPath: string | null;
  linkPath?: string;
  atomPathBase?: string;
  allowMutations?: boolean;
  scopeName?: string;
  scopeId?: string;
  onClose: () => void;
  onGraphChanged: () => void | Promise<void>;
  onArchived: () => void | Promise<void>;
}

interface BrainNodeDetail {
  node: BrainGraphNode;
  links: BrainGraphLink[];
  relatedNodes: BrainGraphNode[];
  content: string;
  provenance: {
    createdBy: string;
    agentId?: string | null;
    adapterType?: string | null;
    createdAt: string;
    updatedAt: string;
    source: string;
    reinforced: number;
  };
  usedBy: Array<{
    id: string;
    type: 'agent' | 'workflow';
    name: string;
    count: number;
  }>;
}

const RELATIONS: KnowledgeLinkRelation[] = ['supports', 'refines', 'derived_from', 'co_observed', 'contradicts'];

export function BrainDetailRail({
  brain,
  node,
  candidateNodes,
  detailPath,
  linkPath,
  atomPathBase,
  allowMutations = true,
  scopeName,
  scopeId,
  onClose,
  onGraphChanged,
  onArchived,
}: RailProps) {
  const toast = useToast();
  const confirm = useConfirm();
  const [health, setHealth] = useState<HealthSnapshot | null>(null);
  const isCoreNode = node?.layer === 'core' || node?.id === 'core';
  const [detail, setDetail] = useState<BrainNodeDetail | null>(null);
  const [loading, setLoading] = useState(false);

  // Load health data when the core node is selected
  useEffect(() => {
    if (!isCoreNode) { setHealth(null); return; }
    const healthPath = scopeId
      ? `/v1/brain/health?scopeId=${encodeURIComponent(scopeId)}`
      : '/v1/brain/health';
    void api<HealthSnapshot>(healthPath).then(setHealth).catch(() => {});
  }, [isCoreNode, scopeId]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkQuery, setLinkQuery] = useState('');
  const [targetId, setTargetId] = useState<string | null>(null);
  const [relation, setRelation] = useState<KnowledgeLinkRelation>('supports');
  const [linking, setLinking] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [contentExpanded, setContentExpanded] = useState(false);
  const [connectionsExpanded, setConnectionsExpanded] = useState(false);
  const [suggestions, setSuggestions] = useState<Array<{ id: string; kind: KnowledgeAtomKind; label: string; score: number; suggestedRelation: KnowledgeLinkRelation }>>([]);
  const [suggestLoading, setSuggestLoading] = useState(false);

  useEffect(() => {
    if (!node || !detailPath) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void api<BrainNodeDetail>(detailPath)
      .then((response) => {
        if (!cancelled) setDetail(response);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [detailPath, node, refreshKey]);

  useEffect(() => {
    setLinkOpen(false);
    setLinkQuery('');
    setTargetId(null);
    setRelation('supports');
    setEditing(false);
    setContentExpanded(false);
    setConnectionsExpanded(false);
    setSuggestions([]);
  }, [node?.id]);

  const atom = node ? atomIdentity(node) : null;
  const canMutate = allowMutations && Boolean(atom && linkPath && atomPathBase);
  const linkCandidates = useMemo(() => {
    const q = linkQuery.trim().toLowerCase();
    return candidateNodes
      .filter((candidate) => candidate.id !== node?.id && candidate.id !== 'core' && atomIdentity(candidate))
      .filter((candidate) => {
        if (!q) return true;
        return candidate.label.toLowerCase().includes(q) || (candidate.description ?? '').toLowerCase().includes(q);
      })
      .slice(0, 8);
  }, [candidateNodes, linkQuery, node?.id]);
  const selectedTarget = candidateNodes.find((candidate) => candidate.id === targetId) ?? null;

  if (!node) {
    return (
      <div className="flex h-full w-80 shrink-0 flex-col border-l border-line bg-surface">
        <div className="border-b border-line px-4 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">Inspector</div>
        </div>
        <div className="flex flex-1 items-center justify-center px-6 py-8 text-center text-[12px] text-text-muted">
          Select a dot to read the atom, provenance, connections, and usage.
        </div>
        {brain.warnings.length > 0 && (
          <div className="border-t border-line p-3">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">Issues</div>
            <div className="space-y-1.5">
              {brain.warnings.slice(0, 5).map((warning, index) => (
                <div key={`${warning.code}-${index}`} className="text-[11px] text-text-secondary">
                  <span className="font-mono text-text-muted">[{warning.code}]</span> {warning.message}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  const currentNode = node;
  const provenance = detail?.provenance;
  const content = detail?.content || node.description || 'No content recorded yet.';
  const connectionCount = detail?.links.length ?? 0;
  const contentCanExpand = content.length > 420 || content.split('\n').length > 8;
  const visibleLinks = detail?.links.slice(0, connectionsExpanded ? undefined : 5) ?? [];

  async function createLink() {
    if (!atom || !selectedTarget || !linkPath) return;
    const target = atomIdentity(selectedTarget);
    if (!target) return;
    setLinking(true);
    try {
      await api(linkPath, {
        method: 'POST',
        body: JSON.stringify({
          sourceId: atom.atomId,
          sourceKind: atom.atomKind,
          targetId: target.atomId,
          targetKind: target.atomKind,
          relation,
        }),
      });
      setLinkOpen(false);
      setTargetId(null);
      setLinkQuery('');
      await onGraphChanged();
      setRefreshKey((value) => value + 1);
      toast.success('Atoms linked', `${shortTitle(currentNode.label)} now ${relationLabel(relation)} ${shortTitle(selectedTarget.label)}.`);
    } catch (error) {
      toast.error('Could not link atoms', apiErrorMessage(error));
    } finally {
      setLinking(false);
    }
  }

  async function archiveNode() {
    if (!atom || !atomPathBase) return;
    const ok = await confirm({
      title: `Archive "${shortTitle(currentNode.label)}"?`,
      body: 'This atom will be archived from the Brain graph. This action cannot be undone.',
      tone: 'danger',
      confirmLabel: 'Archive',
    });
    if (!ok) return;
    setArchiving(true);
    try {
      await api(`${atomPathBase}/${atom.atomKind}/${encodeURIComponent(atom.atomId)}`, { method: 'DELETE' });
      await onArchived();
      toast.success('Atom archived', shortTitle(currentNode.label));
    } catch (error) {
      toast.error('Could not archive atom', apiErrorMessage(error));
    } finally {
      setArchiving(false);
    }
  }

  async function saveContent() {
    if (!atom || !atomPathBase) return;
    setSaving(true);
    try {
      await api(`${atomPathBase}/${atom.atomKind}/${encodeURIComponent(atom.atomId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ content: draft }),
      });
      setEditing(false);
      setRefreshKey((value) => value + 1);
      await onGraphChanged();
      toast.success('Atom updated', shortTitle(currentNode.label));
    } catch (error) {
      toast.error('Could not save atom', apiErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function loadSuggestions() {
    if (!atom || !atomPathBase) return;
    setSuggestLoading(true);
    try {
      const data = await api<{ candidates: Array<{ id: string; kind: KnowledgeAtomKind; label: string; score: number; suggestedRelation: KnowledgeLinkRelation }> }>(
        `${atomPathBase}/${atom.atomKind}/${encodeURIComponent(atom.atomId)}/suggest-links`,
        { method: 'POST' },
      );
      setSuggestions(data.candidates ?? []);
      if ((data.candidates ?? []).length === 0) {
        toast.info('No related atoms found yet', 'Try seeding more knowledge first.');
      }
    } catch (error) {
      toast.error('Could not suggest links', apiErrorMessage(error));
    } finally {
      setSuggestLoading(false);
    }
  }

  async function acceptSuggestion(suggestion: { id: string; kind: KnowledgeAtomKind; suggestedRelation: KnowledgeLinkRelation }) {
    if (!atom || !linkPath) return;
    try {
      await api(linkPath, {
        method: 'POST',
        body: JSON.stringify({
          sourceId: atom.atomId,
          sourceKind: atom.atomKind,
          targetId: suggestion.id,
          targetKind: suggestion.kind,
          relation: suggestion.suggestedRelation,
        }),
      });
      setSuggestions((prev) => prev.filter((candidate) => candidate.id !== suggestion.id));
      await onGraphChanged();
      setRefreshKey((value) => value + 1);
      toast.success('Link created', relationLabel(suggestion.suggestedRelation));
    } catch (error) {
      toast.error('Could not create link', apiErrorMessage(error));
    }
  }

  const confidence = typeof node.confidence === 'number' ? node.confidence : null;
  const trust = typeof node.trust === 'number' ? node.trust : null;

  return (
    <aside className="flex h-full w-[25rem] max-w-[46vw] shrink-0 flex-col border-l border-line bg-surface shadow-[-16px_0_38px_rgba(0,0,0,0.18)]">
      <div className="shrink-0 border-b border-line bg-gradient-to-b from-surface-2/50 to-surface px-5 pb-4 pt-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: layerColor(node.layer), boxShadow: `0 0 7px ${layerColor(node.layer)}` }} />
              <TypeBadge type={node.type} kind={typeof node.metadata.kind === 'string' ? node.metadata.kind : undefined} />
            </div>
            <div className="mt-2.5 line-clamp-3 text-[16px] font-semibold leading-snug text-text-primary">
              {isCoreNode && scopeName ? `${scopeName} Brain` : humanTitle(node.label)}
            </div>
            {typeof node.metadata.scopeLabel === 'string' && node.metadata.scopeLabel ? (
              <div className="mt-2 inline-flex items-center gap-1.5 rounded-pill border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[11px] font-medium text-amber-300">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                {scopeKindLabel(node.metadata.scopeKind)}: {node.metadata.scopeLabel}
              </div>
            ) : node.metadata.workspaceGlobal === true && !isCoreNode ? (
              <div className="mt-2 text-[11px] text-text-muted">Workspace-wide</div>
            ) : null}
          </div>
          <IconButton icon={<X size={14} />} label="Close inspector" size="sm" onClick={onClose} />
        </div>
        {isCoreNode && health ? (
          <div className="mt-4 space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <div className="col-span-2 flex items-center justify-between rounded-card border border-line bg-bg-base px-3 py-2.5">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">Brain Health</div>
                  <div className={`mt-1 text-[28px] font-bold leading-none ${scoreTone(health.healthScore)}`}>{health.healthScore}</div>
                  <div className="mt-1 text-[10px] text-text-muted">Confidence &amp; retrieval readiness</div>
                </div>
                <ShieldCheck size={22} className={scoreTone(health.healthScore)} />
              </div>
              <HealthCard icon={<Gauge size={13} />} label="Context Coverage" value={pct(health.metrics.atomCoverageScore)} />
              <HealthCard icon={<Sparkles size={13} />} label="Evaluator Signal" value={pct(health.metrics.evaluatorSignalRate)} />
              <HealthCard icon={trendIcon(health.metrics.qualityTrend)} label="Quality" value={capitalize(health.metrics.qualityTrend)} detail={`${health.metrics.averageConfidenceDelta >= 0 ? '+' : ''}${health.metrics.averageConfidenceDelta.toFixed(3)} avg Δ`} />
              <HealthCard icon={<AlertTriangle size={13} />} label="Disputes" value={String(health.metrics.disputedAtomCount)} detail={`${health.metrics.staleAtomCount} stale atoms`} />
            </div>
          </div>
        ) : (
          <div className="mt-4 grid grid-cols-3 gap-2">
            <Metric label="Confidence" ratio={confidence} tone="cyan" />
            <Metric label="Trust" ratio={trust} tone="violet" />
            <Stat label="Links" value={String(connectionCount)} />
          </div>
        )}
        {canMutate && (
          <div className="mt-3 flex items-center gap-2">
            <Button variant="secondary" size="sm" iconLeft={<Sparkles size={12} />} loading={suggestLoading} onClick={() => void loadSuggestions()}>
              Suggest related
            </Button>
          </div>
        )}
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4 text-[12px]">
        <Section
          title="Content"
          action={canMutate && !editing ? (
            <button
              type="button"
              onClick={() => { setDraft(detail?.content ?? content); setEditing(true); }}
              className="inline-flex items-center gap-1 rounded border border-line bg-bg-base px-1.5 py-0.5 text-[10px] text-text-muted hover:text-text-primary"
            >
              <Pencil size={10} /> Edit
            </button>
          ) : null}
        >
          {editing ? (
            <div className="space-y-2">
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                aria-label="Atom content (editable)"
                className="max-h-[280px] min-h-[180px] w-full resize-y rounded-card border border-accent bg-bg-base p-3 text-[12px] leading-relaxed text-text-primary outline-none"
              />
              <div className="flex items-center justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={saving}>Cancel</Button>
                <Button variant="primary" size="sm" iconLeft={<Save size={12} />} loading={saving} onClick={() => void saveContent()}>Save</Button>
              </div>
            </div>
          ) : (
            <div
              aria-label="Atom content"
              className={clsx(
                'relative whitespace-pre-wrap rounded-card border border-line bg-bg-base px-3.5 py-3 text-[12px] leading-[1.65] text-text-secondary',
                !contentExpanded && contentCanExpand && 'max-h-[9.5rem] overflow-hidden',
              )}
            >
              {loading ? <span className="text-text-muted">Loading atom content…</span> : content}
              {!loading && !contentExpanded && contentCanExpand && (
                <span className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-bg-base to-transparent" />
              )}
            </div>
          )}
          {!editing && !loading && contentCanExpand && (
            <button
              type="button"
              onClick={() => setContentExpanded((expanded) => !expanded)}
              className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-accent hover:text-text-primary"
            >
              {contentExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              {contentExpanded ? 'Show less' : 'Read full content'}
            </button>
          )}
        </Section>

        <Section title={`Connections (${connectionCount})`}>
          <div className="space-y-2">
            {detail && detail.links.length > 0 ? (
              visibleLinks.map((link) => (
                <ConnectionRow key={link.id} nodeId={node.id} link={link} relatedNodes={detail.relatedNodes} />
              ))
            ) : (
              <div className="rounded-card border border-dashed border-line bg-bg-base px-3 py-2 text-text-muted">
                No links yet.
              </div>
            )}
            {detail && detail.links.length > 5 && (
              <button
                type="button"
                onClick={() => setConnectionsExpanded((expanded) => !expanded)}
                className="flex w-full items-center justify-center gap-1 rounded-card border border-line/70 bg-surface-2/45 px-3 py-2 text-[11px] font-medium text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
              >
                {connectionsExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                {connectionsExpanded ? 'Collapse connections' : `Show ${detail.links.length - 5} more connections`}
              </button>
            )}

            {canMutate && (
              <div className="rounded-card border border-line bg-bg-base p-2">
                {!linkOpen ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    iconLeft={<Link2 size={12} />}
                    className="w-full justify-start"
                    onClick={() => setLinkOpen(true)}
                  >
                    Link manually
                  </Button>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-center gap-1.5 rounded border border-line bg-surface px-2 py-1">
                      <Search size={11} className="text-text-muted" />
                      <input
                        value={linkQuery}
                        onChange={(event) => setLinkQuery(event.target.value)}
                        placeholder="Search atoms"
                        className="min-w-0 flex-1 bg-transparent text-[11px] text-text-primary placeholder:text-text-muted focus:outline-none"
                      />
                    </div>
                    <select
                      value={relation}
                      onChange={(event) => setRelation(event.target.value as KnowledgeLinkRelation)}
                      className="h-8 w-full rounded border border-line bg-surface px-2 text-[11px] text-text-primary focus:outline-none"
                    >
                      {RELATIONS.map((item) => (
                        <option key={item} value={item}>{relationLabel(item)}</option>
                      ))}
                    </select>
                    <div className="max-h-40 space-y-1 overflow-y-auto">
                      {linkCandidates.map((candidate) => (
                        <button
                          key={candidate.id}
                          type="button"
                          onClick={() => setTargetId(candidate.id)}
                          className={clsx(
                            'flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-[11px] transition-colors',
                            targetId === candidate.id ? 'bg-accent-soft text-accent' : 'text-text-secondary hover:bg-surface-2',
                          )}
                        >
                          <span className="truncate">{shortTitle(candidate.label)}</span>
                          <span className="shrink-0 text-[10px] uppercase tracking-wider text-text-muted">
                            {badgeLabel(candidate.type)}
                          </span>
                        </button>
                      ))}
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <Button variant="ghost" size="sm" onClick={() => setLinkOpen(false)}>Cancel</Button>
                      <Button
                        variant="primary"
                        size="sm"
                        loading={linking}
                        disabled={!selectedTarget}
                        onClick={() => void createLink()}
                      >
                        Link
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </Section>

        {canMutate && (
          <Section title="Suggested Links">
            {suggestions.length === 0 ? (
              <div className="rounded-card border border-dashed border-line bg-bg-base px-3 py-2 text-text-muted">
                Use <span className="font-semibold text-text-secondary">Suggest related</span> above to find connections by content similarity.
              </div>
            ) : (
              <div className="space-y-1.5">
                {suggestions.map((suggestion) => (
                  <div key={`${suggestion.kind}-${suggestion.id}`} className="flex items-center gap-2 rounded-card border border-line bg-bg-base px-3 py-2 text-[11px]">
                    <Sparkles size={11} className="shrink-0 text-amber-300" />
                    <span className="min-w-0 flex-1 truncate text-text-primary" title={suggestion.label}>{shortTitle(suggestion.label)}</span>
                    <span className="shrink-0 text-[10px] uppercase tracking-wider text-text-muted">
                      {relationLabel(suggestion.suggestedRelation)} / {Math.round(suggestion.score * 100)}%
                    </span>
                    <button
                      type="button"
                      onClick={() => void acceptSuggestion(suggestion)}
                      className="shrink-0 rounded border border-accent bg-accent-soft px-1.5 py-0.5 text-[10px] text-accent hover:bg-accent hover:text-canvas"
                    >
                      Link
                    </button>
                  </div>
                ))}
              </div>
            )}
          </Section>
        )}

        <details className="group overflow-hidden rounded-card border border-line bg-bg-base">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted transition-colors hover:bg-surface-2/60 hover:text-text-secondary">
            Details and usage
            <ChevronDown size={13} className="transition-transform group-open:rotate-180" />
          </summary>
          <div className="space-y-4 border-t border-line px-3 py-3">
            <Section title="Provenance">
              <div>
                <Fact label="Created by" value={provenance?.createdBy ?? fallbackCreator(node)} />
                <Fact label="When" value={relativeTime(provenance?.createdAt ?? stringMeta(node, 'createdAt'))} />
                <Fact label="Source" value={provenance?.source ?? stringMeta(node, 'source') ?? 'Knowledge import'} />
                <Fact label="Reinforced" value={`${provenance?.reinforced ?? numberMeta(node, 'reinforceCount') ?? 1} time(s)`} />
              </div>
            </Section>
            {pacerClass(node) && (
              <Section title="Memory class (PACER)">
                <div>
                  <Fact label="Class" value={pacerLabel(pacerClass(node)!)} />
                  {stringMeta(node, 'originSurface') && (
                    <Fact label="Origin" value={surfaceLabel(stringMeta(node, 'originSurface'))} />
                  )}
                  <Fact label="State" value={consolidationState(node)} />
                  {stringMeta(node, 'formationMode') && (
                    <Fact label="Formed via" value={formationLabel(stringMeta(node, 'formationMode'))} />
                  )}
                </div>
              </Section>
            )}
            <Section title="Used By">
              <div className="space-y-1.5">
                {detail && detail.usedBy.length > 0 ? (
                  detail.usedBy.map((usage) => (
                    <div key={`${usage.type}-${usage.id}`} className="flex items-center justify-between gap-2 rounded border border-line bg-surface px-3 py-2">
                      <span className="inline-flex min-w-0 items-center gap-2 text-text-primary">
                        {usage.type === 'workflow' ? <GitBranch size={12} className="text-cyan-300" /> : <ArrowUpRight size={12} className="text-violet-300" />}
                        <span className="truncate">{usage.name}</span>
                      </span>
                      <span className="shrink-0 text-[10px] text-text-muted">{usage.count}x</span>
                    </div>
                  ))
                ) : (
                  <div className="text-[11px] text-text-muted">Not referenced yet.</div>
                )}
              </div>
            </Section>
          </div>
        </details>

      </div>

      {canMutate && (
        <div className="shrink-0 border-t border-line bg-surface px-5 py-3">
          <button
            type="button"
            onClick={() => void archiveNode()}
            disabled={archiving}
            className="inline-flex items-center gap-1.5 text-[11px] text-text-muted transition-colors hover:text-rose-300 disabled:opacity-50"
          >
            <Archive size={12} />
            {archiving ? 'Archiving…' : 'Archive this atom'}
          </button>
        </div>
      )}
    </aside>
  );
}

function Metric({ label, ratio, tone }: { label: string; ratio: number | null; tone: 'cyan' | 'violet' }) {
  const pct = ratio == null ? null : Math.round(ratio * 100);
  const bar = tone === 'cyan' ? 'bg-cyan-400' : 'bg-violet-400';
  return (
    <div className="rounded-card border border-line bg-bg-base px-2 py-1.5">
      <div className="text-[14px] font-semibold leading-none text-text-primary">
        {pct == null ? '—' : `${pct}%`}
      </div>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-2">
        <div className={clsx('h-full rounded-full', bar)} style={{ width: `${pct ?? 0}%` }} />
      </div>
      <div className="mt-1 text-[9px] uppercase tracking-wider text-text-muted">{label}</div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-card border border-line bg-bg-base px-2 py-1.5">
      <div className="text-[14px] font-semibold leading-none text-text-primary">{value}</div>
      <div className="mt-[11px] text-[9px] uppercase tracking-wider text-text-muted">{label}</div>
    </div>
  );
}

/** Human label for a scoped atom's owner kind (Workspace Brain provenance). */
function scopeKindLabel(kind: unknown): string {
  if (kind === 'app') return 'App';
  if (kind === 'agent') return 'Agent';
  if (kind === 'workflow') return 'Workflow';
  return 'Scope';
}

function layerColor(layer: BrainNode['layer']): string {
  switch (layer) {
    case 'core': return '#e2e8f0';
    case 'knowledge': return '#22d3ee';
    case 'memory': return '#a78bfa';
    case 'judgment': return '#f59e0b';
    default: return '#94a3b8';
  }
}

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">{title}</div>
        {action ?? null}
      </div>
      {children}
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1 text-[11px]">
      <span className="shrink-0 text-text-muted">{label}</span>
      <span className="min-w-0 text-right text-text-primary">{value}</span>
    </div>
  );
}

function ConnectionRow({
  nodeId,
  link,
  relatedNodes,
}: {
  nodeId: string;
  link: BrainGraphLink;
  relatedNodes: BrainGraphNode[];
}) {
  const outgoing = link.source === nodeId;
  const relatedId = outgoing ? link.target : link.source;
  const related = relatedNodes.find((candidate) => candidate.id === relatedId);
  return (
    <div className="flex items-center gap-2 rounded-card border border-line bg-bg-base px-3 py-2 text-[11px]">
      {outgoing ? <ArrowUpRight size={12} className="shrink-0 text-cyan-300" /> : <ArrowDownLeft size={12} className="shrink-0 text-violet-300" />}
      <span className="shrink-0 text-text-muted">{outgoing ? '->' : '<-'} {relationLabel(link.relation)}</span>
      <span className="min-w-0 truncate text-text-primary">{shortTitle(related?.label ?? relatedId)}</span>
    </div>
  );
}

/** Wedge memory kinds carried on `metadata.kind` for `workspace_memory` atoms. */
const MEMORY_KIND_LABEL: Record<string, string> = {
  fact: 'Fact',
  preference: 'Preference',
  pattern: 'Pattern',
  rule: 'Rule',
  lesson: 'Lesson',
  skill: 'Skill',
  example: 'Example',
};

function TypeBadge({ type, kind }: { type: BrainNodeType; kind?: string }) {
  const tone = badgeTone(type);
  // A memory atom carries its true kind (fact/preference/rule/lesson/pattern)
  // on `metadata.kind`; the coarse node type alone would mislabel them all as
  // "Pattern". Prefer the specific kind when present.
  const label = (kind && MEMORY_KIND_LABEL[kind]) ?? badgeLabel(type);
  return (
    <span className={clsx('inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider', tone)}>
      {label}
    </span>
  );
}

function atomIdentity(node: BrainNode): { atomId: string; atomKind: KnowledgeAtomKind } | null {
  const atomId = typeof node.metadata.atomId === 'string' ? node.metadata.atomId : null;
  const atomKind = typeof node.metadata.atomKind === 'string' ? node.metadata.atomKind : null;
  if (!atomId || !isKnowledgeAtomKind(atomKind)) return null;
  return { atomId, atomKind };
}

function isKnowledgeAtomKind(value: string | null): value is KnowledgeAtomKind {
  return value === 'kb_chunk' || value === 'knowledge_chunk' || value === 'episode' || value === 'memory' || value === 'pattern' || value === 'skill' || value === 'example';
}

function badgeLabel(type: BrainNodeType): string {
  switch (type) {
    case 'knowledge_cluster': return 'Knowledge';
    case 'memory_episode': return 'Memory';
    case 'memory_pattern': return 'Pattern';
    case 'evaluator': return 'Evaluator';
    case 'baseline': return 'Baseline';
    case 'warning': return 'Warning';
    case 'gap': return 'Gap';
    case 'core': return 'Core';
    default: return humanTitle(type);
  }
}

function badgeTone(type: BrainNodeType): string {
  switch (type) {
    case 'knowledge_cluster': return 'border-cyan-300/30 bg-cyan-400/10 text-cyan-200';
    case 'memory_episode':
    case 'memory_pattern': return 'border-violet-300/30 bg-violet-400/10 text-violet-200';
    case 'evaluator':
    case 'baseline': return 'border-amber-300/30 bg-amber-400/10 text-amber-200';
    case 'warning': return 'border-rose-300/30 bg-rose-400/10 text-rose-200';
    case 'gap': return 'border-slate-300/30 bg-slate-400/10 text-slate-200';
    case 'core': return 'border-white/30 bg-white/10 text-white';
    default: return 'border-line bg-bg-base text-text-secondary';
  }
}

function relationLabel(relation: KnowledgeLinkRelation): string {
  return relation.replace(/_/g, ' ');
}

function shortTitle(label: string): string {
  const clean = humanTitle(label);
  return clean.length > 42 ? `${clean.slice(0, 41)}...` : clean;
}

function humanTitle(label: string): string {
  return label.replace(/\.md$/i, '').replace(/_/g, ' ').trim();
}

function fallbackCreator(node: BrainNode): string {
  const agentId = stringMeta(node, 'agentId');
  if (agentId) return `Agent ${agentId.slice(0, 8)}`;
  if (node.layer === 'knowledge') return 'Knowledge import';
  return 'Agent output';
}

function stringMeta(node: BrainNode, key: string): string {
  const value = node.metadata[key];
  return typeof value === 'string' ? value : '';
}

function numberMeta(node: BrainNode, key: string): number | null {
  const value = node.metadata[key];
  return typeof value === 'number' ? value : null;
}

function nodeTags(node: BrainNode): string[] {
  const value = node.metadata.tags;
  return Array.isArray(value) ? value.filter((t): t is string => typeof t === 'string') : [];
}

/** Resolve the PACER class from explicit metadata or the `pacer:<class>` tag. */
function pacerClass(node: BrainNode): string | null {
  const direct = stringMeta(node, 'pacerClass');
  if (direct) return direct;
  const tag = nodeTags(node).find((t) => t.startsWith('pacer:'));
  return tag ? tag.slice('pacer:'.length) : null;
}

function pacerLabel(cls: string): string {
  const map: Record<string, string> = {
    procedural: 'Procedural — execution rule',
    analogical: 'Analogical — similarity',
    conceptual: 'Conceptual — generalized lesson',
    evidence: 'Evidence — grounded observation',
    reference: 'Reference — stable lookup',
  };
  return map[cls] ?? cls;
}

function surfaceLabel(surface: string): string {
  const map: Record<string, string> = {
    tool_output: 'Tool output',
    run_completion: 'Run completion',
    operator_chat: 'Operator chat',
    session_conversation: 'Session conversation',
    knowledge_ingest: 'Knowledge ingest',
    agent_reflection: 'Agent reflection',
  };
  return map[surface] ?? surface;
}

function formationLabel(mode: string): string {
  const map: Record<string, string> = {
    formation_judge: 'Formation judge',
    staged: 'Staged (deterministic)',
    graduated: 'Graduated by reuse',
    feynman: 'Feynman repair',
    curator_distilled: 'Curator distillation',
    episodic_marker: 'Episodic marker',
  };
  return map[mode] ?? mode;
}

/** Staged (decay-eligible) vs consolidated (durable) — read from tags. */
function consolidationState(node: BrainNode): string {
  const tags = nodeTags(node);
  if (tags.includes('graduated')) return 'Consolidated (graduated by reuse)';
  if (tags.includes('consolidated')) return 'Consolidated (durable)';
  if (tags.includes('unconsolidated')) return 'Staged (decays unless reused)';
  return 'Active';
}

function relativeTime(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return 'Unknown';
  const delta = Date.now() - at;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  if (delta < 2_592_000_000) return `${Math.floor(delta / 86_400_000)}d ago`;
  return new Date(at).toLocaleDateString();
}

// ─── Health snapshot (for core-node panel) ────────────────────────────────────

interface HealthSnapshot {
  healthScore: number;
  metrics: {
    atomCoverageScore: number;
    qualityTrend: 'rising' | 'flat' | 'falling';
    averageConfidenceDelta: number;
    evaluatorSignalRate: number;
    staleAtomCount: number;
    disputedAtomCount: number;
  };
  evaluatorSignalsThisWeek: number;
  compressionStatus: { lastRunAt: string | null; atomsArchived: number };
  intelligence: { degraded: boolean };
}

function HealthCard({ icon, label, value, detail }: { icon: ReactNode; label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-card border border-line bg-bg-base px-2.5 py-2">
      <div className="flex items-center justify-between gap-1 text-text-muted">
        <span className="text-[9px] font-semibold uppercase tracking-wide">{label}</span>
        {icon}
      </div>
      <div className="mt-1.5 text-[18px] font-semibold capitalize leading-none text-text-primary">{value}</div>
      {detail && <div className="mt-1 text-[9px] text-text-muted">{detail}</div>}
    </div>
  );
}

function scoreTone(score: number): string {
  if (score >= 75) return 'text-emerald-300';
  if (score >= 45) return 'text-amber-300';
  return 'text-rose-300';
}

function pct(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function trendIcon(trend: 'rising' | 'flat' | 'falling'): ReactNode {
  if (trend === 'rising') return <TrendingUp size={13} className="text-emerald-300" />;
  if (trend === 'falling') return <TrendingDown size={13} className="text-rose-300" />;
  return <Gauge size={13} />;
}
