import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BookOpen, Database, FileText, History, ArrowRight } from 'lucide-react';
import { api } from '../../lib/api';
import { Button } from '../shared/Button';
import type { KnowledgeBaseRow, KnowledgeDocumentRow, EpisodeRowData, MemoryEntryRowData } from './types';

interface KnowledgeSnapshot {
  bases: KnowledgeBaseRow[];
  documents: KnowledgeDocumentRow[];
  memory: MemoryEntryRowData[];
  episodes: EpisodeRowData[];
}

export function KnowledgeStatusCard() {
  const nav = useNavigate();
  const [snapshot, setSnapshot] = useState<KnowledgeSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const baseData = await api<{ knowledgeBases: KnowledgeBaseRow[] }>('/v1/knowledge-bases');
        const bases = baseData.knowledgeBases ?? [];
        const docLists = await Promise.all(bases.map(async (base) => {
          const data = await api<{ documents: KnowledgeDocumentRow[] }>(`/v1/knowledge-bases/${base.id}/documents`);
          return data.documents ?? [];
        }));
        const [memoryData, episodeData] = await Promise.all([
          api<{ memory: MemoryEntryRowData[] }>('/v1/memory?limit=3'),
          api<{ episodes: EpisodeRowData[] }>('/v1/memory/episodes?limit=3'),
        ]);
        if (!cancelled) setSnapshot({ bases, documents: docLists.flat(), memory: memoryData.memory ?? [], episodes: episodeData.episodes ?? [] });
      } catch {
        if (!cancelled) setSnapshot({ bases: [], documents: [], memory: [], episodes: [] });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const total = useMemo(() => {
    if (!snapshot) return 0;
    return snapshot.bases.length + snapshot.documents.length + snapshot.memory.length + snapshot.episodes.length;
  }, [snapshot]);

  if (!snapshot) return null;

  const empty = total === 0;

  return (
    <section className="rounded-card border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-card border border-line bg-surface-2 text-accent">
          <BookOpen size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-subheading text-text-primary">{empty ? 'Seed your workspace knowledge' : 'Workspace knowledge'}</h2>
          <p className="mt-1 text-[12px] leading-relaxed text-text-muted">
            {empty ? 'Add documents, durable memory, or learned episodes so apps and agents start with useful context.' : 'Documents, memory, and promoted lessons are available to apps and agents.'}
          </p>
        </div>
        <Button variant="primary" size="sm" iconRight={<ArrowRight size={12} />} onClick={() => nav('/knowledge')}>Open Knowledge</Button>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-4">
        <Metric icon={<FileText size={13} />} label="Documents" value={snapshot.documents.length} onClick={() => nav('/knowledge?tab=documents')} />
        <Metric icon={<BookOpen size={13} />} label="Bases" value={snapshot.bases.length} onClick={() => nav('/knowledge?tab=bases')} />
        <Metric icon={<Database size={13} />} label="Memory" value={snapshot.memory.length} onClick={() => nav('/knowledge?tab=memory')} />
        <Metric icon={<History size={13} />} label="Episodes" value={snapshot.episodes.length} onClick={() => nav('/knowledge?tab=episodes')} />
      </div>
    </section>
  );
}

function Metric({ icon, label, value, onClick }: { icon: React.ReactNode; label: string; value: number; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex items-center gap-2 rounded-card border border-line bg-surface-2 px-3 py-2 text-left transition-colors hover:bg-surface-3">
      <span className="text-accent">{icon}</span>
      <span className="min-w-0 flex-1 text-[11px] text-text-muted">{label}</span>
      <span className="text-[13px] font-semibold text-text-primary">{value}</span>
    </button>
  );
}