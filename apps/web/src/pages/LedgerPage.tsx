import { useEffect, useMemo, useState } from 'react';
import { Plus, Save, Search, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { useToast } from '../components/shared/Toast';

interface LedgerColumn {
  id: string;
  name: string;
  type: 'text' | 'number' | 'boolean' | 'date' | 'json';
  required?: boolean;
}

interface LedgerTable {
  id: string;
  name: string;
  description: string | null;
  columns: LedgerColumn[];
  createdAt: string;
}

interface LedgerRow {
  id: string;
  data: Record<string, unknown>;
  sourceAgentId: string | null;
  runId: string | null;
  createdAt: string;
}

const DEFAULT_COLUMNS: LedgerColumn[] = [
  { id: 'summary', name: 'Summary', type: 'text', required: true },
  { id: 'status', name: 'Status', type: 'text' },
  { id: 'amount', name: 'Amount', type: 'number' },
];

export function LedgerPage() {
  const toast = useToast();
  const [tables, setTables] = useState<LedgerTable[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [name, setName] = useState('');
  const [columnsText, setColumnsText] = useState('summary:text, status:text, amount:number');
  const [rowText, setRowText] = useState('{"summary":"New record","status":"open"}');
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const selected = useMemo(() => tables.find((table) => table.id === selectedId) ?? tables[0], [tables, selectedId]);

  async function loadTables() {
    const data = await api<{ tables: LedgerTable[] }>('/v1/ledger');
    setTables(data.tables);
    setSelectedId((current) => current ?? data.tables[0]?.id ?? null);
  }

  async function loadRows(tableId = selected?.id) {
    if (!tableId) return;
    const suffix = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : '';
    const data = await api<{ rows: LedgerRow[] }>(`/v1/ledger/${tableId}/rows${suffix}`);
    setRows(data.rows);
  }

  useEffect(() => {
    void loadTables();
  }, []);

  useEffect(() => {
    void loadRows(selected?.id);
  }, [selected?.id]);

  async function createTable() {
    setCreating(true);
    try {
      const columns = parseColumns(columnsText);
      const tableName = name.trim() || `Records ${tables.length + 1}`;
      const created = await api<{ table: LedgerTable }>('/v1/ledger', { method: 'POST', body: JSON.stringify({ name: tableName, columns }) });
      setName('');
      await loadTables();
      setSelectedId(created.table.id);
      toast.success('Record table created');
    } catch (error) {
      toast.error('Could not create record table', (error as { message?: string })?.message ?? 'Check the column list and try again.');
    } finally {
      setCreating(false);
    }
  }

  async function addRow() {
    if (!selected) return;
    await api(`/v1/ledger/${selected.id}/rows`, {
      method: 'POST',
      body: JSON.stringify({ data: JSON.parse(rowText) }),
    });
    await loadRows(selected.id);
  }

  async function deleteRow(rowId: string) {
    if (!selected) return;
    await api(`/v1/ledger/${selected.id}/rows/${rowId}`, { method: 'DELETE' });
    await loadRows(selected.id);
  }

  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-lg font-medium">Records</h1>
          <p className="text-xs text-text-muted">Structured workspace records that agents and workflows can write.</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Record table" className="rounded-md border border-line bg-canvas px-3 py-2 text-sm outline-none focus:border-accent" />
          <input value={columnsText} onChange={(e) => setColumnsText(e.target.value)} className="w-72 rounded-md border border-line bg-canvas px-3 py-2 text-sm outline-none focus:border-accent" />
          <button disabled={creating} onClick={createTable} className="inline-flex items-center gap-1 rounded-md bg-accent px-3 py-2 text-xs font-medium text-canvas disabled:opacity-50"><Plus size={14} />{creating ? 'Creating…' : 'Create'}</button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[240px_1fr]">
        <aside className="min-h-0 overflow-auto rounded-lg border border-line bg-surface p-2">
          {tables.map((table) => (
            <button key={table.id} onClick={() => setSelectedId(table.id)} className={`mb-1 w-full rounded-md px-3 py-2 text-left text-sm ${selected?.id === table.id ? 'bg-surface-2 text-text-primary' : 'text-text-muted hover:bg-surface-2'}`}>
              <div className="font-medium">{table.name}</div>
              <div className="text-[11px] text-text-muted">{table.columns.length} columns</div>
            </button>
          ))}
          {tables.length === 0 && <div className="p-3 text-sm text-text-muted">No record tables yet.</div>}
        </aside>

        <main className="min-h-0 overflow-auto rounded-lg border border-line bg-surface">
          {selected ? (
            <>
              <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
                <div>
                  <div className="font-medium">{selected.name}</div>
                  <div className="text-xs text-text-muted">{selected.columns.map((column) => `${column.name}:${column.type}`).join(' / ')}</div>
                </div>
                <div className="ml-auto flex items-center gap-2">
                  <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search rows" className="rounded-md border border-line bg-canvas px-3 py-2 text-sm outline-none focus:border-accent" />
                  <button onClick={() => loadRows()} className="inline-flex items-center gap-1 rounded-md border border-line px-3 py-2 text-xs hover:text-accent"><Search size={14} />Search</button>
                </div>
              </div>
              <div className="grid gap-3 border-b border-line p-3 lg:grid-cols-[1fr_auto]">
                <textarea value={rowText} onChange={(e) => setRowText(e.target.value)} className="min-h-20 rounded-md border border-line bg-canvas p-3 font-mono text-xs outline-none focus:border-accent" />
                <button onClick={addRow} className="inline-flex items-center justify-center gap-1 rounded-md bg-accent px-3 py-2 text-xs font-medium text-canvas"><Save size={14} />Add record</button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-line text-xs text-text-muted">
                    <tr>
                      {selected.columns.map((column) => <th key={column.id} className="px-3 py-2 font-medium">{column.name}</th>)}
                      <th className="px-3 py-2 font-medium">Created</th>
                      <th className="w-10 px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id} className="border-b border-line/70">
                        {selected.columns.map((column) => <td key={column.id} className="max-w-72 truncate px-3 py-2">{formatValue(row.data[column.id])}</td>)}
                        <td className="px-3 py-2 text-xs text-text-muted">{new Date(row.createdAt).toLocaleString()}</td>
                        <td className="px-3 py-2"><button onClick={() => deleteRow(row.id)} className="rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-danger"><Trash2 size={14} /></button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {rows.length === 0 && <div className="p-6 text-sm text-text-muted">No rows match this view.</div>}
              </div>
            </>
          ) : <div className="p-6 text-sm text-text-muted">Create a table to start capturing records.</div>}
        </main>
      </div>
    </div>
  );
}

function parseColumns(value: string): LedgerColumn[] {
  const parsed = value.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    const [rawName, rawType] = part.split(':').map((segment) => segment.trim());
    const id = (rawName || 'column').replace(/[^a-zA-Z0-9_]/g, '_');
    const requested = (rawType || 'text').toLowerCase();
    const type = ['text', 'number', 'boolean', 'date', 'json'].includes(requested) ? requested as LedgerColumn['type'] : 'text';
    return { id, name: rawName || id, type };
  });
  return parsed.length ? parsed : DEFAULT_COLUMNS;
}

function formatValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
