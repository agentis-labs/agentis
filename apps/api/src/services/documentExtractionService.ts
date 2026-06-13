/**
 * DocumentExtractionService — text extraction for inbound channel documents
 * (OMNICHANNEL-ORCHESTRATOR-10X §3.3 media ingestion).
 *
 * Pulls readable text from PDFs and plain-text attachments so the orchestrator
 * can reason over a document a user sends over a channel. Bounded to text-ish
 * formats; binary/office formats return null and the caller skips them. Always
 * failure-tolerant — never throws.
 */

import type { Logger } from '../logger.js';

export interface DocumentInput {
  bytes: Buffer;
  mimeType: string;
  fileName?: string;
}

/** Cap injected text so a huge PDF can't blow the turn's context budget. */
const MAX_CHARS = 6000;

export class DocumentExtractionService {
  constructor(private readonly deps: { logger?: Logger } = {}) {}

  /** True for formats we can extract text from. */
  supports(mimeType: string, fileName?: string): boolean {
    const m = (mimeType || '').toLowerCase();
    const n = (fileName || '').toLowerCase();
    return m.includes('pdf') || n.endsWith('.pdf')
      || m.startsWith('text/')
      || m.includes('json') || m.includes('csv') || m.includes('markdown')
      || n.endsWith('.txt') || n.endsWith('.md') || n.endsWith('.csv');
  }

  /** Extract text, truncated to MAX_CHARS. Returns null when unsupported/empty. */
  async extract(input: DocumentInput): Promise<string | null> {
    try {
      const text = await this.#rawText(input);
      const trimmed = (text ?? '').trim();
      if (!trimmed) return null;
      return trimmed.length > MAX_CHARS ? `${trimmed.slice(0, MAX_CHARS)}\n…[truncated]` : trimmed;
    } catch (err) {
      this.deps.logger?.warn?.('document.extract_failed', { mime: input.mimeType, err: (err as Error).message });
      return null;
    }
  }

  async #rawText(input: DocumentInput): Promise<string | null> {
    const m = (input.mimeType || '').toLowerCase();
    const n = (input.fileName || '').toLowerCase();
    if (m.includes('pdf') || n.endsWith('.pdf')) {
      const { PDFParse } = (await import('pdf-parse' as string)) as typeof import('pdf-parse');
      const parser = new PDFParse({ data: input.bytes });
      try {
        const result = await parser.getText();
        return result.text ?? '';
      } finally {
        await parser.destroy();
      }
    }
    // text/*, json, csv, markdown, .txt/.md/.csv → decode as UTF-8.
    if (this.supports(input.mimeType, input.fileName)) {
      return input.bytes.toString('utf8');
    }
    return null;
  }
}
