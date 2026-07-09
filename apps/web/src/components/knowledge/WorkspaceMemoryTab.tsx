import { useEffect, useMemo, useState } from 'react';
import { FileText, Trash2 } from 'lucide-react';
import { useConfirm } from '../shared/ConfirmDialog';
import { api } from '../../lib/api';
import { useToast } from '../shared/Toast';
import { Skeleton } from '../shared/Skeleton';
import { EmptyState } from '../shared/EmptyState';
import { MemoryRecordRow } from './MemoryRecordRow';
import { MemoryWriteForm } from './MemoryWriteForm';
import type { MemoryRecordRowData, MemoryKind } from './types';

export function WorkspaceMemoryTab({ scopeId }: { scopeId?: string }) {
  const toast = useToast();
  const [entries, setEntries] = useState<MemoryRecordRowData[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | MemoryKind>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const confirm = useConfirm();
  const isScoped = Boolean(scopeId);
  const memoryPath = scopeId ? `/v1/memory?limit=100&scopeId=${encodeURIComponent(scopeId)}` : '/v1/memory?limit=100';

  async function refresh() {
    setLoading(true);
    try {
      const data = await api<{ memory: MemoryRecordRowData[] }>(memoryPath);
      setEntries(data.memory ?? []);
    } catch (err) {
      toast.error('Failed to load memory', String(err));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, [scopeId]);

  const filtered = useMemo(() => entries.filter((entry) => filter === 'all' || (entry.kind ?? entry.type) === filter), [entries, filter]);
  const allSelected = filtered.length > 0 && filtered.every((e) => selected.has(e.id));

  function toggle(id: string) {
    setSelected((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(filtered.map((e) => e.id)));
  }

  function removeLocal(id: string) {
    setEntries((prev) => prev.filter((e) => e.id !== id));
    setSelected((prev) => { const next = new Set(prev); next.delete(id); return next; });
  }

  async function deleteSelected() {
    const ids = [...selected];
    if (ids.length === 0) return;
    const ok = await confirm({
      title: `Delete ${ids.length} ${ids.length === 1 ? 'memory' : 'memories'}?`,
      body: 'This removes the memory from the Brain. This cannot be undone.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    const results = await Promise.allSettled(ids.map((id) => api(`/v1/memory/${id}`, { method: 'DELETE' })));
    const deleted = new Set(ids.filter((_, i) => results[i]?.status === 'fulfilled'));
    setEntries((prev) => prev.filter((e) => !deleted.has(e.id)));
    setSelected(new Set());
    if (deleted.size < ids.length) toast.error('Some memories could not be deleted');
    else toast.success(`Deleted ${deleted.size} ${deleted.size === 1 ? 'memory' : 'memories'}`);
  }

  async function saveMemory(entry: { kind: MemoryKind; title: string; content: string }) {
    const path = scopeId ? `/v1/memory?scopeId=${encodeURIComponent(scopeId)}` : '/v1/memory';
    await api(path, { method: 'POST', body: JSON.stringify({ ...entry, sourceType: 'operator', importance: 7, confidence: 1 }) });
    toast.success('Memory saved', entry.title);
    await refresh();
  }



  return (
    <div className="space-y-4">
      <MemoryWriteForm
        submitLabel={isScoped ? 'Save to workflow memory' : 'Save to workspace memory'}
        placeholder={isScoped ? 'What should this workflow always remember?' : undefined}
        onSubmit={saveMemory}
      />
      <div className="flex flex-wrap items-center gap-2">
        {filtered.length > 0 && (
          <label className="flex items-center gap-2 text-[12px] text-text-muted">
            <input type="checkbox" checked={allSelected} onChange={toggleAll} className="h-3.5 w-3.5 rounded border-line bg-surface text-accent" />
            {selected.size > 0 ? `${selected.size} selected` : 'Select all'}
          </label>
        )}
        {selected.size > 0 ? (
          <button type="button" onClick={() => void deleteSelected()} className="inline-flex items-center gap-1 rounded-btn border border-danger/30 bg-danger-soft px-2 py-1 text-[11px] font-medium text-danger hover:bg-danger/15">
            <Trash2 size={12} /> Delete selected
          </button>
        ) : (
          <span className="text-[12px] text-text-muted">{entries.length} memory {entries.length === 1 ? 'entry' : 'entries'}</span>
        )}
        <div className="ml-auto flex flex-wrap gap-1">
          {(['all', 'fact', 'rule', 'preference', 'pattern', 'lesson'] as const).map((item) => (
            <button key={item} type="button" onClick={() => setFilter(item)} className={filter === item ? activeFilter : idleFilter}>
              {item === 'all' ? 'All' : item}
            </button>
          ))}
        </div>
      </div>
      {loading ? <Skeleton height={220} /> : filtered.length === 0 ? (
        <EmptyState
          icon={<FileText size={48} />}
          title="No memory entries"
          body={isScoped
            ? 'Add facts, rules, and preferences that only this workflow can use as durable context.'
            : 'Add facts, rules, and preferences that every agent and workflow in this workspace can use as shared context.'}
        />
      ) : (
        <div className="max-h-[560px] space-y-2 overflow-y-auto pr-1">
          {filtered.map((entry) => (
            <MemoryRecordRow
              key={entry.id}
              entry={entry}
              selected={selected.has(entry.id)}
              onToggleSelect={toggle}
              onUpdated={(next) => setEntries((prev) => prev.map((e) => (e.id === next.id ? next : e)))}
              onDeleted={removeLocal}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const activeFilter = 'inline-flex h-7 items-center rounded-pill border border-accent-muted bg-accent-soft px-2.5 text-[11px] font-medium capitalize text-accent';
const idleFilter = 'inline-flex h-7 items-center rounded-pill border border-line bg-surface-2 px-2.5 text-[11px] font-medium capitalize text-text-muted hover:text-text-primary';



