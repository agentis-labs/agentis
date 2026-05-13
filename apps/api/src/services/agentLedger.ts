import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { AgentisError } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';

export type LedgerColumnType = 'text' | 'number' | 'boolean' | 'date' | 'json';

export interface LedgerColumnDefinition {
  id: string;
  name: string;
  type: LedgerColumnType;
  required?: boolean;
  defaultValue?: unknown;
}

export interface CreateLedgerTableArgs {
  workspaceId: string;
  name: string;
  description?: string | null;
  columns: LedgerColumnDefinition[];
}

export interface WriteLedgerRowArgs {
  workspaceId: string;
  tableId: string;
  data: Record<string, unknown>;
  sourceAgentId?: string | null;
  workflowId?: string | null;
  runId?: string | null;
}

export interface QueryLedgerRowsArgs {
  workspaceId: string;
  tableId: string;
  q?: string;
  agentId?: string;
  workflowId?: string;
  runId?: string;
  limit?: number;
}

export class AgentLedgerService {
  constructor(private readonly db: AgentisSqliteDb) {}

  listTables(workspaceId: string) {
    return this.db
      .select()
      .from(schema.workspaceTableDefinitions)
      .where(eq(schema.workspaceTableDefinitions.workspaceId, workspaceId))
      .all()
      .filter((table) => !table.archivedAt)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  getTable(workspaceId: string, tableId: string) {
    const table = this.db
      .select()
      .from(schema.workspaceTableDefinitions)
      .where(
        and(
          eq(schema.workspaceTableDefinitions.id, tableId),
          eq(schema.workspaceTableDefinitions.workspaceId, workspaceId),
        ),
      )
      .get();
    if (!table || table.archivedAt) throw new AgentisError('RESOURCE_NOT_FOUND', 'Ledger table not found');
    return table;
  }

  createTable(args: CreateLedgerTableArgs) {
    const now = new Date().toISOString();
    const row = {
      id: randomUUID(),
      workspaceId: args.workspaceId,
      name: args.name,
      description: args.description ?? null,
      columns: normalizeColumns(args.columns) as unknown as object,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(schema.workspaceTableDefinitions).values(row).run();
    return row;
  }

  archiveTable(workspaceId: string, tableId: string) {
    this.getTable(workspaceId, tableId);
    const now = new Date().toISOString();
    this.db
      .update(schema.workspaceTableDefinitions)
      .set({ archivedAt: now, updatedAt: now })
      .where(eq(schema.workspaceTableDefinitions.id, tableId))
      .run();
    return { id: tableId, archivedAt: now };
  }

  queryRows(args: QueryLedgerRowsArgs) {
    this.getTable(args.workspaceId, args.tableId);
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);
    let rows = this.db
      .select()
      .from(schema.workspaceTableRows)
      .where(
        and(
          eq(schema.workspaceTableRows.workspaceId, args.workspaceId),
          eq(schema.workspaceTableRows.tableId, args.tableId),
        ),
      )
      .all();

    if (args.agentId) rows = rows.filter((row) => row.sourceAgentId === args.agentId);
    if (args.workflowId) rows = rows.filter((row) => row.workflowId === args.workflowId);
    if (args.runId) rows = rows.filter((row) => row.runId === args.runId);
    if (args.q?.trim()) {
      const q = args.q.trim().toLowerCase();
      rows = rows.filter((row) => JSON.stringify(row.data).toLowerCase().includes(q));
    }

    return rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, limit);
  }

