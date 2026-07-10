import { useEffect, useMemo, useState } from 'react';
import type { BrainGraph, BrainNode, BrainResponse } from '@agentis/core';
import { api, apiErrorMessage } from '../../lib/api';
import { useToast } from '../shared/Toast';
import { Skeleton } from '../shared/Skeleton';
import { BrainStage } from './BrainStage';
import { BrainDetailRail } from './BrainDetailRail';
import { CanvasSearch } from './CanvasSearch';
import { graphToBrainEdges, graphToBrainNodes } from './brainGraphAdapter';

export function ScopedBrainMap({
  endpoint,
  detailEndpoint,
  layoutKey,
  emptyMessage,
  scopeName,
  scopeId,
  searchPositionClassName,
  searchQuery,
  onSearchQueryChange,
}: {
  endpoint: string | null;
  detailEndpoint?: string | null;
  layoutKey: string;
  emptyMessage: string;
  scopeName?: string;
  scopeId?: string;
  /** Moves the node-search away from a corner other controls occupy. */
  searchPositionClassName?: string;
  /** When provided, the search input lives in the page toolbar (one bar); the
   * map renders only the results dropdown instead of its own CanvasSearch. */
  searchQuery?: string;
  onSearchQueryChange?: (value: string) => void;
}) {
  const toast = useToast();
  const [graph, setGraph] = useState<BrainGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const controlledSearch = searchQuery !== undefined;
  const [internalSearch, setInternalSearch] = useState('');
  const search = searchQuery ?? internalSearch;
  const setSearch = onSearchQueryChange ?? setInternalSearch;

  useEffect(() => {
    if (!endpoint) {
      setGraph(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setSelectedId(null);
    void api<{ graph: BrainGraph }>(endpoint)
      .then((response) => setGraph(response.graph))
      .catch((error) => toast.error('Could not load Brain map', apiErrorMessage(error)))
      .finally(() => setLoading(false));
    // Toast context changes as messages render; reload only when the scope endpoint changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint]);

  const nodes = useMemo(() => graph ? graphToBrainNodes(graph) : [], [graph]);
  const brain = useMemo<BrainResponse | null>(() => graph ? {
    scope: 'scoped',
    stats: {
      knowledgeNodes: nodes.filter((node) => node.layer === 'knowledge').length,
      memoryNodes: nodes.filter((node) => node.layer === 'memory').length,
      evaluatorNodes: 0,
      baselineConfidence: null,
      staleSources: 0,
    },
    layers: {
      core: nodes.filter((node) => node.layer === 'core'),
      knowledge: nodes.filter((node) => node.layer === 'knowledge'),
      memory: nodes.filter((node) => node.layer === 'memory'),
      judgment: nodes.filter((node) => node.layer === 'judgment'),
    },
    edges: graphToBrainEdges(graph),
    warnings: [],
    gaps: [],
  } : null, [graph, nodes]);
  const matches = useMemo<BrainNode[]>(() => {
    const query = search.trim().toLowerCase();
    return query ? nodes.filter((node) => `${node.label} ${node.description ?? ''}`.toLowerCase().includes(query)).slice(0, 6) : [];
  }, [nodes, search]);
  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedId) ?? null,
    [nodes, selectedId],
  );
  if (loading) return <div className="h-full p-5"><Skeleton height={500} /></div>;
  if (!brain || (graph?.meta.atomCount ?? 0) === 0) {
    return (
      <div className="flex h-full items-center justify-center bg-canvas px-6 text-center">
        <div>
          <p className="text-heading text-text-primary">Nothing mapped yet</p>
          <p className="mt-2 text-[13px] text-text-muted">{emptyMessage}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full overflow-hidden bg-canvas">
      <div className="relative min-w-0 flex-1 overflow-hidden">
        <BrainStage
          brain={brain}
          graph={graph}
          selectedId={selectedId}
          onSelect={setSelectedId}
          filters={{ showWarnings: false, showGaps: false, visibleLayers: { knowledge: true, memory: true, judgment: true } }}
          layoutKey={layoutKey}
        />
        {controlledSearch ? (
          search.trim() && matches.length > 0 && (
            <div className="absolute left-3 top-14 z-40 w-64 overflow-hidden rounded-card border border-line bg-surface shadow-dropdown">
              {matches.map((node) => (
                <button
                  key={node.id}
                  type="button"
                  onClick={() => { setSelectedId(node.id); onSearchQueryChange?.(''); }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] hover:bg-surface-2"
                >
                  <span className="shrink-0 text-[10px] uppercase tracking-wider text-text-muted">{node.layer}</span>
                  <span className="truncate text-text-primary">{node.label}</span>
                </button>
              ))}
            </div>
          )
        ) : (
          <CanvasSearch value={search} onChange={setSearch} results={matches} onSelect={setSelectedId} positionClassName={searchPositionClassName} />
        )}
      </div>
      {selectedNode && (
        <BrainDetailRail
          brain={brain}
          node={selectedNode}
          candidateNodes={nodes}
          detailPath={detailEndpoint
            ? (detailEndpoint.includes(':id')
              ? detailEndpoint.replace(':id', encodeURIComponent(selectedNode.id))
              : `${detailEndpoint}/${encodeURIComponent(selectedNode.id)}`)
            : null}
          allowMutations={false}
          scopeName={scopeName}
          scopeId={scopeId}
          onClose={() => setSelectedId(null)}
          onGraphChanged={() => {}}
          onArchived={() => {}}
        />
      )}
    </div>
  );
}



