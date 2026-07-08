/**
 * Pure free-function helpers used by the node executors (extracted from
 * WorkflowEngine). Dependency-light; shared by the executor controller and a
 * few remaining engine call sites.
 */
import { schema } from '@agentis/db/sqlite';
import { and } from 'drizzle-orm';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

export function backoffMs(attempt: number): number {
  // Exponential with jitter, capped at 4s.
  const base = Math.min(4000, 200 * 2 ** (attempt - 1));
  return base + Math.floor(Math.random() * 100);
}

export function redactUrl(url: string): string {
  // Strip query params from the executor reference for activity feeds; keep
  // host + path so operators can still recognize the call.
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.length > 60 ? `${url.slice(0, 60)}â€¦` : url;
  }
}

export function asString(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

/** Best-effort JSON coercion for templated GraphQL variable strings. */
export function coerceJson(value: string): unknown {
  const t = value.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try { return JSON.parse(t); } catch { return value; }
  }
  return value;
}

/** Parse a CSV string into row objects (when headers) or string arrays. */
export function parseCsv(text: string, hasHeaders: boolean): Array<Record<string, string>> | string[][] {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return hasHeaders ? [] : [];
  if (!hasHeaders) return rows;
  const headers = rows[0]!;
  return rows.slice(1).map((cells) => {
    const rec: Record<string, string> = {};
    headers.forEach((h, i) => { rec[h] = cells[i] ?? ''; });
    return rec;
  });
}

/** RFC-4180-ish CSV tokenizer (quotes, escaped quotes, embedded newlines). */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else { field += ch; }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); field = ''; rows.push(row); row = [];
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** Build a CSV string from row objects. */
export function buildCsv(records: Array<Record<string, unknown>>, hasHeaders: boolean): string {
  if (records.length === 0) return '';
  const headers = Object.keys(records[0]!);
  const escape = (v: unknown): string => {
    const s = v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines: string[] = [];
  if (hasHeaders) lines.push(headers.map(escape).join(','));
  for (const rec of records) lines.push(headers.map((h) => escape(rec[h])).join(','));
  return lines.join('\n');
}

/** Convert an exceljs worksheet to row objects/arrays. */
export function worksheetToRows(ws: unknown, hasHeaders: boolean): Array<Record<string, unknown>> | unknown[][] {
  if (!ws) return [];
  const raw: unknown[][] = [];
  const sheet = ws as { eachRow(cb: (row: { values: unknown }, n: number) => void): void };
  sheet.eachRow((r) => {
    // exceljs row.values is 1-indexed (values[0] is undefined).
    const cells = Array.isArray(r.values) ? (r.values as unknown[]).slice(1) : [];
    raw.push(cells.map((c) => (c && typeof c === 'object' && 'text' in (c as object) ? (c as { text: unknown }).text : c)));
  });
  if (raw.length === 0) return [];
  if (!hasHeaders) return raw;
  const headers = (raw[0] ?? []).map((h) => asString(h));
  return raw.slice(1).map((cells) => {
    const rec: Record<string, unknown> = {};
    headers.forEach((h, i) => { rec[h] = cells[i] ?? null; });
    return rec;
  });
}

/** Pull an HTML string out of a node input: a string, or `{content|html|body}`. */
export function extractInputHtml(inputData: Record<string, unknown>): string {
  for (const key of ['content', 'html', 'body']) {
    const v = inputData[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

export function parseJsonOrString(input: string): unknown {
  if (typeof input !== 'string') return input;
  const trimmed = input.trim();
  if (!trimmed) return '';
  // Best-effort JSON parse for values authored as templates â€” fall back to the
  // literal string when the result isn't valid JSON.
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    trimmed === 'true' ||
    trimmed === 'false' ||
    trimmed === 'null' ||
    /^-?\d+(\.\d+)?$/.test(trimmed)
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return input;
    }
  }
  return input;
}

export function checkGuardrail(
  type: string,
  value: unknown,
  rule: { value?: string; limit?: number },
): boolean {
  const asString = (v: unknown): string => {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  };
  switch (type) {
    case 'not_empty':
      if (value == null) return false;
      if (typeof value === 'string') return value.trim().length > 0;
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === 'object') return Object.keys(value as object).length > 0;
      return Boolean(value);
    case 'min_length':
      return asString(value).length >= (rule.limit ?? 0);
    case 'max_length':
      return asString(value).length <= (rule.limit ?? Number.POSITIVE_INFINITY);
    case 'contains':
      return !!rule.value && asString(value).includes(rule.value);
    case 'not_contains':
      return !!rule.value && !asString(value).includes(rule.value);
    case 'regex':
      if (!rule.value) return true;
      try {
        return new RegExp(rule.value).test(asString(value));
      } catch {
        return false;
      }
    case 'json_schema':
      // Lightweight check â€” full JSON Schema validation lives in the contract
      // pipeline. For inline guardrails we just verify the value parses as JSON
      // and (optionally) has the declared required top-level keys.
      if (!rule.value) return true;
      try {
        const schema = JSON.parse(rule.value) as { required?: string[] };
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
        if (Array.isArray(schema.required)) {
          for (const key of schema.required) {
            if (!(key in (value as Record<string, unknown>))) return false;
          }
        }
        return true;
      } catch {
        return false;
      }
    default:
      return true;
  }
}
