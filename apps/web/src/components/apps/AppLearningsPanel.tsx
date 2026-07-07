/**
 * AppLearningsPanel — "what this agent learned" for an Agentic App.
 *
 * The `/v1/apps/:id/learnings` endpoint has recorded graded lessons and
 * graduated abilities for a while (AppLearningService, Phase M2), but no UI ever
 * read it, so operators were blind to whether an App agent was actually getting
 * better. This compact panel surfaces the recent lessons + graduated abilities
 * in the App's Brain facet.
 */
import { useEffect, useState } from 'react';
import { Lightbulb, Sparkles } from 'lucide-react';
import { appsApi, type AppLearnings } from '../../lib/appsApi';
import { Skeleton } from '../shared/Skeleton';

const OUTCOME_TONE: Record<string, string> = {
  won: 'border-emerald-400/20 bg-emerald-500/10 text-emerald-300',
  lost: 'border-danger/30 bg-danger-soft text-danger',
  abandoned: 'border-line bg-surface-2 text-text-muted',
};

export function AppLearningsPanel({ appId }: { appId: string }) {
  const [learnings, setLearnings] = useState<AppLearnings | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    appsApi.learnings(appId)
      .then((data) => { if (!cancelled) setLearnings(data); })
      .catch(() => { if (!cancelled) setLearnings(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [appId]);

  const lessons = learnings?.lessons ?? [];
  const isEmpty = !loading && lessons.length === 0;

  return (
    <section className="shrink-0 border-b border-line bg-surface">
      <div className="flex items-center gap-2 px-4 py-3">
        <Sparkles size={14} className="text-accent" />
        <div className="text-[13px] font-semibold text-text-primary">What this agent learned</div>
        {!loading && (
          <span className="ml-auto text-[11px] text-text-muted">
            {lessons.length} {lessons.length === 1 ? 'lesson' : 'lessons'}
          </span>
        )}
      </div>

      <div className="max-h-64 overflow-y-auto px-4 pb-4">
        {loading ? (
          <div className="space-y-2">
            <Skeleton height={44} />
            <Skeleton height={44} />
          </div>
        ) : isEmpty ? (
          <div className="rounded-card border border-dashed border-line bg-surface-2 px-4 py-5 text-center text-[12px] leading-5 text-text-muted">
            No lessons yet. As this App's agent closes work (won/lost outcomes), graded lessons appear here.
          </div>
        ) : (
          <div className="grid gap-4">
            {lessons.length > 0 && (
              <div>
                <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                  <Lightbulb size={11} /> Recent lessons
                </div>
                <div className="space-y-1.5">
                  {lessons.map((lesson) => (
                    <div key={lesson.id} className="rounded-card border border-line bg-surface-2 px-3 py-2">
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          {lesson.title && <div className="truncate text-[12px] font-medium text-text-primary">{lesson.title}</div>}
                          {lesson.summary && <div className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-text-secondary">{lesson.summary}</div>}
                        </div>
                        {lesson.outcome && (
                          <span className={`shrink-0 rounded-pill border px-1.5 py-0.5 text-[10px] ${OUTCOME_TONE[lesson.outcome] ?? OUTCOME_TONE.abandoned}`}>
                            {lesson.outcome}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
