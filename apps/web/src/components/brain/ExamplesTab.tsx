import { useCallback, useEffect, useState } from 'react';
import { Sparkles, Pencil, Trash2, Check, X, ChevronRight } from 'lucide-react';
import { api, apiErrorMessage } from '../../lib/api';
import { skillsApi, type SkillExample } from '../../lib/skills';
import { Skeleton } from '../shared/Skeleton';
import { useToast } from '../shared/Toast';
import { useConfirm } from '../shared/ConfirmDialog';

/**
 * Examples tab — curated input→output demonstrations (`example` atoms). They ride
 * along when their skill is loaded and grow from real wins (agents promote a good
 * result via `agentis.skill.promote_example`). Each can be reviewed in full,
 * edited, or removed here.
 */
export function ExamplesTab() {
  const [examples, setExamples] = useState<SkillExample[]>([]);
  const [loading, setLoading] = useState(true);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      setExamples((await skillsApi.examples()).examples);
    } catch (error) {
      toast.error('Failed to load examples', apiErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="mx-auto max-w-5xl px-6 py-5">
      <div className="mb-4">
        <h2 className="text-subheading text-text-primary">Examples</h2>
        <p className="mt-0.5 text-[12px] leading-5 text-text-muted">
          Curated demonstrations of a task done right. They ride along when their skill is loaded, and grow automatically from real wins — promoted by agents, then reviewed and edited here.
        </p>
      </div>

      {loading ? (
        <div className="flex flex-col gap-2">{[0, 1].map((i) => <Skeleton key={i} className="h-16 w-full rounded-card" />)}</div>
      ) : examples.length === 0 ? (
        <div className="rounded-card border border-dashed border-line px-6 py-12 text-center">
          <Sparkles size={22} className="mx-auto text-text-muted" />
          <p className="mt-3 text-[13px] text-text-secondary">No examples yet.</p>
          <p className="mx-auto mt-1 max-w-md text-[12px] leading-5 text-text-muted">
            When a skill produces a genuinely good result, an agent can save it as an example — the skill's demonstration set compounds from real runs.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {examples.map((ex) => (
            <ExampleRow
              key={ex.id}
              example={ex}
              onUpdated={(next) => setExamples((prev) => prev.map((e) => (e.id === next.id ? next : e)))}
              onDeleted={(id) => setExamples((prev) => prev.filter((e) => e.id !== id))}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ExampleRow({
  example,
  onUpdated,
  onDeleted,
}: {
  example: SkillExample;
  onUpdated: (next: SkillExample) => void;
  onDeleted: (id: string) => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [titleDraft, setTitleDraft] = useState(example.title);
  const [contentDraft, setContentDraft] = useState(example.content);

  async function save() {
    const content = contentDraft.trim();
    if (!content) return;
    setSaving(true);
    try {
      await api(`/v1/brain/atoms/example/${example.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: titleDraft.trim() || undefined, content }),
      });
      onUpdated({ ...example, title: titleDraft.trim() || example.title, content });
      setEditing(false);
      toast.success('Example updated');
    } catch (err) {
      toast.error('Failed to update example', apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    const ok = await confirm({ title: `Delete "${example.title}"?`, body: 'This removes the example from the skill’s demonstration set.', confirmLabel: 'Delete', tone: 'danger' });
    if (!ok) return;
    try {
      await api(`/v1/brain/atoms/example/${example.id}`, { method: 'DELETE' });
      onDeleted(example.id);
    } catch (err) {
      toast.error('Failed to delete example', apiErrorMessage(err));
    }
  }

  return (
    <li className="rounded-card border border-line bg-surface">
      <div className="flex items-start gap-2 p-4">
        <button type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded} className="min-w-0 flex-1 text-left">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-accent"><Sparkles size={11} /> {example.title}</div>
          <p className={`text-[12px] leading-5 text-text-secondary ${expanded ? 'whitespace-pre-wrap' : 'line-clamp-2'}`}>{example.content}</p>
        </button>
        <ChevronRight size={15} className={`mt-0.5 shrink-0 text-text-muted transition-transform ${expanded ? 'rotate-90' : ''}`} />
      </div>
      {expanded && (
        <div className="border-t border-line/70 px-4 py-3">
          {editing ? (
            <div className="space-y-2">
              <input
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                placeholder="Title"
                className="w-full rounded-md border border-line bg-canvas px-2.5 py-1.5 text-[12px] font-medium text-text-primary outline-none focus:border-accent"
              />
              <textarea
                value={contentDraft}
                onChange={(e) => setContentDraft(e.target.value)}
                rows={6}
                className="w-full resize-y rounded-md border border-line bg-canvas px-2.5 py-1.5 font-mono text-[12px] leading-5 text-text-primary outline-none focus:border-accent"
              />
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => void save()} disabled={saving} className="inline-flex items-center gap-1 rounded-btn bg-accent px-2 py-1 text-[11px] font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"><Check size={12} /> Save</button>
                <button type="button" onClick={() => { setEditing(false); setTitleDraft(example.title); setContentDraft(example.content); }} className="inline-flex items-center gap-1 rounded-btn px-2 py-1 text-[11px] text-text-muted hover:bg-surface-2"><X size={12} /> Cancel</button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-end gap-1">
              <button type="button" onClick={() => setEditing(true)} className="inline-flex items-center gap-1 rounded-btn px-2 py-1 text-[11px] text-text-muted hover:bg-surface-2 hover:text-text-primary"><Pencil size={12} /> Edit</button>
              <button type="button" onClick={() => void remove()} className="inline-flex items-center gap-1 rounded-btn px-2 py-1 text-[11px] text-text-muted hover:bg-danger/10 hover:text-danger"><Trash2 size={12} /> Delete</button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}
