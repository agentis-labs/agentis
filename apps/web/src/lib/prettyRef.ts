/**
 * prettyRef — never surface a raw identifier as if it were a human name.
 *
 * Agentis assigns UUID / nanoid identifiers to everything it creates
 * (extensions, apps, runs, records). Several UI surfaces used to `humanize()`
 * or `.slice(0, 8)` those ids to fabricate a label, which leaked "harsh code"
 * like `A05adaa1 2182 46ad 889a 3b2ab9796f8e` or `Interface efe2961f` into the
 * product. These helpers detect id-shaped strings so callers can fall back to a
 * real name (or a clean short reference) instead.
 */

/** UUID v1–v5, with or without dashes. */
const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
/** nanoid / opaque token: 12+ chars, no spaces, dominated by hex-ish noise. */
const OPAQUE_RE = /^[0-9a-z][0-9a-z_-]{11,}$/i;

/** True when `s` looks like a machine identifier rather than a human name. */
export function isIdLike(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (UUID_RE.test(t)) return true;
  // Opaque only when it has no word breaks AND is mostly digits/hex — a real
  // slug like "invoice-parser" or "identity_verified" keeps its readable name.
  if (t.includes(' ')) return false;
  if (!OPAQUE_RE.test(t)) return false;
  const digits = (t.match(/[0-9]/g) ?? []).length;
  return digits / t.length >= 0.4;
}

/**
 * A short, non-ugly reference for an identifier — e.g. `#efe2961f`. Use only
 * when no human name is available; prefer the real name whenever you have it.
 */
export function shortRef(id: string): string {
  const t = id.trim().replace(/-/g, '');
  return `#${t.slice(0, 8)}`;
}

/**
 * Given a possibly-empty name and an id, return the best human-facing label:
 * the name if it is a real name, otherwise a clean short reference — never a
 * humanized UUID.
 */
export function prettyRef(name: string | undefined | null, id: string): string {
  const n = (name ?? '').trim();
  if (n && !isIdLike(n)) return n;
  return shortRef(id);
}

/**
 * Best human-facing label for a record card. Uses the candidate title unless it
 * is empty or is itself an identifier (agents sometimes store a UUID *as* the
 * name/title field) — in which case it falls back to a clean short reference on
 * the id, then to `empty`. This is the last line of defense so raw UUIDs never
 * render as a title regardless of what field they came from.
 */
export function displayLabel(candidate: string | undefined | null, id?: string, empty = ''): string {
  const c = (candidate ?? '').trim();
  if (c && !isIdLike(c)) return c;
  const i = (id ?? '').trim();
  if (i) return shortRef(i);
  // Candidate was id-like but we have no separate id — still avoid the raw form.
  if (c) return shortRef(c);
  return empty;
}
