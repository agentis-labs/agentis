/**
 * OrchestratorModelsPanel â€” per-workspace orchestrator model-role config
 * (OMNICHANNEL-ORCHESTRATOR-10X Â§4.4).
 *
 * Each cognition role (conversation, planning, â€¦) can target a different model,
 * or you can point them all at one high model (e.g. claude-opus-4-8). Roles with
 * no override inherit the server's env default. The conversation role takes
 * effect immediately for chat and channels.
 */

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Loader2, Sparkles } from 'lucide-react';
import { api } from '../../lib/api';
import { Button } from '../shared/Button';
import { Skeleton } from '../shared/Skeleton';
import { useToast } from '../shared/Toast';

interface RoleOverride {
  baseUrl: string | null;
  model: string;
  hasApiKey: boolean;
}
interface RoleRow {
  role: string;
  envModel: string | null;
  effectiveModel: string | null;
  override: RoleOverride | null;
}
interface AutonomySummary {
  enabled: boolean;
  model: string | null;
  source?: 'configured_model' | 'agent_harness' | 'none';
  agentName?: string;
  adapterType?: string;
}
interface ModelAssistedRuntimeSummary {
  enabled: boolean;
}

const ROLE_LABELS: Record<string, { title: string; blurb: string }> = {
  conversation: { title: 'Conversation', blurb: "The orchestrator's chat brain (web + channels). Applies immediately." },
  planning: { title: 'Planning', blurb: 'Multi-step build decomposition.' },
  synthesis: { title: 'Synthesis', blurb: 'Workflow graph generation.' },
  evaluation: { title: 'Evaluation', blurb: 'Judge / quality gates / routing.' },
  vision: { title: 'Vision', blurb: 'Image understanding.' },
  transcription: { title: 'Transcription', blurb: 'Voice notes â†’ text.' },
};

