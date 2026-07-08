/**
 * Secret redaction for logs, transcripts, and the event bus.
 *
 * Agents stream reasoning + tool I/O into logs and the realtime event bus; a
 * naive log line can leak a vault value, an `Authorization` header, or an
 * `*_API_KEY` env value into a place it was never meant to live (a shipped log,
 * the DB, a channel message). This module masks those before they are emitted.
 *
 * Two complementary strategies:
 *   1. Key-name redaction — a field whose KEY looks secret (authorization,
 *      api_key, token, password, secret, credential, cookie, …) is masked
 *      wholesale, regardless of its value.
 *   2. Value-pattern redaction — a string VALUE that matches a known secret
 *      shape (Bearer tokens, `sk-…`/`ghp_…`/`xox…` provider keys, long base64
 *      blobs, JWTs) is masked even under an innocent key name.
 *
 * Redaction is bounded (depth + node count) so it stays cheap on the hot logging
 * path and can never recurse into a cyclic structure.
 */

const SENSITIVE_KEY_RE =
  /(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|credential|private[_-]?key|session[_-]?token|bearer|cookie|set-cookie|client[_-]?secret|vault|jwt)/i;

const VALUE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/g, // Authorization: Bearer <token>
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI-style keys
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, // Anthropic keys
  /\bghp_[A-Za-z0-9]{20,}\b/g, // GitHub PATs
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWTs
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
];

const MASK = '«redacted»';
const MAX_DEPTH = 6;
const MAX_NODES = 5_000;

/** Mask secret substrings inside a single string value. */
export function redactSecretString(value: string): string {
  let out = value;
  for (const re of VALUE_PATTERNS) {
    out = out.replace(re, MASK);
  }
  return out;
}

/** True if a field name looks like it holds a secret. */
export function isSensitiveFieldName(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key);
}

/**
 * Return a redacted deep copy of `input` suitable for logging. Strings are
 * pattern-masked; fields with secret-looking names are masked wholesale. Never
 * mutates the input; bounded in depth and node count.
 */
export function redactForLogging<T>(input: T): T {
  let nodes = 0;
  const seen = new WeakSet<object>();

  const walk = (value: unknown, depth: number): unknown => {
    if (nodes++ > MAX_NODES || depth > MAX_DEPTH) return value;
    if (typeof value === 'string') return redactSecretString(value);
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value as object)) return '«circular»';
    seen.add(value as object);

    if (Array.isArray(value)) {
      return value.map((item) => walk(item, depth + 1));
    }
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveFieldName(key)) {
        out[key] = MASK;
      } else if (typeof v === 'string') {
        out[key] = redactSecretString(v);
      } else {
        out[key] = walk(v, depth + 1);
      }
    }
    return out;
  };

  return walk(input, 0) as T;
}
