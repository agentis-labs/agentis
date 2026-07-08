/**
 * ExtensionStudioModal — the single, modern "build an extension" surface.
 *
 * Shared by the Workflow canvas (via ExtensionCombobox / listener source picker)
 * and the Packages library, so creating an extension is the same fast flow
 * everywhere. Two columns: code on the left, manifest + operations + permissions
 * on the right. First-class listener-source support.
 *
 * Posts to /v1/extensions/install-local (node_worker, node:vm or isolated-vm).
 */

import { useMemo, useState } from 'react';
import { Code2, Plus, Radio, Trash2, X } from 'lucide-react';
import { api, apiErrorMessage } from '../../lib/api';
import { useToast } from '../shared/Toast';

export interface CreatedExtension {
  id: string;
  slug: string;
  name: string;
  runtime: string;
}

type Permission =
  | 'network' | 'credentials' | 'workspace.read' | 'workspace.write' | 'filesystem'
  | 'listener' | 'listener.emit' | 'listener.cursor' | 'kv.read' | 'kv.write';

interface OpDraft {
  name: string;
  description: string;
  isListenerSource: boolean;
}

const PERMISSIONS: Array<{ value: Permission; label: string; hint: string; group: 'core' | 'listener' }> = [
  { value: 'network', label: 'Network', hint: 'HTTP to declared domains', group: 'core' },
  { value: 'credentials', label: 'Credentials', hint: 'Read workspace secrets', group: 'core' },
  { value: 'workspace.read', label: 'Read state', hint: 'Read scratchpad', group: 'core' },
  { value: 'workspace.write', label: 'Write state', hint: 'Write scratchpad', group: 'core' },
  { value: 'filesystem', label: 'Filesystem', hint: 'Sandbox temp dir', group: 'core' },
  { value: 'listener', label: 'Listener source', hint: 'Usable as a trigger source', group: 'listener' },
  { value: 'listener.emit', label: 'Emit events', hint: 'ctx.emit()', group: 'listener' },
  { value: 'listener.cursor', label: 'Cursor', hint: 'ctx.cursor / setCursor', group: 'listener' },
  { value: 'kv.read', label: 'KV read', hint: 'ctx.kv.get', group: 'listener' },
  { value: 'kv.write', label: 'KV write', hint: 'ctx.kv.set', group: 'listener' },
];

const STARTER = `// One exported async function per operation: (inputs, ctx) => structured JSON.
// ctx.http.fetch (sandboxed), ctx.kv (durable), ctx.emit (listener sources).
export async function run(inputs, ctx) {
  const res = await ctx.http.fetch(\`https://api.example.com/items?q=\${inputs.query}\`);
  return { count: res.body.items?.length ?? 0, items: res.body.items ?? [] };
}

// A listener-source operation emits events instead of returning once.
export async function watch(inputs, ctx) {
  const since = ctx.kv.get('since') ?? 0;
  const res = await ctx.http.fetch(\`https://api.example.com/items?since=\${since}\`);
  for (const item of res.body.items ?? []) ctx.emit({ item });
  if (res.body.latest) ctx.kv.set('since', res.body.latest);
}`;

const inputCls = 'h-8 w-full rounded-input border border-line bg-surface-2 px-2 text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none';
const labelCls = 'mb-1 block text-[11px] font-medium text-text-secondary';

