/**
 * AppEngineModal — App-level settings, framed as a product control surface.
 *
 * Four tabs, ordered by what someone configuring an Agentic App actually cares
 * about: **Overview** (a friendly summary), **Identity** (name / description /
 * icon / version / lifecycle), **Access** (who can use it, sharing, entry
 * surface), and **Advanced** (custom-code policy, capability grants, and
 * read-only distribution metadata). Implementation plumbing — checksum, source,
 * raw grant JSON — lives only under Advanced, never up front.
 *
 * All edits map to the existing `PATCH /v1/apps/:id` contract; no new fields.
 */
import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  Boxes,
  FileText,
  Image as ImageIcon,
  Loader2,
  Plus,
  Save,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { AppRecord, AppSurface } from '@agentis/core';
import type { AppUpdatePayload } from '../../lib/appsApi';
import { nestedDomainOptions } from '../shared/DomainToolbar';

/** Domain (or Subdomain) the App can be organized under. */
export interface AppEngineDomain {
  id: string;
  name: string;
  colorHex?: string | null;
  managerId?: string | null;
  parentDomainId?: string | null;
}

/** Agent that can own an App (manager or specialist). */
export interface AppEngineAgent {
  id: string;
  name: string;
  role?: string | null;
}

type AppEnginePage = 'overview' | 'identity' | 'access' | 'advanced';
type Audience = AppRecord['policy']['audience'][number];
type CapabilityGrant = AppRecord['policy']['grants'][number];

const ENGINE_PAGES: Array<{ id: AppEnginePage; label: string; icon: ReactNode }> = [
  { id: 'overview', label: 'Overview', icon: <Settings size={13} /> },
  { id: 'identity', label: 'Identity', icon: <ImageIcon size={13} /> },
  { id: 'access', label: 'Access', icon: <ShieldCheck size={13} /> },
  { id: 'advanced', label: 'Advanced', icon: <SlidersHorizontal size={13} /> },
];

const AUDIENCE_OPTIONS: Array<{ value: Audience; label: string; hint: string }> = [
  { value: 'operator', label: 'Operators', hint: 'The agents/people running the app' },
  { value: 'executive', label: 'Team', hint: 'Workspace members with a stake' },
  { value: 'customer', label: 'Customers', hint: 'External end-users you invite' },
  { value: 'public', label: 'Public link', hint: 'Anyone with a share link' },
];

