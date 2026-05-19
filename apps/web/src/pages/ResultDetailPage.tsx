/**
 * ResultDetailPage — APP-OUTPUT-REPLAN.md §5.7.
 *
 * Slide-in detail view for a single app_results row. Reachable via
 * `/apps/:slug/results/:resultId` from the AppThread Hero or ActivityFeed.
 *
 * Renders three sections:
 *   - Header (output key, artifact type, timestamp, neighbour navigation)
 *   - Content (raw artifact, type-aware)
 *   - Lineage (run id, triggered by)
 *
 * Back chevron uses navigate(-1) with a fallback to `/apps/:slug` when the
 * page was opened directly via URL.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';

interface AppResultRow {
  id: string;
  appId: string;
  runId: string;
  outputKey: string;
  artifactType: string;
  content: unknown;
  summary: string | null;
  triggeredBy: string;
  createdAt: string;
}

interface NeighboursResponse {
  result: AppResultRow;
  prev: { id: string; createdAt: string } | null;
  next: { id: string; createdAt: string } | null;
}

export function ResultDetailPage() {
  const { slug, resultId } = useParams<{ slug: string; resultId: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<NeighboursResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [animating, setAnimating] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => setAnimating(false), 50);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!slug || !resultId) return;
    let cancelled = false;
    setError(null);
    api<NeighboursResponse>(`/v1/apps/${slug}/output/${resultId}/neighbours`)
      .then((res) => { if (!cancelled) setData(res); })
      .catch((err: { message?: string }) => { if (!cancelled) setError(err?.message ?? 'Failed to load result'); });
    return () => { cancelled = true; };
  }, [slug, resultId]);

  const back = () => {
    if (window.history.length > 1) navigate(-1);
    else navigate(`/apps/${slug}`);
  };

  return (
    <div
      className={`fixed inset-0 z-40 flex bg-black/60 transition-opacity ${animating ? 'opacity-0' : 'opacity-100'}`}
      onClick={back}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={`ml-auto h-full w-full max-w-3xl overflow-y-auto border-l border-white/10 bg-zinc-950 shadow-2xl transition-transform duration-200 ${animating ? 'translate-x-full' : 'translate-x-0'}`}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-white/10 bg-zinc-950/95 px-5 py-3 backdrop-blur">
          <button
            type="button"
            onClick={back}
            className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-sm text-zinc-300 hover:border-white/30"
          >
            ← Back
          </button>
          <div className="flex items-center gap-2">
            {data?.prev && (
              <Link to={`/apps/${slug}/results/${data.prev.id}`} replace className="rounded-md border border-white/10 px-2 py-1 text-xs text-zinc-300 hover:border-white/30">
                ← Older
              </Link>
            )}
            {data?.next && (
              <Link to={`/apps/${slug}/results/${data.next.id}`} replace className="rounded-md border border-white/10 px-2 py-1 text-xs text-zinc-300 hover:border-white/30">
                Newer →
              </Link>
            )}
          </div>
        </div>

        {error && (
          <div className="mx-5 mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>
        )}
        {!error && !data && (
          <div className="px-5 py-6 text-sm text-zinc-500">Loading…</div>
        )}
        {data && <ResultBody result={data.result} />}
      </div>
    </div>
  );
}

function ResultBody({ result }: { result: AppResultRow }) {
  const json = useMemo(() => {
    try { return JSON.stringify(result.content, null, 2); }
    catch { return String(result.content); }
  }, [result.content]);

  return (
    <div className="space-y-5 px-5 py-5">
      <div>
        <div className="text-xs uppercase tracking-wider text-zinc-500">{result.outputKey} · {result.artifactType}</div>
        <h1 className="mt-1 text-xl font-semibold text-zinc-100">{result.summary ?? 'Untitled result'}</h1>
        <div className="mt-1 text-xs text-zinc-500">
          Created {new Date(result.createdAt).toLocaleString()} · triggered_by {result.triggeredBy}
        </div>
      </div>

      <section>
        <div className="mb-2 text-xs uppercase tracking-wider text-zinc-500">Content</div>
        <ContentRenderer artifactType={result.artifactType} content={result.content} json={json} />
      </section>

      <section>
        <div className="mb-2 text-xs uppercase tracking-wider text-zinc-500">Lineage</div>
        <div className="space-y-1 text-sm text-zinc-300">
          <div>Run: <Link to={`/runs/${result.runId}`} className="text-blue-300 hover:underline">{result.runId}</Link></div>
          <div>Result id: <code className="text-xs text-zinc-400">{result.id}</code></div>
        </div>
      </section>
    </div>
  );
}

function ContentRenderer({ artifactType, content, json }: { artifactType: string; content: unknown; json: string }) {
  const lower = artifactType.toLowerCase();
  if (lower === 'markdown' || lower === 'text/markdown') {
    const text = typeof content === 'string' ? content : json;
    return <pre className="whitespace-pre-wrap rounded-lg border border-white/10 bg-black/40 p-3 text-sm text-zinc-100">{text}</pre>;
  }
  if (lower === 'text' || lower === 'text/plain') {
    const text = typeof content === 'string' ? content : json;
    return <pre className="whitespace-pre-wrap rounded-lg border border-white/10 bg-black/40 p-3 text-sm text-zinc-100">{text}</pre>;
  }
  if (lower === 'json' || lower === 'application/json' || typeof content === 'object') {
    return <pre className="overflow-auto rounded-lg border border-white/10 bg-black/40 p-3 text-xs text-zinc-200">{json}</pre>;
  }
  return <pre className="whitespace-pre-wrap rounded-lg border border-white/10 bg-black/40 p-3 text-sm text-zinc-100">{String(content ?? '')}</pre>;
}
