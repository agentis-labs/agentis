import { describe, expect, it } from 'vitest';
import { scheduleFromNaturalLanguage } from '../../src/services/scheduleFromNaturalLanguage.js';

describe('scheduleFromNaturalLanguage', () => {
  it('converts "every day at 15:05 Brasília" to the correct UTC cron', () => {
    const parsed = scheduleFromNaturalLanguage('send me the digest every day at 15:05h Brasilia/BR');
    expect(parsed).not.toBeNull();
    // 15:05 BRT (UTC-3) → 18:05 UTC → `5 18 * * *`
    expect(parsed!.cron).toBe('5 18 * * *');
    expect(parsed!.timezone).toBe('America/Sao_Paulo');
  });

  it('honors an explicit UTC time without shifting', () => {
    const parsed = scheduleFromNaturalLanguage('run it every day at 09:00 UTC');
    expect(parsed!.cron).toBe('0 9 * * *');
    expect(parsed!.timezone).toBe('UTC');
  });

  it('handles am/pm times', () => {
    const parsed = scheduleFromNaturalLanguage('email me daily at 3pm UTC');
    expect(parsed!.cron).toBe('0 15 * * *');
  });

  it('parses a weekday cadence', () => {
    const parsed = scheduleFromNaturalLanguage('every Monday at 09:00 UTC summarize the week');
    expect(parsed!.cron).toBe('0 9 * * 1');
  });

  it('wraps across midnight when the UTC conversion crosses a day boundary', () => {
    // 23:30 BRT (UTC-3) → 02:30 UTC next day
    const parsed = scheduleFromNaturalLanguage('every day at 23:30 Brasília');
    expect(parsed!.cron).toBe('30 2 * * *');
  });

  it('supports "every N minutes"', () => {
    expect(scheduleFromNaturalLanguage('poll every 5 minutes')!.cron).toBe('*/5 * * * *');
  });

  it('supports hourly', () => {
    expect(scheduleFromNaturalLanguage('check every hour')!.cron).toBe('0 * * * *');
  });

  it('defaults to 09:00 when a cadence is stated without a time', () => {
    expect(scheduleFromNaturalLanguage('run this daily')!.cron).toBe('0 9 * * *');
  });

  it('returns null when there is no scheduling intent', () => {
    expect(scheduleFromNaturalLanguage('summarize the latest AI news and email it to me')).toBeNull();
    expect(scheduleFromNaturalLanguage('hello there')).toBeNull();
  });
});
