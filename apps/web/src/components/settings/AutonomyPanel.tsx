/**
 * AutonomyPanel — Settings → Workspace.
 *
 * Per-workspace opt-in for the autonomous Command Heartbeat (AUTONOMOUS-
 * ORCHESTRATOR-COMMAND-MODEL Layer C). Autonomy is only EFFECTIVE when BOTH the
 * deployment master (env AGENTIS_COMMAND_AUTONOMY) AND this per-workspace switch
 * are on — so the toggle is disabled with an explainer when the master is off.
 */

import { useEffect, useState } from 'react';
import { Radar, AlertCircle } from 'lucide-react';
import { api, apiErrorMessage } from '../../lib/api';
import { useToast } from '../shared/Toast';

interface AutonomyState { enabled: boolean; master: boolean; effective: boolean }

export function AutonomyPanel() {
  const toast = useToast();
  const [state, setState] = useState<AutonomyState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api<AutonomyState>('/v1/command/autonomy')
      .then((s) => { if (!cancelled) setState(s); })
      .catch((e) => { if (!cancelled) setError(apiErrorMessage(e)); });
    return () => { cancelled = true; };
  }, []);

  async function toggle() {
    if (!state) return;
    setSaving(true); setError(null);
    try {
      const next = await api<AutonomyState>('/v1/command/autonomy', {
        method: 'PUT',
        body: JSON.stringify({ enabled: !state.enabled }),
      });
      setState(next);
      toast.success(next.enabled ? 'Autonomous manager enabled' : 'Autonomous manager disabled');
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  const enabled = state?.enabled ?? false;
  const master = state?.master ?? false;

  return (
    <div className="rounded-card border border-line bg-surface p-5">
      <div className="flex items-start gap-3">
        <Radar size={18} className="mt-0.5 text-accent" />
        <div className="min-w-0 flex-1">
          <h3 className="text-heading text-text-primary">Autonomous manager heartbeat</h3>
          <p className="mt-1 text-[12px] text-text-secondary">
            On a cadence, your orchestrator and domain managers review what they own — failed runs, pending
            approvals, stalled work — and act on it unbidden through their tools. Off = they still surface it in
            chat, but wait for you.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          disabled={!state || saving || !master}
          onClick={() => void toggle()}
          className={`relative h-6 w-11 shrink-0 rounded-full transition ${enabled && master ? 'bg-accent' : 'bg-surface-2 border border-line'} ${!master ? 'opacity-50' : ''}`}
        >
          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${enabled ? 'left-[22px]' : 'left-0.5'}`} />
        </button>
      </div>

      {error && <p className="mt-3 flex items-center gap-1 text-[12px] text-danger"><AlertCircle size={13} /> {error}</p>}

      {!master && (
        <p className="mt-3 rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-[12px] text-text-secondary">
          The deployment master switch is off, so autonomy stays inactive even when enabled here. Set
          <code className="mx-1 rounded bg-canvas/70 px-1 font-mono text-[11px]">AGENTIS_COMMAND_AUTONOMY=true</code>
          on the server to arm it.
        </p>
      )}

      {master && enabled && (
        <p className="mt-3 flex items-center gap-1.5 text-[12px] text-accent">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" /> Active — managers act autonomously within their scope.
        </p>
      )}
    </div>
  );
}
