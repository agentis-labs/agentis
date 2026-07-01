/**
 * WorkspaceBundleModal — export / import a whole workspace as a `.agentis` bundle.
 *
 * Export: pick a profile (share | sell) and download the signed-by-checksum
 * envelope, or take a full-fidelity local backup. Import: preview what a bundle
 * contains (and what is stripped) before installing it into THIS workspace.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowUpFromLine, Boxes, Download, HardDrive, Loader2, ShieldCheck, X } from 'lucide-react';
import type { WorkspaceBundleEnvelope, WorkspaceBundlePreview } from '@agentis/core';
import { apiErrorMessage } from '../../lib/api';
import { workspaceBundleApi } from '../../lib/workspaceBundle';
import { useToast } from '../shared/Toast';
import { Button } from '../shared/Button';

type Profile = 'share' | 'sell';

export function WorkspaceBundleModal({
  importEnvelope,
  onClose,
  onImported,
}: {
  /** When provided, the modal opens straight into the import-confirm flow. */
  importEnvelope?: WorkspaceBundleEnvelope;
  onClose: () => void;
  onImported: () => void;
}) {
  const toast = useToast();
  const [mode] = useState<'export' | 'import'>(importEnvelope ? 'import' : 'export');
  const [profile, setProfile] = useState<Profile>('share');
  const [name, setName] = useState('');
  const [license, setLicense] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<WorkspaceBundlePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    if (!importEnvelope) return;
    let cancelled = false;
    workspaceBundleApi.preview(importEnvelope)
      .then((p) => { if (!cancelled) setPreview(p); })
      .catch((err) => { if (!cancelled) setPreviewError(apiErrorMessage(err)); });
    return () => { cancelled = true; };
  }, [importEnvelope]);

  async function doExport() {
    setBusy(true);
    try {
      const envelope = await workspaceBundleApi.export({
        profile,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(profile === 'sell' && license.trim() ? { license: license.trim() } : {}),
      });
      downloadJson(envelope, `${slugify(envelope.name)}.agentis`);
      toast.success('Workspace exported', `${envelope.name} (${profile})`);
      onClose();
    } catch (err) {
      toast.error('Export failed', apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function doBackup() {
    setBusy(true);
    try {
      const res = await workspaceBundleApi.backup();
      toast.success('Backup created', res.outDir);
      onClose();
    } catch (err) {
      toast.error('Backup failed', apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function doImport() {
    if (!importEnvelope) return;
    setBusy(true);
    try {
      const result = await workspaceBundleApi.import(importEnvelope);
      toast.success('Workspace imported', `${result.apps} app(s), ${result.agents} agent(s), ${result.workflows} workflow(s)`);
      onImported();
      onClose();
    } catch (err) {
      toast.error('Import failed', apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-canvas/60 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="flex max-h-[88vh] w-[min(560px,94vw)] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-modal" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center gap-2 border-b border-line px-5 py-4">
          <Boxes size={16} className="text-accent" />
          <div className="flex-1">
            <div className="text-[10px] uppercase tracking-wider text-text-muted">Workspace bundle</div>
            <div className="text-[14px] font-semibold text-text-primary">{mode === 'import' ? 'Import workspace' : 'Export workspace'}</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary">
            <X size={16} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto p-5">
          {mode === 'export' ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2">
                <ProfileCard active={profile === 'share'} onClick={() => setProfile('share')} title="Share" desc="Structure only. No secrets, no live data. Embeddings recompiled on install." />
                <ProfileCard active={profile === 'sell'} onClick={() => setProfile('sell')} title="Sell" desc="Like share + signed + licence. Export is blocked if any secret/PII is detected." />
              </div>

              <Field label="Bundle name (optional)">
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My workspace" className={INPUT} />
              </Field>
              {profile === 'sell' && (
                <Field label="Licence (optional)">
                  <textarea value={license} onChange={(e) => setLicense(e.target.value)} rows={3} placeholder="e.g. Single-workspace commercial licence…" className={`${INPUT} resize-y`} />
                </Field>
              )}

              <div className="flex items-start gap-2 rounded-card border border-line bg-canvas/45 px-3 py-2.5 text-[11.5px] text-text-muted">
                <ShieldCheck size={14} className="mt-0.5 shrink-0 text-text-secondary" />
                Credentials never travel in a share/sell bundle — only the list of which to reconnect. For a full copy with secrets + data, use a local Backup.
              </div>

              <div className="flex items-center gap-2 border-t border-line pt-4">
                <Button variant="primary" size="md" iconLeft={busy ? <Loader2 size={14} className="animate-spin" /> : <ArrowUpFromLine size={14} />} onClick={() => void doExport()} disabled={busy}>
                  Export .agentis
                </Button>
                <Button variant="ghost" size="md" iconLeft={<HardDrive size={14} />} onClick={() => void doBackup()} disabled={busy}>
                  Full backup (local)
                </Button>
              </div>
            </div>
          ) : (
            <ImportPreview envelope={importEnvelope!} preview={preview} error={previewError} busy={busy} onConfirm={() => void doImport()} />
          )}
        </div>
      </div>
    </div>
  );
}

function ImportPreview({
  envelope,
  preview,
  error,
  busy,
  onConfirm,
}: {
  envelope: WorkspaceBundleEnvelope;
  preview: WorkspaceBundlePreview | null;
  error: string | null;
  busy: boolean;
  onConfirm: () => void;
}) {
  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-card border border-danger/30 bg-danger-soft px-3 py-2.5 text-[12px] text-danger">
        <AlertTriangle size={14} /> {error}
      </div>
    );
  }
  if (!preview) {
    return <div className="flex items-center gap-2 py-6 text-[12px] text-text-muted"><Loader2 size={14} className="animate-spin" /> Inspecting bundle…</div>;
  }
  const c = preview.counts;
  return (
    <div className="space-y-4">
      <div>
        <div className="text-[14px] font-semibold text-text-primary">{preview.name}</div>
        <div className="mt-0.5 text-[11px] text-text-muted">
          profile: {preview.profile}{preview.author?.displayName ? ` · by ${preview.author.displayName}` : ''}{envelope.signature ? ' · ✓ signed' : ''}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2">
        <Stat label="Apps" value={c.apps} />
        <Stat label="Agents" value={c.agents} />
        <Stat label="Workflows" value={c.workflows} />
        <Stat label="Extensions" value={c.extensions} />
        <Stat label="Abilities" value={c.abilities} />
        <Stat label="Knowledge" value={c.knowledgeSeeds} />
        <Stat label="Creds" value={c.credentialSlots} />
      </div>

      {preview.license && (
        <Field label="Licence"><div className="rounded-card border border-line bg-canvas/45 px-3 py-2 text-[12px] text-text-secondary whitespace-pre-wrap">{preview.license}</div></Field>
      )}

      {preview.requiredCredentials.length > 0 && (
        <div className="rounded-card border border-warn/30 bg-warn-soft/30 px-3 py-2.5">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-warn">Reconnect after import</div>
          <div className="flex flex-wrap gap-1.5">
            {preview.requiredCredentials.map((cred) => (
              <span key={cred.key} className="rounded-pill border border-line bg-surface-2 px-2 py-0.5 text-[11px] text-text-secondary">{cred.label} · {cred.service}</span>
            ))}
          </div>
        </div>
      )}

      {preview.warnings.map((w, i) => (
        <div key={i} className="flex items-start gap-2 rounded-card border border-line bg-canvas/45 px-3 py-2 text-[11.5px] text-text-muted">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warn" /> {w}
        </div>
      ))}

      <div className="flex items-center gap-2 border-t border-line pt-4">
        <Button variant="primary" size="md" iconLeft={busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} onClick={onConfirm} disabled={busy}>
          Install into this workspace
        </Button>
      </div>
    </div>
  );
}

function ProfileCard({ active, onClick, title, desc }: { active: boolean; onClick: () => void; title: string; desc: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-card border p-3 text-left transition-colors ${active ? 'border-accent bg-accent-soft/40' : 'border-line bg-canvas/45 hover:bg-surface-2'}`}
    >
      <div className={`text-[13px] font-semibold ${active ? 'text-accent' : 'text-text-primary'}`}>{title}</div>
      <div className="mt-1 text-[11px] leading-4 text-text-muted">{desc}</div>
    </button>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-card border border-line bg-canvas/45 px-2.5 py-2 text-center">
      <div className="text-[15px] font-semibold text-text-primary">{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-text-muted">{label}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-text-muted">{label}</span>
      {children}
    </label>
  );
}

function downloadJson(value: unknown, fileName: string) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'workspace';
}

const INPUT = 'w-full rounded-input border border-line bg-surface-2 px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted outline-none focus:border-accent';
