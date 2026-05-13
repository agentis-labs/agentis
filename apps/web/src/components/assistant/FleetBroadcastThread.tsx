import { useState } from 'react';
import { Send } from 'lucide-react';
import { api } from '../../lib/api';
import { useToast } from '../shared/Toast';

interface BroadcastAgent {
  id: string;
  name: string;
  status: string;
  isPaused?: boolean | null;
}

export function FleetBroadcastThread({ agents, onDone }: { agents: BroadcastAgent[]; onDone?: () => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<string[]>([]);
  const eligible = agents.filter((agent) => agent.status !== 'offline' && agent.status !== 'error' && !agent.isPaused);

  async function send() {
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    const results: string[] = [];
    await Promise.all(agents.map(async (agent) => {
      if (!eligible.some((candidate) => candidate.id === agent.id)) {
        results.push(`${agent.name} skipped`);
        return;
      }
      try {
        await api(`/v1/conversations/${agent.id}/send`, { method: 'POST', body: JSON.stringify({ body }) });
        results.push(`${agent.name} replied pending`);
      } catch {
        results.push(`${agent.name} failed`);
      }
    }));
    setSummary(results);
    setDraft('');
    setBusy(false);
    toast.success('Fleet broadcast sent', `${eligible.length} agents received the message.`);
    onDone?.();
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-line bg-surface-2/60 px-3 py-2 text-xs text-text-muted">
        Fleet broadcast · {eligible.length} live recipients
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-auto p-3 text-xs">
        {summary.length === 0 ? <div className="text-text-muted">Send one message to every live, non-standby agent.</div> : summary.map((item) => <div key={item} className="rounded-md border border-line bg-surface-2 px-2 py-1.5">{item}</div>)}
      </div>
      <div className="flex items-center gap-2 border-t border-line bg-surface p-2">
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Broadcast to fleet…" className="flex-1 rounded-md border border-line bg-canvas px-2.5 py-1.5 text-xs outline-none focus:border-accent" />
        <button type="button" disabled={busy || !draft.trim()} onClick={() => void send()} className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-canvas disabled:opacity-40" aria-label="Send broadcast">
          <Send size={12} />
        </button>
      </div>
    </div>
  );
}