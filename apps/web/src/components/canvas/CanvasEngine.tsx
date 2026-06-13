import { useRef, type ComponentProps, type DragEvent, type ReactNode } from 'react';
import {
  Controls,
  MiniMap,
  ReactFlow,
  useViewport,
  type Edge,
  type Node,
  type ReactFlowInstance,
  type XYPosition,
} from '@xyflow/react';
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
  className,
  proOptions,
  deleteKeyCode,
  multiSelectionKeyCode,
  nodesDraggable,
  nodesConnectable,
  elementsSelectable,
  ...flowProps
}: CanvasEngineProps) {
  const flowRef = useRef<CanvasEngineInstance | null>(null);

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
      nodesDraggable={nodesDraggable ?? true}
      nodesConnectable={nodesConnectable ?? true}
      elementsSelectable={elementsSelectable ?? true}
      deleteKeyCode={deleteKeyCode ?? ['Delete', 'Backspace']}
      multiSelectionKeyCode={multiSelectionKeyCode ?? ['Meta', 'Control']}
      proOptions={{ hideAttribution: true, ...(proOptions ?? {}) }}
      className={['agentis-flow-canvas bg-canvas', className].filter(Boolean).join(' ')}
    >
      <CanvasEngineBackground backgroundColor={backgroundColor} />
      <Controls position={controlsPosition} className="!bg-surface-2 !border-line" />
      {showMinimap && (
        <MiniMap
          pannable
          zoomable
          position={minimapPosition}
          className="!bg-surface-2 !border !border-line"
          maskColor="var(--color-overlay)"
          nodeColor={typeof minimapNodeColor === 'function' ? minimapNodeColor : () => minimapNodeColor}
        />
      )}
      {children}
    </ReactFlow>
  );
}
