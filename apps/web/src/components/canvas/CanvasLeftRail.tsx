import { useState } from 'react';
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

  return (
    <aside className="flex min-h-0 w-60 shrink-0 flex-col border-r border-line bg-surface">
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
    </aside>
  );
}



