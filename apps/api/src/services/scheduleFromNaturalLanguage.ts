/**
 * scheduleFromNaturalLanguage — deterministic natural-language → UTC cron.
 *
 * Workflow synthesis (and the deterministic builder) used to emit placeholder
 * crons like `0 9 * * *`, ignoring both the requested time AND timezone — so
 * "every day at 15:05 Brasília" silently became "09:00 (server tz)". This parser
 * extracts the cadence, the explicit time-of-day, and the timezone from free
 * text and produces a correct **UTC** 5-field cron, so the schedule fires when
 * the operator actually asked.
 *
 * Pure and dependency-free: a fixed offset table (DST is not modeled — the
 * common scheduling zones are stated as standard offsets, which is correct for
 * the overwhelming majority of "run it daily at X" requests; `timezone` is also
 * returned so the cron can be interpreted in that zone downstream if available).
 */

export interface ParsedSchedule {
  /** 5-field cron (minute hour day-of-month month day-of-week), in UTC. */
  cron: string;
  /** IANA-ish timezone we recognized for the stated time, or null if none. */
  timezone: string | null;
  /** Plain-language summary for narration / readiness, e.g.
   *  "Every day at 15:05 America/Sao_Paulo (18:05 UTC)". */
  detail: string;
}

interface Zone {
  /** Fixed offset from UTC in minutes (standard time; DST not modeled). */
  offsetMinutes: number;
  /** IANA name surfaced to the operator + threaded to node-cron when possible. */
  iana: string;
}

// Common scheduling zones by name/abbreviation → standard offset. Ordered list
// (longest/most-specific first) so "são paulo" wins before a bare "br".
const ZONES: Array<{ match: RegExp; zone: Zone }> = [
  { match: /\b(s[ãa]o\s*paulo|bras[íi]lia|bras[íi]lia\b|brt|brasil|brazil)\b/i, zone: { offsetMinutes: -180, iana: 'America/Sao_Paulo' } },
  { match: /\b(buenos\s*aires|art)\b/i, zone: { offsetMinutes: -180, iana: 'America/Argentina/Buenos_Aires' } },
  { match: /\b(lisbon|lisboa|wet|portugal)\b/i, zone: { offsetMinutes: 0, iana: 'Europe/Lisbon' } },
  { match: /\b(london|gmt|bst|uk)\b/i, zone: { offsetMinutes: 0, iana: 'Europe/London' } },
  { match: /\b(utc|gmt0|zulu|z)\b/i, zone: { offsetMinutes: 0, iana: 'UTC' } },
  { match: /\b(new\s*york|eastern|est|edt|et|ny)\b/i, zone: { offsetMinutes: -300, iana: 'America/New_York' } },
  { match: /\b(chicago|central|cst|cdt|ct)\b/i, zone: { offsetMinutes: -360, iana: 'America/Chicago' } },
  { match: /\b(denver|mountain|mst|mdt|mt)\b/i, zone: { offsetMinutes: -420, iana: 'America/Denver' } },
  { match: /\b(los\s*angeles|pacific|pst|pdt|pt|california)\b/i, zone: { offsetMinutes: -480, iana: 'America/Los_Angeles' } },
  { match: /\b(berlin|paris|madrid|cet|cest)\b/i, zone: { offsetMinutes: 60, iana: 'Europe/Berlin' } },
  { match: /\b(india|ist|kolkata|mumbai)\b/i, zone: { offsetMinutes: 330, iana: 'Asia/Kolkata' } },
  { match: /\b(tokyo|jst|japan)\b/i, zone: { offsetMinutes: 540, iana: 'Asia/Tokyo' } },
];

const WEEKDAYS: Array<{ match: RegExp; dow: number; name: string }> = [
  { match: /\bsundays?\b|\bdomingos?\b/i, dow: 0, name: 'Sunday' },
  { match: /\bmondays?\b|\bsegundas?\b/i, dow: 1, name: 'Monday' },
  { match: /\btuesdays?\b|\bter[çc]as?\b/i, dow: 2, name: 'Tuesday' },
  { match: /\bwednesdays?\b|\bquartas?\b/i, dow: 3, name: 'Wednesday' },
  { match: /\bthursdays?\b|\bquintas?\b/i, dow: 4, name: 'Thursday' },
  { match: /\bfridays?\b|\bsextas?\b/i, dow: 5, name: 'Friday' },
  { match: /\bsaturdays?\b|\bs[áa]bados?\b/i, dow: 6, name: 'Saturday' },
];

