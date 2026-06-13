/**
 * CustomIntegrationDialog — author a new HTTP connector from the canvas.
 *
 * When the catalog doesn't have the service a user needs, they can define one
 * here: name + logo + auth + one-or-more operations (method/URL/body templates).
 * It's saved via `/v1/integrations` and immediately appears in the catalog with
 * its real logo, usable from any integration node — no code, no redeploy.
 */
import { useMemo, useState, type FormEvent } from 'react';
import { X, Plus, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { createIntegration, type CustomIntegrationInput, type HttpMethod, type IntegrationAuthType } from '../../lib/integrations';
import { apiErrorMessage } from '../../lib/api';
import { CONNECTOR_LOGO_IDS } from '../canvas/connectorLogos.generated';
import { connectorLogoUrl } from '../canvas/connectorLogo';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (service: string) => void;
}

interface OpDraft { name: string; method: HttpMethod; urlTemplate: string; }

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const AUTH_TYPES: { value: IntegrationAuthType; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'bearer', label: 'Bearer token' },
  { value: 'api_key', label: 'API key (header)' },
  { value: 'basic', label: 'Basic auth' },
];
const LOGO_IDS = [...CONNECTOR_LOGO_IDS].sort();

function slugify(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
}

const inputCls =
  'h-9 w-full rounded-input border border-line bg-surface-2 px-2.5 text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none';

