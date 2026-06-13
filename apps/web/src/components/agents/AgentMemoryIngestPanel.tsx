/**
 * AgentMemoryIngestPanel — the agent's "transition into Agentis"
 * (UNIVERSAL-HARNESS §5.1). Scans the connected harness's own memory
 * (CLAUDE.md, AGENTS.md, .cursorrules…), shows quality-gated candidates with
 * their dedup verdict, and imports the operator-approved subset into the
 * agent's Brain. Preview → review → commit, so nothing lands unseen.
 */

import { useState } from 'react';
import { Sparkles, Check, AlertCircle } from 'lucide-react';
import { previewHarnessMemory, commitHarnessMemory, type IngestCandidate } from '../../lib/connections';
import { apiErrorMessage } from '../../lib/api';
import { Button } from '../shared/Button';

export function AgentMemoryIngestPanel({ agentId, onImported }: { agentId: string; onImported?: () => void }) {
  const [candidates, setCandidates] = useState<IngestCandidate[] | null>(null);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imported, setImported] = useState<number | null>(null);

  async function scan() {
    setScanning(true); setError(null); setImported(null);
    try {
      const preview = await previewHarnessMemory(agentId);
      setCandidates(preview.candidates);
      // Pre-select the new (non-duplicate) candidates.
      setAccepted(new Set(preview.candidates.filter((c) => !c.duplicateOf).map((c) => c.hash)));
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setScanning(false);
    }
  }

  async function commit() {
    setImporting(true); setError(null);
    try {
      const res = await commitHarnessMemory(agentId, [...accepted]);
      setImported(res.written + res.reinforced);
      setCandidates(null);
      setAccepted(new Set());
      onImported?.();
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setImporting(false);
    }
  }

  function toggle(hash: string) {
    setAccepted((prev) => {
      const next = new Set(prev);
      if (next.has(hash)) next.delete(hash); else next.add(hash);
      return next;
    });
  }

  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Sparkles size={16} className="text-accent" />
          <div>
            <h3 className="text-subheading text-text-primary">Transition harness memory</h3>
            <p className="text-[12px] text-text-muted">Distil what this agent already knew (CLAUDE.md, AGENTS.md, .cursorrules…) into its Brain.</p>
          </div>
        </div>
        <Button size="sm" variant="secondary" onClick={() => void scan()} loading={scanning} aria-label="Scan harness memory">
          Scan
        </Button>
      </div>

      {error && <p className="mt-2 flex items-center gap-1 text-[12px] text-danger"><AlertCircle size={13} /> {error}</p>}
      {imported !== null && (
        <p className="mt-2 flex items-center gap-1 text-[12px] text-success"><Check size={13} /> Imported {imported} memor{imported === 1 ? 'y' : 'ies'} into the Brain.</p>
      )}

      {candidates && (
        candidates.length === 0 ? (
          <p className="mt-3 text-[13px] text-text-muted">No new harness memory found to import.</p>
        ) : (
          <div className="mt-3 space-y-2">
            <ul className="max-h-72 space-y-1.5 overflow-y-auto">
              {candidates.map((c) => (
                <li key={c.hash} className="flex items-start gap-2 rounded border border-line bg-bg p-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={accepted.has(c.hash)}
                    onChange={() => toggle(c.hash)}
                    aria-label={`Import: ${c.title}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[11px] text-text-muted">
                      <span className="rounded bg-surface px-1.5 py-0.5">{c.section}</span>
                      <span title="quality score">q{Math.round(c.quality * 100)}</span>
                      {c.duplicateOf && <span className="text-warn" title={`already known (${c.duplicateOf.kind})`}>already known</span>}
                      <span className="ml-auto truncate">{c.origin.fileName}</span>
                    </div>
                    <div className="mt-0.5 text-[13px] text-text-secondary">{c.summary}</div>
                  </div>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between">
              <span className="text-[12px] text-text-muted">{accepted.size} selected of {candidates.length}</span>
              <Button size="sm" onClick={() => void commit()} loading={importing} disabled={accepted.size === 0} aria-label="Import selected memories">
                Import selected
              </Button>
            </div>
          </div>
        )
      )}
    </div>
  );
}
