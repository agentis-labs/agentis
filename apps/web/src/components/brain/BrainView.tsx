import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight } from 'lucide-react';
import { REALTIME_EVENTS, type BrainGraph, type BrainNode, type BrainResponse } from '@agentis/core';
import { api, apiErrorMessage } from '../../lib/api';
import { rtSubscribe, useRealtime } from '../../lib/realtime';
import { Skeleton } from '../shared/Skeleton';
import { useToast } from '../shared/Toast';
import { BrainStage } from './BrainStage';
import { BrainDetailRail } from './BrainDetailRail';
import { OrgDetailRail } from './OrgDetailRail';
import { EmptyBrainStage } from './EmptyBrainStage';
import { LayerFilterChips, type BrainVisibleLayers } from './LayerFilterChips';
import { graphToBrainEdges, graphToBrainNodes } from './brainGraphAdapter';

export function BrainView({
  onManage,
  onOpenConfig,
  search = '',
  onSearchChange,
  intelligence = null,
}: {
  onManage?: () => void;
  onOpenConfig?: () => void;
  /** Node-search query, driven by the page toolbar so search lives in one bar. */
  search?: string;
  onSearchChange?: (value: string) => void;
  intelligence?: { degraded: boolean } | null;
}) {
  const [data, setData] = useState<BrainResponse | null>(null);
  const [graph, setGraph] = useState<BrainGraph | null>(null);
  const [orgOverlay, setOrgOverlay] = useState<BrainGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [visibleLayers, setVisibleLayers] = useState<BrainVisibleLayers>({ knowledge: true, memory: true, judgment: true });
  const [showWarnings, setShowWarnings] = useState(true);
  const [showGaps, setShowGaps] = useState(true);
  const [livePulse, setLivePulse] = useState(0);
  const toast = useToast();
  const graphUrl = '/v1/brain/graph';

  const reloadBrain = useCallback(async (showLoader = false) => {
    if (showLoader) {
      setLoading(true);
      setSelectedId(null);
      setGraph(null);
    }
    try {
      const [brain, graphResponse] = await Promise.all([
        api<BrainResponse>('/v1/brain'),
        api<{ graph: BrainGraph }>(graphUrl),
      ]);
      setData(brain);
      setGraph(graphResponse.graph);
    } catch (error) {
      toast.error('Failed to load Brain', apiErrorMessage(error));
    } finally {
      if (showLoader) setLoading(false);
    }
    // Toast context exposes a new object as notifications change; loading must
    // be tied to data events rather than notification renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reloadSupplemental = useCallback(async () => {
    // Organizational overlay is optional and must never hold up the atom map.
    const overlayResponse = await api<{ graph: BrainGraph }>('/v1/grounding/graph').catch(() => null);
    setOrgOverlay(overlayResponse?.graph ?? null);
  }, []);

  const reloadGraph = useCallback(() => {
    void api<{ graph: BrainGraph }>(graphUrl)
      .then((response) => setGraph(response.graph))
      .catch(() => {});
  }, []);

  useEffect(() => {
    void reloadBrain(true);
    void reloadSupplemental();
  }, [reloadBrain, reloadSupplemental]);
  useEffect(() => rtSubscribe('workspace', {}), []);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') reloadGraph(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [reloadGraph]);

  useRealtime([
    REALTIME_EVENTS.BRAIN_ATOM_CREATED,
    REALTIME_EVENTS.BRAIN_ATOM_REINFORCED,
    REALTIME_EVENTS.BRAIN_LINK_CREATED,
  ], () => {
    setLivePulse((value) => value + 1);
    void reloadBrain(false);
  });
  // Merge the organizational overlay into the atom graph so sources, entities,
  // and claims share the same constellation, simulation, search, and filters.
  const mergedGraph = useMemo<BrainGraph | null>(() => {
    if (!orgOverlay || orgOverlay.nodes.length === 0) return graph;
    if (!graph) return orgOverlay;
    return {
      ...graph,
      nodes: [...graph.nodes, ...orgOverlay.nodes],
      links: [...graph.links, ...orgOverlay.links],
      meta: {
        ...graph.meta,
        atomCount: graph.meta.atomCount + orgOverlay.meta.atomCount,
        linkCount: graph.meta.linkCount + orgOverlay.meta.linkCount,
      },
    };
  }, [graph, orgOverlay]);

  const graphNodes = useMemo<BrainNode[]>(() => mergedGraph ? graphToBrainNodes(mergedGraph) : [], [mergedGraph]);
  const displayBrain = useMemo<BrainResponse | null>(() => {
    if (!data) return null;
    if (!mergedGraph || mergedGraph.meta.atomCount === 0) return data;
    const layers = {
      core: graphNodes.filter((node) => node.layer === 'core'),
      knowledge: graphNodes.filter((node) => node.layer === 'knowledge'),
      memory: graphNodes.filter((node) => node.layer === 'memory'),
      judgment: graphNodes.filter((node) => node.layer === 'judgment'),
    };
    return {
      ...data,
      stats: {
        ...data.stats,
        knowledgeNodes: layers.knowledge.length,
        memoryNodes: layers.memory.length,
        evaluatorNodes: layers.judgment.length,
      },
      layers,
      edges: graphToBrainEdges(mergedGraph),
    };
  }, [data, mergedGraph, graphNodes]);

  const allNodes = useMemo<BrainNode[]>(() => {
    if (graphNodes.length > 1) return graphNodes;
    if (!displayBrain) return [];
    return [
      ...displayBrain.layers.core,
      ...displayBrain.layers.knowledge,
      ...displayBrain.layers.memory,
      ...displayBrain.layers.judgment,
    ];
  }, [displayBrain, graphNodes]);

  const searchMatches = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return [];
    return allNodes.filter((node) =>
      node.label.toLowerCase().includes(query) ||
      (node.description ?? '').toLowerCase().includes(query),
    ).slice(0, 6);
  }, [search, allNodes]);

  const selectedNode = useMemo(
    () => allNodes.find((node) => node.id === selectedId) ?? null,
    [allNodes, selectedId],
  );

  if (loading) {
    return <div className="h-full space-y-3 p-5"><Skeleton height={34} /><Skeleton height={500} /></div>;
  }
  if (!data) {
    return <div className="p-8 text-[14px] text-text-muted">Could not load Brain.</div>;
  }

  const brain = displayBrain ?? data;
  const isEmptyBrain = brain.layers.knowledge.length === 0 && brain.layers.memory.length === 0 && brain.layers.judgment.length === 0;

  return (
    <div className="brain-scope flex h-full flex-col">
      {intelligence?.degraded && (
        <div className="flex shrink-0 items-center gap-3 border-b border-amber-400/20 bg-amber-500/10 px-5 py-2.5 text-[12px] text-amber-100">
          <AlertTriangle size={14} className="shrink-0 text-amber-300" />
          <span>Brain is running in keyword mode. Semantic search is disabled.</span>
          <button type="button" onClick={onOpenConfig} className="ml-auto inline-flex items-center gap-1 font-semibold text-amber-200 hover:text-amber-100">
            Set up embedding <ArrowRight size={12} />
          </button>
        </div>
      )}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="relative flex-1 overflow-hidden">
          {isEmptyBrain ? (
            <EmptyBrainStage
              scope="workspace"
              actionLabel="Open Knowledge"
              onAction={onManage ?? (() => { window.location.href = '/brain?tab=knowledge'; })}
            />
          ) : (
            <BrainStage
              brain={brain}
              graph={mergedGraph}
              selectedId={selectedId}
              onSelect={setSelectedId}
              filters={{ showWarnings, showGaps, visibleLayers }}
              livePulse={livePulse}
              layoutKey="workspace"
              atomBadgeClassName="bottom-16 left-3"
            />
          )}
          {!isEmptyBrain && (
            <>
              {search.trim() && searchMatches.length > 0 && (
                <div className="absolute left-3 top-14 z-40 w-64 overflow-hidden rounded-card border border-line bg-surface shadow-dropdown">
                  {searchMatches.map((node) => (
                    <button
                      key={node.id}
                      type="button"
                      onClick={() => { setSelectedId(node.id); onSearchChange?.(''); }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] hover:bg-surface-2"
                    >
                      <span className="shrink-0 text-[10px] uppercase tracking-wider text-text-muted">{node.layer}</span>
                      <span className="truncate text-text-primary">{node.label}</span>
                    </button>
                  ))}
                </div>
              )}
              <LayerFilterChips
                visibleLayers={visibleLayers}
                onToggleLayer={(layer) => setVisibleLayers((current) => ({ ...current, [layer]: !current[layer] }))}
                showWarnings={showWarnings}
                onToggleWarnings={() => setShowWarnings((visible) => !visible)}
                hasWarnings={brain.warnings.length > 0 || allNodes.some((node) => node.type === 'warning')}
                showGaps={showGaps}
                onToggleGaps={() => setShowGaps((visible) => !visible)}
                hasGaps={brain.gaps.length > 0 || allNodes.some((node) => node.type === 'gap')}
              />
            </>
          )}
        </div>
        {selectedNode && Boolean(selectedNode.metadata?.grounding) && (
          <OrgDetailRail
            node={selectedNode}
            onClose={() => setSelectedId(null)}
            onChanged={() => {
              void reloadBrain(false);
              void reloadSupplemental();
            }}
          />
        )}
        {selectedNode && !selectedNode.metadata?.grounding && (
          <BrainDetailRail
            brain={brain}
            node={selectedNode}
            candidateNodes={allNodes}
            detailPath={`${graphUrl}/node/${encodeURIComponent(selectedId!)}`}
            linkPath="/v1/brain/links"
            atomPathBase="/v1/brain/atoms"
            scopeName="Workspace"
            onClose={() => setSelectedId(null)}
            onGraphChanged={() => reloadBrain(false)}
            onArchived={() => {
              setSelectedId(null);
              return reloadBrain(false);
            }}
          />
        )}
      </div>
    </div>
  );
}