export function OrchestratorModelsPanel() {
  const toast = useToast();
  const [roles, setRoles] = useState<RoleRow[] | null>(null);
  const [autonomy, setAutonomy] = useState<AutonomySummary | null>(null);
  const [modelAssistedRuntime, setModelAssistedRuntime] = useState<ModelAssistedRuntimeSummary | null>(null);
  const [toggleBusy, setToggleBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await api<{ roles: RoleRow[]; autonomy?: AutonomySummary; modelAssistedRuntime?: ModelAssistedRuntimeSummary }>('/v1/orchestrator/models');
      const nextRoles = data.roles ?? [];
      setRoles(nextRoles);
      setModelAssistedRuntime(data.modelAssistedRuntime ?? { enabled: true });
      // Prefer the server's autonomy signal (mirrors the engine's canRun). Fall
      // back to deriving it from the role models for older responses/mocks.
      setAutonomy(
        data.autonomy ?? {
          enabled: nextRoles.some((r) => (r.role === 'evaluation' || r.role === 'conversation') && Boolean(r.effectiveModel)),
          model: nextRoles.find((r) => r.role === 'evaluation' || r.role === 'conversation')?.effectiveModel ?? null,
        },
      );
    } catch {
      setRoles([]);
      setAutonomy(null);
      setModelAssistedRuntime(null);
    }
  }, []);

  async function toggleModelAssistedRuntime() {
    if (!modelAssistedRuntime) return;
    const enabled = !modelAssistedRuntime.enabled;
    setToggleBusy(true);
    try {
      await api('/v1/orchestrator/models/model-assisted-runtime', {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      });
      toast.success(enabled ? 'Model-assisted runtime enabled' : 'Model-assisted runtime disabled');
      await refresh();
    } catch (err) {
      toast.error('Could not update runtime setting', String(err));
    } finally {
      setToggleBusy(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section>
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">Model overrides</h2>
        <span className="rounded-pill border border-line bg-surface-2 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-text-muted">Optional</span>
      </div>
      <p className="mb-3 text-[13px] text-text-secondary">
        By default every cognition role â€” chat, planning, synthesis, evaluation â€” runs on
        <strong className="text-text-primary"> your agent's harness</strong>, the model you already set up.
        Nothing to configure here. Override a role only if you want a different or stronger model for it
        (e.g. a sharper model just for <span className="text-text-primary">synthesis</span>) â€” a power-user plus,
        not a required step.
      </p>
      <div className="mb-3 flex items-center justify-between gap-3 rounded-card border border-line bg-surface px-4 py-3">
        <div>
          <div className="text-[14px] font-medium text-text-primary">Model-assisted evaluator and brain features</div>
          <p className="mt-0.5 text-[12px] text-text-muted">
            Allows evaluation, synthesis, agent sessions, formation judge, Feynman repair, memory reflection, and Brain Ask to reuse the orchestrator model when no role-specific model is selected.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={modelAssistedRuntime?.enabled ?? true}
          disabled={!modelAssistedRuntime || toggleBusy}
          onClick={() => void toggleModelAssistedRuntime()}
          className={`relative h-6 w-11 shrink-0 rounded-full transition ${modelAssistedRuntime?.enabled ?? true ? 'bg-accent' : 'border border-line bg-surface-2'} disabled:opacity-60`}
        >
          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${modelAssistedRuntime?.enabled ?? true ? 'left-[22px]' : 'left-0.5'}`} />
        </button>
      </div>
      {autonomy && !autonomy.enabled && (
        <div role="alert" className="mb-3 flex items-start gap-2.5 rounded-card border border-warn bg-warn-soft px-4 py-3">
          <Sparkles size={15} className="mt-0.5 shrink-0 text-warn" />
          <div className="text-[13px] text-text-secondary">
            <span className="font-medium text-text-primary">No autonomy model is configured for this workspace.</span>{' '}
            Specialists fall back to a single-shot text completion â€” no tool use, delegation, memory, or multi-step reasoning.
            Connect an agent runtime, or set a <span className="text-text-primary">Conversation</span> or{' '}
            <span className="text-text-primary">Evaluation</span> model below, to switch agents into full tool-using mode.
          </div>
        </div>
      )}
      {autonomy?.enabled && autonomy.source === 'agent_harness' && (
        <div className="mb-3 flex items-start gap-2.5 border-l-2 border-success/70 bg-success/5 px-3 py-2.5">
          <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-success" />
          <p className="text-[12px] leading-5 text-text-secondary">
            <span className="font-medium text-text-primary">Default runtime: {autonomy.agentName ?? 'orchestrator harness'}.</span>{' '}
            Conversation, planning, synthesis, evaluation, and repair inherit this connected {autonomy.adapterType ?? 'agent'} runtime until you add an override.
          </p>
        </div>
      )}
      {roles === null ? (
        <Skeleton height={240} />
      ) : (
        <div className="space-y-2">
          {roles.map((row) => (
            <RoleCard key={row.role} row={row} onChanged={refresh} toast={toast} />
          ))}
        </div>
      )}
    </section>
  );
}

function RoleCard({ row, onChanged, toast }: { row: RoleRow; onChanged: () => Promise<void>; toast: ReturnType<typeof useToast> }) {
  const label = ROLE_LABELS[row.role] ?? { title: row.role, blurb: '' };
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<'save' | 'reset' | null>(null);
  const [model, setModel] = useState(row.override?.model ?? '');
  const [baseUrl, setBaseUrl] = useState(row.override?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');

  async function save() {
    if (model.trim().length < 1) {
      toast.error('Model required', 'Enter a model id.');
      return;
    }
    setBusy('save');
    try {
      await api(`/v1/orchestrator/models/${row.role}`, {
        method: 'PUT',
        body: JSON.stringify({
          model: model.trim(),
          baseUrl: baseUrl.trim() || null,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        }),
      });
      toast.success(`${label.title} model set`);
      setApiKey('');
      setEditing(false);
      await onChanged();
    } catch (err) {
      toast.error('Could not save', String(err));
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    setBusy('reset');
    try {
      await api(`/v1/orchestrator/models/${row.role}`, { method: 'DELETE' });
      toast.success(`${label.title} reverted to default`);
      setModel('');
      setBaseUrl('');
      setApiKey('');
      setEditing(false);
      await onChanged();
    } catch (err) {
      toast.error('Could not reset', String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-card border border-line bg-surface px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="text-[14px] font-medium text-text-primary">{label.title}</span>
        <span className="text-[12px] text-text-muted">
          {row.override
            ? row.override.model
            : row.envModel
              ? `${row.envModel} Â· server default`
              : 'Uses your harness'}
        </span>
        {!editing && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setEditing(true)}>
            {row.override ? 'Change' : 'Override'}
          </Button>
        )}
      </div>
      <p className="mt-0.5 text-[12px] text-text-muted">{label.blurb}</p>

      {editing && (
        <div className="mt-3 space-y-2">
          <Field label="Model">
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={row.envModel ?? 'e.g. claude-opus-4-8'}
              className={INPUT_CLS}
            />
          </Field>
          <Field label="Base URL" hint="Optional â€” inherits the server default endpoint when blank">
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.provider.com/v1"
              className={INPUT_CLS}
            />
          </Field>
          <Field label="API key" hint={row.override?.hasApiKey ? 'A key is set â€” leave blank to keep it' : 'Optional â€” inherits the server default key when blank'}>
            <input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              type="password"
              placeholder={row.override?.hasApiKey ? 'â€¢â€¢â€¢â€¢â€¢â€¢ (unchanged)' : 'Paste an API key'}
              className={INPUT_CLS}
            />
          </Field>
          <div className="flex gap-2 pt-1">
            <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => void save()}>
              {busy === 'save' ? <Loader2 size={12} className="animate-spin" /> : 'Save'}
            </Button>
            {row.override && (
              <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void reset()}>
                {busy === 'reset' ? 'Resettingâ€¦' : 'Reset to default'}
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

const INPUT_CLS =
  'w-full rounded-input border border-line bg-surface-2 px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-text-muted">{hint}</span>}
    </label>
  );
}