/** Parse a schedule from free text, or null when no scheduling intent is present. */
export function scheduleFromNaturalLanguage(text: string): ParsedSchedule | null {
  const lower = text.toLowerCase();
  const hasScheduleWord = /\b(every|each|daily|hourly|weekly|monthly|schedule|cron|recurring|todo\s*dia|cada|toda|diariamente)\b/i.test(lower)
    || /\bat\s+\d/i.test(lower) || /\b[àa]s\s+\d/i.test(lower);

  // Every N minutes — independent of time-of-day.
  const everyMin = lower.match(/\bevery\s+(\d{1,3})\s*(?:min|minute)/);
  if (everyMin) {
    const n = clamp(parseInt(everyMin[1]!, 10), 1, 59);
    return { cron: `*/${n} * * * *`, timezone: null, detail: `Every ${n} minute${n === 1 ? '' : 's'}` };
  }

  const zone = detectZone(lower);
  const time = detectTime(lower); // { hour, minute } in the stated zone, or null

  // Hourly — fire at a fixed minute past each hour (no day/zone shift needed).
  if (/\b(every\s*hour|hourly|cada\s*hora)\b/.test(lower)) {
    const minute = time?.minute ?? 0;
    return { cron: `${minute} * * * *`, timezone: null, detail: `Every hour at :${pad(minute)}` };
  }

  const weekday = detectWeekday(lower);
  const isWeekly = weekday !== null || /\b(every\s*week|weekly|semanal)\b/.test(lower);
  const isDaily = /\b(every\s*day|each\s*day|daily|every\s*morning|todo\s*dia|diariamente|all\s*days)\b/.test(lower);

  if (!hasScheduleWord && !time && !isWeekly && !isDaily) return null;

  // Default to 09:00 when a cadence is stated without an explicit time (preserves
  // the historical default), otherwise honor the requested time.
  const localHour = time?.hour ?? 9;
  const localMinute = time?.minute ?? 0;
  const utc = toUtc(localHour, localMinute, zone?.offsetMinutes ?? 0);

  const tzDetail = zone ? `${zone.iana} (${pad(utc.hour)}:${pad(utc.minute)} UTC)` : 'UTC';
  const timeDetail = `${pad(localHour)}:${pad(localMinute)} ${tzDetail}`;

  if (isWeekly && weekday !== null) {
    // Weekday shift across a UTC midnight is intentionally not modeled (rare for
    // daytime schedules); the stated weekday is preserved.
    return {
      cron: `${utc.minute} ${utc.hour} * * ${weekday.dow}`,
      timezone: zone?.iana ?? null,
      detail: `Every ${weekday.name} at ${timeDetail}`,
    };
  }
  if (isWeekly) {
    return {
      cron: `${utc.minute} ${utc.hour} * * 1`,
      timezone: zone?.iana ?? null,
      detail: `Every Monday at ${timeDetail}`,
    };
  }

  // Daily (explicit, or a bare time-of-day / generic schedule word → daily).
  return {
    cron: `${utc.minute} ${utc.hour} * * *`,
    timezone: zone?.iana ?? null,
    detail: `Every day at ${timeDetail}`,
  };
}

function detectZone(lower: string): Zone | null {
  for (const { match, zone } of ZONES) if (match.test(lower)) return zone;
  return null;
}

function detectWeekday(lower: string): { dow: number; name: string } | null {
  for (const { match, dow, name } of WEEKDAYS) if (match.test(lower)) return { dow, name };
  return null;
}

/** Extract an explicit time-of-day in the stated zone, or null. */
function detectTime(lower: string): { hour: number; minute: number } | null {
  // 15:05, 15h05, 15.05, optionally with am/pm or a trailing "h"
  const hm = lower.match(/\b(\d{1,2})\s*[:h.]\s*(\d{2})\s*(am|pm)?/);
  if (hm) {
    let hour = parseInt(hm[1]!, 10);
    const minute = clamp(parseInt(hm[2]!, 10), 0, 59);
    hour = applyMeridiem(hour, hm[3]);
    if (hour >= 0 && hour <= 23) return { hour, minute };
  }
  // 3pm / 9 am / 15h (no minutes)
  const hOnly = lower.match(/\b(\d{1,2})\s*(am|pm)\b/) ?? lower.match(/\b(\d{1,2})\s*h\b/);
  if (hOnly) {
    let hour = parseInt(hOnly[1]!, 10);
    hour = applyMeridiem(hour, hOnly[2]);
    if (hour >= 0 && hour <= 23) return { hour, minute: 0 };
  }
  return null;
}

function applyMeridiem(hour: number, meridiem?: string): number {
  if (meridiem === 'pm') return hour === 12 ? 12 : hour + 12;
  if (meridiem === 'am') return hour === 12 ? 0 : hour;
  return hour;
}

/** Convert a local wall-clock time to UTC given the zone's offset (minutes). */
function toUtc(hour: number, minute: number, offsetMinutes: number): { hour: number; minute: number } {
  let total = hour * 60 + minute - offsetMinutes; // local = utc + offset → utc = local - offset
  total = ((total % 1440) + 1440) % 1440;
  return { hour: Math.floor(total / 60), minute: total % 60 };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo));
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
