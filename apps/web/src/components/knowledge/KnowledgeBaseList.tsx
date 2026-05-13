import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '../shared/Button';
import { EmptyState } from '../shared/EmptyState';
import { KnowledgeBaseCard } from './KnowledgeBaseCard';
import type { KnowledgeBaseRow } from './types';

export function KnowledgeBaseList({
  bases,
  documentCounts,
  onCreate,
  onOpen,
  onDelete,
}: {
  bases: KnowledgeBaseRow[];
  documentCounts: Map<string, number>;
  onCreate: (input: { name: string; description?: string }) => Promise<void>;
  onOpen: (base: KnowledgeBaseRow) => void;
  onDelete: (base: KnowledgeBaseRow) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const clean = name.trim();
    if (!clean || saving) return;
    setSaving(true);
    try {
      await onCreate({ name: clean, description: description.trim() || undefined });
      setName('');
      setDescription('');
      setCreating(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      {creating && (
        <form onSubmit={(event) => void submit(event)} className="rounded-card border border-line bg-surface p-4">
          <div className="grid gap-3 md:grid-cols-[240px_1fr_auto]">
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Knowledge base name" className="h-10 rounded-input border border-line bg-surface-2 px-3 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none" />
            <input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Description" className="h-10 rounded-input border border-line bg-surface-2 px-3 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none" />
            <Button type="submit" variant="primary" size="md" loading={saving}>Create</Button>
          </div>
        </form>
      )}
      {bases.length === 0 && !creating ? (
        <EmptyState
          icon={<Plus size={48} />}
          title="No knowledge bases yet"
          body="A knowledge base groups related documents for targeted retrieval. Create one for policies, product docs, customer FAQs, or project references."
          primaryAction={<Button variant="primary" size="sm" iconLeft={<Plus size={12} />} onClick={() => setCreating(true)}>Create your first base</Button>}
        />
      ) : (
        <>
          <div className="flex justify-end">
            <Button variant="secondary" size="sm" iconLeft={<Plus size={12} />} onClick={() => setCreating((value) => !value)}>Add knowledge base</Button>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {bases.map((base) => (
              <KnowledgeBaseCard
                key={base.id}
                base={base}
                documentCount={documentCounts.get(base.id) ?? 0}
                onOpen={onOpen}
                onDelete={onDelete}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}