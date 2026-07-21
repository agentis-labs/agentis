/**
 * channelGuards — platform-owned anti-ban rails for outbound channel sends
 * (OMNICHANNEL-RICH-MESSAGING §7). Unofficial transports like WhatsApp/baileys
 * carry inherent ban risk from volume and cold outreach; these guards let an
 * operator cap that risk without hand-rolling it per App.
 *
 * All rails are OPT-IN: with no settings the guard always allows (behaviour is
 * unchanged). Every block is an operator decision, never a silent wall — the
 * cockpit/operator can bypass with an audited flag (§ operator sovereignty).
 *
 *   - rate limit    per-minute + per-day sliding-window caps per connection.
 *   - warmup ramp   a new connection's daily cap ramps up over a warmup window
 *                   so a fresh number isn't blasted on day one.
 *   - opt-in gate   refuse to cold-message a contact that never messaged first.
 */

export interface ChannelGuardSettings {
  rateLimit?: { perMinute?: number; perDay?: number };
  warmupStartedAt?: string;
  requireOptIn?: boolean;
}

export interface GuardDecision {
  ok: boolean;
  code?: 'CHANNEL_RATE_LIMITED' | 'CHANNEL_OPT_IN_REQUIRED' | 'CHANNEL_SEND_BLOCKED';
  reason?: string;
  remediation?: string;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const WARMUP_DAYS = 7;
const WARMUP_START_PER_DAY = 20;
const WARMUP_DEFAULT_TARGET = 1_000;

/**
 * Effective per-day cap after applying the warmup ramp. Ramps linearly from
 * WARMUP_START_PER_DAY to the target (or a default ceiling when no explicit cap)
 * across WARMUP_DAYS, then returns the configured cap unchanged.
 */
export function effectivePerDay(settings: ChannelGuardSettings, now: number): number | undefined {
  const target = settings.rateLimit?.perDay;
  if (!settings.warmupStartedAt) return target;
  const started = Date.parse(settings.warmupStartedAt);
  if (!Number.isFinite(started)) return target;
  const days = (now - started) / DAY_MS;
  if (days >= WARMUP_DAYS) return target;
  const ceiling = target ?? WARMUP_DEFAULT_TARGET;
  const ramped = Math.floor(WARMUP_START_PER_DAY + (ceiling - WARMUP_START_PER_DAY) * Math.max(0, days) / WARMUP_DAYS);
  return target ? Math.min(target, Math.max(WARMUP_START_PER_DAY, ramped)) : Math.max(WARMUP_START_PER_DAY, ramped);
}

export class ChannelSendGuard {
  readonly #sends = new Map<string, number[]>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Decide whether a send may proceed. `isNewContact` is only consulted for the
   * opt-in gate — the caller supplies it (a DB lookup) so this class stays pure.
   */
  evaluate(connectionId: string, settings: ChannelGuardSettings, opts: { isNewContact?: boolean } = {}): GuardDecision {
    if (settings.requireOptIn && opts.isNewContact) {
      return {
        ok: false,
        code: 'CHANNEL_OPT_IN_REQUIRED',
        reason: 'This contact has not messaged this channel first — cold outreach is the top ban trigger and is blocked by the opt-in rail.',
        remediation: 'Wait for the contact to message first, or send from the cockpit with the opt-in override (audited) if you are certain this contact consented.',
      };
    }
    const now = this.now();
    const perMinute = settings.rateLimit?.perMinute;
    if (perMinute && perMinute > 0 && this.#count(connectionId, now, MINUTE_MS) >= perMinute) {
      return {
        ok: false,
        code: 'CHANNEL_RATE_LIMITED',
        reason: `Per-minute send cap (${perMinute}) reached for this connection.`,
        remediation: 'Slow the send rate; the window frees as older sends age out.',
      };
    }
    const perDay = effectivePerDay(settings, now);
    if (perDay && perDay > 0 && this.#count(connectionId, now, DAY_MS) >= perDay) {
      const warming = Boolean(settings.warmupStartedAt);
      return {
        ok: false,
        code: 'CHANNEL_RATE_LIMITED',
        reason: `Daily send cap (${perDay}${warming ? ', warmup-limited' : ''}) reached for this connection.`,
        remediation: warming
          ? 'The connection is warming up; the daily cap rises over the warmup window. Resume tomorrow or raise the warmup ceiling.'
          : 'Resume when the 24h window frees, or raise the daily cap in channel settings.',
      };
    }
    return { ok: true };
  }

  /** Record a successful send so it counts against the windows. */
  record(connectionId: string): void {
    const now = this.now();
    const times = this.#sends.get(connectionId) ?? [];
    times.push(now);
    // Prune anything older than a day so the map can't grow unbounded.
    this.#sends.set(connectionId, times.filter((t) => now - t < DAY_MS));
  }

  #count(connectionId: string, now: number, windowMs: number): number {
    const times = this.#sends.get(connectionId);
    if (!times) return 0;
    let n = 0;
    for (const t of times) if (now - t < windowMs) n += 1;
    return n;
  }
}
