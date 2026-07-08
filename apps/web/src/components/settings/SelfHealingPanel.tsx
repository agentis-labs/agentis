

import { useEffect, useState } from 'react';
import { Wand2, Check, AlertCircle, ShieldCheck, Zap } from 'lucide-react';
import { getSelfHealConfig, setSelfHealConfig, type SelfHealConfig } from '../../lib/automation';
import { api, apiErrorMessage } from '../../lib/api';
import { useToast } from '../shared/Toast';

interface HealerAgent { id: string; name: string; role?: string }

export function SelfHealingPanel() {
  const toast = useToast();
  const [cfg, setCfg] = useState<SelfHealConfig | null>(null);
  const [agents, setAgents] = useState<HealerAgent[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getSelfHealConfig().then((c) => { if (!cancelled) setCfg(c); }).catch((e) => { if (!cancelled) setError(apiErrorMessage(e)); });
    void api<{ agents: HealerAgent[] }>('/v1/agents')
      .then((d) => { if (!cancelled) setAgents(d.agents ?? []); })
      .catch(() => { /* selector falls back to default-only */ });
    return () => { cancelled = true; };
  }, []);

  async function save(patch: Partial<SelfHealConfig>) {
    setSaving(true); setError(null);
    try {
      const next = await setSelfHealConfig(patch);
      setCfg(next);
      toast.success('Self-healing updated');
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-card border border-line bg-surface p-5">
      <div className="flex items-start gap-3">
        <Wand2 size={18} className="mt-0.5 text-accent" />
        <div className="min-w-0 flex-1">
          <h3 className="text-heading text-text-primary">Self-fixing workflows</h3>
          <p className="mt-1 text-[12px] text-text-secondary">
            When a step fails, an agent diagnoses why and repairs the workflow within budget â€”
            preserving its intent and never fabricating data. Fixing workflows by hand is a nightmare; let your agents do it.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={cfg?.enabled ?? false}
          disabled={!cfg || saving}
          onClick={() => cfg && void save({ enabled: !cfg.enabled })}
          className={`relative h-6 w-11 shrink-0 rounded-full transition ${cfg?.enabled ? 'bg-accent' : 'bg-surface-2 border border-line'}`}
        >
          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${cfg?.enabled ? 'left-[22px]' : 'left-0.5'}`} />
        </button>
      </div>

      {error && <p className="mt-3 flex items-center gap-1 text-[12px] text-danger"><AlertCircle size={13} /> {error}</p>}

      {cfg?.enabled && (
        <div className="mt-4 space-y-3 border-t border-line pt-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">Recovery autonomy</div>
          <ModeOption
            icon={<ShieldCheck size={15} />}
            active={cfg.mode === 'guarded'}
            onClick={() => void save({ mode: 'guarded' })}
            title="Guarded autonomous (recommended)"
            body="Internal repairs across the full ladder apply immediately. Agentis pauses only when a repair changes an outward, irreversible, or unknown-effect action."
          />
          <ModeOption
            icon={<Zap size={15} />}
            active={cfg.mode === 'bypass'}
            onClick={() => void save({ mode: 'bypass' })}
            title="Full bypass"
            body="Certified, intent-preserving graph edits apply without asking, within budget â€” like a harness with permissions skipped."
          />

          <div className="flex items-center justify-between pt-1">
            <span className="text-[12.5px] text-text-secondary">Max distinct plans per failure</span>
            <select
              value={cfg.maxRepairPlans}
              disabled={saving}
              onChange={(e) => void save({ maxRepairPlans: Number(e.target.value) })}
              className="rounded-md border border-line bg-bg px-2 py-1 text-[13px]"
              aria-label="Max repair plans"
            >
              {[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>

          <div className="flex items-center justify-between pt-1">
            <div className="min-w-0 pr-3">
              <span className="text-[12.5px] text-text-secondary">Healing agent</span>
              <p className="text-[11px] text-text-muted">Grounds the diagnosis and runs a step whose own agent goes offline.</p>
            </div>
            <select
              value={cfg.healerAgentId ?? ''}
              disabled={saving}
              onChange={(e) => void save({ healerAgentId: e.target.value || null })}
              className="max-w-[55%] shrink-0 truncate rounded-md border border-line bg-bg px-2 py-1 text-[13px]"
              aria-label="Healing agent"
            >
              <option value="">Orchestrator (default)</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}{a.role ? ` Â· ${a.role}` : ''}</option>
              ))}
            </select>
          </div>
        </div>
      )}
    </div>
  );
}

function ModeOption({ icon, active, onClick, title, body }: {
  icon: React.ReactNode; active: boolean; onClick: () => void; title: string; body: string;
}) {
  return (
    <button type="button" onClick={onClick}
      className={`block w-full rounded-md border p-3 text-left ${active ? 'border-accent bg-accent/5' : 'border-line hover:border-accent/40'}`}>
      <span className="flex items-center gap-2 text-[13px] font-medium text-text-primary">
        <span className="text-accent">{icon}</span>{title}
        {active && <Check size={14} className="ml-auto text-accent" />}
      </span>
      <span className="mt-1 block text-[12px] text-text-muted">{body}</span>
    </button>
  );
}



