/**
 * Context Inspector — V1-SPEC §13.5.
 *
 * Right-side dock that shows the current selection's typed schema +
 * configuration. For agent task nodes it shows the routed agent and its
 * input contract; for skill nodes it shows the manifest's input/output
 * schemas; for branches it shows the condition expression.
 *
 * Defaults to closed; opens when the operator clicks a node on the canvas.
 */

import clsx from 'clsx';

export interface InspectorSelection {
  kind: 'node' | 'edge' | null;
  nodeType?: string;
  nodeId?: string;
  data?: Record<string, unknown>;
}

export function ContextInspector({
  selection,
  onClose,
  className,
}: {
  selection: InspectorSelection;
  onClose: () => void;
  className?: string;
}) {
  if (!selection.kind) return null;
  return (
    <aside
      className={clsx(
        'flex w-80 shrink-0 flex-col border-l border-line bg-surface text-xs',
        className,
      )}
    >
      <header className="flex items-center justify-between border-b border-line px-3 py-2">
        <span className="text-[10px] uppercase tracking-wider text-text-muted">
          {selection.kind === 'node' ? selection.nodeType : 'Edge'}
        </span>
        <button onClick={onClose} className="text-text-muted hover:text-accent">
          ×
        </button>
      </header>
      <div className="flex-1 overflow-auto p-3">
        {selection.nodeId && (
          <div className="mb-3">
            <div className="text-[10px] uppercase tracking-wider text-text-muted">Node ID</div>
            <div className="font-mono">{selection.nodeId}</div>
          </div>
        )}
        <div className="text-[10px] uppercase tracking-wider text-text-muted">Configuration</div>
        <pre className="mt-1 whitespace-pre-wrap break-all rounded-md border border-line bg-surface-2 p-2 font-mono text-[11px]">
          {JSON.stringify(selection.data ?? {}, null, 2)}
        </pre>
      </div>
    </aside>
  );
}
