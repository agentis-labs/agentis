import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { PALETTE_NODES, type PaletteNodeType } from './NodePalette';

/**
 * NodeCommandPalette â€” Cmd/Ctrl+K modal for fast node insertion.
 *
 * Surfaces:
 *   - every node kind from the palette (curated, validated)
 *   - reusable subflow workflows
 *   - installed Extensions
 *   - integration connectors (each operation listed individually)
 *
 * Picking a result fires `onPick(type, defaults)` which the canvas turns into
 * a node drop at the current cursor or the center of the viewport.
 */

export interface CommandOption {
  /** Unique key for React. */
  key: string;
  /** Engine node kind (`agent_task`, `extension_task`, `integration`, â€¦). */
  type: string;
  label: string;
  description: string;
  category: 'Nodes' | 'Extensions' | 'Subflows' | 'Integrations';
  glyph?: string;
  defaults?: Record<string, unknown>;
}

export interface NodeCommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onPick: (type: string, defaults?: Record<string, unknown>) => void;
  /** Live subflows pulled from the API. */
  subflows?: Array<{ id: string; title: string }>;
  /** Live Extensions pulled from the API. */
  extensions?: Array<{ id: string; name: string; description?: string }>;
  /** Live integration operations from ConnectorRegistry. */
  integrations?: Array<{ service: string; name: string; operations: readonly string[]; icon?: string }>;
}

export function NodeCommandPalette(props: NodeCommandPaletteProps) {
  const { open, onClose, onPick, subflows = [], extensions = [], integrations = [] } = props;
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset state on open/close.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      // Defer focus until the input is mounted.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const options = useMemo<CommandOption[]>(() => {
    const out: CommandOption[] = [];
    for (const node of PALETTE_NODES as PaletteNodeType[]) {
      out.push({
        key: `node:${node.type}`,
        type: node.type,
        label: node.label,
        description: node.description,
        category: 'Nodes',
        glyph: node.glyph,
        defaults: node.defaults,
      });
    }
    for (const extension of extensions) {
      out.push({
        key: `extension:${extension.id}`,
        type: 'extension_task',
        label: extension.name,
        description: extension.description ?? 'Run a typed deterministic extension',
        category: 'Extensions',
        glyph: 'âœ¦',
        defaults: { extensionId: extension.id, inputMapping: {}, outputMapping: {} },
      });
    }
    for (const sub of subflows) {
      out.push({
        key: `sub:${sub.id}`,
        type: 'subflow',
        label: sub.title || 'Untitled workflow',
        description: 'Embed this workflow as a subflow',
        category: 'Subflows',
        glyph: 'â–¦',
        defaults: { workflowId: sub.id, inputMapping: {}, outputMapping: {} },
      });
    }
    for (const integration of integrations) {
      for (const operation of integration.operations) {
        out.push({
          key: `int:${integration.service}:${operation}`,
          type: 'integration',
          label: `${integration.name} â€” ${operation}`,
          description: `${integration.name} ${operation} operation`,
          category: 'Integrations',
          glyph: integration.icon ?? 'âš™',
          defaults: { integrationId: integration.service, operationId: operation, inputs: {} },
        });
      }
    }
    return out;
  }, [extensions, subflows, integrations]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options.slice(0, 40);
    return options
      .filter((opt) => opt.label.toLowerCase().includes(q) || opt.description.toLowerCase().includes(q))
      .slice(0, 40);
  }, [options, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, filtered.length]);

  if (!open) return null;

  function commit(opt: CommandOption) {
    onPick(opt.type, opt.defaults);
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && filtered[activeIndex]) {
      e.preventDefault();
      commit(filtered[activeIndex]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  // Group filtered results by category for the rendered list while keeping a
  // single flat `activeIndex` that maps to the index in `filtered`.
  const groups = useMemo(() => {
    const map = new Map<CommandOption['category'], CommandOption[]>();
    for (const opt of filtered) {
      const arr = map.get(opt.category) ?? [];
      arr.push(opt);
      map.set(opt.category, arr);
    }
    return [...map.entries()];
  }, [filtered]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-canvas/60 backdrop-blur-sm"
      onClick={onClose}
      onKeyDown={onKeyDown}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="mt-32 w-[560px] overflow-hidden rounded-card border border-line bg-surface shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-line/60 px-3 py-2">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search nodes, Extensions, integrationsâ€¦"
            className="w-full bg-transparent text-[14px] text-text-primary placeholder:text-text-muted focus:outline-none"
          />
        </div>
        <div className="max-h-96 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-[12px] text-text-muted">No matches.</div>
          ) : (
            groups.map(([category, items]) => (
              <div key={category}>
                <div className="border-b border-line/40 bg-surface-2 px-3 py-1 text-[10px] uppercase tracking-wider text-text-muted">
                  {category}
                </div>
                {items.map((opt) => {
                  const flatIndex = filtered.indexOf(opt);
                  const isActive = flatIndex === activeIndex;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      onMouseEnter={() => setActiveIndex(flatIndex)}
                      onClick={() => commit(opt)}
                      className={clsx(
                        'flex w-full items-start gap-3 px-3 py-2 text-left transition-colors',
                        isActive ? 'bg-surface-2' : 'hover:bg-surface-2/60',
                      )}
                    >
                      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-canvas text-sm">
                        {opt.glyph ?? 'â€¢'}
                      </span>
                      <span className="min-w-0 flex-1">
                        <div className="truncate text-[13px] text-text-primary">{opt.label}</div>
                        <div className="truncate text-[11px] text-text-muted">{opt.description}</div>
                      </span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <div className="flex items-center justify-between border-t border-line/60 bg-surface-2 px-3 py-1.5 text-[10px] text-text-muted">
          <span>â†‘â†“ navigate</span>
          <span>â†µ pick Â· Esc close</span>
        </div>
      </div>
    </div>
  );
}



