/**
 * Shared, failure-tolerant document extraction for channel and operator chat
 * attachments. Uploaded specifications must reach the model as content rather
 * than being reduced to a filename hint.
 */

import type { Logger } from '../logger.js';

export interface DocumentInput {
  bytes: Buffer;
  mimeType: string;
  fileName?: string;
}

export const DEFAULT_EXTRACTED_DOCUMENT_CHARS = 8_000;
export const MAX_EXTRACTED_DOCUMENT_CHARS = 120_000;

export interface DocumentExtractionResult {
  text: string;
  truncated: boolean;
  originalChars: number;
  kind: 'text' | 'document' | 'spreadsheet';
}

export class DocumentExtractionService {
  constructor(private readonly deps: { logger?: Logger } = {}) {}

  supports(mimeType: string, fileName?: string): boolean {
    const mime = (mimeType || '').toLowerCase();
    const name = (fileName || '').toLowerCase();
    return mime.includes('pdf') || name.endsWith('.pdf')
      || mime.includes('wordprocessingml') || name.endsWith('.docx')
      || mime.includes('spreadsheetml') || name.endsWith('.xlsx')
      || mime.startsWith('text/')
      || mime.includes('json') || mime.includes('csv') || mime.includes('markdown')
      || /\.(txt|md|mdx|csv|tsv|json|jsonl|ya?ml|toml|xml|html?|css|scss|less|js|jsx|mjs|cjs|ts|tsx|py|rb|go|rs|java|kt|swift|sql|sh|ps1|env|ini|conf|log)$/i.test(name);
  }

  async extractDetailed(input: DocumentInput, options: { maxChars?: number } = {}): Promise<DocumentExtractionResult | null> {
    try {
      const raw = await this.#rawText(input);
      const trimmed = raw.text.trim();
      if (!trimmed) return null;
      const maxChars = Math.min(Math.max(options.maxChars ?? DEFAULT_EXTRACTED_DOCUMENT_CHARS, 2_500), MAX_EXTRACTED_DOCUMENT_CHARS);
      const truncated = trimmed.length > maxChars;
      const text = truncated
        ? `${trimmed.slice(0, maxChars - 2_000)}\n\n...[truncated: middle omitted to fit context]...\n\n${trimmed.slice(-1_900)}`
        : trimmed;
      return { text, truncated, originalChars: trimmed.length, kind: raw.kind };
    } catch (error) {
      this.deps.logger?.warn?.('document.extract_failed', {
        mime: input.mimeType,
        fileName: input.fileName,
        err: (error as Error).message,
      });
      return null;
    }
  }

  async extract(input: DocumentInput, options: { maxChars?: number } = {}): Promise<string | null> {
    return (await this.extractDetailed(input, options))?.text ?? null;
  }

  async #rawText(input: DocumentInput): Promise<{ text: string; kind: DocumentExtractionResult['kind'] }> {
    const mime = (input.mimeType || '').toLowerCase();
    const name = (input.fileName || '').toLowerCase();
    if (mime.includes('pdf') || name.endsWith('.pdf')) {
      const { PDFParse } = (await import('pdf-parse' as string)) as typeof import('pdf-parse');
      const parser = new PDFParse({ data: input.bytes });
      try {
        const result = await parser.getText();
        return { text: result.text ?? '', kind: 'document' };
      } finally {
        await parser.destroy();
      }
    }
    if (mime.includes('wordprocessingml') || name.endsWith('.docx')) {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ buffer: input.bytes });
      return { text: result.value ?? '', kind: 'document' };
    }
    if (mime.includes('spreadsheetml') || name.endsWith('.xlsx')) {
      const { default: ExcelJS } = await import('exceljs');
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(input.bytes as unknown as ArrayBuffer);
      const sheets: string[] = [];
      workbook.eachSheet((sheet) => {
        const rows: string[] = [`## Sheet: ${sheet.name}`];
        sheet.eachRow({ includeEmpty: false }, (row) => {
          const values: unknown[] = Array.isArray(row.values)
            ? row.values.slice(1)
            : Object.values(row.values as Record<string, unknown>);
          rows.push(values.map((cell: unknown) => spreadsheetCell(cell)).join('\t'));
        });
        sheets.push(rows.join('\n'));
      });
      return { text: sheets.join('\n\n'), kind: 'spreadsheet' };
    }
    if (this.supports(input.mimeType, input.fileName)) {
      return {
        text: decodeTextBytes(input.bytes),
        kind: /(?:csv|tsv)/i.test(`${mime} ${name}`) ? 'spreadsheet' : 'text',
      };
    }
    return { text: '', kind: 'document' };
  }
}

/** Decode common operator-authored text encodings, including Windows Notepad UTF-16 files. */
function decodeTextBytes(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString('utf16le');
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const body = bytes.subarray(2);
    const swapped = Buffer.allocUnsafe(body.length - (body.length % 2));
    for (let index = 0; index < swapped.length; index += 2) {
      swapped[index] = body[index + 1]!;
      swapped[index + 1] = body[index]!;
    }
    return swapped.toString('utf16le');
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3).toString('utf8');
  }

  const sampleLength = Math.min(bytes.length - (bytes.length % 2), 4_096);
  if (sampleLength >= 8) {
    let evenNulls = 0;
    let oddNulls = 0;
    for (let index = 0; index < sampleLength; index += 2) {
      if (bytes[index] === 0) evenNulls += 1;
      if (bytes[index + 1] === 0) oddNulls += 1;
    }
    const pairs = sampleLength / 2;
    if (oddNulls / pairs > 0.3 && evenNulls / pairs < 0.05) return bytes.toString('utf16le');
    if (evenNulls / pairs > 0.3 && oddNulls / pairs < 0.05) {
      const swapped = Buffer.allocUnsafe(bytes.length - (bytes.length % 2));
      for (let index = 0; index < swapped.length; index += 2) {
        swapped[index] = bytes[index + 1]!;
        swapped[index + 1] = bytes[index]!;
      }
      return swapped.toString('utf16le');
    }
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

function spreadsheetCell(value: unknown): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const record = value as {
      text?: unknown;
      result?: unknown;
      formula?: unknown;
      richText?: Array<{ text?: string }>;
    };
    if (typeof record.text === 'string') return record.text;
    if (record.result != null) return String(record.result);
    if (record.formula != null) return `=${String(record.formula)}`;
    if (Array.isArray(record.richText)) return record.richText.map((part) => part.text ?? '').join('');
  }
  return String(value).replace(/[\r\n\t]+/g, ' ');
}
