
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Database, Download, Loader2, Plus, RefreshCw, Table2, Trash2, Upload, X } from 'lucide-react';
import clsx from 'clsx';
import { REALTIME_EVENTS, type CollectionInfo, type CollectionRecord, type CollectionField } from '@agentis/core';
import { appsApi } from '../../lib/appsApi';
import { downloadBlob, toCsv, parseCsv } from '../../lib/download';
import { rtSubscribe, useRealtime, type RealtimeEnvelope } from '../../lib/realtime';
import { apiErrorMessage } from '../../lib/api';
import { formatDisplay, humanizeToken } from './format';

const PAGE = 50;

export function AppDataGrid({ appId, collections }: { appId: string; collections: CollectionInfo[] }) {
  const [activeName, setActiveName] = useState<string | null>(collections[0]?.name ?? null);
  useEffect(() => {
    // Keep a valid selection as collections load/change (agents can add them live).
    if ((!activeName || !collections.some((c) => c.name === activeName)) && collections[0]) {
      setActiveName(collections[0].name);
    }
  }, [collections, activeName]);

  const active = collections.find((c) => c.name === activeName) ?? null;

  if (collections.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center text-text-muted">
        <Database size={30} className="mb-3 text-text-secondary" />
        <div className="text-[14px] font-medium text-text-secondary">No collections yet</div>
        <p className="mt-1 max-w-md text-[12px] leading-relaxed">Collections defined by agents or app actions appear here as typed, editable tables — and fill in live as runs write records.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-56 shrink-0 flex-col overflow-y-auto border-r border-line bg-surface">
        <div className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Collections</div>
        <div className="flex flex-col gap-0.5 p-1.5">
          {collections.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setActiveName(c.name)}
              className={clsx(
                'flex items-center gap-2 rounded-btn px-2.5 py-1.5 text-left text-[13px]',
                c.name === activeName ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:bg-surface-2',
              )}
            >
              <Table2 size={13} className="shrink-0" />
              <span className="flex-1 truncate font-mono text-[12px]">{c.name}</span>
              <span className="shrink-0 rounded-full bg-surface-2 px-1.5 text-[10px] tabular-nums text-text-muted" title={`${c.recordCount ?? 0} record${(c.recordCount ?? 0) === 1 ? '' : 's'}`}>{formatCount(c.recordCount ?? 0)}</span>
            </button>
          ))}
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        {active ? <CollectionGrid key={active.id} appId={appId} collection={active} /> : null}
      </div>
    </div>
  );
}

