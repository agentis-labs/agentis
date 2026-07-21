import { describe, expect, it } from 'vitest';
import { ChannelSendGuard, effectivePerDay } from '../../src/services/conversation/channelGuards.js';

describe('ChannelSendGuard', () => {
  it('allows everything with no settings (opt-in default, unchanged behaviour)', () => {
    const g = new ChannelSendGuard(() => 1_000);
    for (let i = 0; i < 100; i += 1) { expect(g.evaluate('c1', {}).ok).toBe(true); g.record('c1'); }
  });

  it('enforces a per-minute cap and frees as the window ages', () => {
    let now = 1_000_000;
    const g = new ChannelSendGuard(() => now);
    const settings = { rateLimit: { perMinute: 3 } };
    for (let i = 0; i < 3; i += 1) { expect(g.evaluate('c', settings).ok).toBe(true); g.record('c'); }
    const blocked = g.evaluate('c', settings);
    expect(blocked.ok).toBe(false);
    expect(blocked.code).toBe('CHANNEL_RATE_LIMITED');
    now += 61_000; // all three sends age out of the minute window
    expect(g.evaluate('c', settings).ok).toBe(true);
  });

  it('blocks cold outreach to a new contact when opt-in is required', () => {
    const g = new ChannelSendGuard(() => 1_000);
    const settings = { requireOptIn: true };
    expect(g.evaluate('c', settings, { isNewContact: true }).code).toBe('CHANNEL_OPT_IN_REQUIRED');
    expect(g.evaluate('c', settings, { isNewContact: false }).ok).toBe(true); // a reply passes
  });

  it('ramps the daily cap during warmup then honours the target', () => {
    const start = 2_000_000_000_000;
    const settings = { rateLimit: { perDay: 1000 }, warmupStartedAt: new Date(start).toISOString() };
    const day0 = effectivePerDay(settings, start + 60_000)!;
    const day3 = effectivePerDay(settings, start + 3 * 86_400_000)!;
    const day8 = effectivePerDay(settings, start + 8 * 86_400_000)!;
    expect(day0).toBeLessThan(day3);
    expect(day3).toBeLessThan(1000);
    expect(day8).toBe(1000);
  });
});
