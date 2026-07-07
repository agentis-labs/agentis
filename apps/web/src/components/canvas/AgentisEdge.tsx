/**
 * AgentisEdge — NEW-WORKFLOW.md Part 2 §P3.
 *
 * Custom edge renderer that paints a small label badge on the edge midpoint
 * and supports double-click inline rename. The label is persisted on the
 * edge `data.label` field which the canvas serialises into the workflow
 * graph alongside source/target.
 */

import { useEffect, useRef, useState } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  useReactFlow,
  type EdgeProps,
} from '@xyflow/react';
import clsx from 'clsx';

export function AgentisEdge(props: EdgeProps) {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    style,
    markerEnd,
    data,
    selected,
  } = props;
  const { setEdges } = useReactFlow();
  const label = (data as { label?: string } | undefined)?.label ?? '';
  const xray = (data as { xray?: { costLabel: string; tokenLabel: string } } | undefined)?.xray;
  const edgeType = (data as { type?: 'default' | 'error' | 'condition' } | undefined)?.type ?? 'default';
  const onDelete = (data as { onDelete?: (edgeId: string) => void } | undefined)?.onDelete;

  // Edge-type styling. Error edges render dashed in red to make catch branches
  // visually distinct from the success path; condition edges get a subtle
  // amber accent. The base color comes from `style`, so we only override what
  // matters for the type discriminant.
  const typedStyle: React.CSSProperties = (() => {
    if (edgeType === 'error') {
      return {
        ...(style ?? {}),
        stroke: 'var(--color-danger, #ef4444)',
        strokeDasharray: '6 4',
      };
    }
    if (edgeType === 'condition') {
      return { ...(style ?? {}), stroke: 'var(--color-warn, #d97706)' };
    }
    return style ?? {};
  })();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  useEffect(() => {
    setDraft(label);
  }, [label]);

  // Orthogonal routing with rounded corners (reference-builder parity): edges
  // travel the gutters between cards and bands as tidy staircases instead of
  // long diagonals slashing across the graph.
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 14,
    offset: 16,
  });

  function commit(next: string) {
    setEditing(false);
    const trimmed = next.trim();
    setEdges((eds) =>
      eds.map((e) => {
        if (e.id !== id) return e;
        const prev = (e.data as { label?: string } | undefined)?.label ?? '';
        if (prev === trimmed) return e;
        return { ...e, data: { ...(e.data ?? {}), label: trimmed || undefined } };
      }),
    );
  }

  return (
    <>
      <BaseEdge id={id} path={edgePath} style={typedStyle} markerEnd={markerEnd} />
      <EdgeLabelRenderer>
        <div
          // React Flow recommends pointer-events:all on labels so they can
          // receive events while sitting on top of the SVG path.
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: 'all',
          }}
          className="nodrag nopan group flex items-center gap-1"
          onDoubleClick={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
        >
          {editing ? (
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => commit(draft)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commit(draft);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setEditing(false);
                  setDraft(label);
                }
                e.stopPropagation();
              }}
              placeholder="label"
              maxLength={24}
              className="rounded-full border border-accent/60 bg-surface px-2 py-0.5 text-[10px] text-text-primary outline-none shadow-card"
              style={{ width: '7rem' }}
            />
          ) : xray ? (
            <span
              role="button"
              tabIndex={0}
              title={label ? `${label} · ${xray.tokenLabel} · ${xray.costLabel}` : `${xray.tokenLabel} · ${xray.costLabel}`}
              className={clsx(
                'inline-flex max-w-[12rem] items-center gap-1 rounded-full border bg-surface px-2 py-0.5 font-mono text-[10px] transition',
                selected
                  ? 'border-accent/70 text-accent shadow-glow'
                  : 'border-accent/40 text-accent hover:border-accent/70',
              )}
            >
              {label && <span className="max-w-[4rem] truncate text-text-muted">{label}</span>}
              <span>{xray.tokenLabel}</span>
              <span className="text-text-muted">·</span>
              <span>{xray.costLabel}</span>
            </span>
          ) : label ? (
            <span
              role="button"
              tabIndex={0}
              title="Double-click to rename"
              className={clsx(
                'inline-flex max-w-[9rem] items-center rounded-full border bg-surface px-1.5 py-px text-[9.5px] tracking-tight transition',
                selected
                  ? 'border-accent/60 text-accent shadow-glow'
                  : 'border-line text-text-muted hover:border-accent/40 hover:text-text-primary',
              )}
            >
              <span className="truncate">{label}</span>
            </span>
          ) : (
            // Tiny invisible affordance so users can still double-click an
            // unlabelled edge near its midpoint to add a label.
            <span
              role="button"
              tabIndex={0}
              aria-label="Add edge label"
              title="Double-click to add label"
              className="block h-3 w-6 rounded-full border border-dashed border-line/60 bg-surface/40 opacity-0 transition group-hover:opacity-100"
            />
          )}
          {onDelete && !editing && (
            <button
              type="button"
              aria-label="Delete connection"
              title="Delete connection"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(id);
              }}
              className={clsx(
                'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border bg-surface text-[11px] leading-none transition',
                selected
                  ? 'border-danger text-danger opacity-100'
                  : 'border-line text-text-muted opacity-0 group-hover:opacity-100 hover:border-danger hover:text-danger',
              )}
            >
              ×
            </button>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
