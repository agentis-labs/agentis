import { useState } from 'react';
import clsx from 'clsx';
import { Save } from 'lucide-react';
import { Button } from '../shared/Button';
import type { MemoryKind } from './types';

const KINDS: Array<{ value: MemoryKind; label: string }> = [
  { value: 'fact', label: 'Fact' },
  { value: 'rule', label: 'Rule' },
  { value: 'preference', label: 'Preference' },
  { value: 'pattern', label: 'Pattern' },
  { value: 'lesson', label: 'Lesson' },
];

export function MemoryWriteForm({
  submitLabel = 'Save memory',
  placeholder = 'What should this surface always remember?',
  onSubmit,
  className,
}: {
  submitLabel?: string;
  placeholder?: string;
  onSubmit: (entry: { kind: MemoryKind; title: string; content: string }) => Promise<void>;
  className?: string;
}) {
  const [kind, setKind] = useState<MemoryKind>('fact');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const cleanTitle = title.trim();
    const cleanContent = content.trim();
    if (!cleanTitle || !cleanContent || saving) return;
    setSaving(true);
    try {
      await onSubmit({ kind, title: cleanTitle, content: cleanContent });
      setTitle('');
      setContent('');
      setKind('fact');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className={clsx('rounded-card border border-line bg-surface p-4', className)}>
      <div className="flex flex-wrap gap-1.5">
        {KINDS.map((item) => (
          <button
            key={item.value}
            type="button"
            onClick={() => setKind(item.value)}
            className={clsx(
              'h-7 rounded-pill border px-2.5 text-[11px] font-medium transition-colors',
              kind === item.value
                ? 'border-accent-muted bg-accent-soft text-accent'
                : 'border-line bg-surface-2 text-text-muted hover:text-text-primary',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-[240px_1fr]">
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Title"
          className="h-10 rounded-input border border-line bg-surface-2 px-3 text-[13px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
        />
        <textarea
          value={content}
          onChange={(event) => setContent(event.target.value)}
          rows={3}
          placeholder={placeholder}
          className="min-h-[92px] resize-y rounded-input border border-line bg-surface-2 px-3 py-2 text-[13px] leading-relaxed text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
        />
      </div>
      <div className="mt-3 flex justify-end">
        <Button type="submit" variant="primary" size="sm" loading={saving} iconLeft={<Save size={12} />} disabled={!title.trim() || !content.trim()}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}


