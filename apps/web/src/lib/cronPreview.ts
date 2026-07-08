/**
 * Tiny cron parser for canvas preview.
 *
 * Supports the standard 5-field cron syntax (minute hour day-of-month month
 * day-of-week) with `*`, comma lists (`1,3,5`), ranges (`1-5`), and step values
 * (`*â€‹/15`). Used purely for showing a human-readable description and the next
 * few firing times in the TriggerForm â€” the real scheduling runs on the server
 * via `node-cron`.
 *
 * This is intentionally permissive: malformed expressions return `null` and the
 * UI just skips the preview. It does NOT need to match node-cron's behavior
 * byte-for-byte; it needs to be helpful and never lie.
 */

interface ParsedField {
  values: Set<number>;
}

interface ParsedCron {
  minute: ParsedField;
  hour: ParsedField;
  dayOfMonth: ParsedField;
  month: ParsedField;
  dayOfWeek: ParsedField;
}

const FIELD_RANGES = {
  minute: [0, 59] as const,
  hour: [0, 23] as const,
  dayOfMonth: [1, 31] as const,
  month: [1, 12] as const,
  dayOfWeek: [0, 6] as const, // 0 or 7 = Sunday; we collapse 7â†’0
};

function parseField(token: string, range: readonly [number, number]): ParsedField | null {
  const [min, max] = range;
  if (token === '*') {
    const values = new Set<number>();
    for (let v = min; v <= max; v += 1) values.add(v);
    return { values };
  }
  const values = new Set<number>();
  for (const part of token.split(',')) {
    const stepIdx = part.indexOf('/');
    let rangeStr = part;
    let step = 1;
    if (stepIdx !== -1) {
      step = Number(part.slice(stepIdx + 1));
      if (!Number.isInteger(step) || step <= 0) return null;
      rangeStr = part.slice(0, stepIdx);
    }
    let from = min;
    let to = max;
    if (rangeStr === '*' || rangeStr === '') {
      // step-only, e.g. `*/15`
    } else if (rangeStr.includes('-')) {
      const parts = rangeStr.split('-').map(Number);
      const a = parts[0];
      const b = parts[1];
      if (a == null || b == null || !Number.isInteger(a) || !Number.isInteger(b)) return null;
      from = a;
      to = b;
    } else {
      const v = Number(rangeStr);
      if (!Number.isInteger(v)) return null;
      from = v;
      to = v;
    }
    for (let v = from; v <= to; v += step) {
      if (v >= min && v <= max) values.add(v === 7 && range === FIELD_RANGES.dayOfWeek ? 0 : v);
    }
  }
  return values.size > 0 ? { values } : null;
}

