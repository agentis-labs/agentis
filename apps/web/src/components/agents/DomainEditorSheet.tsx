import { useEffect, useMemo, useState } from 'react';
import { Check, Loader2, Plus, Trash2, X } from 'lucide-react';
import clsx from 'clsx';
import { api, apiErrorMessage } from '../../lib/api';
import { useConfirm } from '../shared/ConfirmDialog';
import { useToast } from '../shared/Toast';

export interface DomainOption {
  id: string;
  name: string;
  slug?: string | null;
  description?: string | null;
  colorHex?: string | null;
  managerId?: string | null;
  /** When set, this domain is a Subdomain nested under the referenced Domain. */
  parentDomainId?: string | null;
}

export interface DomainManagerOption {
  id: string;
  name: string;
  role?: string | null;
}

interface DomainEditorSheetProps {
  open: boolean;
  domain?: DomainOption | null;
  managers: DomainManagerOption[];
  /** Top-level Domains a Subdomain can nest under (resolves the parent name/manager). */
  parentOptions?: DomainOption[];
  /** Specialists that can own a Subdomain (falls back to managers). */
  specialists?: DomainManagerOption[];
  /** Preset parent when creating a new subdomain (the "Add subdomain" flow). */
  initialParentDomainId?: string | null;
  /** Children of the top-level domain being edited â€” drives the Subdomains section. */
  subdomains?: DomainOption[];
  /** Resolve an owner agent id â†’ display name (subdomains list + owner picker). */
  resolveAgentName?: (agentId: string | null | undefined) => string | undefined;
  /** Specialist count under a subdomain (badge in the list). */
  specialistCountFor?: (subdomainId: string) => number;
  onAddSubdomain?: () => void;
  onEditSubdomain?: (subdomain: DomainOption) => void;
  /** Persist the subdomain (if new), then hand off to create a specialist to own it. */
  onCreateSpecialist?: (ctx: { subdomainId: string; parentManagerId: string | null }) => void;
  onClose: () => void;
  onSaved: (domain: DomainOption | null) => void;
}

const DEFAULT_DOMAIN_COLOR = '#22c55e';
const COLOR_SWATCHES = [DEFAULT_DOMAIN_COLOR, '#06b6d4', '#8b5cf6', '#f59e0b', '#ef4444', '#64748b'];

