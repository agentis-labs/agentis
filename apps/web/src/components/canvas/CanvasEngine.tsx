import { useEffect, useRef, useState, type ComponentProps, type DragEvent, type ReactNode } from 'react';
import {
  ControlButton,
  Controls,
  MiniMap,
  ReactFlow,
  SelectionMode,
  useViewport,
  type Edge,
  type Node,
  type ReactFlowInstance,
  type XYPosition,
} from '@xyflow/react';
import { LayoutGrid } from 'lucide-react';
import '@xyflow/react/dist/style.css';
import { CanvasBackground } from '../home/CanvasBackground';

type ReactFlowProps = ComponentProps<typeof ReactFlow>;
type CanvasPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export type CanvasEngineInstance = ReactFlowInstance<Node, Edge>;

export interface CanvasEngineProps extends Omit<ReactFlowProps, 'children' | 'onInit' | 'onDragOver' | 'onDrop'> {
  children?: ReactNode;
  showMinimap?: boolean;
  minimapPosition?: CanvasPosition;
  minimapNodeColor?: string | ((node: Node) => string);
  controlsPosition?: CanvasPosition;
  backgroundGap?: number;
  backgroundSize?: number;
  backgroundColor?: string;
  dropEffect?: DataTransfer['dropEffect'];
  onReady?: (instance: CanvasEngineInstance) => void;
  onDropCanvas?: (event: DragEvent<HTMLDivElement>, position: XYPosition) => void;
  onTidy?: () => void;
}

function CanvasEngineBackground({ backgroundColor }: { backgroundColor?: string }) {
  const { x, y, zoom } = useViewport();

  if (backgroundColor === 'transparent') {
    return (
      <div className="react-flow__background absolute inset-0 h-full w-full pointer-events-none" style={{ zIndex: 0 }} />
    );
  }

  return (
    <div className="react-flow__background absolute inset-0 h-full w-full pointer-events-none" style={{ zIndex: 0 }}>
      <CanvasBackground pan={{ x, y }} zoom={zoom} />
    </div>
  );
}

export function CanvasEngine({
  children,
  showMinimap = false,
  minimapPosition = 'bottom-left',
  minimapNodeColor = '#7c83ff',
  controlsPosition = 'bottom-right',
  backgroundGap = 24,
  backgroundSize = 1,
  backgroundColor = 'var(--color-canvas-grid)',
  dropEffect = 'copy',
  onReady,
  onDropCanvas,
  onTidy,
  className,
  proOptions,
  deleteKeyCode,
  multiSelectionKeyCode,
  nodesDraggable,
  nodesConnectable,
  elementsSelectable,
  selectionMode,
  ...flowProps
}: CanvasEngineProps) {
  const flowRef = useRef<CanvasEngineInstance | null>(null);
  const [autoMinimapVisible, setAutoMinimapVisible] = useState(false);
  const hideMinimapTimerRef = useRef<number | null>(null);
  const lastViewportRef = useRef<{ x: number; y: number; zoom: number } | null>(null);
  const externalOnMove = flowProps.onMove;

  function scheduleMinimapHide(delay = 1400) {
    if (showMinimap) return;
    if (hideMinimapTimerRef.current) window.clearTimeout(hideMinimapTimerRef.current);
    hideMinimapTimerRef.current = window.setTimeout(() => setAutoMinimapVisible(false), delay);
  }

  function revealMinimap() {
    if (showMinimap) return;
    setAutoMinimapVisible(true);
    scheduleMinimapHide();
  }

  useEffect(
    () => () => {
      if (hideMinimapTimerRef.current) window.clearTimeout(hideMinimapTimerRef.current);
    },
    [],
  );

  return (
    <ReactFlow
      {...flowProps}
      onInit={(instance) => {
        const typed = instance as CanvasEngineInstance;
        flowRef.current = typed;
        onReady?.(typed);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = dropEffect;
      }}
      onDrop={(event) => {
        event.preventDefault();
        if (!onDropCanvas || !flowRef.current) return;
        const position = flowRef.current.screenToFlowPosition({ x: event.clientX, y: event.clientY });
        onDropCanvas(event, position);
      }}
      onMove={(event, viewport) => {
        externalOnMove?.(event, viewport);
        const previous = lastViewportRef.current;
        lastViewportRef.current = viewport;
        if (!previous) return;
        const panDelta = Math.hypot(viewport.x - previous.x, viewport.y - previous.y);
        const zoomDelta = Math.abs(viewport.zoom - previous.zoom);
        if (panDelta > 34 || zoomDelta > 0.055) revealMinimap();
      }}
      nodesDraggable={nodesDraggable ?? true}
      nodesConnectable={nodesConnectable ?? true}
      elementsSelectable={elementsSelectable ?? true}
      selectionMode={selectionMode ?? SelectionMode.Partial}
      deleteKeyCode={deleteKeyCode ?? ['Delete', 'Backspace']}
      multiSelectionKeyCode={multiSelectionKeyCode ?? ['Meta', 'Control']}
      proOptions={{ hideAttribution: true, ...(proOptions ?? {}) }}
      className={['agentis-flow-canvas bg-canvas', className].filter(Boolean).join(' ')}
    >
      <CanvasEngineBackground backgroundColor={backgroundColor} />
      <Controls position={controlsPosition} className="!bg-surface-2 !border-line">
        {onTidy && (
          <ControlButton type="button" onClick={onTidy} title="Tidy graph" aria-label="Tidy graph">
            <LayoutGrid size={14} />
          </ControlButton>
        )}
      </Controls>
      {(showMinimap || autoMinimapVisible) && (
        <MiniMap
          pannable
          zoomable
          position={minimapPosition}
          className="!bg-surface-2 !border !border-line"
          maskColor="var(--color-overlay)"
          nodeColor={typeof minimapNodeColor === 'function' ? minimapNodeColor : () => minimapNodeColor}
          onMouseEnter={() => {
            if (hideMinimapTimerRef.current) window.clearTimeout(hideMinimapTimerRef.current);
          }}
          onMouseLeave={() => scheduleMinimapHide(900)}
          onFocus={() => {
            if (hideMinimapTimerRef.current) window.clearTimeout(hideMinimapTimerRef.current);
          }}
          onBlur={() => scheduleMinimapHide(900)}
        />
      )}
      {children}
    </ReactFlow>
  );
}
