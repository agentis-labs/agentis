/**
 * multipartEncoder — JSON-safe part descriptions → real multipart/form-data
 * bytes (INTEGRATION-CEILING-10X §3, the extension-sandbox media-upload fix).
 */
import { describe, expect, it } from 'vitest';
import { encodeMultipart } from '../../src/extensions/multipartEncoder.js';

function parseParts(body: Uint8Array, boundary: string): string[] {
  return Buffer.from(body).toString('latin1').split(`--${boundary}`).slice(1, -1);
}

describe('encodeMultipart', () => {
  it('encodes a text field with the correct Content-Disposition', () => {
    const { body, contentType } = encodeMultipart([{ name: 'caption', value: 'hello world' }]);
    const boundary = contentType.split('boundary=')[1]!;
    const parts = parseParts(body, boundary);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toContain('Content-Disposition: form-data; name="caption"');
    expect(parts[0]).toContain('hello world');
  });

  it('encodes a file part and round-trips the exact bytes via base64', () => {
    const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff]); // arbitrary "PNG-ish" bytes
    const { body, contentType } = encodeMultipart([
      { name: 'image', filename: 'photo.png', contentType: 'image/png', dataBase64: original.toString('base64') },
    ]);
    const boundary = contentType.split('boundary=')[1]!;
    const raw = Buffer.from(body);
    // Locate the part, extract the raw bytes between the header block and the trailing CRLF boundary marker.
    const headerEnd = raw.indexOf('\r\n\r\n') + 4;
    const tail = raw.indexOf(`\r\n--${boundary}--`);
    const extracted = raw.subarray(headerEnd, tail);
    expect(extracted.equals(original)).toBe(true);
    expect(raw.toString('latin1')).toContain('Content-Disposition: form-data; name="image"; filename="photo.png"');
    expect(raw.toString('latin1')).toContain('Content-Type: image/png');
  });

  it('encodes multiple mixed parts under one boundary', () => {
    const { body, contentType } = encodeMultipart([
      { name: 'caption', value: 'a listing photo' },
      { name: 'image', filename: 'a.jpg', contentType: 'image/jpeg', dataBase64: Buffer.from('bytes').toString('base64') },
    ]);
    const boundary = contentType.split('boundary=')[1]!;
    expect(parseParts(body, boundary)).toHaveLength(2);
  });

  it('rejects an empty part list', () => {
    expect(() => encodeMultipart([])).toThrow(/at least one part/);
  });

  it('rejects more than the part-count cap', () => {
    const parts = Array.from({ length: 11 }, (_, i) => ({ name: `f${i}`, value: 'x' }));
    expect(() => encodeMultipart(parts)).toThrow(/at most/);
  });

  it('rejects a part with no name', () => {
    expect(() => encodeMultipart([{ name: '', value: 'x' }])).toThrow(/non-empty "name"/);
  });

  it('rejects a file part with no dataBase64', () => {
    expect(() => encodeMultipart([{ name: 'f', filename: 'x', contentType: 'text/plain', dataBase64: '' }])).toThrow(/dataBase64/);
  });

  it('rejects when the total encoded size exceeds the cap', () => {
    const big = Buffer.alloc(20 * 1024 * 1024, 1).toString('base64');
    const parts = [
      { name: 'a', filename: 'a.bin', contentType: 'application/octet-stream', dataBase64: big },
      { name: 'b', filename: 'b.bin', contentType: 'application/octet-stream', dataBase64: big },
    ];
    expect(() => encodeMultipart(parts)).toThrow(/exceeds/);
  });

  it('strips quotes/newlines from name and filename to prevent header injection', () => {
    const { body, contentType } = encodeMultipart([{ name: 'x"\r\ninjected', value: 'v' }]);
    const boundary = contentType.split('boundary=')[1]!;
    const text = Buffer.from(body).toString('latin1');
    // The quote + CRLF are stripped, merging into one clean, unbroken header line —
    // no injected blank line, no attacker-controlled second header.
    expect(text).toContain('Content-Disposition: form-data; name="xinjected"\r\n\r\n');
    expect(parseParts(body, boundary)).toHaveLength(1);
  });
});
