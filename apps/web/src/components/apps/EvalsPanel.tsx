import { useEffect, useMemo, useState } from 'react';
import { FileCheck2, PlayCircle, RefreshCw } from 'lucide-react';
import { api } from '../../lib/api';
import { useToast } from '../shared/Toast';

interface EvalSuite {
  id: string;
  appInstanceId?: string | null;
  workflowId?: string | null;
  name: string;
  status: string;
  updatedAt: string;
}

interface EvalResult {
  id: string;
  suiteId: string;
  status: string;
  score: number;
  summary?: string | null;
  createdAt: string;
}

export function EvalsPanel({ appId, appName, workflowId }: { appId: string; appName: string; workflowId?: string | null }) {
  const toast = useToast();
  const [suites, setSuites] = useState<EvalSuite[]>([]);
  const [results, setResults] = useState<Record<string, EvalResult[]>>({});
  const [busy, setBusy] = useState<string | null>(null);

  async function refresh() {
    const data = await api<{ suites: EvalSuite[] }>('/v1/evals');
    const own = data.suites.filter((suite) => suite.appInstanceId === appId || (!!workflowId && suite.workflowId === workflowId));
    setSuites(own);
    const next: Record<string, EvalResult[]> = {};
    await Promise.all(own.map(async (suite) => {
      const res = await api<{ results: EvalResult[] }>(`/v1/evals/${suite.id}/results`).catch(() => ({ results: [] as EvalResult[] }));
      next[suite.id] = res.results;
    }));
    setResults(next);
  }

  useEffect(() => {
    void refresh();
  }, [appId, workflowId]);

  const hasSmokeSuite = useMemo(() => suites.some((suite) => suite.name === `${appName} Smoke`), [appName, suites]);

  async function createSmokeSuite() {
    setBusy('create');
    try {
      await api('/v1/evals', {
        method: 'POST',
        body: JSON.stringify({
          appInstanceId: appId,
          workflowId,
          name: `${appName} Smoke`,
          config: { threshold: 1 },
          cases: [{ name: 'Empty input', input: {}, expected: {} }],
        }),
      });
      toast.success('Eval suite created', appName);
      await refresh();
    } catch (err) {
      toast.error('Eval create failed', messageFrom(err));
    } finally {
      setBusy(null);
    }
  }

  async function runSuite(suiteId: string) {
    setBusy(suiteId);
    try {
      await api(`/v1/evals/${suiteId}/run`, { method: 'POST', body: JSON.stringify({ syncTimeoutMs: 2500 }) });
      toast.success('Eval completed', appName);
      await refresh();
    } catch (err) {
      toast.error('Eval failed', messageFrom(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-md border border-line bg-surface shadow-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <FileCheck2 size={14} className="text-accent" />
        <div className="text-xs font-medium text-text-primary">Evals</div>
        <div className="ml-auto flex items-center gap-1">
          {!hasSmokeSuite && (
            <button type="button" onClick={() => void createSmokeSuite()} disabled={busy === 'create'} className="inline-flex h-7 items-center gap-1 rounded-md border border-line bg-canvas px-2 text-[11px] text-text-primary hover:border-accent/40 disabled:opacity-50">
              <FileCheck2 size={12} />
              Smoke
            </button>
          )}
          <button type="button" onClick={() => void refresh()} className="rounded-md p-1.5 text-text-muted hover:bg-surface-2 hover:text-accent" title="Refresh evals" aria-label="Refresh evals">
            <RefreshCw size={13} />
          </button>
        </div>
      </div>
      {suites.length === 0 ? (
        <div className="px-3 py-8 text-center text-xs text-text-muted">No eval suites.</div>
      ) : suites.map((suite) => {
        const latest = results[suite.id]?.[0];
        return (
          <div key={suite.id} className="flex flex-wrap items-center gap-3 border-b border-line/70 px-3 py-2 text-xs last:border-0">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-text-primary">{suite.name}</div>
              <div className="mt-1 text-[11px] text-text-muted">{latest ? `${latest.summary ?? latest.status} / ${Math.round(latest.score * 100)}%` : suite.status}</div>
            </div>
            <button type="button" onClick={() => void runSuite(suite.id)} disabled={busy === suite.id} className="inline-flex h-7 items-center gap-1 rounded-md border border-accent/30 bg-accent/10 px-2 text-[11px] text-accent hover:border-accent/60 disabled:opacity-50">
              <PlayCircle size={12} />
              Run
            </button>
          </div>
        );
      })}
    </div>
  );
}

function messageFrom(err: unknown) {
  return err && typeof err === 'object' && 'message' in err
    ? String((err as { message?: unknown }).message)
    : 'Something went wrong.';
}