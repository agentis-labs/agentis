/**
 * BrowserControlPanel — Settings → Governance.
 *
 * Per-workspace opt-in for letting agents attach to and drive the user's REAL
 * Chrome (their profile, logins, extensions). OFF by default — this is
 * credential-grade power — and enabled with one explicit switch instead of a raw
 * env var. The deployment env (AGENTIS_BROWSER_ALLOW_CDP) is a master override:
 * when set it forces the decision and the switch goes inert with an explainer.
 */

import { useEffect, useState } from 'react';
import { Globe, AlertCircle } from 'lucide-react';
import { api, apiErrorMessage } from '../../lib/api';
import { useToast } from '../shared/Toast';

interface ControlState { enabled: boolean; master: boolean | null; effective: boolean }

export function BrowserControlPanel() {
  const toast = useToast();
  const [state, setState] = useState<ControlState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api<ControlState>('/v1/browser/real-chrome-control')
      .then((s) => { if (!cancelled) setState(s); })
      .catch((e) => { if (!cancelled) setError(apiErrorMessage(e)); });
    return () => { cancelled = true; };
  }, []);

  async function toggle() {
    if (!state) return;
    setSaving(true); setError(null);
    try {
      const next = await api<ControlState>('/v1/browser/real-chrome-control', {
        method: 'PUT',
        body: JSON.stringify({ enabled: !state.enabled }),
      });
      setState(next);
      toast.success(next.effective ? 'Agents can control your real Chrome' : 'Real-Chrome control disabled');
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  const enabled = state?.enabled ?? false;
  const master = state?.master ?? null;      // null = defer to this switch
  const effective = state?.effective ?? false;
  const forced = master !== null;            // deployment overrode the decision

  return (
    <div className="rounded-card border border-line bg-surface p-5">
      <div className="flex items-start gap-3">
        <Globe size={18} className="mt-0.5 text-accent" />
        <div className="min-w-0 flex-1">
          <h3 className="text-heading text-text-primary">Let agents control your real Chrome</h3>
          <p className="mt-1 text-[12px] text-text-secondary">
            When on, agents can attach to your own running Chrome — your profile, logins, and extensions — and act
            in your window (they only touch tabs they open; they never close your browser). Off = agents use a
            separate managed browser window instead. Only enable on a machine you trust.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={effective}
          disabled={!state || saving || forced}
          onClick={() => void toggle()}
          className={`relative h-6 w-11 shrink-0 rounded-full transition ${effective ? 'bg-accent' : 'bg-surface-2 border border-line'} ${forced ? 'opacity-50' : ''}`}
        >
          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${effective ? 'left-[22px]' : 'left-0.5'}`} />
        </button>
      </div>

      {error && <p className="mt-3 flex items-center gap-1 text-[12px] text-danger"><AlertCircle size={13} /> {error}</p>}

      {master === true && (
        <p className="mt-3 rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-[12px] text-text-secondary">
          The deployment forces real-Chrome control ON
          (<code className="mx-1 rounded bg-canvas/70 px-1 font-mono text-[11px]">AGENTIS_BROWSER_ALLOW_CDP=true</code>),
          so this switch is inert.
        </p>
      )}
      {master === false && (
        <p className="mt-3 rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-[12px] text-text-secondary">
          The deployment forces real-Chrome control OFF
          (<code className="mx-1 rounded bg-canvas/70 px-1 font-mono text-[11px]">AGENTIS_BROWSER_ALLOW_CDP=false</code>).
          Unset it on the server to let this switch decide.
        </p>
      )}

      {effective && (
        <p className="mt-3 rounded-md border border-line bg-surface-2 px-3 py-2 text-[12px] text-text-secondary">
          One-time setup: fully quit Chrome, then start it with
          <code className="mx-1 rounded bg-canvas/70 px-1 font-mono text-[11px]">--remote-debugging-port=9222</code>.
          Ask an agent to open a browser session with <code className="mx-1 rounded bg-canvas/70 px-1 font-mono text-[11px]">attach: "chrome"</code>.
        </p>
      )}
    </div>
  );
}
