import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Search, X } from 'lucide-react';
import type { BrainNode } from '@agentis/core';

export function CanvasSearch({
  value,
  onChange,
  results,
  onSelect,
}: {
  value: string;
  onChange: (value: string) => void;
  results: BrainNode[];
  onSelect: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (expanded) inputRef.current?.focus();
  }, [expanded]);

  function close() {
    onChange('');
    setExpanded(false);
  }

  return (
    <div className="absolute right-3 top-3 z-30">
      <div className={clsx('flex h-10 items-center rounded-btn border border-line bg-surface/90 shadow-card backdrop-blur-md transition-all', expanded ? 'w-72 px-2' : 'w-10 justify-center')}>
        {!expanded ? (
          <button type="button" aria-label="Search the brain" onClick={() => setExpanded(true)} className="flex h-full w-full items-center justify-center text-text-secondary hover:text-text-primary">
            <Search size={15} />
          </button>
        ) : (
          <>
            <Search size={14} className="mr-2 shrink-0 text-text-muted" />
            <input
              ref={inputRef}
              type="text"
              value={value}
              onChange={(event) => onChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') close();
                if (event.key === 'Enter' && results[0]) {
                  onSelect(results[0].id);
                  close();
                }
              }}
              placeholder="Search the brain"
              className="min-w-0 flex-1 bg-transparent text-[12px] text-text-primary placeholder:text-text-muted focus:outline-none"
            />
            <button type="button" aria-label="Close search" onClick={close} className="ml-1 text-text-muted hover:text-text-primary">
              <X size={13} />
            </button>
          </>
        )}
      </div>
      {expanded && value.trim() && results.length > 0 && (
        <div className="mt-1 w-72 overflow-hidden rounded-card border border-line bg-surface shadow-dropdown">
          {results.map((node) => (
            <button
              type="button"
              key={node.id}
              onClick={() => { onSelect(node.id); close(); }}
              className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[12px] hover:bg-surface-2"
            >
              <span className="text-[10px] uppercase tracking-wider text-text-muted">{node.layer}</span>
              <span className="truncate text-text-primary">{node.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}



