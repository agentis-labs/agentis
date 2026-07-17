/**
 * Client-side file download + CSV serialization/parsing. Shared so the workflow
 * output viewers and the App Data grid produce byte-identical CSV/JSON and use one
 * download path instead of each re-inventing it.
 */

/** Trigger a browser download of in-memory text content. */
export function downloadBlob(content: string, name: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** A single value → its flat cell text (objects/arrays are JSON-stringified). */
export function cellText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** RFC-4180-ish CSV: quote any cell containing a quote, comma, or newline. */
export function toCsv(rows: Array<Record<string, unknown>>, columns: string[]): string {
  const esc = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const head = columns.map(esc).join(',');
  const body = rows.map((r) => columns.map((c) => esc(cellText(r[c]))).join(',')).join('\n');
  return `${head}\n${body}`;
}

/**
 * Parse CSV text (RFC-4180-ish: quoted fields, escaped `""`, embedded newlines)
 * into row records keyed by the header line. Empty trailing line is ignored.
 */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return [];
  const header = rows[0]!;
  const out: Array<Record<string, string>> = [];
  for (let i = 1; i < rows.length; i += 1) {
    const cells = rows[i]!;
    // Skip a blank final row (a single empty cell from a trailing newline).
    if (cells.length === 1 && cells[0] === '') continue;
    const record: Record<string, string> = {};
    header.forEach((key, idx) => {
      record[key] = cells[idx] ?? '';
    });
    out.push(record);
  }
  return out;
}

/** Tokenize CSV into a matrix of raw string cells. */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      // Normalize CRLF: skip the \n after a \r.
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  // Flush the last cell/row if the file doesn't end in a newline.
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
