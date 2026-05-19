/**
 * DataView — the app's Data layer tab (AGENTIS-PLATFORM-10X §Layer 3).
 *
 * Schema viewer + record browser for every structured table the app owns.
 * Tables are declared in the package manifest and provisioned on install;
 * this view reads them through `/v1/apps/:id/data`.
 */

import { useCallback, useEffect, useState } from 'react';
import { Database, RefreshCw, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { Skeleton } from '../shared/Skeleton';
import { EmptyState } from '../shared/EmptyState';
import { Button } from '../shared/Button';
import { AppDataSourcesSection } from '../apps/AppDataSourcesSection';

interface DataField {
  type: string;
  required?: boolean;
  description?: string;
}
interface DataTableMeta {
  name: string;
  description: string | null;
  rowCount: number;
  schema: { name: string; schema: Record<string, DataField> } | null;
}
interface QueryResult {
  records: Array<Record<string, unknown>>;
  total: number;
  limit: number;
  offset: number;
}

export function DataView({ appId, initialTable }: { appId: string; initialTable?: string }) {
  const [tables, setTables] = useState<DataTableMeta[] | null>(null);
  const [active, setActive] = useState<string | null>(initialTable ?? null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [loadingRecords, setLoadingRecords] = useState(false);

  const loadTables = useCallback(async () => {
    try {
      const data = await api<{ tables: DataTableMeta[] }>(`/v1/apps/${appId}/data`);
      setTables(data.tables);
      setActive((prev) => prev ?? data.tables[0]?.name ?? null);
    } catch {
      setTables([]);
    }
  }, [appId]);

  const loadRecords = useCallback(
    async (table: string) => {
      setLoadingRecords(true);
      try {
        const data = await api<QueryResult>(`/v1/apps/${appId}/data/${table}?limit=100`);
        setResult(data);
      } catch {
        setResult({ records: [], total: 0, limit: 100, offset: 0 });
      } finally {
        setLoadingRecords(false);
      }
    },
    [appId],
  );

  useEffect(() => {
    void loadTables();
  }, [loadTables]);
  useEffect(() => {
    if (initialTable) setActive(initialTable);
  }, [initialTable]);
  useEffect(() => {
    if (active) void loadRecords(active);
  }, [active, loadRecords]);

  async function deleteRecord(table: string, id: string) {
    await api(`/v1/apps/${appId}/data/${table}/${id}`, { method: 'DELETE' });
    void loadRecords(table);
    void loadTables();
  }

  if (tables === null) {
    return (
      <div className="space-y-3 p-6">
        <Skeleton height={32} />
        <Skeleton height={280} />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <AppDataSourcesSection
        appId={appId}
        onImported={async () => {
          await loadTables();
          if (active) await loadRecords(active);
        }}
      />

      {tables.length === 0 ? (
        <div className="flex-1 overflow-auto p-8">
          <EmptyState
            icon={<Database size={48} />}
            title="No Data tables"
            body="This app does not declare a Data layer. Add dataTables to the app manifest to give it an operational store that workflows write to and APIs query."
            variant="page"
          />
        </div>
      ) : (
        <DataTableBrowser
          tables={tables}
          active={active}
          setActive={setActive}
          result={result}
          loadingRecords={loadingRecords}
          onRefresh={() => active && void loadRecords(active)}
          onDelete={(id) => active && void deleteRecord(active, id)}
        />
      )}
    </div>
  );
}

function DataTableBrowser({
  tables,
  active,
  setActive,
  result,
  loadingRecords,
  onRefresh,
  onDelete,
}: {
  tables: DataTableMeta[];
  active: string | null;
  setActive: (table: string) => void;
  result: QueryResult | null;
  loadingRecords: boolean;
  onRefresh: () => void;
  onDelete: (id: string) => void;
}) {
  const activeMeta = tables.find((t) => t.name === active) ?? null;
  const columns = activeMeta?.schema ? Object.keys(activeMeta.schema.schema) : [];

  return (
    <div className="flex min-h-0 flex-1">
      <div className="w-56 shrink-0 overflow-y-auto border-r border-line p-3">
        <div className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
          Tables
        </div>
        {tables.map((t) => (
          <button
            key={t.name}
            onClick={() => setActive(t.name)}
            className={
              'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[13px] ' +
              (t.name === active
                ? 'bg-surface-raised text-text-primary'
                : 'text-text-secondary hover:bg-surface-raised/60')
            }
          >
            <span className="truncate">{t.name}</span>
            <span className="ml-2 shrink-0 text-[11px] text-text-muted">{t.rowCount}</span>
          </button>
        ))}
      </div>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <div className="min-w-0">
            <div className="text-[14px] font-semibold text-text-primary">{active}</div>
            {activeMeta?.description && (
              <div className="truncate text-[12px] text-text-muted">{activeMeta.description}</div>
            )}
          </div>
          <Button size="sm" variant="ghost" onClick={onRefresh}>
            <RefreshCw size={13} /> Refresh
          </Button>
        </div>

        <div className="flex-1 overflow-auto p-5">
          {loadingRecords ? (
            <Skeleton height={240} />
          ) : !result || result.records.length === 0 ? (
            <EmptyState
              icon={<Database size={40} />}
              title="No records yet"
              body="Workflows that write to this table via data_write nodes will fill it as the app runs."
            />
          ) : (
            <div className="overflow-auto rounded-lg border border-line">
              <table className="w-full text-[12px]">
                <thead className="bg-surface-raised text-text-muted">
                  <tr>
                    {columns.map((col) => (
                      <th key={col} className="px-3 py-2 text-left font-medium">
                        {col}
                      </th>
                    ))}
                    <th className="px-3 py-2 text-left font-medium">created</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody>
                  {result.records.map((rec) => (
                    <tr key={String(rec.id)} className="border-t border-line">
                      {columns.map((col) => (
                        <td key={col} className="max-w-[240px] truncate px-3 py-1.5 text-text-secondary">
                          {renderCell(rec[col])}
                        </td>
                      ))}
                      <td className="px-3 py-1.5 text-text-muted">
                        {formatDate(rec.created_at)}
                      </td>
                      <td className="px-2">
                        <button
                          className="text-text-muted hover:text-status-error"
                          onClick={() => onDelete(String(rec.id))}
                          title="Delete record"
                        >
                          <Trash2 size={13} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {result && (
            <div className="mt-3 text-[11px] text-text-muted">
              Showing {result.records.length} of {result.total} records
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function renderCell(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function formatDate(value: unknown): string {
  if (typeof value !== 'string') return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}