function CollectionGrid({ appId, collection }: { appId: string; collection: CollectionInfo }) {
  const fields = collection.schema.fields;
  const [rows, setRows] = useState<CollectionRecord[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<CollectionRecord | 'new' | null>(null);

  const load = useCallback(
    async (opts: { append?: boolean; cursor?: string } = {}) => {
      setLoading(true);
      setError(null);
      try {
        const res = await appsApi.query(appId, collection.name, { limit: PAGE, ...(opts.cursor ? { cursor: opts.cursor } : {}) });
        setRows((prev) => (opts.append ? [...prev, ...res.rows] : res.rows));
        setCursor(res.nextCursor);
      } catch (err) {
        setError(apiErrorMessage(err));
      } finally {
        setLoading(false);
      }
    },
    [appId, collection.name],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Live: refetch the first page when this collection changes under us (a run or
  // DATA_CHANGED is dual-published to the workspace room (appStores.ts), so a
  // workspace subscription delivers it (with SSE fallback + reconnect for free).
  useEffect(() => rtSubscribe('workspace', {}), []);
  const onData = useCallback(
    (env: RealtimeEnvelope) => {
      const p = (env.payload ?? {}) as { appId?: string; collection?: string };
      if (p.appId === appId && p.collection === collection.name) void load();
    },
    [appId, collection.name, load],
  );
  useRealtime(useMemo(() => [REALTIME_EVENTS.DATA_CHANGED], []), onData);

  const remove = useCallback(
    async (record: CollectionRecord) => {
      try {
        await appsApi.deleteRecord(appId, collection.name, record.id);
        setRows((prev) => prev.filter((r) => r.id !== record.id));
      } catch (err) {
        setError(apiErrorMessage(err));
      }
    },
    [appId, collection.name],
  );

  const fileInput = useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = useState(false);
  const [exportMenu, setExportMenu] = useState(false);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  /** Read every record's data across all pages (bounded) for an export. */
  const gatherAll = useCallback(async (): Promise<Array<Record<string, unknown>>> => {
    const all: Array<Record<string, unknown>> = [];
    let cur: string | undefined;
    for (let guard = 0; guard < 400 && all.length < 20_000; guard += 1) {
      const res = await appsApi.query(appId, collection.name, { limit: 500, ...(cur ? { cursor: cur } : {}) });
      for (const r of res.rows) all.push(r.data);
      if (!res.nextCursor) break;
      cur = res.nextCursor;
    }
    return all;
  }, [appId, collection.name]);

  const exportData = useCallback(
    async (format: 'csv' | 'json') => {
      setExportMenu(false);
      setExporting(true);
      setError(null);
      try {
        const data = await gatherAll();
        if (format === 'csv') {
          downloadBlob(toCsv(data, fields.map((f) => f.key)), `${collection.name}.csv`, 'text/csv;charset=utf-8');
        } else {
          downloadBlob(JSON.stringify(data, null, 2), `${collection.name}.json`, 'application/json');
        }
        setNotice(`Exported ${data.length} row${data.length === 1 ? '' : 's'} as ${format.toUpperCase()}.`);
      } catch (err) {
        setError(apiErrorMessage(err));
      } finally {
        setExporting(false);
      }
    },
    [gatherAll, fields, collection.name],
  );

  const importFile = useCallback(
    async (file: File) => {
      setImporting(true);
      setError(null);
      setNotice(null);
      try {
        const text = await file.text();
        let records: Array<Record<string, unknown>>;
        if (file.name.toLowerCase().endsWith('.json')) {
          const parsed = JSON.parse(text);
          const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.rows) ? parsed.rows : null;
          if (!list) throw new Error('JSON import must be an array of row objects (or { rows: [...] }).');
          records = list.map((raw: Record<string, unknown>) => coerceImportRow(fields, raw));
        } else {
          records = parseCsv(text).map((raw) => coerceImportRow(fields, raw));
        }
        if (records.length === 0) throw new Error('No rows found in the file.');
        const res = await appsApi.insertMany(appId, collection.name, records);
        const failed = res.failed.length;
        setNotice(`Imported ${res.inserted} row${res.inserted === 1 ? '' : 's'}${failed ? ` · ${failed} skipped (invalid)` : ''}.`);
        await load();
      } catch (err) {
        setError(apiErrorMessage(err));
      } finally {
        setImporting(false);
      }
    },
    [appId, collection.name, fields, load],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2.5">
        <div className="min-w-0">
          <div className="truncate font-mono text-[13px] font-semibold text-text-primary">{collection.name}</div>
          <div className="text-[11px] text-text-muted">{rows.length}{cursor ? '+' : ''} row{rows.length === 1 ? '' : 's'} · {fields.length} fields</div>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex h-8 items-center gap-1.5 rounded-btn border border-line px-2.5 text-[12px] text-text-secondary hover:bg-surface-2 disabled:opacity-50" title="Refresh">
            {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          </button>
          <button type="button" onClick={() => fileInput.current?.click()} disabled={importing} className="inline-flex h-8 items-center gap-1.5 rounded-btn border border-line px-2.5 text-[12px] text-text-secondary hover:bg-surface-2 disabled:opacity-50" title="Import CSV or JSON">
            {importing ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />} Import
          </button>
          <div className="relative">
            <button type="button" onClick={() => setExportMenu((v) => !v)} disabled={exporting} className="inline-flex h-8 items-center gap-1.5 rounded-btn border border-line px-2.5 text-[12px] text-text-secondary hover:bg-surface-2 disabled:opacity-50" title="Export CSV or JSON">
              {exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} Export
            </button>
            {exportMenu ? (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setExportMenu(false)} />
                <div className="absolute right-0 z-20 mt-1 w-36 overflow-hidden rounded-btn border border-line bg-surface shadow-dropdown">
                  <button type="button" onClick={() => void exportData('csv')} className="block w-full px-3 py-1.5 text-left text-[12px] text-text-secondary hover:bg-surface-2">Export as CSV</button>
                  <button type="button" onClick={() => void exportData('json')} className="block w-full px-3 py-1.5 text-left text-[12px] text-text-secondary hover:bg-surface-2">Export as JSON</button>
                </div>
              </>
            ) : null}
          </div>
          <button type="button" onClick={() => setEditing('new')} className="inline-flex h-8 items-center gap-1.5 rounded-btn bg-accent px-3 text-[12px] font-semibold text-canvas hover:bg-accent-hover">
            <Plus size={13} /> Insert
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".csv,.json,text/csv,application/json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importFile(f);
            e.target.value = ''; // allow re-importing the same file
          }}
        />
      </div>

      {error ? <div className="border-b border-danger/30 bg-danger/5 px-4 py-1.5 text-[11px] text-danger">{error}</div> : null}
      {notice ? <div className="border-b border-line bg-surface-2 px-4 py-1.5 text-[11px] text-text-secondary">{notice}</div> : null}

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-[12px]">
          <thead className="sticky top-0 z-10 bg-surface">
            <tr className="border-b border-line text-left">
              {fields.map((f) => (
                <th key={f.key} className="whitespace-nowrap px-3 py-2 font-medium text-text-secondary">
                  <span className="font-mono text-[12px] text-text-primary">{f.key}</span>
                  <span className="ml-1.5 text-[10px] text-text-muted">{f.type}</span>
                </th>
              ))}
              <th className="w-10 px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="group border-b border-line/60 hover:bg-surface-2">
                {fields.map((f) => (
                  <td
                    key={f.key}
                    className="max-w-[280px] cursor-pointer truncate px-3 py-1.5 align-top"
                    title="Edit row"
                    onClick={() => setEditing(r)}
                  >
                    <CellValue value={r.data[f.key]} field={f} />
                  </td>
                ))}
                <td className="px-2 py-1.5 text-right">
                  <button
                    type="button"
                    onClick={() => void remove(r)}
                    className="text-text-disabled opacity-0 transition group-hover:opacity-100 hover:text-danger"
                    title="Delete row"
                  >
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && !loading ? (
              <tr>
                <td colSpan={fields.length + 1} className="px-3 py-10 text-center text-[12px] text-text-muted">
                  No records yet. Insert one, or run a workflow that writes to this collection.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        {cursor ? (
          <div className="p-3 text-center">
            <button type="button" onClick={() => void load({ append: true, cursor })} disabled={loading} className="inline-flex h-8 items-center gap-1.5 rounded-btn border border-line px-3 text-[12px] text-text-secondary hover:bg-surface-2 disabled:opacity-50">
              {loading ? <Loader2 size={13} className="animate-spin" /> : null} Load more
            </button>
          </div>
        ) : null}
      </div>

      {editing ? (
        <RecordEditor
          appId={appId}
          collection={collection}
          record={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved, isNew) => {
            setRows((prev) => (isNew ? [saved, ...prev] : prev.map((r) => (r.id === saved.id ? saved : r))));
            setEditing(null);
          }}
        />
      ) : null}
    </div>
  );
}