export function parseCron(expression: string): ParsedCron | null {
  const tokens = expression.trim().split(/\s+/);
  if (tokens.length !== 5) return null;
  const [m, h, dom, mon, dow] = tokens;
  const minute = parseField(m!, FIELD_RANGES.minute);
  const hour = parseField(h!, FIELD_RANGES.hour);
  const dayOfMonth = parseField(dom!, FIELD_RANGES.dayOfMonth);
  const month = parseField(mon!, FIELD_RANGES.month);
  const dayOfWeek = parseField(dow!.replace('7', '0'), FIELD_RANGES.dayOfWeek);
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return null;
  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

/** Returns a human-readable description, or `null` for unparseable input. */
export function describeCron(expression: string): string | null {
  const parsed = parseCron(expression);
  if (!parsed) return null;
  const allMinutes = parsed.minute.values.size === 60;
  const allHours = parsed.hour.values.size === 24;
  const allDom = parsed.dayOfMonth.values.size === 31;
  const allMonths = parsed.month.values.size === 12;
  const allDow = parsed.dayOfWeek.values.size === 7;

  const minutes = [...parsed.minute.values].sort((a, b) => a - b);
  const hours = [...parsed.hour.values].sort((a, b) => a - b);

  // Build the time fragment.
  let timePart: string;
  if (allMinutes && allHours) {
    timePart = 'every minute';
  } else if (allMinutes) {
    timePart = `every minute of hours ${hours.join(', ')}`;
  } else if (parsed.minute.values.size === 1 && parsed.hour.values.size === 1) {
    timePart = `at ${pad(hours[0]!)}:${pad(minutes[0]!)}`;
  } else if (allHours && minutes.length === 1) {
    timePart = `at minute ${minutes[0]} of every hour`;
  } else if (minutes.length === 1 && hours.length > 1) {
    timePart = `at ${hours.map((h) => `${pad(h)}:${pad(minutes[0]!)}`).join(', ')}`;
  } else {
    timePart = `at ${formatList(hours, 'hours')}, minute ${formatList(minutes, 'minutes')}`;
  }

  const dayParts: string[] = [];
  if (!allDow) {
    const names = [...parsed.dayOfWeek.values]
      .sort((a, b) => a - b)
      .map((d) => DOW_NAMES[d]);
    dayParts.push(`on ${formatList(names)}`);
  }
  if (!allDom) {
    dayParts.push(`on day ${formatList([...parsed.dayOfMonth.values].sort((a, b) => a - b))} of the month`);
  }
  if (!allMonths) {
    const names = [...parsed.month.values]
      .sort((a, b) => a - b)
      .map((m) => MONTH_NAMES[m - 1]);
    dayParts.push(`in ${formatList(names)}`);
  }

  const tail = dayParts.length > 0 ? `, ${dayParts.join(', ')}` : '';
  return `${timePart}${tail}`;
}

/**
 * Compute the next N firing times (UTC). Returns ISO strings, oldest first.
 * Naive but correct algorithm: step forward minute-by-minute, check if all
 * five fields match. Capped at one year of forward search.
 */
export function nextFires(expression: string, count = 5, from: Date = new Date()): string[] {
  const parsed = parseCron(expression);
  if (!parsed) return [];
  const out: string[] = [];
  const cursor = new Date(Math.ceil(from.getTime() / 60_000) * 60_000); // round up to next minute
  const horizon = cursor.getTime() + 366 * 24 * 60 * 60 * 1000;
  while (cursor.getTime() < horizon && out.length < count) {
    if (matches(cursor, parsed)) out.push(cursor.toISOString());
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return out;
}

function matches(date: Date, parsed: ParsedCron): boolean {
  return (
    parsed.minute.values.has(date.getUTCMinutes())
    && parsed.hour.values.has(date.getUTCHours())
    && parsed.dayOfMonth.values.has(date.getUTCDate())
    && parsed.month.values.has(date.getUTCMonth() + 1)
    && parsed.dayOfWeek.values.has(date.getUTCDay())
  );
}

const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function formatList<T>(values: T[], unit?: string): string {
  if (values.length === 0) return unit ? `no ${unit}` : '';
  if (values.length === 1) return String(values[0]);
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  if (values.length <= 5) return `${values.slice(0, -1).join(', ')}, and ${values[values.length - 1]}`;
  return `${values.slice(0, 4).join(', ')}, â€¦ (+${values.length - 4} more)`;
}

/** Common presets users can pick from to seed the field. */
export const CRON_PRESETS: Array<{ label: string; expression: string; description: string }> = [
  { label: 'Every minute', expression: '* * * * *', description: 'Every minute (testing only)' },
  { label: 'Every 5 minutes', expression: '*/5 * * * *', description: 'Every 5 minutes' },
  { label: 'Every hour', expression: '0 * * * *', description: 'At the top of every hour' },
  { label: 'Every day 09:00 UTC', expression: '0 9 * * *', description: 'Every day at 09:00 UTC' },
  { label: 'Weekdays 09:00 UTC', expression: '0 9 * * 1-5', description: 'Monâ€“Fri at 09:00 UTC' },
  { label: 'Every Monday 09:00 UTC', expression: '0 9 * * 1', description: 'Every Monday at 09:00 UTC' },
  { label: 'First of the month 00:00 UTC', expression: '0 0 1 * *', description: 'First day of every month at 00:00 UTC' },
];