export function AppEngineModal({
  open,
  app,
  surfaces,
  domains = [],
  agents = [],
  onClose,
  onSave,
}: {
  open: boolean;
  app: AppRecord | null;
  surfaces: AppSurface[];
  domains?: AppEngineDomain[];
  agents?: AppEngineAgent[];
  onClose: () => void;
  onSave: (patch: AppUpdatePayload) => Promise<AppRecord>;
}) {
  const [page, setPage] = useState<AppEnginePage>('overview');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [version, setVersion] = useState('');
  const [status, setStatus] = useState<AppRecord['status']>('draft');
  const [icon, setIcon] = useState('');
  const [domainId, setDomainId] = useState('');
  const [ownerAgentId, setOwnerAgentId] = useState('');
  const [entrySurfaceId, setEntrySurfaceId] = useState('');
  const [audience, setAudience] = useState<Audience[]>([]);
  const [shareable, setShareable] = useState(false);
  const [customCode, setCustomCode] = useState<AppRecord['policy']['customCode']>('disabled');
  const [grants, setGrants] = useState<CapabilityGrant[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open || !app) return;
    setPage('overview');
    setName(app.name);
    setDescription(app.description ?? '');
    setVersion(app.version);
    setStatus(app.status);
    setIcon(app.icon ?? '');
    setDomainId(app.domainId ?? '');
    setOwnerAgentId(app.ownerAgentId ?? '');
    setEntrySurfaceId(app.entrySurfaceId ?? '');
    setAudience(app.policy.audience);
    setShareable(app.policy.shareable);
    setCustomCode(app.policy.customCode);
    setGrants(app.policy.grants);
    setError(null);
    setSaving(false);
  }, [app, open]);

  if (!open || !app) return null;

  const trimmedIcon = icon.trim();
  const entrySurface = surfaces.find((surface) => surface.id === entrySurfaceId) ?? null;
  const selectedDomain = domains.find((domain) => domain.id === domainId) ?? null;
  const selectedOwner = agents.find((agent) => agent.id === ownerAgentId) ?? null;
  const domainManager = selectedDomain?.managerId
    ? agents.find((agent) => agent.id === selectedDomain.managerId) ?? null
    : null;
  const orgSummary = selectedDomain
    ? `${selectedDomain.name}${domainManager ? ` · ${domainManager.name}` : ''}`
    : 'Unassigned';
  const audienceSummary = audience.length
    ? audience.map((value) => AUDIENCE_OPTIONS.find((option) => option.value === value)?.label ?? value).join(', ')
    : 'Workspace members only';

  async function submit(event: { preventDefault: () => void }) {
    event.preventDefault();
    if (!app || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: name.trim() || app.name,
        description: description.trim(),
        version: version.trim() || app.version,
        status,
        icon: trimmedIcon || null,
        domainId: domainId || null,
        ownerAgentId: ownerAgentId || null,
        entrySurfaceId: entrySurfaceId || null,
        policy: {
          audience,
          shareable,
          customCode,
          grants: grants.filter((grant) => grant.capability.trim()),
        },
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to save app settings');
    } finally {
      setSaving(false);
    }
  }

  async function loadIconFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await readFileAsDataUrl(file);
      setIcon(dataUrl);
    } finally {
      event.currentTarget.value = '';
    }
  }

  function toggleAudience(value: Audience) {
    setAudience((current) => (
      current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value]
    ));
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-canvas/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="App engine"
      onClick={onClose}
    >
      <form
        onSubmit={(event) => void submit(event)}
        className="flex h-[min(760px,88vh)] w-[min(980px,94vw)] overflow-hidden rounded-2xl border border-line bg-surface shadow-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <aside className="w-52 shrink-0 border-r border-line bg-canvas/55 p-2">
          <div className="px-2 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-accent">App engine</div>
            <div className="mt-2 flex items-center gap-2">
              <AppIconPreview icon={trimmedIcon} />
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold text-text-primary">{name || app.name}</div>
                <div className="truncate text-[11px] text-text-muted">v{version || app.version}</div>
              </div>
            </div>
          </div>
          <nav className="mt-2 space-y-1">
            {ENGINE_PAGES.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setPage(item.id)}
                className={clsx(
                  'flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-[12px] font-medium transition-colors',
                  page === item.id
                    ? 'bg-surface-2 text-text-primary'
                    : 'text-text-muted hover:bg-surface hover:text-text-secondary',
                )}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </nav>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center justify-between border-b border-line px-4">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-text-muted">App engine</div>
              <div className="text-[13px] font-semibold text-text-primary">{ENGINE_PAGES.find((item) => item.id === page)?.label}</div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close app engine"
              className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
            >
              <X size={16} />
            </button>
          </header>

          <div className="min-h-0 flex-1 overflow-auto p-4">
            {error ? (
              <div className="mb-3 rounded-card border border-danger/30 bg-danger-soft px-3 py-2 text-[12px] text-danger">{error}</div>
            ) : null}

            {page === 'overview' && (
              <div className="grid gap-3 md:grid-cols-2">
                <EngineStat label="Status" value={status} />
                <EngineStat label="Version" value={`v${version || app.version}`} />
                <EngineStat label="Surfaces" value={String(surfaces.length)} />
                <EngineStat label="Domain" value={orgSummary} />
                <EngineStat label="Who can use it" value={audienceSummary} />
                <InfoPanel className="md:col-span-2" title="What this app does">
                  {description || 'No description yet. Add one in Identity so operators understand what this app does.'}
                </InfoPanel>
                <InfoPanel title="Entry surface">
                  {entrySurface ? entrySurface.name : 'No entry surface selected.'}
                </InfoPanel>
                <InfoPanel title="Sharing & code">
                  {shareable ? 'Public link enabled' : 'Workspace only'}; {customCode === 'allowed' ? 'custom-coded views allowed' : 'custom code off'}
                </InfoPanel>
              </div>
            )}

            {page === 'identity' && (
              <div className="space-y-4">
                <div className="flex items-start gap-4 rounded-xl border border-line bg-canvas/45 p-3">
                  <AppIconPreview icon={trimmedIcon} size="lg" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <TextField label="Name" value={name} onChange={setName} />
                    <TextField label="Icon, image URL, or emoji" value={icon} onChange={setIcon} placeholder="Store icon, https://..., or data:image/..." />
                    <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={(event) => void loadIconFile(event)} />
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="inline-flex h-8 items-center gap-1.5 rounded-btn border border-line bg-surface-2 px-2.5 text-[12px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary"
                    >
                      <Upload size={13} /> Upload image
                    </button>
                  </div>
                </div>
                <TextareaField label="Description" value={description} onChange={setDescription} rows={5} />
                <div className="grid gap-3 md:grid-cols-2">
                  <TextField label="Version" value={version} onChange={setVersion} />
                  <SelectField label="Lifecycle status" value={status} onChange={(value) => setStatus(value as AppRecord['status'])}>
                    <option value="draft">draft</option>
                    <option value="published">published</option>
                    <option value="archived">archived</option>
                  </SelectField>
                </div>
                <div className="space-y-3 border-t border-line pt-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Organization</div>
                  <p className="-mt-1 text-[11px] text-text-muted">
                    Place this app under a domain (and its manager). Its workflows inherit this when they have no owner of their own.
                  </p>
                  <div className="grid gap-3 md:grid-cols-2">
                    <SelectField label="Domain" value={domainId} onChange={setDomainId}>
                      <option value="">Unassigned</option>
                      {nestedDomainOptions(domains).map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </SelectField>
                    <SelectField label="Owner (specialist)" value={ownerAgentId} onChange={setOwnerAgentId}>
                      <option value="">{domainManager ? `Domain manager (${domainManager.name})` : 'No specific owner'}</option>
                      {agents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name}{agent.role ? ` · ${agent.role}` : ''}
                        </option>
                      ))}
                    </SelectField>
                  </div>
                  {selectedOwner ? (
                    <p className="text-[11px] text-text-muted">This app is owned by {selectedOwner.name}.</p>
                  ) : null}
                </div>
              </div>
            )}

            {page === 'access' && (
              <div className="space-y-4">
                <div>
                  <div className="mb-1 text-[12px] font-semibold text-text-primary">Who can use this app</div>
                  <div className="mb-2 text-[11px] text-text-muted">Leave all unchecked for workspace members only.</div>
                  <div className="grid gap-2 md:grid-cols-2">
                    {AUDIENCE_OPTIONS.map((item) => (
                      <label key={item.value} className="flex items-start gap-2 rounded-card border border-line bg-canvas/45 px-3 py-2 text-[12px] text-text-secondary">
                        <input
                          type="checkbox"
                          checked={audience.includes(item.value)}
                          onChange={() => toggleAudience(item.value)}
                          className="mt-0.5 h-4 w-4 rounded border-line bg-surface text-accent"
                        />
                        <span className="min-w-0">
                          <span className="block font-medium text-text-primary">{item.label}</span>
                          <span className="block text-[11px] text-text-muted">{item.hint}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
                <ToggleField label="Shareable via public link" checked={shareable} onChange={setShareable} />
                <SelectField label="Entry surface" value={entrySurfaceId} onChange={setEntrySurfaceId}>
                  <option value="">No entry surface</option>
                  {surfaces.map((surface) => (
                    <option key={surface.id} value={surface.id}>{surface.name}</option>
                  ))}
                </SelectField>
                {surfaces.length === 0 ? (
                  <InfoPanel title="No surfaces yet">Build a surface in the Interface tab before choosing an entry surface.</InfoPanel>
                ) : null}
              </div>
            )}

            {page === 'advanced' && (
              <div className="space-y-4">
                <ToggleField label="Allow custom-coded views" checked={customCode === 'allowed'} onChange={(value) => setCustomCode(value ? 'allowed' : 'disabled')} />
                <p className="-mt-2 text-[11px] text-text-muted">
                  Custom views run agent-written HTML in a hardened sandbox. Leave off for fully portable apps.
                </p>
                <GrantsEditor grants={grants} onChange={setGrants} />
                <div className="space-y-2 border-t border-line pt-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Distribution</div>
                  <InfoPanel title="Slug">{app.slug}</InfoPanel>
                  <InfoPanel title="Source">{app.source ? `${app.source.kind}:${app.source.id}` : 'Local app, no Hub source attached.'}</InfoPanel>
                  <InfoPanel title="Installed checksum">{app.installedChecksum ?? 'None — this app was built here.'}</InfoPanel>
                  <InfoPanel title="Export">Export this app as a portable .agentisapp package from the editor toolbar.</InfoPanel>
                </div>
              </div>
            )}
          </div>

          <footer className="flex items-center justify-between gap-3 border-t border-line bg-surface-2 px-4 py-3">
            <div className="flex min-w-0 items-center gap-2 text-[11px] text-text-muted">
              <SlidersHorizontal size={13} />
              <span className="truncate">Settings save to this self-hosted Agentis runtime.</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={saving}
                className="inline-flex h-8 items-center justify-center rounded-btn border border-line bg-transparent px-3 text-[12px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="inline-flex h-8 items-center gap-1.5 rounded-btn bg-accent px-3 text-[12px] font-semibold text-canvas hover:bg-accent-hover disabled:opacity-50"
              >
                {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                Save settings
              </button>
            </div>
          </footer>
        </section>
      </form>
    </div>
  );
}

function GrantsEditor({ grants, onChange }: { grants: CapabilityGrant[]; onChange: (grants: CapabilityGrant[]) => void }) {
  function update(index: number, capability: string) {
    onChange(grants.map((grant, i) => (i === index ? { ...grant, capability } : grant)));
  }
  function remove(index: number) {
    onChange(grants.filter((_, i) => i !== index));
  }
  function add() {
    onChange([...grants, { capability: '', scopes: [] }]);
  }
  return (
    <div>
      <div className="mb-1 text-[12px] font-semibold text-text-primary">Capability grants</div>
      <div className="mb-2 text-[11px] text-text-muted">Cross-app or plugin capabilities this app may use. Most apps need none.</div>
      <div className="space-y-2">
        {grants.length === 0 ? (
          <div className="rounded-card border border-dashed border-line px-3 py-2 text-[11px] text-text-muted">No grants.</div>
        ) : grants.map((grant, index) => (
          <div key={index} className="flex items-center gap-2">
            <input
              value={grant.capability}
              onChange={(event) => update(index, event.target.value)}
              placeholder="capability id (e.g. agentmail.send)"
              aria-label={`Grant ${index + 1}`}
              className="h-8 flex-1 rounded-input border border-line bg-surface-2 px-2.5 text-[12px] text-text-primary outline-none focus:border-accent"
            />
            <button
              type="button"
              onClick={() => remove(index)}
              aria-label={`Remove grant ${index + 1}`}
              className="rounded-btn p-1.5 text-text-muted hover:bg-danger-soft hover:text-danger"
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={add}
        className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-btn border border-line bg-surface-2 px-2.5 text-[12px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary"
      >
        <Plus size={13} /> Add grant
      </button>
    </div>
  );
}

function AppIconPreview({ icon, size = 'md' }: { icon: string; size?: 'md' | 'lg' }) {
  const box = size === 'lg' ? 'h-20 w-20 rounded-xl' : 'h-9 w-9 rounded-lg';
  const isImage = icon.startsWith('http://') || icon.startsWith('https://') || icon.startsWith('data:image/');
  return (
    <span className={clsx('flex shrink-0 items-center justify-center overflow-hidden border border-line bg-canvas text-text-secondary', box)}>
      {isImage ? (
        <img src={icon} alt="" className="h-full w-full object-cover" />
      ) : icon ? (
        <span className={size === 'lg' ? 'px-2 text-center text-[24px]' : 'px-1 text-center text-[15px]'}>{icon}</span>
      ) : (
        <Boxes size={size === 'lg' ? 24 : 15} />
      )}
    </span>
  );
}

function EngineStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-canvas/45 p-3">
      <div className="text-[11px] text-text-muted">{label}</div>
      <div className="mt-1 truncate text-[16px] font-semibold text-text-primary">{value}</div>
    </div>
  );
}

function InfoPanel({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <div className={clsx('rounded-xl border border-line bg-canvas/45 p-3', className)}>
      <div className="mb-1 flex items-center gap-1.5 text-[12px] font-semibold text-text-primary">
        <FileText size={13} />
        {title}
      </div>
      <div className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-text-secondary">{children}</div>
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block text-[12px] font-medium text-text-secondary">
      {label}
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="mt-1.5 h-9 w-full rounded-input border border-line bg-surface-2 px-3 text-[13px] text-text-primary outline-none focus:border-accent"
      />
    </label>
  );
}

function TextareaField({
  label,
  value,
  onChange,
  rows,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows: number;
}) {
  return (
    <label className="block text-[12px] font-medium text-text-secondary">
      {label}
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={rows}
        className="mt-1.5 w-full resize-y rounded-input border border-line bg-surface-2 px-3 py-2.5 text-[13px] leading-relaxed text-text-primary outline-none focus:border-accent"
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="block text-[12px] font-medium text-text-secondary">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1.5 h-9 w-full rounded-input border border-line bg-surface-2 px-3 text-[13px] text-text-primary outline-none focus:border-accent"
      >
        {children}
      </select>
    </label>
  );
}

function ToggleField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="flex h-10 items-center justify-between gap-3 rounded-card border border-line bg-canvas/45 px-3 text-[12px] text-text-secondary">
      <span className="font-medium text-text-primary">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
        className="h-4 w-4 rounded border-line bg-surface text-accent"
      />
    </label>
  );
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read image'));
    reader.readAsDataURL(file);
  });
}