export function CustomIntegrationDialog({ open, onClose, onCreated }: Props) {
  const [name, setName] = useState('');
  const [serviceEdited, setServiceEdited] = useState(false);
  const [service, setService] = useState('');
  const [category, setCategory] = useState('Custom');
  const [description, setDescription] = useState('');
  const [authType, setAuthType] = useState<IntegrationAuthType>('bearer');
  const [headerName, setHeaderName] = useState('');
  const [icon, setIcon] = useState('');
  const [iconQuery, setIconQuery] = useState('');
  const [ops, setOps] = useState<OpDraft[]>([{ name: 'request', method: 'GET', urlTemplate: 'https://api.example.com/v1/resource' }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveService = serviceEdited ? service : slugify(name);
  const filteredLogos = useMemo(() => {
    const q = iconQuery.trim().toLowerCase();
    return q ? LOGO_IDS.filter((id) => id.includes(q)) : LOGO_IDS;
  }, [iconQuery]);

  if (!open) return null;

  function setOp(i: number, patch: Partial<OpDraft>) {
    setOps((prev) => prev.map((op, idx) => (idx === i ? { ...op, ...patch } : op)));
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const cleanOps = ops
      .map((op) => ({ ...op, name: slugify(op.name), urlTemplate: op.urlTemplate.trim() }))
      .filter((op) => op.name && op.urlTemplate);
    if (!name.trim()) { setError('Give the integration a name.'); return; }
    if (!effectiveService) { setError('A service id is required.'); return; }
    if (cleanOps.length === 0) { setError('Add at least one operation with a name and URL.'); return; }
    const input: CustomIntegrationInput = {
      service: effectiveService,
      name: name.trim(),
      category: category.trim() || 'Custom',
      description: description.trim() || `Custom ${name.trim()} integration.`,
      auth: authType === 'api_key' ? { type: authType, headerName: headerName.trim() || 'X-API-Key' } : { type: authType },
      operationSpecs: cleanOps.map((op) => ({ name: op.name, method: op.method, urlTemplate: op.urlTemplate })),
      ...(icon ? { icon } : {}),
    };
    setSaving(true);
    try {
      const { integration } = await createIntegration(input);
      onCreated(integration.service);
      onClose();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="animate-fade-in fixed inset-0 z-[70] flex items-center justify-center bg-overlay p-4" role="dialog" aria-modal="true">
      <form onSubmit={handleSave} className="animate-scale-in flex max-h-[88vh] w-full max-w-lg flex-col rounded-modal border border-line bg-surface shadow-modal">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div>
            <div className="text-[14px] font-semibold text-text-primary">New integration</div>
            <div className="text-[11px] text-text-muted">Define a custom HTTP connector — it joins the catalog instantly.</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-text-secondary">Name</span>
              <input className={inputCls} value={name} placeholder="Acme CRM" onChange={(e) => setName(e.target.value)} autoFocus />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-text-secondary">Service id</span>
              <input className={inputCls} value={effectiveService} placeholder="acme_crm" onChange={(e) => { setServiceEdited(true); setService(slugify(e.target.value)); }} />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-text-secondary">Category</span>
              <input className={inputCls} value={category} onChange={(e) => setCategory(e.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-text-secondary">Auth</span>
              <select className={inputCls} value={authType} onChange={(e) => setAuthType(e.target.value as IntegrationAuthType)}>
                {AUTH_TYPES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
              </select>
            </label>
          </div>
          {authType === 'api_key' && (
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-text-secondary">API key header name</span>
              <input className={inputCls} value={headerName} placeholder="X-API-Key" onChange={(e) => setHeaderName(e.target.value)} />
            </label>
          )}
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-text-secondary">Description</span>
            <input className={inputCls} value={description} placeholder="What this integration does" onChange={(e) => setDescription(e.target.value)} />
          </label>

          {/* Operations */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">Operations</span>
              <button type="button" onClick={() => setOps((p) => [...p, { name: '', method: 'POST', urlTemplate: '' }])} className="inline-flex items-center gap-1 rounded-btn border border-line px-2 py-1 text-[11px] text-text-secondary hover:border-accent/50 hover:text-text-primary">
                <Plus size={12} /> Add
              </button>
            </div>
            <div className="space-y-1.5">
              {ops.map((op, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <input className={clsx(inputCls, 'w-24 shrink-0')} value={op.name} placeholder="create" onChange={(e) => setOp(i, { name: e.target.value })} />
                  <select className={clsx(inputCls, 'w-20 shrink-0')} value={op.method} onChange={(e) => setOp(i, { method: e.target.value as HttpMethod })}>
                    {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <input className={inputCls} value={op.urlTemplate} placeholder="https://api.acme.com/{{params.id}}" onChange={(e) => setOp(i, { urlTemplate: e.target.value })} />
                  {ops.length > 1 && (
                    <button type="button" onClick={() => setOps((p) => p.filter((_, idx) => idx !== i))} aria-label="Remove operation" className="shrink-0 rounded-md p-1.5 text-text-muted hover:bg-surface-2 hover:text-danger">
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="mt-1 text-[10px] text-text-muted">URL/body support <code className="rounded bg-surface-2 px-1">{'{{params.x}}'}</code> templating from node inputs.</div>
          </div>

          {/* Logo picker */}
          <div>
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-text-muted">Logo</span>
            <input className={clsx(inputCls, 'mb-1.5')} value={iconQuery} placeholder="Search brand logos…" onChange={(e) => setIconQuery(e.target.value)} />
            <div className="grid max-h-28 grid-cols-8 gap-1 overflow-y-auto rounded-input border border-line bg-surface-2 p-1.5">
              <button type="button" onClick={() => setIcon('')} className={clsx('flex h-8 items-center justify-center rounded-md border text-[9px]', !icon ? 'border-accent bg-accent-soft text-accent' : 'border-line text-text-muted hover:border-line-strong')}>none</button>
              {filteredLogos.map((id) => {
                const url = connectorLogoUrl(id);
                return (
                  <button key={id} type="button" title={id} onClick={() => setIcon(id)} className={clsx('flex h-8 items-center justify-center rounded-md border', icon === id ? 'border-accent bg-accent-soft' : 'border-line hover:border-line-strong')}>
                    {url && <img src={url} alt={id} className="h-4 w-4 object-contain" />}
                  </button>
                );
              })}
            </div>
          </div>

          {error && <div className="rounded-input border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-[11px] text-danger">{error}</div>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
          <button type="button" onClick={onClose} className="h-9 rounded-btn border border-line px-3 text-[12px] font-medium text-text-secondary hover:bg-surface-2">Cancel</button>
          <button type="submit" disabled={saving} className="inline-flex h-9 items-center rounded-btn bg-accent px-4 text-[12px] font-semibold text-canvas hover:bg-accent-hover disabled:opacity-50">
            {saving ? 'Creating…' : 'Create integration'}
          </button>
        </div>
      </form>
    </div>
  );
}
