/**
 * DocumentExtractionService — text extraction for inbound documents (§3.3).
 */
import { describe, expect, it } from 'vitest';
import { DocumentExtractionService } from '../../src/services/documentExtractionService.js';

describe('DocumentExtractionService', () => {
  const svc = new DocumentExtractionService();

  it('supports() recognizes pdf / text-ish formats and rejects binaries', () => {
    expect(svc.supports('application/pdf')).toBe(true);
    expect(svc.supports('text/plain')).toBe(true);
    expect(svc.supports('application/json')).toBe(true);
    expect(svc.supports('application/octet-stream', 'notes.md')).toBe(true);
    expect(svc.supports('application/octet-stream', 'report.pdf')).toBe(true);
    expect(svc.supports('image/png')).toBe(false);
    expect(svc.supports('application/zip', 'archive.zip')).toBe(false);
  });

  it('extracts UTF-8 text and trims', async () => {
    const text = await svc.extract({ bytes: Buffer.from('  hello world  '), mimeType: 'text/plain' });
    expect(text).toBe('hello world');
  });

  it('truncates very long text', async () => {
    const long = 'x'.repeat(10_000);
    const text = await svc.extract({ bytes: Buffer.from(long), mimeType: 'text/plain' });
    expect(text!.length).toBeLessThan(long.length);
    expect(text).toMatch(/truncated/);
  });

  it('returns null for unsupported types and empty content', async () => {
    expect(await svc.extract({ bytes: Buffer.from('binary'), mimeType: 'application/zip' })).toBeNull();
    expect(await svc.extract({ bytes: Buffer.from('   '), mimeType: 'text/plain' })).toBeNull();
  });
});