/** Compact cell rendering: json as a mono snippet, everything else via the format kit. */
function CellValue({ value, field }: { value: unknown; field: CollectionField }) {
  if (field.type === 'json') {
    if (value == null) return <span className="text-text-disabled">—</span>;
    return <span className="font-mono text-[11px] text-text-secondary">{clip(JSON.stringify(value))}</span>;
  }
  return <>{formatDisplay(value, field.type === 'date' ? { format: 'date' } : {})}</>;
}

/** Compact record count for the collection list: 1234 → "1.2k". */
function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function clip(s: string, n = 60): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Edit/insert one record — a field per schema column, typed inputs, json as text. */
function RecordEditor({
  appId,
  collection,
  record,
  onClose,
  onSaved,
}: {
  appId: string;
  collection: CollectionInfo;
  record: CollectionRecord | null;
  onClose: () => void;
  onSaved: (saved: CollectionRecord, isNew: boolean) => void;
}) {
  const fields = collection.schema.fields;
  const [draft, setDraft] = useState<Record<string, string>>(() => initialDraft(fields, record));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const payload = coerce(fields, draft);
      const isNew = record === null;
      const saved = isNew
        ? await appsApi.insertRecord(appId, collection.name, payload)
        : await appsApi.updateRecord(appId, collection.name, record.id, payload);
      onSaved(saved, isNew);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }, [appId, collection.name, draft, fields, record, onSaved]);

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={onClose}>
      <div className="flex h-full w-[min(30rem,100%)] flex-col border-l border-line bg-surface shadow-dropdown" onClick={(e) => e.stopPropagation()}>
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3">
          <div className="text-[13px] font-semibold text-text-primary">{record ? 'Edit record' : 'Insert record'}</div>
          <span className="font-mono text-[11px] text-text-muted">{collection.name}</span>
          <button type="button" onClick={onClose} className="ml-auto text-text-muted hover:text-text-primary"><X size={16} /></button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4">
          {fields.map((f) => (
            <label key={f.key} className="block">
              <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-text-secondary">
                <span className="font-mono text-text-primary">{f.key}</span>
                <span className="text-[10px] text-text-muted">{f.type}{f.required ? ' · required' : ''}</span>
              </div>
              <FieldInput field={f} value={draft[f.key] ?? ''} onChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))} />
              {f.description ? <div className="mt-0.5 text-[10px] text-text-muted">{f.description}</div> : null}
            </label>
          ))}
        </div>
        {error ? <div className="border-t border-danger/30 bg-danger/5 px-4 py-1.5 text-[11px] text-danger">{error}</div> : null}
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-3">
          <button type="button" onClick={onClose} className="h-9 rounded-btn border border-line px-3 text-[12px] text-text-secondary hover:bg-surface-2">Cancel</button>
          <button type="button" onClick={() => void save()} disabled={saving} className="inline-flex h-9 items-center gap-1.5 rounded-btn bg-accent px-4 text-[12px] font-semibold text-canvas hover:bg-accent-hover disabled:opacity-50">
            {saving ? <Loader2 size={13} className="animate-spin" /> : null} {record ? 'Save' : 'Insert'}
          </button>
        </div>
      </div>
    </div>
  );
}

