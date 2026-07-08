/**
 * format — the value-presentation brain of the Agentis Interface Kit
 * (INTERFACE-OVERHAUL-10X §3.1).
 *
 * Agents bind raw values; THIS layer decides how they read. One place turns
 * `SUCCESS_DEPLOYED_STORE_AND_CRM` into a humanized tone pill, a bare URL into
 * a truncated external link, an ISO timestamp into "4h ago", a numeric string
 * into a locale-grouped tabular numeral — so no generated surface ever shows
 * raw snake_case, unlinked URLs, or overflowing text again. Every kit block
 * (tables, lists, records, approvals) formats through here; agents never
 * hand-format values.
 */
import type { ReactNode } from 'react';
import clsx from 'clsx';
import { Check, ExternalLink, Mail, Minus } from 'lucide-react';
import { toneFillClass, toneFromStatus, toneSoftClass } from './styleIntent';

export type ValueKind =
  | 'empty' | 'status' | 'url' | 'email' | 'date' | 'number' | 'boolean' | 'id' | 'text' | 'long-text';

const URL_RE = /^https?:\/\/\S+$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
const SCREAMING_RE = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/;
const STATUSY_KEY = /(status|stage|state|phase|priority|severity|tier|verdict|health|result|outcome|decision)$/i;
const DATE_KEY = /(_at|_on|date|time)$/i;

/** Words kept uppercase when humanizing tokens. */
const ACRONYMS = new Set(['crm', 'url', 'id', 'api', 'ai', 'sku', 'seo', 'roi', 'kpi', 'qa', 'ui', 'ux', 'db', 'sla', 'pr']);

/** `SUCCESS_DEPLOYED_STORE_AND_CRM` → `Success deployed store and CRM`. */
export function humanizeToken(value: string): string {
  const words = value
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w));
  const joined = words.join(' ');
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/** Classify a raw value (with its column/field key as a hint) into a display kind. */
export function classifyValue(value: unknown, key?: string): ValueKind {
  if (value == null || value === '') return 'empty';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value !== 'string') return 'text';
  const s = value.trim();
  if (s === '') return 'empty';
  if (URL_RE.test(s)) return 'url';
  if (EMAIL_RE.test(s)) return 'email';
  if (UUID_RE.test(s)) return 'id';
  if (ISO_DATE_RE.test(s) && !Number.isNaN(Date.parse(s))) return 'date';
  if (key && DATE_KEY.test(key) && !Number.isNaN(Date.parse(s))) return 'date';
  if (s !== '' && !Number.isNaN(Number(s.replace(/,/g, ''))) && /^[\d,.\s%+-]+$/.test(s)) return 'number';
  if ((key && STATUSY_KEY.test(key)) || SCREAMING_RE.test(s)) return 'status';
  if (s.length > 80) return 'long-text';
  return 'text';
}

export function isNumericKind(kind: ValueKind): boolean {
  return kind === 'number';
}

/** Locale-grouped numeral; compact ≥ 10k ("12.4k"). */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Math.abs(value) >= 10_000) {
    return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  }
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
}

function relativeOrDate(iso: string): { label: string; title: string } {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return { label: iso, title: iso };
  const title = new Date(t).toLocaleString();
  const diff = Date.now() - t;
  const abs = Math.abs(diff);
  const MIN = 60_000, H = 3_600_000, D = 86_400_000;
  const suffix = diff >= 0 ? ' ago' : '';
  const prefix = diff < 0 ? 'in ' : '';
  if (abs < 45_000) return { label: 'just now', title };
  if (abs < H) return { label: `${prefix}${Math.round(abs / MIN)}m${suffix}`, title };
  if (abs < D) return { label: `${prefix}${Math.round(abs / H)}h${suffix}`, title };
  if (abs < 90 * D) return { label: `${prefix}${Math.round(abs / D)}d${suffix}`, title };
  return { label: new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }), title };
}

/** Humanized, toned, truncation-safe status pill — THE status treatment everywhere. */
export function StatusPill({ value, className }: { value: string; className?: string }) {
  const tone = toneFromStatus(value);
  const label = humanizeToken(value);
  return (
    <span className={clsx('s-chip', toneSoftClass(tone), className)} title={label.length > 26 ? label : undefined}>
      <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', toneFillClass(tone))} />
      <span className="max-w-[190px] truncate">{label}</span>
    </span>
  );
}

