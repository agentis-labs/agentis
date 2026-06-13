import { useEffect, useMemo, useState } from 'react';
import { FileText } from 'lucide-react';
import { api } from '../../lib/api';
import { useToast } from '../shared/Toast';
import { Skeleton } from '../shared/Skeleton';
import { EmptyState } from '../shared/EmptyState';
import { MemoryRecordRow } from './MemoryRecordRow';
import { MemoryWriteForm } from './MemoryWriteForm';
import type { MemoryRecordRowData, MemoryKind } from './types';

export function WorkspaceMemoryTab() {
  const toast = useToast();
  const [entries, setEntries] = useState<MemoryRecordRowData[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | MemoryKind>('all');

  async function refresh() {
    setLoading(true);
    try {
      const data = await api<{ memory: MemoryRecordRowData[] }>('/v1/memory?limit=100');
      setEntries(data.memory ?? []);
    } catch (err) {
      toast.error('Failed to load memory', String(err));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  const filtered = useMemo(() => entries.filter((entry) => filter === 'all' || (entry.kind ?? entry.type) === filter), [entries, filter]);

  async function saveMemory(entry: { kind: MemoryKind; title: string; content: string }) {
    await api('/v1/memory', { method: 'POST', body: JSON.stringify({ ...entry, sourceType: 'operator', importance: 7, confidence: 1 }) });
    toast.success('Memory saved', entry.title);
    await refresh();
  }

  async function archive(id: string) {
    await api(`/v1/memory/${id}`, { method: 'DELETE' });
    toast.success('Memory archived');
    await refresh();
  }

  return (
    <div className="space-y-4">
      <MemoryWriteForm submitLabel="Save to workspace memory" onSubmit={saveMemory} />
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] text-text-muted">{entries.length} memory {entries.length === 1 ? 'entry' : 'entries'}</span>
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
          body="Add facts, rules, and preferences that every agent and workflow in this workspace can use as shared context."
        />
      ) : (
        <div className="space-y-2">{filtered.map((entry) => <MemoryRecordRow key={entry.id} entry={entry} onArchive={(id) => void archive(id)} />)}</div>
      )}
    </div>
  );
}

const activeFilter = 'inline-flex h-7 items-center rounded-pill border border-accent-muted bg-accent-soft px-2.5 text-[11px] font-medium capitalize text-accent';
const idleFilter = 'inline-flex h-7 items-center rounded-pill border border-line bg-surface-2 px-2.5 text-[11px] font-medium capitalize text-text-muted hover:text-text-primary';
