/**
 * MediaModelsPanel — per-workspace media-generation model config
 * (INTEGRATION-CEILING-10X §1). Mirrors OrchestratorModelsPanel exactly: media
 * generation gets the same "bring your own model/endpoint, no restart"
 * treatment chat models already had — point image generation at OpenRouter,
 * a self-hosted endpoint, or just a different model, with zero server config.
 */

import { useCallback, useEffect, useState } from 'react';
import { AudioLines, ImageIcon, Loader2, Mic2 } from 'lucide-react';
import { api } from '../../lib/api';
import { Button } from '../shared/Button';
import { Skeleton } from '../shared/Skeleton';
import { useToast } from '../shared/Toast';

interface ModalityOverride {
  baseUrl: string | null;
  model: string;
  hasApiKey: boolean;
}
interface ModalityEnvDefault {
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
}
interface ModalityRow {
  modality: string;
  envDefault: ModalityEnvDefault | null;
  override: ModalityOverride | null;
  effectiveModel: string | null;
  available: boolean;
}

const MODALITY_LABELS: Record<string, { title: string; blurb: string }> = {
  image: { title: 'Image generation', blurb: 'Any OpenAI-compatible /images endpoint — point it at OpenRouter, a self-hosted model, or a different vendor. No vendor lock-in.' },
  audio: { title: 'Audio generation', blurb: 'Any compatible /audio/generations endpoint, including a local runtime.' },
  speech: { title: 'Voice generation', blurb: 'Any OpenAI-compatible /audio/speech endpoint, hosted or local.' },
  video: { title: 'Video generation', blurb: 'No provider wired yet on this deployment.' },
};

export function MediaModelsPanel() {
  const toast = useToast();
  const [modalities, setModalities] = useState<ModalityRow[] | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api<{ modalities: ModalityRow[] }>('/v1/media/models');
      setModalities(data.modalities ?? []);
    } catch {
      setModalities([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Only show modalities the platform actually has a provider seam for — a
  // deployment with no env default AND no override isn't wireable yet, and
  // showing an editable-but-inert row would be dishonest.
  const wireable = (modalities ?? []).filter((m) => m.envDefault !== null || m.override !== null);

  return (
    <section>
      <h3 className="mb-1 text-[14px] font-semibold text-text-primary">Media generation</h3>
      <p className="mb-3 text-[12px] text-text-muted">
        Image, voice, and audio generation resolve through free-text model and endpoint settings.
        Modalities with no override use this server&apos;s configured default.
      </p>
      {modalities === null ? (
        <Skeleton height={120} />
      ) : wireable.length === 0 ? (
        <p className="rounded-card border border-line bg-surface px-4 py-3 text-[13px] text-text-muted">
          No media provider is configured on this server yet.
        </p>
      ) : (
        <div className="space-y-2">
          {wireable.map((row) => (
            <ModalityCard key={row.modality} row={row} onChanged={refresh} toast={toast} />
          ))}
        </div>
      )}
    </section>
  );
}

function ModalityCard({ row, onChanged, toast }: { row: ModalityRow; onChanged: () => Promise<void>; toast: ReturnType<typeof useToast> }) {
  const label = MODALITY_LABELS[row.modality] ?? { title: row.modality, blurb: '' };
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<'save' | 'reset' | null>(null);
  const [model, setModel] = useState(row.override?.model ?? '');
  const [baseUrl, setBaseUrl] = useState(row.override?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const Icon = row.modality === 'speech' ? Mic2 : row.modality === 'audio' ? AudioLines : ImageIcon;

  async function save() {
    if (model.trim().length < 1) {
      toast.error('Model required', 'Enter a model id.');
      return;
    }
    setBusy('save');
    try {
      await api(`/v1/media/models/${row.modality}`, {
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
      await api(`/v1/media/models/${row.modality}`, { method: 'DELETE' });
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
        <Icon size={14} className="text-text-muted" />
        <span className="text-[14px] font-medium text-text-primary">{label.title}</span>
        <span className="text-[12px] text-text-muted">
          {row.override
            ? row.override.model
            : row.envDefault
              ? `${row.envDefault.model} · server default`
              : 'Not configured'}
        </span>
        {!row.available && <span className="text-[11px] text-warn">not configured</span>}
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
              placeholder={row.envDefault?.model ?? 'e.g. gpt-image-1, or any model id your endpoint serves'}
              className={INPUT_CLS}
            />
          </Field>
          <Field label="Base URL" hint="Optional — inherits the server default. Compatible hosted gateways and local endpoints are supported.">
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://openrouter.ai/api/v1"
              className={INPUT_CLS}
            />
          </Field>
          <Field label="API key" hint={row.override?.hasApiKey ? 'A key is set — leave blank to keep it' : 'Optional — local endpoints may not require one'}>
            <input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              type="password"
              placeholder={row.override?.hasApiKey ? '•••••• (unchanged)' : 'Paste an API key'}
              className={INPUT_CLS}
            />
          </Field>
          <div className="flex gap-2 pt-1">
            <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => void save()}>
              {busy === 'save' ? <Loader2 size={12} className="animate-spin" /> : 'Save'}
            </Button>
            {row.override && (
              <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void reset()}>
                {busy === 'reset' ? 'Resetting…' : 'Reset to default'}
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
