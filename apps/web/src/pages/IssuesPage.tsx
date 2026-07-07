/**
 * IssuesPage — the operator-facing view of the workspace issue backlog.
 *
 * The `/v1/issues` API (list / accept / schedule) has been live for a while but
 * had no dedicated surface — issues only appeared as inline summaries on the
 * canvas/home. This page lists them, filters by status, and lets the operator
 * hand an issue to an agent (accept) so the schedulable backlog is actually
 * reachable and actionable.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, CalendarClock, ListChecks, Repeat, SearchX, Workflow as WorkflowIcon } from 'lucide-react';
import { api, apiErrorMessage } from '../lib/api';
import { Button } from '../components/shared/Button';
import { EmptyState } from '../components/shared/EmptyState';
import { Skeleton } from '../components/shared/Skeleton';
import { useToast } from '../components/shared/Toast';

type IssueStatus = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'cancelled';
type IssuePriority = 'urgent' | 'high' | 'medium' | 'low' | 'none';

interface Issue {
  id: string;
  title: string;
  description?: string | null;
  status: IssueStatus;
  priority: IssuePriority;
  labels?: string[] | null;
  assigneeAgentId?: string | null;
  linkedWorkflowId?: string | null;
  scheduledFor?: string | null;
  recurrenceCron?: string | null;
  activeRunId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

type StatusFilter = 'all' | 'open' | IssueStatus;

const STATUS_META: Record<IssueStatus, { label: string; tone: string }> = {
  backlog: { label: 'Backlog', tone: 'border-line bg-surface-2 text-text-muted' },
  todo: { label: 'To do', tone: 'border-sky-400/20 bg-sky-500/10 text-sky-300' },
  in_progress: { label: 'In progress', tone: 'border-amber-400/20 bg-amber-500/10 text-amber-300' },
  in_review: { label: 'In review', tone: 'border-violet-400/20 bg-violet-500/10 text-violet-300' },
  blocked: { label: 'Blocked', tone: 'border-danger/30 bg-danger-soft text-danger' },
  done: { label: 'Done', tone: 'border-emerald-400/20 bg-emerald-500/10 text-emerald-300' },
  cancelled: { label: 'Cancelled', tone: 'border-line bg-surface-2 text-text-muted' },
};

const PRIORITY_META: Record<IssuePriority, { label: string; tone: string }> = {
  urgent: { label: 'Urgent', tone: 'text-danger' },
  high: { label: 'High', tone: 'text-amber-300' },
  medium: { label: 'Medium', tone: 'text-sky-300' },
  low: { label: 'Low', tone: 'text-text-muted' },
  none: { label: 'None', tone: 'text-text-muted' },
};

const OPEN_STATUSES: IssueStatus[] = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked'];

export function IssuesPage() {
  const nav = useNavigate();
  const toast = useToast();
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<StatusFilter>('open');
  const [acceptingId, setAcceptingId] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const res = await api<{ issues: Issue[] }>('/v1/issues');
      setIssues(res.issues ?? []);
    } catch {
      setIssues([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  const counts = useMemo(() => {
    const open = issues.filter((i) => OPEN_STATUSES.includes(i.status)).length;
    return { all: issues.length, open };
  }, [issues]);

  const filtered = useMemo(() => {
    if (filter === 'all') return issues;
    if (filter === 'open') return issues.filter((i) => OPEN_STATUSES.includes(i.status));
    return issues.filter((i) => i.status === filter);
  }, [issues, filter]);

  async function accept(issue: Issue) {
    setAcceptingId(issue.id);
    try {
      await api(`/v1/issues/${issue.id}/accept`, { method: 'POST', body: JSON.stringify({}) });
      toast.success('Issue accepted', issue.title);
      void refresh();
    } catch (err) {
      toast.error('Could not accept issue', apiErrorMessage(err));
    } finally {
      setAcceptingId(null);
    }
  }

  const tabs: Array<{ value: StatusFilter; label: string; count?: number }> = [
    { value: 'open', label: 'Open', count: counts.open },
    { value: 'all', label: 'All', count: counts.all },
    { value: 'backlog', label: 'Backlog' },
    { value: 'in_progress', label: 'In progress' },
    { value: 'blocked', label: 'Blocked' },
    { value: 'done', label: 'Done' },
  ];

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-6 py-4">
        <div>
          <h1 className="text-display text-text-primary">Issues</h1>
          <div className="mt-0.5 text-[12px] text-text-muted">
            The workspace backlog — schedulable work an agent can pick up. Accept an issue to hand it to an agent.
          </div>
        </div>
        <div className="ml-auto">
          <Button variant="secondary" size="md" onClick={() => void refresh()}>Refresh</Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-6 py-3">
        <div role="tablist" aria-label="Issue status filter" className="flex flex-wrap gap-1 rounded-pill border border-line bg-surface-2 p-1 text-[12px]">
          {tabs.map((tab) => (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={filter === tab.value}
              onClick={() => setFilter(tab.value)}
              className={`inline-flex h-7 items-center gap-1.5 rounded-pill px-3 transition-colors ${
                filter === tab.value ? 'bg-accent-soft text-accent' : 'text-text-muted hover:text-text-primary'
              }`}
            >
              {tab.label}
              {typeof tab.count === 'number' && (
                <span className="rounded-pill border border-line bg-surface px-1.5 py-0.5 text-[10px] leading-none text-text-muted">
                  {tab.count}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {loading && filtered.length === 0 ? (
          <div className="space-y-2">
            <Skeleton height={72} />
            <Skeleton height={72} />
            <Skeleton height={72} />
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<SearchX size={48} />}
            title={filter === 'open' ? 'No open issues' : 'No issues here'}
            body="Issues are created when an agent flags follow-up work, a run needs attention, or you schedule a task. They show up here as a workspace backlog."
            variant="page"
          />
        ) : (
          <div className="space-y-2">
            {filtered.map((issue) => (
              <IssueRow
                key={issue.id}
                issue={issue}
                accepting={acceptingId === issue.id}
                onAccept={() => void accept(issue)}
                onOpenWorkflow={issue.linkedWorkflowId ? () => nav(`/apps/workflows/${issue.linkedWorkflowId}`) : undefined}
                onOpenRun={issue.activeRunId ? () => nav(`/runs/${issue.activeRunId}`) : undefined}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function IssueRow({
  issue,
  accepting,
  onAccept,
  onOpenWorkflow,
  onOpenRun,
}: {
  issue: Issue;
  accepting: boolean;
  onAccept: () => void;
  onOpenWorkflow?: () => void;
  onOpenRun?: () => void;
}) {
  const status = STATUS_META[issue.status] ?? STATUS_META.backlog;
  const priority = PRIORITY_META[issue.priority] ?? PRIORITY_META.none;
  const isTerminal = issue.status === 'done' || issue.status === 'cancelled';
  return (
    <article className="rounded-card border border-line bg-surface p-4 transition-colors hover:border-line-strong hover:bg-surface-2">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-card border border-line bg-surface-2 text-text-muted">
          <ListChecks size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="min-w-0 truncate text-subheading text-text-primary">{issue.title}</span>
            <span className={`shrink-0 rounded-pill border px-1.5 py-0.5 text-[10px] ${status.tone}`}>{status.label}</span>
            {issue.priority !== 'none' && (
              <span className={`inline-flex shrink-0 items-center gap-1 text-[11px] ${priority.tone}`}>
                <AlertCircle size={11} /> {priority.label}
              </span>
            )}
          </div>
          {issue.description && (
            <div className="mt-1 line-clamp-2 text-[12px] leading-5 text-text-secondary">{issue.description}</div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-muted">
            {issue.scheduledFor && (
              <span className="inline-flex items-center gap-1"><CalendarClock size={11} /> {formatDate(issue.scheduledFor)}</span>
            )}
            {issue.recurrenceCron && (
              <span className="inline-flex items-center gap-1"><Repeat size={11} /> {issue.recurrenceCron}</span>
            )}
            {issue.linkedWorkflowId && (
              <button type="button" onClick={onOpenWorkflow} className="inline-flex items-center gap-1 hover:text-text-primary">
                <WorkflowIcon size={11} /> Linked workflow
              </button>
            )}
            {(issue.labels ?? []).slice(0, 4).map((label) => (
              <span key={label} className="rounded-pill border border-line bg-surface-2 px-1.5 py-0.5 text-[10px]">{label}</span>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {issue.activeRunId && (
            <Button variant="ghost" size="sm" onClick={onOpenRun}>View run</Button>
          )}
          {!isTerminal && (
            <Button variant="secondary" size="sm" loading={accepting} onClick={onAccept}>Accept</Button>
          )}
        </div>
      </div>
    </article>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
