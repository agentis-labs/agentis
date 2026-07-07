import { useCallback, useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { apiErrorMessage } from '../../lib/api';
import { skillsApi, type SkillExample } from '../../lib/skills';
import { Skeleton } from '../shared/Skeleton';
import { useToast } from '../shared/Toast';

/**
 * Examples tab — curated input→output demonstrations (`example` atoms). They ride
 * along when their skill is loaded and grow from real wins (agents promote a good
 * result via `agentis.skill.promote_example`).
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
          Curated demonstrations of a task done right. They ride along when their skill is loaded, and grow automatically from real wins.
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
            <li key={ex.id} className="rounded-card border border-line bg-surface p-4">
              <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-accent"><Sparkles size={11} /> {ex.title}</div>
              <p className="whitespace-pre-wrap text-[12px] leading-5 text-text-secondary">{ex.content}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