function slugify(v: string): string {
  return v.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

export interface ExtensionInitial {
  name: string;
  slug: string;
  description?: string;
  source?: string;
  operations?: Array<{ name: string; description?: string; isListenerSource?: boolean }>;
  permissions?: string[];
  allowedDomains?: string[];
  credentialKeys?: Array<string | { key: string }>;
}

const ALL_PERMS = new Set<string>(PERMISSIONS.map((p) => p.value));

export function ExtensionStudioModal({
  onClose,
  onCreated,
  initial,
}: {
  onClose: () => void;
  onCreated: (ext: CreatedExtension) => void;
  initial?: ExtensionInitial;
}) {
  const toast = useToast();
  const editing = !!initial;
  const [name, setName] = useState(initial?.name ?? 'My Extension');
  const [slug, setSlug] = useState(initial?.slug ?? 'my-extension');
  const [slugTouched, setSlugTouched] = useState(editing);
  const [description, setDescription] = useState(initial?.description ?? '');
  const [source, setSource] = useState(initial?.source ?? STARTER);
  const [operations, setOperations] = useState<OpDraft[]>(
    initial?.operations?.length
      ? initial.operations.map((o) => ({ name: o.name, description: o.description ?? '', isListenerSource: !!o.isListenerSource }))
      : [
          { name: 'run', description: 'Fetch and return structured data.', isListenerSource: false },
          { name: 'watch', description: 'Emit events as a listener source.', isListenerSource: true },
        ],
  );
  const [permissions, setPermissions] = useState<Set<Permission>>(
    initial?.permissions
      ? new Set(initial.permissions.filter((p): p is Permission => ALL_PERMS.has(p)))
      : new Set(['network', 'listener', 'listener.emit', 'kv.read', 'kv.write']),
  );
  const [allowedDomains, setAllowedDomains] = useState(initial?.allowedDomains?.join(', ') ?? 'api.example.com');
  const [credentialKeys, setCredentialKeys] = useState(
    (initial?.credentialKeys ?? []).map((k) => (typeof k === 'string' ? k : k.key)).join(', '),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasListenerOp = useMemo(() => operations.some((o) => o.isListenerSource), [operations]);

  const togglePerm = (p: Permission) =>
    setPermissions((prev) => {
      const next = new Set(prev);
      next.has(p) ? next.delete(p) : next.add(p);
      return next;
    });

  function setName_(v: string) {
    setName(v);
    if (!slugTouched) setSlug(slugify(v));
  }

  function updateOp(idx: number, patch: Partial<OpDraft>) {
    setOperations((cur) => cur.map((op, i) => (i === idx ? { ...op, ...patch } : op)));
    if (patch.isListenerSource) {
      setPermissions((prev) => new Set(prev).add('listener').add('listener.emit'));
    }
  }

  async function submit() {
    setError(null);
    const cleanName = name.trim();
    const cleanSlug = slugify(slug || name);
    if (!cleanName || !cleanSlug) return setError('Name and slug are required.');
    const ops = operations.map((o) => ({ ...o, name: o.name.trim() })).filter((o) => o.name);
    if (ops.length === 0) return setError('Add at least one named operation.');
    const domains = allowedDomains.split(',').map((s) => s.trim()).filter(Boolean);
    const creds = credentialKeys.split(',').map((s) => s.trim()).filter(Boolean);
    const perms = [...permissions];
    if (perms.includes('network') && domains.length === 0) return setError('Network permission needs at least one allowed domain.');
    if (perms.includes('credentials') && creds.length === 0) return setError('Credentials permission needs at least one credential key.');
    const listenerOperations = ops.filter((o) => o.isListenerSource).map((o) => o.name);
    if (listenerOperations.length && !perms.includes('listener')) return setError('Grant the "Listener source" permission to expose a listener operation.');

    setSaving(true);
    try {
      const manifest = {
        name: cleanName,
        slug: cleanSlug,
        version: '1.0.0',
        description: description.trim() || undefined,
        runtime: 'node_worker' as const,
        entrypoint: 'index.js',
        source,
        operations: ops.map((o) => ({
          name: o.name,
          description: o.description.trim() || undefined,
          inputSchema: {},
          outputSchema: {},
          ...(o.isListenerSource ? { isListenerSource: true } : {}),
        })),
        ...(listenerOperations.length ? { listenerOperations } : {}),
        permissions: perms,
        allowedDomains: domains,
        credentialKeys: creds,
        capabilityTags: [],
      };
      const res = await api<{ extension: CreatedExtension }>('/v1/extensions/install-local', {
        method: 'POST',
        body: JSON.stringify({ manifest, permissionsAcknowledged: perms }),
      });
      toast.success(editing ? 'Extension saved' : 'Extension created', cleanName);
      onCreated({ id: res.extension.id, slug: cleanSlug, name: cleanName, runtime: 'node_worker' });
    } catch (err) {
      setError(apiErrorMessage(err));
      toast.error(editing ? 'Could not save extension' : 'Could not create extension', apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-[70] bg-overlay-soft" onClick={onClose} />
      <div className="fixed inset-0 z-[71] m-auto flex h-[88vh] max-h-[900px] w-[min(1100px,94vw)] flex-col overflow-hidden rounded-card border border-line bg-surface shadow-modal">
        <div className="flex items-center gap-3 border-b border-line px-5 py-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-card border border-emerald-400/20 bg-emerald-500/10 text-emerald-300">
            <Code2 size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-medium text-text-primary">{editing ? 'Edit extension' : 'Build extension'}</div>
            <div className="text-[11px] text-text-muted">Real deterministic code that runs on compute — no LLM tokens. Sandboxed (node:vm, or isolated-vm when installed).</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="-m-1 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"><X size={16} /></button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[1.3fr_1fr]">
          {/* Code */}
          <div className="flex min-h-0 flex-col border-r border-line">
            <div className="border-b border-line px-4 py-1.5 text-[10px] uppercase tracking-wider text-text-muted">Code</div>
            <textarea
              value={source}
              onChange={(e) => setSource(e.target.value)}
              spellCheck={false}
              className="flex-1 resize-none bg-canvas px-4 py-3 font-mono text-[12px] leading-relaxed text-text-primary focus:outline-none"
            />
          </div>

          {/* Config */}
          <div className="min-h-0 overflow-y-auto px-4 py-3">
            <label className={labelCls}>Name</label>
            <input className={inputCls} value={name} onChange={(e) => setName_(e.target.value)} />
            <label className={`${labelCls} mt-3`}>Slug{editing && <span className="ml-1 text-text-muted">· locked</span>}</label>
            <input
              className={`${inputCls} font-mono ${editing ? 'opacity-60' : ''}`}
              value={slug}
              readOnly={editing}
              onChange={(e) => { setSlug(e.target.value); setSlugTouched(true); }}
            />
            <label className={`${labelCls} mt-3`}>Description</label>
            <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What does it do?" />

            {/* Operations */}
            <div className="mt-4 flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-wider text-text-muted">Operations</span>
              <button type="button" onClick={() => setOperations((c) => [...c, { name: '', description: '', isListenerSource: false }])} className="inline-flex items-center gap-1 rounded-pill border border-line px-2 py-0.5 text-[10px] text-text-secondary hover:border-accent/50 hover:text-text-primary">
                <Plus size={11} /> Add
              </button>
            </div>
            <div className="mt-1 space-y-2">
              {operations.map((op, idx) => (
                <div key={idx} className="rounded-md border border-line bg-surface-2 p-2">
                  <div className="flex items-center gap-2">
                    <input className={`${inputCls} font-mono`} placeholder="operationName" value={op.name} onChange={(e) => updateOp(idx, { name: e.target.value.replace(/[^A-Za-z0-9_$]/g, '') })} />
                    {operations.length > 1 && (
                      <button type="button" onClick={() => setOperations((c) => c.filter((_, i) => i !== idx))} className="shrink-0 rounded-md p-1 text-text-muted hover:bg-canvas hover:text-danger"><Trash2 size={13} /></button>
                    )}
                  </div>
                  <input className={`${inputCls} mt-1.5`} placeholder="description" value={op.description} onChange={(e) => updateOp(idx, { description: e.target.value })} />
                  <label className="mt-1.5 flex cursor-pointer items-center gap-1.5 text-[11px] text-text-secondary">
                    <input type="checkbox" checked={op.isListenerSource} onChange={(e) => updateOp(idx, { isListenerSource: e.target.checked })} />
                    <Radio size={11} className="text-violet-300" /> Listener source
                  </label>
                </div>
              ))}
            </div>

            {/* Permissions */}
            <div className="mt-4 text-[11px] font-medium uppercase tracking-wider text-text-muted">Permissions</div>
            <div className="mt-1 grid grid-cols-2 gap-1">
              {PERMISSIONS.map((p) => (
                <label key={p.value} title={p.hint} className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] ${permissions.has(p.value) ? 'border-accent bg-accent/10 text-text-primary' : 'border-line text-text-secondary'} ${p.group === 'listener' ? 'border-l-2 border-l-violet-400/40' : ''}`}>
                  <input type="checkbox" checked={permissions.has(p.value)} onChange={() => togglePerm(p.value)} />
                  {p.label}
                </label>
              ))}
            </div>

            {permissions.has('network') && (
              <>
                <label className={`${labelCls} mt-3`}>Allowed domains (comma-separated)</label>
                <input className={inputCls} value={allowedDomains} onChange={(e) => setAllowedDomains(e.target.value)} placeholder="api.example.com" />
              </>
            )}
            {permissions.has('credentials') && (
              <>
                <label className={`${labelCls} mt-3`}>Credential keys (comma-separated)</label>
                <input className={inputCls} value={credentialKeys} onChange={(e) => setCredentialKeys(e.target.value)} />
              </>
            )}

            {hasListenerOp && (
              <p className="mt-3 rounded-md border border-violet-400/30 bg-violet-500/5 px-2 py-1.5 text-[10px] text-text-muted">
                <Radio size={10} className="mr-1 inline text-violet-300" />
                This extension exposes a listener source. Pick it in a workflow’s Persistent listener trigger to fire on emitted events.
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
          <span className="text-[11px] text-danger">{error}</span>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="rounded-md border border-line px-3 py-1.5 text-[12px] text-text-secondary hover:text-text-primary">Cancel</button>
            <button type="button" onClick={() => void submit()} disabled={saving} className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:bg-accent/90 disabled:opacity-60">
              {saving ? 'Saving…' : editing ? 'Save changes' : 'Create extension'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}



