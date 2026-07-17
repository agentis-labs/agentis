/**
 * OutputViewers — the Layer 6 viewer registry (WORKFLOW-10X-MASTERPLAN §6.1-6.2).
 *
 * Production-grade, dependency-free viewers selected by artifact type / renderAs.
 * Each is a self-contained component the Output tab + artifact gallery dispatch to.
 */

import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { Download, Copy, Check, ZoomIn, ZoomOut, X, ArrowUp, ArrowDown } from 'lucide-react';
import { downloadBlob, cellText, toCsv } from '../../lib/download';

// ─── shared helpers ──────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

export function safeExternalUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function safeResourceUrl(value: string, dataPrefixes: readonly string[] = []): string | null {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (dataPrefixes.some((prefix) => lower.startsWith(prefix.toLowerCase()))) return trimmed;
  return safeExternalUrl(trimmed);
}

// ─── DataTableViewer ─────────────────────────────────────────────────────────

/** Interactive table: sort, global filter, pagination, CSV/JSON export. */
export function DataTableViewer({ rows }: { rows: Array<Record<string, unknown>> }) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);

  const columns = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows.slice(0, 50)) for (const k of Object.keys(r)) set.add(k);
    return [...set].slice(0, 24);
  }, [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => columns.some((c) => cellText(r[c]).toLowerCase().includes(q)));
  }, [rows, columns, query]);

  const sorted = useMemo(() => {
    if (!sortKey) return filtered;
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = a[sortKey]; const bv = b[sortKey];
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return cellText(av).localeCompare(cellText(bv)) * dir;
    });
  }, [filtered, sortKey, sortDir]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const clamped = Math.min(page, pageCount - 1);
  const pageRows = sorted.slice(clamped * pageSize, clamped * pageSize + pageSize);

  const toggleSort = (c: string) => {
    if (sortKey === c) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(c); setSortDir('asc'); }
  };

  if (rows.length === 0) return <div className="text-[12px] text-text-muted">No rows.</div>;

  return (
    <div className="overflow-hidden rounded-input border border-line bg-surface-2">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-2 py-1.5">
        <input
          value={query}
          onChange={(e) => { setQuery(e.target.value); setPage(0); }}
          placeholder="Filter…"
          className="h-7 w-40 rounded-input border border-line bg-surface-2 px-2 text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
        />
        <span className="text-[11px] text-text-muted">{sorted.length} rows · {columns.length} cols</span>
        <div className="ml-auto flex items-center gap-1">
          <select
            value={pageSize}
            onChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }}
            className="h-7 rounded-input border border-line bg-surface-2 px-1 text-[11px] text-text-secondary"
          >
            {[25, 50, 100].map((n) => <option key={n} value={n}>{n}/page</option>)}
          </select>
          <button type="button" onClick={() => downloadBlob(toCsv(sorted, columns), 'data.csv', 'text/csv')}
            className="inline-flex h-7 items-center gap-1 rounded-btn border border-line px-2 text-[11px] text-text-secondary hover:bg-surface-2">
            <Download size={11} /> CSV
          </button>
          <button type="button" onClick={() => downloadBlob(JSON.stringify(sorted, null, 2), 'data.json', 'application/json')}
            className="inline-flex h-7 items-center gap-1 rounded-btn border border-line px-2 text-[11px] text-text-secondary hover:bg-surface-2">
            <Download size={11} /> JSON
          </button>
        </div>
      </div>
      <div className="max-h-[420px] overflow-auto">
        <table className="w-full text-left text-[12px]">
          <thead className="sticky top-0 bg-surface">
            <tr className="border-b border-line text-[10px] uppercase tracking-wider text-text-muted">
              {columns.map((c) => (
                <th key={c} className="cursor-pointer select-none whitespace-nowrap px-3 py-2 hover:text-text-primary" onClick={() => toggleSort(c)}>
                  <span className="inline-flex items-center gap-1">
                    {c}
                    {sortKey === c && (sortDir === 'asc' ? <ArrowUp size={10} /> : <ArrowDown size={10} />)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((r, i) => (
              <tr key={i} className="border-b border-line/50 last:border-b-0 hover:bg-surface">
                {columns.map((c) => (
                  <td key={c} className="max-w-[280px] truncate px-3 py-1.5 text-text-primary" title={cellText(r[c])}>{cellText(r[c])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pageCount > 1 && (
        <div className="flex items-center justify-end gap-2 border-t border-line px-3 py-1.5 text-[11px] text-text-muted">
          <button type="button" disabled={clamped === 0} onClick={() => setPage(clamped - 1)} className="rounded px-2 py-0.5 hover:bg-surface-2 disabled:opacity-40">Prev</button>
          <span>Page {clamped + 1} / {pageCount}</span>
          <button type="button" disabled={clamped >= pageCount - 1} onClick={() => setPage(clamped + 1)} className="rounded px-2 py-0.5 hover:bg-surface-2 disabled:opacity-40">Next</button>
        </div>
      )}
    </div>
  );
}

/** Coerce an arbitrary value into table rows, or return null when it isn't tabular. */
export function rowsFrom(value: unknown): Array<Record<string, unknown>> | null {
  if (Array.isArray(value) && value.length > 0 && value.every(isRecord)) return value as Array<Record<string, unknown>>;
  if (isRecord(value)) {
    for (const key of ['rows', 'records', 'items', 'data', 'results']) {
      const v = value[key];
      if (Array.isArray(v) && v.length > 0 && v.every(isRecord)) return v as Array<Record<string, unknown>>;
    }
  }
  return null;
}

// ─── CodeViewer ──────────────────────────────────────────────────────────────

export function CodeViewer({ code, language }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  const lines = code.split('\n');
  const copy = () => { void navigator.clipboard?.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  return (
    <div className="overflow-hidden rounded-input border border-line bg-surface-2">
      <div className="flex items-center gap-2 border-b border-line bg-surface px-2 py-1.5">
        <span className="text-[10px] uppercase tracking-wider text-text-muted">{language ?? 'code'} · {lines.length} lines</span>
        <button type="button" onClick={copy} className="ml-auto inline-flex h-7 items-center gap-1 rounded-btn border border-line px-2 text-[11px] text-text-secondary hover:bg-surface-2">
          {copied ? <Check size={11} /> : <Copy size={11} />} {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className="max-h-[420px] overflow-auto">
        <pre className="flex text-[12px] leading-relaxed">
          <code className="select-none border-r border-line px-2 py-2 text-right font-mono text-text-muted">
            {lines.map((_, i) => <div key={i}>{i + 1}</div>)}
          </code>
          <code className="flex-1 overflow-x-auto px-3 py-2 font-mono text-text-primary">
            {lines.map((l, i) => <div key={i} className="whitespace-pre">{l || ' '}</div>)}
          </code>
        </pre>
      </div>
    </div>
  );
}

// ─── ImageViewer ─────────────────────────────────────────────────────────────

export function ImageViewer({ src, alt }: { src: string; alt?: string }) {
  const [open, setOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  const safeSrc = safeResourceUrl(src, ['data:image/']);
  if (!safeSrc) return <div className="text-[12px] text-danger">Blocked unsafe image URL.</div>;
  return (
    <>
      <button type="button" onClick={() => { setOpen(true); setZoom(1); }} className="block overflow-hidden rounded-input border border-line bg-surface-2 p-1">
        <img src={safeSrc} alt={alt ?? 'image'} className="max-h-72 w-full cursor-zoom-in rounded object-contain" />
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex flex-col bg-overlay-strong" onClick={() => setOpen(false)}>
          <div className="flex items-center justify-end gap-1 p-2" onClick={(e) => e.stopPropagation()}>
            <button type="button" onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))} className="rounded p-2 text-white hover:bg-white/10"><ZoomOut size={16} /></button>
            <span className="px-1 text-[12px] text-white">{Math.round(zoom * 100)}%</span>
            <button type="button" onClick={() => setZoom((z) => Math.min(10, z + 0.25))} className="rounded p-2 text-white hover:bg-white/10"><ZoomIn size={16} /></button>
            <button type="button" onClick={() => setOpen(false)} className="rounded p-2 text-white hover:bg-white/10"><X size={16} /></button>
          </div>
          <div className="flex flex-1 items-center justify-center overflow-auto p-4" onClick={(e) => e.stopPropagation()}>
            <img src={safeSrc} alt={alt ?? 'image'} style={{ transform: `scale(${zoom})` }} className="max-h-full max-w-full origin-center object-contain transition-transform" />
          </div>
        </div>
      )}
    </>
  );
}

// ─── PdfViewer ───────────────────────────────────────────────────────────────

export function PdfViewer({ src, name }: { src: string; name?: string }) {
  const safeSrc = safeResourceUrl(src, ['data:application/pdf']);
  if (!safeSrc) return <div className="text-[12px] text-danger">Blocked unsafe PDF URL.</div>;
  return (
    <div className="overflow-hidden rounded-input border border-line bg-surface-2">
      <div className="flex items-center gap-2 border-b border-line bg-surface px-2 py-1.5">
        <span className="text-[10px] uppercase tracking-wider text-text-muted">PDF</span>
        <a href={safeSrc} download={name ?? 'document.pdf'} className="ml-auto inline-flex h-7 items-center gap-1 rounded-btn border border-line px-2 text-[11px] text-text-secondary hover:bg-surface-2">
          <Download size={11} /> Download
        </a>
      </div>
      <iframe title={name ?? 'PDF'} src={safeSrc} className="h-[480px] w-full bg-white" />
    </div>
  );
}

// ─── VideoPlayer ─────────────────────────────────────────────────────────────

const PLAYBACK_RATES = [0.5, 1, 1.5, 2] as const;

export function VideoPlayer({ src, name }: { src: string; name?: string }) {
  const [rate, setRate] = useState(1);
  const safeSrc = safeResourceUrl(src, ['data:video/']);
  if (!safeSrc) return <div className="text-[12px] text-danger">Blocked unsafe video URL.</div>;
  return (
    <div className="overflow-hidden rounded-input border border-line bg-surface-2">
      <div className="flex items-center gap-2 border-b border-line bg-surface px-2 py-1.5">
        <span className="text-[10px] uppercase tracking-wider text-text-muted">Video</span>
        <div className="ml-auto flex items-center gap-1">
          {PLAYBACK_RATES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => { setRate(r); const el = document.getElementById(`vid-${name ?? 'v'}`) as HTMLVideoElement | null; if (el) el.playbackRate = r; }}
              className={clsx('h-6 rounded-btn border px-1.5 text-[10px]', rate === r ? 'border-accent text-accent' : 'border-line text-text-secondary hover:bg-surface-2')}
            >
              {r}×
            </button>
          ))}
          <a href={safeSrc} download={name ?? 'video'} className="inline-flex h-6 items-center gap-1 rounded-btn border border-line px-2 text-[10px] text-text-secondary hover:bg-surface-2">
            <Download size={10} /> Download
          </a>
        </div>
      </div>
      <video id={`vid-${name ?? 'v'}`} src={safeSrc} controls className="max-h-[480px] w-full bg-black" />
    </div>
  );
}

// ─── AudioPlayer ─────────────────────────────────────────────────────────────

export function AudioPlayer({ src, name }: { src: string; name?: string }) {
  const safeSrc = safeResourceUrl(src, ['data:audio/']);
  if (!safeSrc) return <div className="text-[12px] text-danger">Blocked unsafe audio URL.</div>;
  return (
    <div className="overflow-hidden rounded-input border border-line bg-surface-2">
      <div className="flex items-center gap-2 border-b border-line bg-surface px-2 py-1.5">
        <span className="text-[10px] uppercase tracking-wider text-text-muted">Audio</span>
        <span className="truncate text-[11px] text-text-secondary">{name}</span>
        <a href={safeSrc} download={name ?? 'audio'} className="ml-auto inline-flex h-6 items-center gap-1 rounded-btn border border-line px-2 text-[10px] text-text-secondary hover:bg-surface-2">
          <Download size={10} /> Download
        </a>
      </div>
      <div className="p-3">
        <audio src={safeSrc} controls className="w-full" />
      </div>
    </div>
  );
}

// ─── WebsitePreview ──────────────────────────────────────────────────────────

/** In-panel browser for a hosted site: read-only address bar + iframe + open. */
export function WebsitePreview({ url }: { url: string }) {
  const safeUrl = safeExternalUrl(url);
  if (!safeUrl) return <div className="text-[12px] text-danger">Blocked unsafe website URL.</div>;
  return (
    <div className="overflow-hidden rounded-input border border-line bg-surface-2">
      <div className="flex items-center gap-2 border-b border-line bg-surface px-2 py-1.5">
        <span className="text-[10px] uppercase tracking-wider text-text-muted">Website</span>
        <span className="flex-1 truncate rounded bg-surface-2 px-2 py-0.5 font-mono text-[10px] text-text-secondary">{safeUrl}</span>
        <a href={safeUrl} target="_blank" rel="noreferrer" className="inline-flex h-6 items-center gap-1 rounded-btn border border-line px-2 text-[10px] text-text-secondary hover:bg-surface-2">
          Open
        </a>
      </div>
      <iframe title="Website preview" src={safeUrl} className="h-[480px] w-full bg-white" sandbox="" />
    </div>
  );
}

// ─── DiffViewer ──────────────────────────────────────────────────────────────

/** Unified-diff viewer: colorizes +/- lines and @@ hunks. */
export function DiffViewer({ diff }: { diff: string }) {
  const lines = diff.split('\n');
  return (
    <div className="overflow-hidden rounded-input border border-line bg-surface-2">
      <div className="border-b border-line bg-surface px-2 py-1.5 text-[10px] uppercase tracking-wider text-text-muted">Diff</div>
      <div className="max-h-[420px] overflow-auto">
        <pre className="px-3 py-2 font-mono text-[12px] leading-relaxed">
          {lines.map((l, i) => {
            const cls = l.startsWith('+') && !l.startsWith('+++') ? 'text-success'
              : l.startsWith('-') && !l.startsWith('---') ? 'text-danger'
              : l.startsWith('@@') ? 'text-accent'
              : 'text-text-secondary';
            return <div key={i} className={`${cls} whitespace-pre`}>{l || ' '}</div>;
          })}
        </pre>
      </div>
    </div>
  );
}

// ─── CodebaseViewer ──────────────────────────────────────────────────────────

/** File tree + selected-file code pane for a multi-file artifact. */
export function CodebaseViewer({ files }: { files: Array<{ path: string; content: string }> }) {
  const [active, setActive] = useState(0);
  const file = files[active];
  return (
    <div className="flex max-h-[460px] overflow-hidden rounded-input border border-line bg-surface-2">
      <div className="w-48 shrink-0 overflow-y-auto border-r border-line bg-surface">
        <div className="border-b border-line px-2 py-1.5 text-[10px] uppercase tracking-wider text-text-muted">{files.length} files</div>
        {files.map((f, i) => (
          <button
            key={f.path}
            type="button"
            onClick={() => setActive(i)}
            className={`block w-full truncate px-2 py-1 text-left text-[11px] ${i === active ? 'bg-surface-2 text-accent' : 'text-text-secondary hover:bg-surface-2'}`}
            title={f.path}
          >
            {f.path}
          </button>
        ))}
      </div>
      <div className="min-w-0 flex-1">
        {file ? <CodeViewer code={file.content} language={file.path.split('.').pop()} /> : <div className="p-4 text-[11px] text-text-muted">No file selected</div>}
      </div>
    </div>
  );
}

// ─── DashboardViewer ─────────────────────────────────────────────────────────

interface DashboardSpec { title?: string; series: Array<{ label: string; value: number }> }

/** Dependency-free bar-chart dashboard from a {title, series:[{label,value}]} spec. */
export function DashboardViewer({ spec }: { spec: DashboardSpec }) {
  const max = Math.max(1, ...spec.series.map((s) => s.value));
  return (
    <div className="overflow-hidden rounded-input border border-line bg-surface-2">
      <div className="border-b border-line bg-surface px-2 py-1.5 text-[10px] uppercase tracking-wider text-text-muted">
        {spec.title ?? 'Dashboard'}
      </div>
      <div className="flex flex-col gap-2 p-3">
        {spec.series.map((s, i) => (
          <div key={i} className="flex items-center gap-2 text-[11px]">
            <span className="w-28 shrink-0 truncate text-text-secondary" title={s.label}>{s.label}</span>
            <div className="h-3 flex-1 overflow-hidden rounded-full bg-line">
              <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${(s.value / max) * 100}%` }} />
            </div>
            <span className="w-12 shrink-0 text-right tabular-nums text-text-primary">{s.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Parse a data-artifact JSON into a DashboardSpec, or null if it isn't one. */
export function dashboardSpecFrom(value: unknown): DashboardSpec | null {
  if (!isRecord(value)) return null;
  const root = isRecord(value.dashboard) ? value.dashboard : isRecord(value.chart) ? value.chart : value;
  const series = (root as { series?: unknown }).series;
  if (!Array.isArray(series)) return null;
  const parsed = series
    .filter(isRecord)
    .map((r) => ({ label: cellText(r.label ?? r.name ?? r.x), value: Number(r.value ?? r.y ?? r.count) }))
    .filter((s) => s.label && Number.isFinite(s.value));
  if (parsed.length === 0) return null;
  return { title: typeof (root as { title?: unknown }).title === 'string' ? (root as { title: string }).title : undefined, series: parsed };
}

// ─── DeploymentCard ──────────────────────────────────────────────────────────

interface DeploymentSpec { url: string; status?: string; version?: string; environment?: string }

/** Live deployment surface: URL + health badge + inline preview. */
export function DeploymentCard({ spec }: { spec: DeploymentSpec }) {
  const safeUrl = safeExternalUrl(spec.url);
  if (!safeUrl) return <div className="text-[12px] text-danger">Blocked unsafe deployment URL.</div>;
  const healthy = !spec.status || /ok|healthy|live|200|success/i.test(spec.status);
  return (
    <div className="overflow-hidden rounded-input border border-line bg-surface-2">
      <div className="flex items-center gap-2 border-b border-line bg-surface px-2 py-1.5">
        <span className="text-[10px] uppercase tracking-wider text-text-muted">Deployment</span>
        <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] ${healthy ? 'bg-emerald-500/10 text-success' : 'bg-danger/10 text-danger'}`}>
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${healthy ? 'bg-emerald-400' : 'bg-danger'}`} />
          {spec.status ?? 'live'}
        </span>
        {spec.environment && <span className="text-[10px] text-text-muted">{spec.environment}</span>}
        {spec.version && <span className="text-[10px] text-text-muted">v{spec.version}</span>}
        <a href={safeUrl} target="_blank" rel="noreferrer" className="ml-auto inline-flex h-6 items-center gap-1 rounded-btn border border-line px-2 text-[10px] text-text-secondary hover:bg-surface-2">Open</a>
      </div>
      <iframe title="Deployment preview" src={safeUrl} className="h-[420px] w-full bg-white" sandbox="" />
    </div>
  );
}

export function deploymentSpecFrom(value: unknown): DeploymentSpec | null {
  if (!isRecord(value)) return null;
  const root = isRecord(value.deployment) ? value.deployment : value;
  const url = (root as { url?: unknown }).url;
  if (typeof url !== 'string' || !safeExternalUrl(url)) return null;
  return {
    url,
    status: typeof (root as { status?: unknown }).status === 'string' ? (root as { status: string }).status : undefined,
    version: cellText((root as { version?: unknown }).version) || undefined,
    environment: cellText((root as { environment?: unknown }).environment ?? (root as { env?: unknown }).env) || undefined,
  };
}

// ─── APIExplorer ─────────────────────────────────────────────────────────────

interface OpenApiSpec { title?: string; version?: string; paths: Array<{ method: string; path: string; summary?: string }> }

/** Interactive-ish OpenAPI doc: lists operations grouped by path. */
export function APIExplorer({ spec }: { spec: OpenApiSpec }) {
  const METHOD_COLOR: Record<string, string> = {
    get: 'text-success', post: 'text-accent', put: 'text-warn', patch: 'text-warn', delete: 'text-danger',
  };
  return (
    <div className="overflow-hidden rounded-input border border-line bg-surface-2">
      <div className="border-b border-line bg-surface px-2 py-1.5 text-[10px] uppercase tracking-wider text-text-muted">
        API · {spec.title ?? 'OpenAPI'}{spec.version ? ` v${spec.version}` : ''} · {spec.paths.length} ops
      </div>
      <div className="max-h-[420px] overflow-auto p-2">
        {spec.paths.map((op, i) => (
          <div key={i} className="flex items-center gap-2 border-b border-line/40 px-1 py-1.5 text-[11px] last:border-0">
            <span className={`w-14 shrink-0 font-mono text-[10px] font-semibold uppercase ${METHOD_COLOR[op.method.toLowerCase()] ?? 'text-text-muted'}`}>{op.method}</span>
            <span className="font-mono text-text-primary">{op.path}</span>
            {op.summary && <span className="ml-auto truncate text-text-muted">{op.summary}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

export function openApiFrom(value: unknown): OpenApiSpec | null {
  if (!isRecord(value) || (!value.openapi && !value.swagger)) return null;
  const info = isRecord(value.info) ? value.info : {};
  const pathsObj = isRecord(value.paths) ? value.paths : {};
  const paths: OpenApiSpec['paths'] = [];
  for (const [path, methods] of Object.entries(pathsObj)) {
    if (!isRecord(methods)) continue;
    for (const [method, op] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method.toLowerCase())) continue;
      paths.push({ method, path, summary: isRecord(op) && typeof op.summary === 'string' ? op.summary : undefined });
    }
  }
  if (paths.length === 0) return null;
  return {
    title: typeof (info as { title?: unknown }).title === 'string' ? (info as { title: string }).title : undefined,
    version: cellText((info as { version?: unknown }).version) || undefined,
    paths,
  };
}

/** Parse a data-artifact JSON into a codebase file list, or null. */
export function filesFrom(value: unknown): Array<{ path: string; content: string }> | null {
  if (!isRecord(value)) return null;
  const files = (value.files ?? value.codebase) as unknown;
  if (!Array.isArray(files)) return null;
  const parsed = files
    .filter(isRecord)
    .map((f) => ({ path: cellText(f.path ?? f.name), content: cellText(f.content ?? f.code ?? '') }))
    .filter((f) => f.path);
  return parsed.length > 0 ? parsed : null;
}



