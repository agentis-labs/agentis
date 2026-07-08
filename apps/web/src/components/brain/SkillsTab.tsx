import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileCode, Plus, Trash2, Sparkles, Lightbulb, Upload } from 'lucide-react';
import { apiErrorMessage } from '../../lib/api';
import { skillsApi, type SkillListItem, type SkillDetail, type LinkedAtom } from '../../lib/skills';
import { Button } from '../shared/Button';
import { Skeleton } from '../shared/Skeleton';
import { useToast } from '../shared/Toast';
import { useConfirm } from '../shared/ConfirmDialog';

interface Draft {
  id: string | null; // null = a new skill
  name: string;
  description: string;
  body: string;
}

const EMPTY_DRAFT: Draft = { id: null, name: '', description: '', body: '' };


export function SkillsTab() {
  const [skills, setSkills] = useState<SkillListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [linked, setLinked] = useState<{ examples: LinkedAtom[]; lessons: LinkedAtom[] }>({ examples: [], lessons: [] });
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();

  const load = useCallback(async (showLoader = false) => {
    if (showLoader) setLoading(true);
    try {
      setSkills((await skillsApi.list()).skills);
    } catch (error) {
      toast.error('Failed to load skills', apiErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(true); }, [load]);

  const openNew = () => { setDraft({ ...EMPTY_DRAFT }); setLinked({ examples: [], lessons: [] }); };

  const openEdit = async (id: string) => {
    try {
      const detail = await skillsApi.get(id);
      const s: SkillDetail = detail.skill;
      setDraft({ id: s.id, name: s.name, description: s.description, body: s.body });
      setLinked({ examples: detail.examples, lessons: detail.lessons });
    } catch (error) {
      toast.error('Could not open skill', apiErrorMessage(error));
    }
  };

  const save = async () => {
    if (!draft || !draft.name.trim() || saving) return;
    setSaving(true);
    try {
      if (draft.id) {
        await skillsApi.update(draft.id, { name: draft.name, description: draft.description, body: draft.body });
        toast.success('Skill updated', draft.name);
      } else {
        await skillsApi.create({ name: draft.name, description: draft.description, body: draft.body, scopeId: null });
        toast.success('Skill created', draft.name);
      }
      setDraft(null);
      await load();
    } catch (error) {
      toast.error('Save failed', apiErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (skill: SkillListItem) => {
    const ok = await confirm({ title: `Delete "${skill.name}"?`, body: 'This removes the skill and its metabolism. This cannot be undone.', confirmLabel: 'Delete', tone: 'danger' });
    if (!ok) return;
    try {
      await skillsApi.remove(skill.id);
      if (draft?.id === skill.id) setDraft(null);
      await load();
    } catch (error) {
      toast.error('Delete failed', apiErrorMessage(error));
    }
  };

  if (draft) {
    return <SkillEditor draft={draft} setDraft={setDraft} onSave={save} onCancel={() => setDraft(null)} saving={saving} linked={linked} />;
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-subheading text-text-primary">Skills</h2>
          <p className="mt-0.5 text-[12px] leading-5 text-text-muted">
            Reusable procedures your agents load on demand. Each is a real <span className="font-mono">SKILL.md</span> on disk plus a Brain atom whose confidence moves with real run outcomes.
          </p>
        </div>
        <Button variant="primary" size="sm" iconLeft={<Plus size={13} />} onClick={openNew}>New skill</Button>
      </div>

      {loading ? (
        <div className="flex flex-col gap-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 w-full rounded-card" />)}</div>
      ) : skills.length === 0 ? (
        <div className="rounded-card border border-dashed border-line px-6 py-12 text-center">
          <FileCode size={22} className="mx-auto text-text-muted" />
          <p className="mt-3 text-[13px] text-text-secondary">No skills yet.</p>
          <p className="mx-auto mt-1 max-w-md text-[12px] leading-5 text-text-muted">
            Author a procedure here, install a skill package, or import agents from a harness — their <span className="font-mono">SKILL.md</span> files become skills automatically.
          </p>
          <div className="mt-4"><Button variant="primary" size="sm" iconLeft={<Plus size={13} />} onClick={openNew}>Create your first skill</Button></div>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {skills.map((skill) => (
            <li key={skill.id}>
              <div className="group flex items-center gap-3 rounded-card border border-line bg-surface p-4 transition-colors hover:border-line-strong hover:bg-surface-2">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-card border border-accent/20 bg-accent-soft text-accent"><FileCode size={15} /></span>
                <button type="button" onClick={() => void openEdit(skill.id)} className="min-w-0 flex-1 text-left">
                  <div className="truncate text-[13px] font-medium text-text-primary">{skill.name}</div>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-text-muted">{skill.slug}{skill.scopeId ? ` · scoped` : ''}</div>
                  {skill.description && <div className="mt-1 line-clamp-1 text-[12px] leading-5 text-text-secondary">{skill.description}</div>}
                </button>
                <ConfidencePill value={skill.confidence} />
                <button type="button" onClick={() => void remove(skill)} aria-label="Delete skill" className="rounded-input p-1.5 text-text-muted opacity-0 transition-opacity hover:text-danger group-hover:opacity-100">
                  <Trash2 size={14} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ConfidencePill({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const tone = value >= 0.6 ? 'text-accent bg-accent-soft' : value >= 0.35 ? 'text-warn bg-warn/10' : 'text-danger bg-danger/10';
  return <span className={`shrink-0 rounded-pill px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${tone}`} title="Confidence — moves with run outcomes">{pct}%</span>;
}

/** Parse a SKILL.md: YAML-ish frontmatter (name/description) + Markdown body. */
function parseSkillMarkdown(text: string, filename: string): { name: string; description: string; body: string } {
  let name = '';
  let description = '';
  let body = text;
  const fm = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(text);
  if (fm) {
    body = text.slice(fm[0].length);
    for (const line of fm[1]!.split('\n')) {
      const m = /^\s*(name|description|title)\s*:\s*(.+?)\s*$/i.exec(line);
      if (!m) continue;
      const value = m[2]!.replace(/^["']|["']$/g, '');
      if (/name|title/i.test(m[1]!) && !name) name = value;
      else if (/description/i.test(m[1]!)) description = value;
    }
  }
  if (!name) {
    const h1 = /^#\s+(.+)$/m.exec(body);
    name = h1 ? h1[1]!.trim() : filename.replace(/\.md$/i, '').replace(/[-_]/g, ' ');
  }
  return { name, description, body: body.trim() };
}

function SkillEditor({ draft, setDraft, onSave, onCancel, saving, linked }: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  linked: { examples: LinkedAtom[]; lessons: LinkedAtom[] };
}) {
  const inputCls = 'w-full rounded-input border border-line bg-surface-2 px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted outline-none focus:border-accent';
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function loadFile(file: File) {
    const text = await file.text();
    const parsed = parseSkillMarkdown(text, file.name);
    setDraft({ ...draft, name: draft.name || parsed.name, description: draft.description || parsed.description, body: parsed.body });
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-subheading text-text-primary">{draft.id ? 'Edit skill' : 'New skill'}</h2>
        <div className="flex gap-2">
          <input ref={fileRef} type="file" accept=".md,text/markdown,text/plain" className="hidden" onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) void loadFile(f); e.currentTarget.value = ''; }} />
          <Button variant="ghost" size="sm" iconLeft={<Upload size={13} />} onClick={() => fileRef.current?.click()} disabled={saving}>Upload SKILL.md</Button>
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={onSave} loading={saving} disabled={saving || !draft.name.trim()}>Save</Button>
        </div>
      </div>
      <div
        className="flex flex-col gap-4"
        onDragOver={(e) => { e.preventDefault(); }}
        onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) void loadFile(f); }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-text-secondary">Name</span>
          <input className={inputCls} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Triage Stripe webhooks" />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-text-secondary">Description <span className="font-normal text-text-muted">— what an agent searches on to find it</span></span>
          <input className={inputCls} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="Verify signatures before trusting a webhook payload." />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-text-secondary">Procedure <span className="font-normal text-text-muted">— the SKILL.md body (Markdown)</span></span>
          <textarea className={`${inputCls} min-h-[240px] resize-y font-mono text-[12px] leading-5`} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} placeholder={'# Steps\n1. Recompute the HMAC.\n2. Reject on mismatch with 401.'} />
        </label>

        {(linked.examples.length > 0 || linked.lessons.length > 0) && (
          <div className="rounded-card border border-line bg-surface-2 p-4">
            <p className="mb-2 text-[12px] font-medium text-text-secondary">Grown from real runs</p>
            {linked.examples.length > 0 && (
              <div className="mb-2">
                <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-accent"><Sparkles size={11} /> Examples ({linked.examples.length})</div>
                <ul className="flex flex-col gap-1">{linked.examples.map((e) => <li key={e.id} className="line-clamp-2 text-[12px] leading-5 text-text-secondary">{e.content}</li>)}</ul>
              </div>
            )}
            {linked.lessons.length > 0 && (
              <div>
                <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-warn"><Lightbulb size={11} /> Lessons ({linked.lessons.length})</div>
                <ul className="flex flex-col gap-1">{linked.lessons.map((l) => <li key={l.id} className="line-clamp-2 text-[12px] leading-5 text-text-secondary">{l.content}</li>)}</ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}



