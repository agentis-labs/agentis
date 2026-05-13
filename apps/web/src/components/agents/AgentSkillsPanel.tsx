/**
 * AgentSkillsPanel — Skills tab content for AgentDetailPage.
 *
 * Fetches workspace skills, splits them into Active (slug in capabilityTags)
 * and Available, and allows toggling them on/off via PATCH /v1/agents/:id.
 */

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useToast } from '../shared/Toast';

interface SkillManifest {
  name?: string;
  description?: string;
  capabilityTags?: string[];
}

interface WorkspaceSkill {
  id: string;
  slug: string;
  name: string;
  version: string;
  runtime: string;
  manifest: SkillManifest;
}

export function AgentSkillsPanel({
  agentId,
  capabilityTags,
  onTagsChanged,
}: {
  agentId: string;
  capabilityTags: string[];
  onTagsChanged: (newTags: string[]) => void;
}) {
  const toast = useToast();
  const [skills, setSkills] = useState<WorkspaceSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    void api<{ skills: WorkspaceSkill[] }>('/v1/skills')
      .then((r) => setSkills(r.skills))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function toggle(slug: string) {
    setSaving(slug);
    try {
      const isActive = capabilityTags.includes(slug);
      const newTags = isActive
        ? capabilityTags.filter((t) => t !== slug)
        : [...capabilityTags, slug];
      await api(`/v1/agents/${agentId}`, {
        method: 'PATCH',
        body: JSON.stringify({ capabilityTags: newTags }),
      });
      onTagsChanged(newTags);
      toast.success(isActive ? 'Skill removed' : 'Skill enabled', slug);
    } catch (err) {
      toast.error('Failed', err instanceof Error ? err.message : 'Could not update skill.');
    } finally {
      setSaving(null);
    }
  }

  const filtered = skills.filter(
    (s) =>
      search === '' ||
      s.slug.includes(search.toLowerCase()) ||
      s.name.toLowerCase().includes(search.toLowerCase()),
  );
  const active = filtered.filter((s) => capabilityTags.includes(s.slug));
  const available = filtered.filter((s) => !capabilityTags.includes(s.slug));

  if (loading) {
    return <div className="py-10 text-center text-sm text-text-muted">Loading skills…</div>;
  }

  if (skills.length === 0) {
    return (
      <div className="rounded-xl border border-line bg-surface p-8 text-center">
        <div className="mb-2 text-sm font-medium">No skills installed</div>
        <div className="text-xs text-text-muted">
          Install skills from the Skills page, then assign them to agents here.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search skills…"
          className="w-full max-w-xs rounded-md border border-line bg-canvas px-3 py-2 text-sm outline-none focus:border-accent"
        />
        <span className="text-xs text-text-muted">{capabilityTags.length} active</span>
      </div>

      {active.length > 0 && (
        <section>
          <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-text-muted">Active</div>
          <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {active.map((s) => (
              <SkillRow key={s.id} skill={s} active saving={saving === s.slug} onToggle={() => void toggle(s.slug)} />
            ))}
          </div>
        </section>
      )}

      {available.length > 0 && (
        <section>
          <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-text-muted">Available</div>
          <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {available.map((s) => (
              <SkillRow key={s.id} skill={s} active={false} saving={saving === s.slug} onToggle={() => void toggle(s.slug)} />
            ))}
          </div>
        </section>
      )}

      {filtered.length === 0 && (
        <div className="py-8 text-center text-sm text-text-muted">No skills match "{search}"</div>
      )}
    </div>
  );
}

function SkillRow({
  skill,
  active,
  saving,
  onToggle,
}: {
  skill: WorkspaceSkill;
  active: boolean;
  saving: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-canvas text-base">
        🔧
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{skill.name || skill.slug}</div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-text-muted">{skill.slug}</span>
          <span className="text-[10px] text-text-muted">v{skill.version}</span>
          <span className="rounded border border-line px-1 py-0.5 text-[10px] text-text-muted">{skill.runtime}</span>
        </div>
        {skill.manifest.description && (
          <div className="mt-0.5 line-clamp-1 text-xs text-text-muted">{skill.manifest.description}</div>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={active}
        onClick={onToggle}
        disabled={saving}
        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors disabled:opacity-50 ${active ? 'bg-accent' : 'bg-line'}`}
      >
        <span
          className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${active ? 'translate-x-4' : 'translate-x-0'}`}
        />
      </button>
    </div>
  );
}
