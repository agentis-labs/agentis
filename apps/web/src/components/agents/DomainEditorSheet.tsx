import { useEffect, useMemo, useState } from 'react';
import { Check, Loader2, Trash2, X } from 'lucide-react';
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
  onClose: () => void;
  onSaved: (domain: DomainOption | null) => void;
}

const DEFAULT_DOMAIN_COLOR = '#22c55e';
const COLOR_SWATCHES = [DEFAULT_DOMAIN_COLOR, '#06b6d4', '#8b5cf6', '#f59e0b', '#ef4444', '#64748b'];

export function DomainEditorSheet({
  open,
  domain,
  managers,
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
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(domain?.name ?? '');
    setDescription(domain?.description ?? '');
    setColorHex(domain?.colorHex ?? DEFAULT_DOMAIN_COLOR);
    setManagerId(domain?.managerId ?? '');
  }, [domain, open]);

  const title = editing ? 'Edit domain' : 'Create domain';
  const slug = useMemo(() => slugify(name), [name]);
  const canSave = name.trim().length >= 2 && /^#[0-9a-fA-F]{6}$/.test(colorHex);

  if (!open) return null;

  async function save() {
    if (!canSave) return;
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        slug,
        description: description.trim() || null,
        colorHex,
        managerId: managerId || null,
      };
      const response = await api<{ data: DomainOption }>(
        editing ? `/v1/spaces/${domain!.id}` : '/v1/spaces',
        { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(payload) },
      );
      toast.success(editing ? 'Domain updated' : 'Domain created', response.data.name);
      onSaved(response.data);
      onClose();
    } catch (error) {
      toast.error(editing ? 'Could not update domain' : 'Could not create domain', apiErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!domain?.id) return;
    const ok = await confirm({
      title: `Delete ${domain.name}?`,
      body: 'Agents and workflows in this domain will stay in the workspace and become unassigned.',
      confirmLabel: 'Delete domain',
      tone: 'danger',
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await api(`/v1/spaces/${domain.id}`, { method: 'DELETE' });
      toast.success('Domain deleted', domain.name);
      onSaved(null);
      onClose();
    } catch (error) {
      toast.error('Could not delete domain', apiErrorMessage(error));
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
            <p className="mt-1 text-xs text-text-muted">Domains organize managers, agents, and workflows without leaving the fleet.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary">
            <X size={16} />
          </button>
        </header>

        <main className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-text-secondary">Name</span>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Marketing"
              className={inputCls}
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-text-secondary">Description</span>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
              placeholder="What this domain owns."
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

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-text-secondary">Manager</span>
            <select value={managerId} onChange={(event) => setManagerId(event.target.value)} className={inputCls}>
              <option value="">No manager yet</option>
              {managers.map((manager) => (
                <option key={manager.id} value={manager.id}>{manager.name}</option>
              ))}
            </select>
          </label>
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
              {editing ? 'Save domain' : 'Create domain'}
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

const inputCls = 'mt-1 w-full rounded-input border border-line bg-surface-2 px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-accent';
const secondaryBtnCls = 'inline-flex h-9 items-center gap-1.5 rounded-btn border border-line px-3 text-xs font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary';
const primaryBtnCls = 'inline-flex h-9 items-center gap-1.5 rounded-btn bg-accent px-3 text-xs font-semibold text-canvas hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40';
