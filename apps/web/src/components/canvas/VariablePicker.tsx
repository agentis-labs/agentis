import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { buildNodeAliasMap } from '@agentis/core';
import { nodeKindIcon } from './nodeKindIcon';
import { Zap } from 'lucide-react';

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
  /** Node kind (or `'trigger'`) — picks the group icon. Absent for non-node namespaces. */
  kind?: string;
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
 * Node id -> readable title-slug, for every node whose slug is unambiguous
 * within `nodes`. The engine builds this exact map (`buildNodeAliasMap`) to
 * resolve `{{nodes.<slug>...}}`, so inserting the slug here always works.
 */
export function slugForNode(nodes: ReadonlyArray<{ id: string; title?: string | null }>): Map<string, string> {
  const alias = buildNodeAliasMap(nodes);
  const slugOf = new Map<string, string>();
  for (const [slug, id] of Object.entries(alias)) slugOf.set(id, slug);
  return slugOf;
}

/**
 * Build the full option list. Caller composes upstream + extras. The picker
 * filters them by the current query (everything after `{{` up to the caret).
 */
export function buildVariableOptions(upstream: UpstreamNode[], extras?: VariablePickerOption[]): VariablePickerOption[] {
  const slugOf = slugForNode(upstream);
  const out: VariablePickerOption[] = [
    { path: 'trigger', label: 'trigger', origin: 'trigger', hint: 'the inputs that started this run', kind: 'trigger' },
  ];
  for (const node of upstream) {
    const key = slugOf.get(node.id) ?? node.id;
    out.push({
      path: `nodes.${key}`,
      label: `nodes.${key}`,
      origin: node.title || node.id,
      hint: `outputs of ${node.type}`,
      kind: node.type,
    });
    for (const outKey of node.outputKeys ?? []) {
      out.push({
        path: `nodes.${key}.${outKey}`,
        label: `nodes.${key}.${outKey}`,
        origin: node.title || node.id,
        hint: outKey,
        kind: node.type,
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
        {filtered.map((option, idx) => {
          // Entries are already grouped by origin (trigger first, then each
          // node's bare reference followed by its output keys) — a header at
          // every origin boundary reads as sections without re-sorting anything.
          const showHeader = idx === 0 || filtered[idx - 1]!.origin !== option.origin;
          const isSubItem = !showHeader;
          const Icon = option.kind === 'trigger' ? Zap : nodeKindIcon(option.kind);
          return (
            <li key={option.path}>
              {showHeader && (
                <div className="mt-1 flex items-center gap-1.5 px-2 pb-0.5 pt-1.5 text-[10px] font-medium text-text-muted first:mt-0">
                  <Icon size={11} className="shrink-0" />
                  <span className="truncate">{option.origin}</span>
                </div>
              )}
              <div
                className={clsx(
                  'flex cursor-pointer items-center gap-2 py-1 pr-2 text-[12px] hover:bg-surface-2',
                  isSubItem ? 'pl-6' : 'pl-2',
                  idx === activeIndex && 'bg-surface-2',
                )}
                onMouseEnter={() => setActiveIndex(idx)}
                onMouseDown={(e) => {
                  e.preventDefault(); // keep focus on the textarea
                  commit(option);
                }}
              >
                <span className="truncate font-mono text-text-primary">{`{{${option.label}}}`}</span>
                {option.hint && isSubItem && <span className="shrink-0 truncate text-[10px] text-text-muted">{option.hint}</span>}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}



