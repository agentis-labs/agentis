/**
 * ExtensionsPanel — the reusable list/detail body of the workspace Extension
 * manager: capability strip, search, list, and the create/edit Studio.
 *
 * Extensions are how you run REAL deterministic code on compute instead of
 * spending LLM tokens: scrapers, parsers, signers, sync jobs, math, custom
 * protocols, and listener sources. Sandboxed (node:vm, or isolated-vm when
 * installed), typed I/O, callable from any workflow node — and powerful enough
 * to build almost anything.
 *
 * No modal-specific concerns live here (no onClose, no overlay/backdrop) so it
 * embeds cleanly inside `ExtensionsModal` — the surface opened from the Apps hub
 * header and each workflow canvas toolbar. The create/edit Studio is portaled to
 * `document.body` so it is never clipped by an `overflow-hidden` ancestor (e.g.
 * the modal's scroll box).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Code2, Plus, Search, Trash2, Pencil, MoreHorizontal, Radio, Globe, Key, Database,
  Boxes, Wand2, Webhook, Network,
} from 'lucide-react';
import { Button, IconButton } from '../shared/Button';
import { EmptyState } from '../shared/EmptyState';
import { Skeleton } from '../shared/Skeleton';
import { useToast } from '../shared/Toast';
import { useConfirm } from '../shared/ConfirmDialog';
import { api, apiErrorMessage } from '../../lib/api';
import { ExtensionStudioModal, type ExtensionInitial } from './ExtensionStudioModal';

interface ExtOperation { name: string; description?: string; isListenerSource?: boolean }
interface ExtManifest {
  description?: string;
  permissions?: string[];
  allowedDomains?: string[];
  credentialKeys?: Array<string | { key: string }>;
  source?: string;
  operations?: ExtOperation[];
  listenerOperations?: string[];
  icon?: string;
}
interface WorkspaceExtension {
  id: string;
  name: string;
  slug: string;
  version: string;
  runtime: string;
  manifest: ExtManifest;
}

const PERM_META: Record<string, { label: string; icon: typeof Globe; tone: string }> = {
  network: { label: 'Network', icon: Globe, tone: 'text-sky-300 bg-sky-500/10' },
  'network.unrestricted': { label: 'Any network', icon: Globe, tone: 'text-sky-300 bg-sky-500/10' },
  credentials: { label: 'Credentials', icon: Key, tone: 'text-amber-300 bg-amber-500/10' },
  'kv.read': { label: 'KV read', icon: Database, tone: 'text-emerald-300 bg-emerald-500/10' },
  'kv.write': { label: 'KV write', icon: Database, tone: 'text-lime-300 bg-lime-500/10' },
  listener: { label: 'Listener', icon: Radio, tone: 'text-violet-300 bg-violet-500/10' },
};

const CAPABILITIES = [
  { icon: Globe, label: 'Web scraping & APIs' },
  { icon: Boxes, label: 'Parsing & transforms' },
  { icon: Key, label: 'Crypto & signing' },
  { icon: Network, label: 'Data sync jobs' },
  { icon: Radio, label: 'Listener sources' },
  { icon: Webhook, label: 'Custom protocols' },
];

function manifestToInitial(ext: WorkspaceExtension): ExtensionInitial {
  const m = ext.manifest ?? {};
  return {
    name: ext.name,
    slug: ext.slug,
    description: m.description,
    source: m.source,
    operations: (m.operations ?? []).map((o) => ({ name: o.name, description: o.description, isListenerSource: o.isListenerSource })),
    permissions: m.permissions ?? [],
    allowedDomains: m.allowedDomains ?? [],
    credentialKeys: m.credentialKeys ?? [],
  };
}

export function ExtensionsPanel({
  onActiveDialogChange,
}: {
  /** Optional: notified when the create/edit Studio opens or closes, so a modal
   *  wrapper can suppress its own close-on-Escape/close-on-backdrop-click while
   *  the Studio is up. Standalone pages can safely omit this. */
  onActiveDialogChange?: (active: boolean) => void;
} = {}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [extensions, setExtensions] = useState<WorkspaceExtension[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [studio, setStudio] = useState<{ mode: 'create' } | { mode: 'edit'; initial: ExtensionInitial } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setExtensions((await api<{ extensions: WorkspaceExtension[] }>('/v1/extensions')).extensions ?? []);
    } catch (err) {
      toast.error('Could not load extensions', apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { onActiveDialogChange?.(Boolean(studio)); }, [studio, onActiveDialogChange]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return extensions;
    return extensions.filter((e) =>
      e.name.toLowerCase().includes(q)
      || e.slug.toLowerCase().includes(q)
      || (e.manifest.description ?? '').toLowerCase().includes(q)
      || (e.manifest.operations ?? []).some((o) => o.name.toLowerCase().includes(q)),
    );
  }, [extensions, search]);

  async function handleDelete(ext: WorkspaceExtension) {
    const ok = await confirm({ title: `Delete ${ext.name}?`, body: 'Workflows that call this extension will stop working. This cannot be undone.', confirmLabel: 'Delete', tone: 'danger' });
    if (!ok) return;
    try { await api(`/v1/extensions/${ext.id}`, { method: 'DELETE' }); toast.success('Extension deleted', ext.name); await refresh(); }
    catch (err) { toast.error('Delete failed', apiErrorMessage(err)); }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Capability strip — what's possible */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line bg-surface-2/40 px-5 py-2.5">
        <span className="mr-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted">Build</span>
        {CAPABILITIES.map((c) => {
          const Icon = c.icon;
          return (
            <span key={c.label} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] text-text-secondary">
              <Icon size={11} className="text-accent" /> {c.label}
            </span>
          );
        })}
      </div>

      {/* Search + create */}
      <div className="flex items-center gap-2 border-b border-line px-5 py-3">
        <div className="relative flex-1">
          <Search size={13} className="absolute left-2.5 top-2.5 text-text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search extensions by name, slug, or operation"
            className="w-full rounded-input border border-line bg-surface-2 py-2 pl-8 pr-2 text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
          />
        </div>
        <Button variant="primary" size="md" iconLeft={<Plus size={14} />} onClick={() => setStudio({ mode: 'create' })}>
          New extension
        </Button>
      </div>

      {/* List */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {loading ? (
          <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-card" />)}</div>
        ) : filtered.length === 0 ? (
          search.trim() ? (
            <EmptyState icon={<Search size={36} />} title="No matching extensions" body="Try a different search, or build the one you need." variant="inline" />
          ) : (
            <ExtensionsEmptyState onCreate={() => setStudio({ mode: 'create' })} />
          )
        ) : (
          <ul className="flex flex-col gap-2">
            {filtered.map((ext) => (
              <li key={ext.id}>
                <ExtensionRow
                  ext={ext}
                  onEdit={() => setStudio({ mode: 'edit', initial: manifestToInitial(ext) })}
                  onDelete={() => handleDelete(ext)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      {studio && createPortal(
        <ExtensionStudioModal
          initial={studio.mode === 'edit' ? studio.initial : undefined}
          onClose={() => setStudio(null)}
          onCreated={() => { setStudio(null); void refresh(); }}
        />,
        document.body,
      )}
    </div>
  );
}

function ExtensionRow({ ext, onEdit, onDelete }: { ext: WorkspaceExtension; onEdit: () => void; onDelete: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const ops = ext.manifest.operations ?? [];
  const perms = ext.manifest.permissions ?? [];
  const isListener = perms.includes('listener') || ops.some((o) => o.isListenerSource) || (ext.manifest.listenerOperations ?? []).length > 0;
  const shownPerms = perms.filter((p) => PERM_META[p]).slice(0, 4);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onEdit}
      onKeyDown={(e) => { if (e.key === 'Enter') onEdit(); }}
      className="flex items-start gap-3 rounded-card border border-line bg-surface px-4 py-3 transition-colors hover:border-line-strong hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-muted"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-card bg-surface-2 text-emerald-300">
        {ext.manifest.icon ? <span className="text-lg">{ext.manifest.icon}</span> : <Code2 size={16} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="truncate text-[13px] font-medium text-text-primary">{ext.name}</h3>
          <span className="rounded-full bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-text-muted">{ext.runtime}</span>
          <span className="text-[10px] text-text-muted">v{ext.version}</span>
          {isListener && (
            <span className="inline-flex items-center gap-1 rounded-full bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-300">
              <Radio size={9} /> Listener source
            </span>
          )}
        </div>
        <p className="mt-0.5 truncate text-[11px] text-text-muted">{ext.manifest.description?.trim() || 'No description'}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] text-text-muted">{ops.length} {ops.length === 1 ? 'operation' : 'operations'}</span>
          {shownPerms.map((p) => {
            const meta = PERM_META[p]!;
            const Icon = meta.icon;
            return (
              <span key={p} className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] ${meta.tone}`}>
                <Icon size={9} /> {meta.label}
              </span>
            );
          })}
        </div>
      </div>
      <div className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
        <IconButton icon={<MoreHorizontal size={14} />} label="More actions" size="sm" onClick={() => setMenuOpen((v) => !v)} />
        {menuOpen && (
          <div className="absolute right-0 top-full z-30 mt-1 w-40 overflow-hidden rounded-card border border-line bg-surface shadow-dropdown" onMouseLeave={() => setMenuOpen(false)}>
            <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-text-secondary hover:bg-surface-2 hover:text-text-primary" onClick={() => { setMenuOpen(false); onEdit(); }}><Pencil size={12} /> Edit</button>
            <button type="button" className="flex w-full items-center gap-2 border-t border-line px-3 py-2 text-left text-[12px] text-danger hover:bg-danger-soft" onClick={() => { setMenuOpen(false); onDelete(); }}><Trash2 size={12} /> Delete</button>
          </div>
        )}
      </div>
    </div>
  );
}

function ExtensionsEmptyState({ onCreate }: { onCreate: () => void }) {
  const examples = [
    { icon: Globe, title: 'Scrape a site or API', body: 'Fetch a page or endpoint, extract exactly the fields you need, return typed JSON.' },
    { icon: Boxes, title: 'Parse & transform data', body: 'CSV→JSON, reshape payloads, compute derived values — deterministically, every time.' },
    { icon: Key, title: 'Sign & verify', body: 'HMAC, JWTs, hashes, custom auth schemes — pure compute, no tokens.' },
    { icon: Radio, title: 'Watch for changes', body: 'A listener source that emits an event when something happens, then fires a workflow.' },
  ];
  return (
    <div className="mx-auto max-w-2xl py-6 text-center">
      <span className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-card border border-emerald-400/20 bg-emerald-500/10 text-emerald-300">
        <Wand2 size={26} />
      </span>
      <h3 className="text-[16px] font-semibold text-text-primary">Build real code that does whatever you want</h3>
      <p className="mx-auto mt-1.5 max-w-lg text-[12px] text-text-muted">
        Extensions are sandboxed deterministic operations — the opposite of an LLM call. Use them when work should be exact,
        fast, and free of token cost. They expose <code className="text-text-secondary">ctx.http</code>, durable{' '}
        <code className="text-text-secondary">ctx.kv</code>, and <code className="text-text-secondary">ctx.emit</code>, and plug into any workflow.
      </p>
      <div className="mt-5 grid grid-cols-1 gap-2 text-left sm:grid-cols-2">
        {examples.map((ex) => {
          const Icon = ex.icon;
          return (
            <div key={ex.title} className="rounded-card border border-line bg-surface-2 p-3">
              <div className="flex items-center gap-2 text-[12px] font-medium text-text-primary"><Icon size={13} className="text-accent" /> {ex.title}</div>
              <p className="mt-1 text-[11px] text-text-muted">{ex.body}</p>
            </div>
          );
        })}
      </div>
      <Button variant="primary" size="md" iconLeft={<Plus size={14} />} className="mt-5" onClick={onCreate}>Build your first extension</Button>
    </div>
  );
}
