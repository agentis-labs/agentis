import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';

/**
 * VariablePicker — autocomplete combobox for `{{...}}` template references.
 *
 * Renders as a portal anchored to the active text field. Walks the workflow
 * graph topology to find every node upstream of the current selection and
 * surfaces their output keys plus the standard namespaces (trigger, scratchpad,
 * store, loop).
 *
 * Used by every form field that accepts a template — agent prompts, HTTP URLs
 * and bodies, transform expressions, evaluator targets, workflow_store keys,
 * etc. Wiring it once in `<TextField hasVariablePicker>` is the future
 * end-state; this lower-level API exposes the dropdown so individual forms
 * can adopt it incrementally.
 */

export interface UpstreamNode {
  id: string;
  title: string;
  type: string;
  /** Known output keys for this node — depends on node kind. */
  outputKeys?: string[];
}

export interface VariablePickerOption {
  /** What gets inserted (without the `{{...}}` wrapping). */
  path: string;
  /** What the user sees in the dropdown. */
  label: string;
  /** Origin badge (`trigger`, `scratchpad`, the node title…). */
  origin: string;
  /** Optional preview of the inferred type. */
  hint?: string;
}

export interface VariablePickerProps {
  /** Current text-field value. */
  value: string;
  /** Set on every keystroke. */
  onChange: (next: string) => void;
  /** Insertion point — the index right after `{{` that started the picker. */
  caret: number;
  /** Upstream nodes for the current selection, topologically ordered. */
  upstream: UpstreamNode[];
  /** Extra known namespaces — primarily `scratchpad`/`store` keys. */
  extras?: VariablePickerOption[];
  /** Called when the user dismisses without picking (Escape, blur). */
  onDismiss?: () => void;
  /** Optional class for the popover. */
  className?: string;
}

/**
 * Build the full option list. Caller composes upstream + extras. The picker
 * filters them by the current query (everything after `{{` up to the caret).
 */
export function buildVariableOptions(upstream: UpstreamNode[], extras?: VariablePickerOption[]): VariablePickerOption[] {
  const out: VariablePickerOption[] = [
    { path: 'trigger', label: 'trigger', origin: 'trigger', hint: 'the inputs that started this run' },
  ];
  for (const node of upstream) {
    out.push({
      path: `nodes.${node.id}`,
      label: `nodes.${node.id}`,
      origin: node.title || node.id,
      hint: `outputs of ${node.type}`,
    });
    for (const key of node.outputKeys ?? []) {
      out.push({
        path: `nodes.${node.id}.${key}`,
        label: `nodes.${node.id}.${key}`,
        origin: node.title || node.id,
        hint: key,
      });
    }
  }
  if (extras) out.push(...extras);
  return out;
}

export function VariablePicker(props: VariablePickerProps) {
  const { value, onChange, caret, upstream, extras, onDismiss, className } = props;
  const [activeIndex, setActiveIndex] = useState(0);
  const ref = useRef<HTMLDivElement | null>(null);

  // Compute the query: everything between the last `{{` and the caret.
  const query = useMemo(() => {
    const before = value.slice(0, caret);
    const open = before.lastIndexOf('{{');
    if (open === -1) return '';
    return before.slice(open + 2);
  }, [value, caret]);

  const options = useMemo(() => buildVariableOptions(upstream, extras), [upstream, extras]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options.slice(0, 30);
    return options
      .filter((opt) => opt.path.toLowerCase().includes(q) || opt.label.toLowerCase().includes(q))
      .slice(0, 30);
  }, [options, query]);

  // Reset highlight when filtered list changes.
  useEffect(() => {
    setActiveIndex(0);
  }, [filtered.length, query]);

  function commit(option: VariablePickerOption) {
    // Replace the query (everything from the most recent `{{` through caret)
    // with `{{<picked-path>}}`. Place the new caret AFTER the closing braces.
    const before = value.slice(0, caret);
    const after = value.slice(caret);
    const open = before.lastIndexOf('{{');
    const prefix = open === -1 ? before : before.slice(0, open);
    const inserted = `{{${option.path}}}`;
    onChange(prefix + inserted + after);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      if (filtered[activeIndex]) {
        e.preventDefault();
        commit(filtered[activeIndex]);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onDismiss?.();
    }
  }

  if (filtered.length === 0) return null;

  return (
    <div
      ref={ref}
      onKeyDown={onKeyDown}
      tabIndex={0}
      className={clsx(
        'z-50 max-h-72 w-80 overflow-y-auto rounded-md border border-line bg-surface shadow-lg',
        className,
      )}
    >
      <div className="border-b border-line/60 bg-surface-2 px-2 py-1 text-[10px] uppercase tracking-wider text-text-muted">
        Variables
        {query && <span className="ml-1 normal-case tracking-normal text-text-secondary">— filter: {query}</span>}
      </div>
      <ul className="py-1">
        {filtered.map((option, idx) => (
          <li
            key={option.path}
            className={clsx(
              'flex cursor-pointer items-center justify-between gap-2 px-2 py-1 text-[12px] hover:bg-surface-2',
              idx === activeIndex && 'bg-surface-2',
            )}
            onMouseEnter={() => setActiveIndex(idx)}
            onMouseDown={(e) => {
              e.preventDefault(); // keep focus on the textarea
              commit(option);
            }}
          >
            <span className="truncate font-mono text-text-primary">{`{{${option.label}}}`}</span>
            <span className="shrink-0 text-[10px] text-text-muted">{option.origin}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}



