import { describe, expect, it } from 'vitest';
import { looksLikeTaskCommand } from '../src/services/chat/chatMemoryCapture.js';

/**
 * §B7.1 — the narrow-write guard. A one-shot task command must NOT be captured as
 * durable memory (the production bug: "create a workflow that watches AI posts"
 * was stored as an "Operator rule"). A standing policy MUST still be captured.
 */
describe('looksLikeTaskCommand — task command vs standing policy', () => {
  it('treats one-shot task requests as commands (dropped from memory)', () => {
    expect(looksLikeTaskCommand('create a new workflow that constantly watches for new posts about AI')).toBe(true);
    expect(looksLikeTaskCommand('remember to create a workflow that scrapes Hacker News each morning')).toBe(true);
    expect(looksLikeTaskCommand('send the quarterly report to the finance team')).toBe(true);
    expect(looksLikeTaskCommand('build me a dashboard for lead conversion')).toBe(true);
    expect(looksLikeTaskCommand('please summarize this thread')).toBe(true);
  });

  it('keeps standing policies even when they start with an action verb', () => {
    // Modality makes it a recurring rule, not a one-off task.
    expect(looksLikeTaskCommand('always create a backup before deploying')).toBe(false);
    expect(looksLikeTaskCommand('never send email before 9am ET')).toBe(false);
    expect(looksLikeTaskCommand('whenever you deploy, run the smoke tests first')).toBe(false);
  });

  it('does not flag preferences/facts/rules that are not action commands', () => {
    expect(looksLikeTaskCommand('I prefer concise answers in bullet points')).toBe(false);
    expect(looksLikeTaskCommand('our fiscal year ends December 31')).toBe(false);
    expect(looksLikeTaskCommand('you must always be proactive')).toBe(false);
  });
});