function LinkCell({ url }: { url: string }) {
  let display = url;
  try {
    const u = new URL(url);
    const path = u.pathname !== '/' ? u.pathname : '';
    display = `${u.hostname.replace(/^www\./, '')}${path.length > 18 ? `${path.slice(0, 17)}…` : path}`;
  } catch { /* keep raw */ }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      title={url}
      onClick={(e) => e.stopPropagation()}
      className="inline-flex max-w-full items-center gap-1 font-medium text-accent hover:underline"
    >
      <span className="truncate">{display}</span>
      <ExternalLink size={11} className="shrink-0 opacity-70" />
    </a>
  );
}

export interface FormatOpts {
  /** Explicit column format hint (schema `columns[].format`) — wins over inference. */
  format?: string;
  /** The column/field key — improves classification (status-ish, date-ish keys). */
  key?: string;
}

/**
 * Format any raw value for display. Returns a ready ReactNode: links are links,
 * statuses are pills, dates are relative, numbers are grouped, long text is
 * truncated with a tooltip. `opts.format` (badge/date/boolean/number/text)
 * forces a treatment; otherwise the kind is inferred.
 */
export function formatDisplay(value: unknown, opts: FormatOpts = {}): ReactNode {
  if (value == null || value === '') return <span className="text-text-disabled">—</span>;

  if (opts.format === 'badge') return <StatusPill value={String(value)} />;
  if (opts.format === 'boolean' || typeof value === 'boolean') {
    return value
      ? <span className="inline-flex items-center text-success" title="Yes"><Check size={14} /></span>
      : <span className="inline-flex items-center text-text-muted" title="No"><Minus size={14} /></span>;
  }
  if (opts.format === 'date') {
    const d = relativeOrDate(String(value));
    return <span title={d.title} className="whitespace-nowrap tabular-nums">{d.label}</span>;
  }
  if (opts.format === 'number') {
    const n = Number(value);
    return <span className="tabular-nums">{Number.isFinite(n) ? formatNumber(n) : String(value)}</span>;
  }

  const kind = classifyValue(value, opts.key);
  switch (kind) {
    case 'url': return <LinkCell url={String(value).trim()} />;
    case 'email': {
      const v = String(value).trim();
      return (
        <a href={`mailto:${v}`} onClick={(e) => e.stopPropagation()} className="inline-flex max-w-full items-center gap-1 text-accent hover:underline">
          <Mail size={11} className="shrink-0 opacity-70" /><span className="truncate">{v}</span>
        </a>
      );
    }
    case 'status': return <StatusPill value={String(value)} />;
    case 'date': {
      const d = relativeOrDate(String(value));
      return <span title={d.title} className="whitespace-nowrap tabular-nums">{d.label}</span>;
    }
    case 'number': {
      const n = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''));
      return <span className="tabular-nums">{Number.isFinite(n) ? formatNumber(n) : String(value)}</span>;
    }
    case 'id': {
      const v = String(value);
      return <code title={v} className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-text-muted">{v.slice(0, 8)}</code>;
    }
    case 'long-text': {
      const v = String(value);
      return <span title={v} className="block max-w-[340px] truncate">{v}</span>;
    }
    default: {
      const v = String(value);
      return v.length > 48 ? <span title={v} className="block max-w-[280px] truncate">{v}</span> : v;
    }
  }
}

/**
 * Numeral auto-fit: the KPI type step shrinks as the value gets longer, so a
 * long value NEVER overflows or wraps mid-word (the "ACCOMPLISHE D" defect).
 * Returns a multiplier applied to `--s-kpi-size`.
 */
export function numeralScale(text: string): number {
  const len = text.length;
  if (len <= 7) return 1;
  if (len <= 10) return 0.84;
  if (len <= 14) return 0.68;
  if (len <= 20) return 0.56;
  return 0.46;
}

/**
 * True when a metric value reads as WORDS (a status/verdict), not a numeral —
 * those render as a tone pill instead of a 32px numeral.
 */
export function isWordyMetric(text: string): boolean {
  if (text === '') return false;
  if (/^[\d,.\s%+$€£-]+$/.test(text)) return false;
  return /[a-zA-Z]{3,}/.test(text);
}
