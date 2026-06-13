/**
 * WorkflowRecordBrowser — mini record browser for one `data_write` table.
 *
 * One instance per target table inside the workflow Output tab's
 * "Accumulated Records" section (WORKFLOW-PAGE-REDESIGN.md §Tab 3 §B).
 * Shows a key-column grid, supports Load more / View all, CSV export, and
 * a confirmed Clear.
 */

import { useState } from 'react';
import { Download, Trash2 } from 'lucide-react';
import { api, apiErrorMessage } from '../../lib/api';
import { useToast } from '../shared/Toast';
import { useConfirm } from '../shared/ConfirmDialog';
import { relativeTime } from './runFormat';

interface TableSchema {
  name?: string;
  schema?: Record<string, { type?: string }>;
}

export interface RecordTable {
  table: string;
  total: number;
  records: Array<Record<string, unknown>>;
  schema: TableSchema | null;
}

const RESERVED = new Set(['id', 'created_at', 'updated_at']);
const PREVIEW_LIMIT = 5;

/** Derive the displayed columns: declared fields (or record keys) + createdAt. */
function deriveColumns(table: RecordTable): string[] {
  const fields: string[] = [];
  if (table.schema?.schema) {
    for (const key of Object.keys(table.schema.schema)) {
      if (!RESERVED.has(key)) fields.push(key);
    }
  } else {
    for (const rec of table.records) {
      for (const key of Object.keys(rec)) {
        if (!RESERVED.has(key) && !fields.includes(key)) fields.push(key);
      }
    }
  }
  return [...fields.slice(0, 5), 'created_at'];
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function humanize(value: string): string {
  const spaced = value.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function WorkflowRecordBrowser({
  workflowId,
  initial,
  onCleared,
}: {
  workflowId: string;
  initial: RecordTable;
  onCleared: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [records, setRecords] = useState(initial.records);
  const [total, setTotal] = useState(initial.total);
  const [loading, setLoading] = useState(false);
  const columns = deriveColumns({ ...initial, records });

  async function loadMore(all: boolean) {
    setLoading(true);
    try {
      const limit = all ? total : records.length + 20;
      const d = await api<RecordTable>(
        `/v1/workflows/${workflowId}/records/${encodeURIComponent(initial.table)}?limit=${limit}&offset=0`,
      );
      setRecords(d.records);
      setTotal(d.total);
    } catch (e) {
      toast.error('Failed to load records', apiErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  async function handleExport() {
    try {
      const d = await api<{ filename: string; csv: string }>(
        `/v1/workflows/${workflowId}/records/export?table=${encodeURIComponent(initial.table)}`,
      );
      const blob = new Blob([d.csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = d.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error('Export failed', apiErrorMessage(e));
    }
  }

  async function handleClear() {
    const ok = await confirm({
      title: `Clear "${initial.table}" records?`,
      body: `This permanently deletes all ${total} record${total === 1 ? '' : 's'} this workflow wrote to "${initial.table}". This cannot be undone.`,
      confirmLabel: 'Clear records',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api(`/v1/workflows/${workflowId}/records?table=${encodeURIComponent(initial.table)}`, {
        method: 'DELETE',
      });
      setRecords([]);
      setTotal(0);
      toast.success('Records cleared');
      onCleared();
    } catch (e) {
      toast.error('Clear failed', apiErrorMessage(e));
    }
  }

  return (
    <div className="rounded-card border border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="font-mono text-[13px] font-medium text-text-primary">{initial.table}</span>
        <span className="text-[12px] text-text-muted">
          {total} record{total === 1 ? '' : 's'}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => void handleExport()}
            disabled={total === 0}
            className="inline-flex h-7 items-center gap-1 rounded-btn border border-line bg-surface-2 px-2 text-[11px] font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary disabled:opacity-50"
          >
            <Download size={11} /> Export
          </button>
          <button
            type="button"
            onClick={() => void handleClear()}
            disabled={total === 0}
            className="inline-flex h-7 items-center gap-1 rounded-btn border border-line bg-surface-2 px-2 text-[11px] font-medium text-text-secondary hover:bg-danger-soft hover:text-danger disabled:opacity-50"
          >
            <Trash2 size={11} /> Clear
          </button>
        </div>
      </div>

      {records.length === 0 ? (
        <p className="px-4 py-6 text-center text-[12px] text-text-muted">
          No records written yet.
        </p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table
              className="w-full"
              role="grid"
              aria-rowcount={total}
              aria-label={`${initial.table} records`}
            >
              <thead>
                <tr className="border-b border-line bg-surface-2 text-[10px] font-medium uppercase tracking-wider text-text-muted">
                  {columns.map((col) => (
                    <th key={col} className="px-3 py-2 text-left">
                      {col === 'created_at' ? 'Created' : humanize(col)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {records.map((rec, i) => (
                  <tr key={String(rec.id ?? i)} className="border-b border-line/60 last:border-b-0">
                    {columns.map((col) => (
                      <td key={col} className="max-w-[280px] truncate px-3 py-2 text-[12px] text-text-secondary">
                        {col === 'created_at'
                          ? relativeTime(typeof rec.created_at === 'string' ? rec.created_at : null)
                          : cellText(rec[col])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-3 px-4 py-2.5 text-[11px] text-text-muted">
            <span>
              Showing {records.length} of {total} record{total === 1 ? '' : 's'}.
            </span>
            {records.length < total && (
              <>
                <button
                  type="button"
                  onClick={() => void loadMore(false)}
                  disabled={loading}
                  className="font-medium text-accent hover:text-accent-hover disabled:opacity-50"
                >
                  Load more
                </button>
                <button
                  type="button"
                  onClick={() => void loadMore(true)}
                  disabled={loading}
                  className="font-medium text-accent hover:text-accent-hover disabled:opacity-50"
                >
                  View all →
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export { PREVIEW_LIMIT };
