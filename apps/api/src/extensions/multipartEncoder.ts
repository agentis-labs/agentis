/**
 * Multipart/form-data encoder for the extension sandbox's `ctx.http.fetch`
 * (INTEGRATION-CEILING-10X §3 — file/media upload from user-authored
 * extensions). Neither `node:vm` nor `isolated-vm` sandboxes have a native
 * `FormData`/`Blob`, and values crossing the isolate boundary must be
 * JSON-safe — so the sandboxed script describes parts as plain objects
 * (`{name, value}` or `{name, filename, contentType, dataBase64}`), and this
 * HOST-SIDE function builds the real multipart bytes. `safeFetch` accepts a
 * raw `Uint8Array` body, so the encoded bytes flow straight through the
 * existing SSRF-guarded transport with no further plumbing.
 */

export interface MultipartFieldPart {
  name: string;
  value: string;
}
export interface MultipartFilePart {
  name: string;
  filename: string;
  contentType: string;
  dataBase64: string;
}
export type MultipartPart = MultipartFieldPart | MultipartFilePart;

const MAX_PARTS = 10;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024; // 25 MiB — matches safeFetch's default response cap

export function isFilePart(part: MultipartPart): part is MultipartFilePart {
  return typeof (part as MultipartFilePart).filename === 'string';
}

/** Encode parts into a multipart/form-data body. Returns the bytes + the Content-Type header value (carries the boundary). */
export function encodeMultipart(parts: MultipartPart[]): { body: Uint8Array; contentType: string } {
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error('formData requires at least one part');
  }
  if (parts.length > MAX_PARTS) {
    throw new Error(`formData accepts at most ${MAX_PARTS} parts`);
  }
  const boundary = `----agentisExtBoundary${randomBoundaryToken()}`;
  const chunks: Buffer[] = [];
  let total = 0;
  const push = (buf: Buffer) => {
    total += buf.length;
    if (total > MAX_TOTAL_BYTES) throw new Error(`formData exceeds ${MAX_TOTAL_BYTES} bytes total`);
    chunks.push(buf);
  };

  for (const part of parts) {
    if (!part || typeof part.name !== 'string' || !part.name.trim()) {
      throw new Error('every formData part requires a non-empty "name"');
    }
    push(Buffer.from(`--${boundary}\r\n`));
    if (isFilePart(part)) {
      if (typeof part.dataBase64 !== 'string' || !part.dataBase64) {
        throw new Error(`formData part "${part.name}" is missing dataBase64`);
      }
      const filename = String(part.filename || 'upload').replace(/["\r\n]/g, '');
      const contentType = String(part.contentType || 'application/octet-stream');
      push(Buffer.from(`Content-Disposition: form-data; name="${escapeName(part.name)}"; filename="${filename}"\r\n`));
      push(Buffer.from(`Content-Type: ${contentType}\r\n\r\n`));
      push(Buffer.from(part.dataBase64, 'base64'));
      push(Buffer.from('\r\n'));
    } else {
      push(Buffer.from(`Content-Disposition: form-data; name="${escapeName(part.name)}"\r\n\r\n`));
      push(Buffer.from(`${String(part.value ?? '')}\r\n`));
    }
  }
  push(Buffer.from(`--${boundary}--\r\n`));

  return { body: new Uint8Array(Buffer.concat(chunks)), contentType: `multipart/form-data; boundary=${boundary}` };
}

function escapeName(name: string): string {
  return name.replace(/["\r\n]/g, '');
}

function randomBoundaryToken(): string {
  // Not security-sensitive (just needs to not collide with the payload) —
  // Math.random is fine here; this module runs in trusted Node host code.
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