export function DomainEditorSheet({
  open,
  domain,
  managers,
  parentOptions = [],
  specialists = [],
  initialParentDomainId = null,
  subdomains = [],
  resolveAgentName,
  specialistCountFor,
  onAddSubdomain,
  onEditSubdomain,
  onCreateSpecialist,
  onClose,
  onSaved,
}: DomainEditorSheetProps) {
  const toast = useToast();
  const confirm = useConfirm();
  const editing = Boolean(domain?.id);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [colorHex, setColorHex] = useState(DEFAULT_DOMAIN_COLOR);
  const [managerId, setManagerId] = useState('');
  const [parentDomainId, setParentDomainId] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(domain?.name ?? '');
    setDescription(domain?.description ?? '');
    setColorHex(domain?.colorHex ?? DEFAULT_DOMAIN_COLOR);
    setManagerId(domain?.managerId ?? '');
    setParentDomainId(domain?.parentDomainId ?? initialParentDomainId ?? '');
  }, [domain, initialParentDomainId, open]);

  // A Subdomain is owned by a responsible specialist; a top-level Domain by a manager.
  const isSubdomain = Boolean(parentDomainId);
  const ownerOptions = isSubdomain && specialists.length > 0 ? specialists : managers;
  const ownerLabel = isSubdomain ? 'Responsible specialist' : 'Manager';
  const parentDomain = parentOptions.find((option) => option.id === parentDomainId) ?? null;
  const parentManagerId = parentDomain?.managerId ?? null;
  const entity = isSubdomain ? 'subdomain' : 'domain';
  const title = editing ? `Edit ${entity}` : `Create ${entity}`;
  const slug = useMemo(() => slugify(name), [name]);
  const canSave = name.trim().length >= 2 && /^#[0-9a-fA-F]{6}$/.test(colorHex);
  const showSubdomainsSection = editing && !isSubdomain && Boolean(onAddSubdomain);

  if (!open) return null;

  /** Create/update the domain row; returns it (no toast/close). */
  async function persist(): Promise<DomainOption | null> {
    if (!canSave) return null;
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        slug,
        description: description.trim() || null,
        colorHex,
        managerId: managerId || null,
        parentDomainId: parentDomainId || null,
      };
      const response = await api<{ data: DomainOption }>(
        editing ? `/v1/domains/${domain!.id}` : '/v1/domains',
        { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(payload) },
      );
      return response.data;
    } catch (error) {
      toast.error(editing ? `Could not update ${entity}` : `Could not create ${entity}`, apiErrorMessage(error));
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function save() {
    const saved = await persist();
    if (!saved) return;
    toast.success(editing ? `${capitalize(entity)} updated` : `${capitalize(entity)} created`, saved.name);
    onSaved(saved);
    onClose();
  }

  /** Save the subdomain first (so it has an id + parent), then hand off to the wizard. */
  async function createSpecialist() {
    const saved = await persist();
    if (!saved) return;
    onSaved(saved);
    onCreateSpecialist?.({ subdomainId: saved.id, parentManagerId });
  }

  async function remove() {
    if (!domain?.id) return;
    const ok = await confirm({
      title: `Delete ${domain.name}?`,
      body: isSubdomain
        ? 'Its specialist and workflows stay in the workspace and become unassigned from this subdomain.'
        : 'Its subdomains are removed; agents and workflows stay in the workspace and become unassigned.',
      confirmLabel: `Delete ${entity}`,
      tone: 'danger',
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await api(`/v1/domains/${domain.id}`, { method: 'DELETE' });
      toast.success(`${capitalize(entity)} deleted`, domain.name);
      onSaved(null);
      onClose();
    } catch (error) {
      toast.error(`Could not delete ${entity}`, apiErrorMessage(error));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex justify-end bg-overlay-soft"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <aside
        className="flex h-full w-full max-w-[460px] animate-slide-in-right flex-col border-l border-line bg-surface shadow-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-heading text-text-primary">{title}</h2>
            <p className="mt-1 text-xs text-text-muted">
              {isSubdomain
                ? 'A subdomain is a focused area owned by one specialist, grouping its workflows.'
                : 'Domains organize managers, agents, and workflows without leaving the fleet.'}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary">
            <X size={16} />
          </button>
        </header>

        <main className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
          {isSubdomain && parentDomain && (
            <div className="flex items-center gap-2 rounded-input border border-line bg-surface-2 px-3 py-2 text-[11px] text-text-muted">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: parentDomain.colorHex ?? '#64748b' }} />
              Subdomain of <span className="font-medium text-text-secondary">{parentDomain.name}</span>
            </div>
          )}

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-text-secondary">Name</span>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={isSubdomain ? 'SEO' : 'Marketing'}
              className={inputCls}
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-text-secondary">Description</span>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
              placeholder={isSubdomain ? 'What this subdomain covers.' : 'What this domain owns.'}
              className={clsx(inputCls, 'h-auto resize-none py-2')}
            />
          </label>

          <div className="space-y-2">
            <span className="text-xs font-medium text-text-secondary">Color</span>
            <div className="flex flex-wrap gap-2">
              {COLOR_SWATCHES.map((swatch) => (
                <button
                  key={swatch}
                  type="button"
                  onClick={() => setColorHex(swatch)}
                  aria-label={`Use ${swatch}`}
                  className={clsx(
                    'inline-flex h-8 w-8 items-center justify-center rounded-full border transition',
                    colorHex === swatch ? 'border-white/80 ring-2 ring-white/20' : 'border-line hover:border-line-strong',
                  )}
                  style={{ backgroundColor: swatch }}
                >
                  {colorHex === swatch && <Check size={13} className="text-canvas" />}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-text-secondary">{ownerLabel}</span>
              <select value={managerId} onChange={(event) => setManagerId(event.target.value)} className={inputCls}>
                <option value="">{isSubdomain ? 'No specialist yet' : 'No manager yet'}</option>
                {ownerOptions.map((owner) => (
                  <option key={owner.id} value={owner.id}>{owner.name}</option>
                ))}
              </select>
            </label>
            {isSubdomain && onCreateSpecialist && (
              <button
                type="button"
                onClick={() => void createSpecialist()}
                disabled={saving || !canSave}
                className="inline-flex items-center gap-1.5 rounded-btn px-1 py-0.5 text-[11px] font-medium text-accent hover:text-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
                Create a new specialist for this subdomain
              </button>
            )}
          </div>

          {showSubdomainsSection && (
            <div className="space-y-2 border-t border-line pt-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-text-secondary">Subdomains</span>
                <button
                  type="button"
                  onClick={onAddSubdomain}
                  className="inline-flex h-7 items-center gap-1 rounded-btn border border-line bg-surface-2 px-2 text-[11px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary"
                >
                  <Plus size={11} /> Add subdomain
                </button>
              </div>
              {subdomains.length === 0 ? (
                <p className="text-[11px] text-text-muted">
                  No subdomains yet. Add one to give a specialist a focused area (e.g. SEO, inbound) under {domain?.name ?? 'this domain'}.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {subdomains.map((sub) => {
                    const ownerName = resolveAgentName?.(sub.managerId) ?? null;
                    const count = specialistCountFor?.(sub.id) ?? 0;
                    return (
                      <li key={sub.id}>
                        <button
                          type="button"
                          onClick={() => onEditSubdomain?.(sub)}
                          className="flex w-full items-center gap-2 rounded-btn border border-line bg-surface-2 px-3 py-2 text-left transition-colors hover:bg-surface-3"
                        >
                          <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: sub.colorHex ?? '#64748b' }} />
                          <span className="flex-1 truncate text-[12px] font-medium text-text-primary">{sub.name}</span>
                          <span className={clsx('truncate text-[10px]', ownerName ? 'text-text-secondary' : 'text-text-muted')}>
                            {ownerName ?? 'No specialist'}
                          </span>
                          {count > 0 && (
                            <span className="rounded-full bg-surface-3 px-1.5 py-0.5 text-[9px] font-medium text-text-muted">{count}</span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </main>

        <footer className="flex items-center justify-between gap-2 border-t border-line bg-surface-2 px-5 py-3">
          {editing ? (
            <button
              type="button"
              onClick={() => void remove()}
              disabled={deleting || saving}
              className="inline-flex h-9 items-center gap-1.5 rounded-btn border border-danger/35 px-3 text-xs font-medium text-danger hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {deleting ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
              Delete
            </button>
          ) : <span />}
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className={secondaryBtnCls}>Cancel</button>
            <button type="button" disabled={saving || !canSave} onClick={() => void save()} className={primaryBtnCls}>
              {saving ? <Loader2 size={12} className="animate-spin" /> : null}
              {editing ? `Save ${entity}` : `Create ${entity}`}
            </button>
          </div>
        </footer>
      </aside>
    </div>
  );
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'domain';
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

const inputCls = 'mt-1 w-full rounded-input border border-line bg-surface-2 px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-accent';
const secondaryBtnCls = 'inline-flex h-9 items-center gap-1.5 rounded-btn border border-line px-3 text-xs font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary';
const primaryBtnCls = 'inline-flex h-9 items-center gap-1.5 rounded-btn bg-accent px-3 text-xs font-semibold text-canvas hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40';