function FieldInput({ field, value, onChange }: { field: CollectionField; value: string; onChange: (v: string) => void }) {
  const cls = 'w-full rounded-btn border border-line bg-canvas px-2.5 py-1.5 text-[12px] text-text-primary outline-none focus:border-accent';
  if (field.type === 'boolean') {
    return (
      <select value={value || 'false'} onChange={(e) => onChange(e.target.value)} className={cls}>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  if (field.type === 'json') {
    return <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={4} spellCheck={false} placeholder="{ }" className={clsx(cls, 'font-mono text-[11px]')} />;
  }
  return (
    <input
      type={field.type === 'number' ? 'number' : field.type === 'date' ? 'text' : 'text'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cls}
      placeholder={field.type === 'date' ? 'ISO 8601' : ''}
    />
  );
}

function initialDraft(fields: CollectionField[], record: CollectionRecord | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = record?.data[f.key];
    out[f.key] = v == null ? '' : f.type === 'json' ? JSON.stringify(v, null, 2) : String(v);
  }
  return out;
}


function coerce(fields: CollectionField[], draft: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const raw = (draft[f.key] ?? '').trim();
    if (raw === '' && !f.required) continue; // leave unset rather than write empties
    if (f.type === 'number') out[f.key] = Number(raw);
    else if (f.type === 'boolean') out[f.key] = raw === 'true';
    else if (f.type === 'json') out[f.key] = raw === '' ? null : JSON.parse(raw); // throws → surfaced as error
    else out[f.key] = raw;
  }
  return out;
}

/**
 * Coerce one imported row to the collection's field types. Mirrors {@link coerce}
 * but tolerates already-typed values (from a JSON import) — only string cells (as
 * a CSV always produces) are converted. Unknown keys are dropped.
 */
function coerceImportRow(fields: CollectionField[], raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = raw[f.key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') {
      out[f.key] = v; // JSON already carries the right type
      continue;
    }
    const s = v.trim();
    if (s === '') continue; // empty cell → leave unset (server enforces `required`)
    if (f.type === 'number') out[f.key] = Number(s);
    else if (f.type === 'boolean') out[f.key] = s === 'true';
    else if (f.type === 'json') out[f.key] = JSON.parse(s); // throws → surfaced as error
    else out[f.key] = s;
  }
  return out;
}