  insertRow(args: WriteLedgerRowArgs) {
    const table = this.getTable(args.workspaceId, args.tableId);
    const data = validateRow(table.columns as LedgerColumnDefinition[], args.data);
    const now = new Date().toISOString();
    const row = {
      id: randomUUID(),
      tableId: args.tableId,
      workspaceId: args.workspaceId,
      data: data as unknown as object,
      sourceAgentId: args.sourceAgentId ?? null,
      workflowId: args.workflowId ?? null,
      runId: args.runId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(schema.workspaceTableRows).values(row).run();
    return row;
  }

  updateRow(workspaceId: string, tableId: string, rowId: string, patch: Record<string, unknown>) {
    const table = this.getTable(workspaceId, tableId);
    const existing = this.db
      .select()
      .from(schema.workspaceTableRows)
      .where(
        and(
          eq(schema.workspaceTableRows.id, rowId),
          eq(schema.workspaceTableRows.tableId, tableId),
          eq(schema.workspaceTableRows.workspaceId, workspaceId),
        ),
      )
      .get();
    if (!existing) throw new AgentisError('RESOURCE_NOT_FOUND', 'Ledger row not found');
    const data = validateRow(table.columns as LedgerColumnDefinition[], {
      ...(existing.data as Record<string, unknown>),
      ...patch,
    });
    const updatedAt = new Date().toISOString();
    this.db
      .update(schema.workspaceTableRows)
      .set({ data: data as unknown as object, updatedAt })
      .where(eq(schema.workspaceTableRows.id, rowId))
      .run();
    return { ...existing, data, updatedAt };
  }

  deleteRow(workspaceId: string, tableId: string, rowId: string) {
    this.getTable(workspaceId, tableId);
    this.db
      .delete(schema.workspaceTableRows)
      .where(
        and(
          eq(schema.workspaceTableRows.id, rowId),
          eq(schema.workspaceTableRows.tableId, tableId),
          eq(schema.workspaceTableRows.workspaceId, workspaceId),
        ),
      )
      .run();
    return { id: rowId };
  }
}

function normalizeColumns(columns: LedgerColumnDefinition[]): LedgerColumnDefinition[] {
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new AgentisError('VALIDATION_FAILED', 'At least one ledger column is required');
  }
  const seen = new Set<string>();
  return columns.map((column) => {
    const id = safeColumnId(column.id || column.name);
    if (seen.has(id)) throw new AgentisError('VALIDATION_FAILED', `Duplicate column id: ${id}`);
    seen.add(id);
    if (!['text', 'number', 'boolean', 'date', 'json'].includes(column.type)) {
      throw new AgentisError('VALIDATION_FAILED', `Unsupported column type: ${column.type}`);
    }
    return {
      id,
      name: String(column.name || id),
      type: column.type,
      required: Boolean(column.required),
      ...(column.defaultValue !== undefined ? { defaultValue: column.defaultValue } : {}),
    };
  });
}

function validateRow(columns: LedgerColumnDefinition[], input: Record<string, unknown>): Record<string, unknown> {
  const normalized = normalizeColumns(columns);
  const output: Record<string, unknown> = {};
  for (const column of normalized) {
    const raw = input[column.id] ?? column.defaultValue;
    if (raw === undefined || raw === null || raw === '') {
      if (column.required) throw new AgentisError('VALIDATION_FAILED', `${column.name} is required`);
      output[column.id] = raw ?? null;
      continue;
    }
    output[column.id] = coerceValue(column, raw);
  }
  return output;
}

function coerceValue(column: LedgerColumnDefinition, value: unknown): unknown {
  switch (column.type) {
    case 'text':
      return String(value);
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new AgentisError('VALIDATION_FAILED', `${column.name} must be a number`);
      return n;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      throw new AgentisError('VALIDATION_FAILED', `${column.name} must be a boolean`);
    case 'date': {
      const date = new Date(String(value));
      if (Number.isNaN(date.getTime())) throw new AgentisError('VALIDATION_FAILED', `${column.name} must be a date`);
      return date.toISOString();
    }
    case 'json':
      return typeof value === 'string' ? JSON.parse(value) : value;
  }
}

function safeColumnId(value: string): string {
  const id = String(value || '').trim().replace(/[^a-zA-Z0-9_]/g, '_');
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(id)) {
    throw new AgentisError('VALIDATION_FAILED', 'Column ids must be valid identifiers');
  }
  return id;
}
