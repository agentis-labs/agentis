/**
 * StartupPanel — Settings → Profile.
 *
 * Optional, off-by-default "launch Agentis automatically when this machine
 * turns on" toggle, backed by GET/POST /v1/system/autostart. The API is the
 * source of truth (it checks the real OS registration file), so this panel
 * never caches an enabled/disabled guess across reloads.
 */

import { useEffect, useState } from 'react';
import { Power, AlertCircle } from 'lucide-react';
import { api, apiErrorMessage } from '../../lib/api';
import { useToast } from '../shared/Toast';

interface AutostartState {
  supported: boolean;
  enabled: boolean;
  platform: string;
  reason?: string;
}

export function StartupPanel() {
  const toast = useToast();
  const [state, setState] = useState<AutostartState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api<AutostartState>('/v1/system/autostart')
      .then((s) => { if (!cancelled) setState(s); })
      .catch((e) => { if (!cancelled) setError(apiErrorMessage(e)); });
    return () => { cancelled = true; };
  }, []);

  async function toggle() {
    if (!state) return;
    setSaving(true); setError(null);
    try {
      const next = await api<AutostartState>('/v1/system/autostart', {
        method: 'POST',
        body: JSON.stringify({ enabled: !state.enabled }),
      });
      setState(next);
      toast.success(next.enabled ? 'Agentis will start automatically' : 'Autostart disabled');
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  const enabled = state?.enabled ?? false;
  const supported = state?.supported ?? false;

  return (
    <div>
      <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-muted">Startup</h2>
      <div className="rounded-card border border-line bg-surface p-5">
        <div className="flex items-start gap-3">
          <Power size={18} className="mt-0.5 text-accent" />
          <div className="min-w-0 flex-1">
            <h3 className="text-heading text-text-primary">Start Agentis when I turn on my computer</h3>
            <p className="mt-1 text-[12px] text-text-secondary">
              Launches Agentis in the background at login, so it's already running when you open the dashboard.
              Off by default.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            disabled={!state || saving || !supported}
            onClick={() => void toggle()}
            className={`relative h-6 w-11 shrink-0 rounded-full transition ${enabled ? 'bg-accent' : 'bg-surface-2 border border-line'} ${!supported ? 'opacity-50' : ''}`}
          >
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${enabled ? 'left-[22px]' : 'left-0.5'}`} />
          </button>
        </div>

        {error && <p className="mt-3 flex items-center gap-1 text-[12px] text-danger"><AlertCircle size={13} /> {error}</p>}

        {state && !supported && (
          <p className="mt-3 rounded-md border border-line bg-surface-2 px-3 py-2 text-[12px] text-text-muted">
            {state.reason ?? 'Not available on this host.'}
          </p>
        )}
      </div>
    </div>
  );
}
