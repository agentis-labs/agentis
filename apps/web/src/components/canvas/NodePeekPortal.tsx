/**
 * NodePeekPortal — ENGINE-10X §12.1. Single floating tooltip that follows the
 * pointer when it hovers a node element. Pulls the per-node activity tail from
 * the `liveNodeTail` ring buffer so the user can answer "what is this node
 * doing right now" without opening the inspector.
 *
 * Lightweight: one global mouseover listener walks `event.target.closest`
 * looking for `[data-node-id]`. Tail fetches are debounced (200ms) and
 * cancelled when the cursor leaves.
 */

import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Activity, Cpu, Sparkles, Wrench } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api } from '../../lib/api';

interface TailEntry {
  at: string;
  kind: 'thinking' | 'tool_call' | 'progress' | 'log' | 'cache' | 'retry';
  text: string;
}

const KIND_ICON: Record<TailEntry['kind'], LucideIcon> = {
  thinking: Sparkles,
  tool_call: Wrench,
  progress: Activity,
  log: Cpu,
  cache: Cpu,
  retry: Activity,
};

export function NodePeekPortal({ runId }: { runId: string | null }) {
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [tail, setTail] = useState<TailEntry[]>([]);
  const fetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      const host = target?.closest?.('[data-node-id]') as HTMLElement | null;
      const id = host?.getAttribute('data-node-id') ?? null;
      if (id !== activeNodeId) {
        setActiveNodeId(id);
        setTail([]);
      }
      if (id) setPos({ x: e.clientX + 16, y: e.clientY + 16 });
    }
    function onLeave() {
      setActiveNodeId(null);
      setTail([]);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseleave', onLeave);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseleave', onLeave);
    };
  }, [activeNodeId]);

  useEffect(() => {
    if (!runId || !activeNodeId) return;
    if (fetchTimer.current) clearTimeout(fetchTimer.current);
    fetchTimer.current = setTimeout(() => {
      void api<{ tail: TailEntry[] }>(`/v1/runs/${runId}/nodes/${activeNodeId}/tail`)
        .then((res) => setTail(res.tail ?? []))
        .catch(() => setTail([]));
    }, 200);
    return () => {
      if (fetchTimer.current) clearTimeout(fetchTimer.current);
    };
  }, [runId, activeNodeId]);

  if (!activeNodeId || !runId) return null;
  return (
    <div
      role="tooltip"
      className="pointer-events-none fixed z-50 max-w-sm rounded-md border border-line bg-surface px-2.5 py-2 text-[11px] text-text-primary shadow-card"
      style={{ left: pos.x, top: pos.y }}
    >
      <div className="mb-1 flex items-center justify-between gap-2 border-b border-line/60 pb-1">
        <span className="truncate font-mono text-[10px] text-accent">{activeNodeId}</span>
        <span className="text-[10px] text-text-muted">live tail</span>
      </div>
      {tail.length === 0 ? (
        <p className="text-text-muted">No recent activity.</p>
      ) : (
        <ul className="space-y-1">
          {tail.slice(-6).map((entry, i) => {
            const Icon = KIND_ICON[entry.kind] ?? Activity;
            return (
              <li
                key={`${entry.at}-${i}`}
                className={clsx(
                  'flex items-start gap-1.5 leading-tight',
                  entry.kind === 'cache' && 'text-cyan-300',
                  entry.kind === 'retry' && 'text-amber-300',
                )}
              >
                <Icon size={10} />
                <span className="truncate">{entry.text}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
