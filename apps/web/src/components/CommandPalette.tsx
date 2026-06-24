/**
 * Cmd+K command palette.
 *
 * Opens on ⌘K / Ctrl+K. Queries /v1/command/search and navigates to the
 * selected result's href. Backed by CommandIndex (workflows, agents,
 * gateways, runs, approvals, extensions, conversations).
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';

interface Hit {
  type: 'app' | 'workflow' | 'agent' | 'gateway' | 'run' | 'approval' | 'extension' | 'conversation';
  id: string;
  title: string;
  subtitle?: string;
  href: string;
  score: number;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const nav = useNavigate();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === 'Escape') {
        setOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!open) {
      setQ('');
      setHits([]);
      setActive(0);
      return;
    }
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const query = q.trim();
    if (query.length < 2) {
      setHits([]);
      setActive(0);
      return;
    }
    const handle = setTimeout(async () => {
      try {
        const r = await api<{ hits: Hit[] }>(`/v1/command/search?q=${encodeURIComponent(query)}`);
        setHits(r.hits.slice(0, 12));
        setActive(0);
      } catch {
        setHits([]);
      }
    }, 180);
    return () => clearTimeout(handle);
  }, [q, open]);

  if (!open) return null;

  function go(h: Hit) {
    setOpen(false);
    nav(h.href);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-overlay pt-24"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-2xl border border-line bg-surface shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, hits.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              const hit = hits[active];
              if (hit) go(hit);
            }
          }}
          placeholder="Search apps, agents, workflows, runs, approvals…"
          className="w-full border-b border-line bg-transparent px-4 py-3 text-sm outline-none"
        />
        <div className="max-h-80 overflow-auto">
          {hits.length === 0 && (
            <div className="px-4 py-6 text-center text-xs text-text-muted">
              {q ? 'No matches' : 'Start typing to search.'}
            </div>
          )}
          {hits.map((h, i) => (
            <button
              key={`${h.type}:${h.id}`}
              onClick={() => go(h)}
              onMouseEnter={() => setActive(i)}
              className={`flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm ${
                i === active ? 'bg-surface-2 text-accent' : 'hover:bg-surface-2'
              }`}
            >
              <div className="min-w-0">
                <div className="truncate">{h.title}</div>
                {h.subtitle && <div className="truncate text-xs text-text-muted">{h.subtitle}</div>}
              </div>
              <span className="text-[10px] uppercase tracking-wide text-text-muted">{h.type}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center justify-between border-t border-line px-4 py-2 text-[10px] text-text-muted">
          <span>↑↓ navigate · ↵ open · esc close</span>
          <span>⌘K</span>
        </div>
      </div>
    </div>
  );
}
