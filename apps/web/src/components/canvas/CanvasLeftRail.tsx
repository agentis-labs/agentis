import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import { SegmentedControl } from '../shared/SegmentedControl';
import { NodePalette } from './NodePalette';
import { PhaseRail } from './PhaseRail';
import type { PhaseNode, PhaseSpec } from './PhaseLayer';

/**
 * CanvasLeftRail — the single left panel for the workflow editor.
 *
 * One column, two modes: "Phases" (structure + navigation) and "Nodes" (the
 * drag-and-drop palette). A workflow with phases opens structure-first so the
 * shape of the flow reads before the parts list — minimalism over a wall of
 * panels.
 */
type RailMode = 'phases' | 'nodes';

interface CanvasLeftRailProps {
  phases: PhaseSpec[];
  nodes: PhaseNode[];
  focusedPhaseId?: string | null;
  onFocusPhase: (phaseId: string) => void;
  onClearFocus: () => void;
  onAskAgentForPhases?: () => void;
}

const SEGMENTS = [
  { value: 'phases' as RailMode, label: 'Phases' },
  { value: 'nodes' as RailMode, label: 'Nodes' },
] as const;

export function CanvasLeftRail({
  phases,
  nodes,
  focusedPhaseId,
  onFocusPhase,
  onClearFocus,
  onAskAgentForPhases,
}: CanvasLeftRailProps) {
  // Structure-first when the workflow has phases; otherwise open on the
  // palette so an empty/flat canvas leads with "add a step".
  const [mode, setMode] = useState<RailMode>(phases.length > 0 ? 'phases' : 'nodes');
  const [isOpen, setIsOpen] = useState(true);

  return (
    <aside
      className={clsx(
        'relative shrink-0 border-line bg-surface transition-[width] duration-300 ease-in-out',
        isOpen ? 'w-60 border-r' : 'w-0 border-r-0'
      )}
    >
      <div className="h-full w-full overflow-hidden">
        <div
          className={clsx(
            'flex h-full w-60 flex-col transition-opacity duration-300',
            isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
          )}
        >
          <div className="flex shrink-0 justify-center border-b border-line p-2">
            <SegmentedControl segments={SEGMENTS} value={mode} onChange={setMode} size="sm" />
          </div>
          {mode === 'phases' ? (
            <PhaseRail
              phases={phases}
              nodes={nodes}
              focusedPhaseId={focusedPhaseId}
              onFocusPhase={onFocusPhase}
              onClearFocus={onClearFocus}
              onAskAgentForPhases={onAskAgentForPhases}
            />
          ) : (
            <NodePalette bare />
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        title={isOpen ? 'Collapse sidebar' : 'Expand sidebar'}
        className={clsx(
          'absolute top-6 z-50 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border border-line bg-surface text-text-muted shadow-sm transition-all duration-300 ease-in-out hover:bg-surface-2 hover:text-text-primary',
          isOpen ? 'right-0 translate-x-1/2' : 'right-0 translate-x-full'
        )}
      >
        {isOpen ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
      </button>
    </aside>
  );
}



