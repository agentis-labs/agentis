/**
 * Run Drawer — V1-SPEC §13.5 + §13.9.
 *
 * Bottom-docked tabbed drawer that surfaces the active run's:
 *   - Ledger      — append-only event log per run (LEDGER_PAGE_SIZE)
 *   - Scratchpad  — typed key/value store the run's agents read/write
 *   - Replay      — scrub through the run's normalized event stream
 *
 * Visible when a run is active or when the user clicks a node with a recent
 * run; collapsed otherwise.
 */

import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { api } from '../../lib/api';

type Tab = 'ledger' | 'scratchpad' | 'replay';

interface LedgerEntry {
  id: string;
  type: string;
  summary: string;
  createdAt: string;
}

interface ScratchpadEntry {
  key: string;
  value: unknown;
  updatedAt: string;
}

export function RunDrawer({
  runId,
  open,
  onClose,
}: {
  runId: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>('ledger');
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [scratch, setScratch] = useState<ScratchpadEntry[]>([]);

  useEffect(() => {
    if (!open || !runId) return;
    void api<{ entries: LedgerEntry[] }>(`/v1/runs/${runId}/ledger`)
      .then((d) => setLedger(d.entries))
      .catch(() => setLedger([]));
    void api<{ entries: ScratchpadEntry[] }>(`/v1/runs/${runId}/scratchpad`)
      .then((d) => setScratch(d.entries))
      .catch(() => setScratch([]));
  }, [runId, open, tab]);

  if (!open) return null;

  return (
    <div className="absolute inset-x-0 bottom-0 z-30 flex h-72 flex-col border-t border-line bg-surface text-xs shadow-card">
      <header className="flex items-center justify-between border-b border-line px-3 py-2">
        <div className="flex items-center gap-2">
          {(['ledger', 'scratchpad', 'replay'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={clsx(
                'rounded px-2 py-0.5 text-[11px] uppercase tracking-wider',
                t === tab ? 'bg-surface-2 text-accent' : 'text-text-muted hover:text-text-primary',
              )}
            >
              {t}
            </button>
          ))}
          {runId && (
            <span className="ml-2 font-mono text-[10px] text-text-muted">
              run {runId.slice(0, 8)}
            </span>
          )}
        </div>
        <button onClick={onClose} className="text-text-muted hover:text-accent">
          ×
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {!runId && <div className="text-text-muted">No run selected.</div>}
        {runId && tab === 'ledger' && (
          <ul className="space-y-1">
            {ledger.length === 0 && <li className="text-text-muted">No ledger entries yet.</li>}
            {ledger.map((l) => (
              <li key={l.id} className="flex items-baseline gap-2">
                <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
                  {l.type}
                </span>
                <span className="flex-1 truncate">{l.summary}</span>
                <span className="text-[10px] text-text-muted">
                  {new Date(l.createdAt).toLocaleTimeString()}
                </span>
              </li>
            ))}
          </ul>
        )}
        {runId && tab === 'scratchpad' && (
          <ul className="space-y-1.5">
            {scratch.length === 0 && <li className="text-text-muted">Scratchpad is empty.</li>}
            {scratch.map((s) => (
              <li key={s.key} className="rounded border border-line bg-surface-2 p-2">
                <div className="font-mono text-[11px] text-accent">{s.key}</div>
                <pre className="mt-1 whitespace-pre-wrap break-all text-[11px]">
                  {JSON.stringify(s.value, null, 2)}
                </pre>
              </li>
            ))}
          </ul>
        )}
        {runId && tab === 'replay' && (
          <div className="text-text-muted">
            Replay scrubber renders inside the canvas; use ←/→ keys to step events.
          </div>
        )}
      </div>
    </div>
  );
}
