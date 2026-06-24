import type { Node } from '@xyflow/react';
import { ViewportPortal } from '@xyflow/react';
import type { WorkflowPhase } from '@agentis/core';
import type React from 'react';
import { FolderPlus, LayoutGrid, MoveRight, Trash2 } from 'lucide-react';

export function CanvasSelectionToolbar({
  nodes,
  phases,
  canCreatePhase,
  onCreatePhase,
  onMoveToPhase,
  onTidy,
  onDelete,
}: {
  nodes: Node[];
  phases: WorkflowPhase[];
  canCreatePhase: boolean;
  onCreatePhase: (nodeIds: string[]) => void;
  onMoveToPhase: (phaseId: string, nodeIds: string[]) => void;
  onTidy: (nodeIds: string[]) => void;
  onDelete: (nodeIds: string[]) => void;
}) {
  if (nodes.length < 2) return null;
  const nodeIds = nodes.map((node) => node.id);
  const minX = Math.min(...nodes.map((node) => node.position.x));
  const maxX = Math.max(...nodes.map((node) => node.position.x + (node.width ?? 240)));
  const minY = Math.min(...nodes.map((node) => node.position.y));
  const x = minX + (maxX - minX) / 2;
  const stopCanvasEvent = (event: React.SyntheticEvent) => {
    event.stopPropagation();
  };
  const runAction = (event: React.MouseEvent, action: (selectedNodeIds: string[]) => void) => {
    event.preventDefault();
    event.stopPropagation();
    action(nodeIds);
  };

  return (
    <ViewportPortal>
      <div
        data-testid="canvas-selection-toolbar"
        data-canvas-toolbar
        // `nopan nodrag` are React Flow markers: without them a pointerdown on the
        // toolbar is captured by the pane first (selection box / pane click) and
        // clears the selection before our handlers run. With them, RF leaves the
        // event to the toolbar so the buttons actually fire.
        className="nopan nodrag absolute flex items-center gap-1 rounded-lg border border-line bg-surface/95 p-1 shadow-dropdown backdrop-blur"
        style={{ transform: `translate(${x}px, ${minY - 12}px) translate(-50%, -100%)`, zIndex: 20 }}
        onPointerDownCapture={stopCanvasEvent}
        onPointerUpCapture={stopCanvasEvent}
        onMouseDownCapture={stopCanvasEvent}
        onMouseUpCapture={stopCanvasEvent}
        onTouchStartCapture={stopCanvasEvent}
        onTouchEndCapture={stopCanvasEvent}
        onClick={stopCanvasEvent}
      >
        <button type="button" disabled={!canCreatePhase} onClick={(event) => runAction(event, onCreatePhase)} className={buttonClass} title="Create a phase from unassigned nodes">
          <FolderPlus size={12} /> Create phase
        </button>
        {phases.length > 0 && (
          <label className="relative">
            <MoveRight className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-text-muted" size={12} />
            <select
              defaultValue=""
              onPointerDownCapture={stopCanvasEvent}
              onPointerUpCapture={stopCanvasEvent}
              onPointerDown={stopCanvasEvent}
              onClick={stopCanvasEvent}
              onChange={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (event.target.value) onMoveToPhase(event.target.value, nodeIds);
                event.target.value = '';
              }}
              className="h-7 rounded-md border-0 bg-transparent pl-7 pr-6 text-[10px] font-medium text-text-secondary outline-none hover:bg-surface-2"
            >
              <option value="" disabled>Move to phase</option>
              {phases.map((phase) => <option key={phase.id} value={phase.id}>{phase.name}</option>)}
            </select>
          </label>
        )}
        <button type="button" onClick={(event) => runAction(event, onTidy)} className={buttonClass}><LayoutGrid size={12} /> Tidy selection</button>
        <button type="button" onClick={(event) => runAction(event, onDelete)} className={`${buttonClass} text-danger`}><Trash2 size={12} /> Delete</button>
      </div>
    </ViewportPortal>
  );
}

const buttonClass = 'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[10px] font-medium text-text-secondary hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-35';
