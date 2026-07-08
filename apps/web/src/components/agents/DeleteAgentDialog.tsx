

import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { api, apiErrorMessage } from '../../lib/api';
import { deleteAgentWithMemory, type MemoryDisposition } from '../../lib/agentImport';
import { Button } from '../shared/Button';

interface AgentLite { id: string; name: string }

export function DeleteAgentDialog({ agent, allAgents, onClose, onDeleted }: {
  agent: AgentLite;
  allAgents: AgentLite[];
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [memCount, setMemCount] = useState<number | null>(null);
  const [disposition, setDisposition] = useState<MemoryDisposition>('promote');
  const [target, setTarget] = useState<string>('');
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const others = allAgents.filter((a) => a.id !== agent.id);

  useEffect(() => {
    let cancelled = false;
    void api<{ entries: unknown[] }>(`/v1/brain/agents/${agent.id}/memory`)
      .then((d) => { if (!cancelled) setMemCount((d.entries ?? []).length); })
      .catch(() => { if (!cancelled) setMemCount(0); });
    return () => { cancelled = true; };
  }, [agent.id]);

  async function run() {
    if (confirmText !== agent.name) return;
    if (disposition === 'transfer' && !target) { setError('Choose an agent to move the memories to.'); return; }
    setBusy(true); setError(null);
    try {
      await deleteAgentWithMemory(agent.id, disposition, disposition === 'transfer' ? target : undefined);
      onDeleted();
    } catch (e) {
      setError(apiErrorMessage(e));
      setBusy(false);
    }
  }

  const hasMemory = (memCount ?? 0) > 0;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-overlay p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-md rounded-lg border border-line bg-surface p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <AlertTriangle size={18} className="text-danger" />
          <h2 className="text-heading text-text-primary">Delete “{agent.name}??</h2>
        </div>
        <p className="mt-2 text-[13px] text-text-secondary">
          The agent is removed from this workspace. {memCount === null
            ? <span className="inline-flex items-center gap-1 text-text-muted"><Loader2 size={11} className="animate-spin" /> checking memory…</span>
            : hasMemory
              ? <>It carries <b className="text-text-primary">{memCount}</b> {memCount === 1 ? 'memory' : 'memories'} — choose what happens to them.</>
              : <>It has no personal memory to preserve.</>}
        </p>

        {hasMemory && (
          <div className="mt-3 space-y-2">
            <DispoOption value="promote" checked={disposition === 'promote'} onSelect={setDisposition}
              title="Keep in the workspace Brain" body="Memories stay available to the workspace (recommended)." />
            <DispoOption value="transfer" checked={disposition === 'transfer'} onSelect={setDisposition}
              title="Move to another agent" body="Reassign the memories to a specific agent." disabled={others.length === 0}>
              {disposition === 'transfer' && (
                <select value={target} onChange={(e) => setTarget(e.target.value)}
                  className="mt-2 w-full rounded-md border border-line bg-bg px-2 py-1.5 text-[13px]" aria-label="Target agent">
                  <option value="">Select an agent…</option>
                  {others.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              )}
            </DispoOption>
            <DispoOption value="delete" checked={disposition === 'delete'} onSelect={setDisposition}
              title="Delete the memories" body="Permanently remove everything this agent remembered." />
          </div>
        )}

        <label className="mt-4 block text-[12px] text-text-muted">Type <b className="text-text-primary">{agent.name}</b> to confirm</label>
        <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)}
          className="mt-1 w-full rounded-md border border-line bg-bg px-2 py-1.5 text-[13px]" aria-label="Confirm agent name" />

        {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button size="sm" variant="danger" loading={busy} disabled={confirmText !== agent.name} onClick={() => void run()}>
            Delete agent
          </Button>
        </div>
      </div>
    </div>
  );
}

function DispoOption({ value, checked, onSelect, title, body, disabled, children }: {
  value: MemoryDisposition; checked: boolean; onSelect: (v: MemoryDisposition) => void;
  title: string; body: string; disabled?: boolean; children?: React.ReactNode;
}) {
  return (
    <label className={`block rounded-md border p-2.5 ${checked ? 'border-accent bg-accent/5' : 'border-line'} ${disabled ? 'opacity-50' : 'cursor-pointer'}`}>
      <span className="flex items-start gap-2">
        <input type="radio" name="memory-disposition" className="mt-0.5" checked={checked} disabled={disabled} onChange={() => onSelect(value)} />
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium text-text-primary">{title}</span>
          <span className="block text-[12px] text-text-muted">{body}</span>
          {children}
        </span>
      </span>
    </label>
  );
}



