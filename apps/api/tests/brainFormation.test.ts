/**
 * Memory-formation gate (§P0/P1/P3) — the wall between agent output and Brain
 * memory. These are the golden cases that must never regress: the exact garbage
 * observed in production must be dropped, real lessons must survive, and
 * transient tasks must be gated to episodic_only.
 */
import { describe, it, expect } from 'vitest';
import {
  extractCandidateStatements,
  classifyOutputShape,
  isRejectable,
  scoreStatement,
  FORMATION_MIN_SCORE,
} from '../src/services/brainFormation.js';
import { resolveMemoryPolicy } from '../src/services/memoryPolicyResolver.js';

// The literal pollution from the bug report.
const PRODUCTION_GARBAGE = [
  '| 8 | hn:48446141 | 3.70 | Healthcare AI copilot signal, useful but requiring cautious validation.',
  'Link: https://github.com/salimassili62-afk/ai-costguard',
  '| 4 | https://www.theverge.com/podcast/944138/microsoft-ai-ceo-mustafa-suleyman-superintelligence',
  'No fresh unsent important AI stories were found for today’s digest.',
  'I selected 8 stories because the instruction allows 5-8 when candidateCount is greater than five.',
  'Source: https://news.ycombinator.com/item?id=48446328',
];

// Statements that ARE durable, reusable memory and must survive.
const REAL_LESSONS = [
  'Always retry the Slack API with exponential backoff because it rate-limits bursts above 50 requests per minute.',
  'Never send the daily digest before 9am ET; recipients flagged earlier sends as spam.',
  'The export job fails when a row contains an unescaped comma, so quote all CSV fields.',
];

describe('extractCandidateStatements — drops production garbage', () => {
  for (const junk of PRODUCTION_GARBAGE) {
    it(`rejects: ${junk.slice(0, 48)}…`, () => {
      const survivors = extractCandidateStatements(junk).map((s) => s.text);
      expect(survivors).toHaveLength(0);
    });
  }

  it('drops the whole digest output but keeps an embedded real lesson', () => {
    const digest = [
      '# Daily AI Digest',
      '| 1 | hn:48446141 | 3.70 | Healthcare AI copilot signal',
      '| 2 | hn:48446328 | 3.95 | Rising AI cost vs measurable value',
      'Link: https://github.com/example/repo',
      'I selected 8 stories because the instruction allows 5-8.',
      'No fresh unsent important AI stories were found for today’s digest.',
      'Always validate healthcare AI outputs against a clinician before publishing because hallucinated dosages are dangerous.',
    ].join('\n');
    const survivors = extractCandidateStatements(digest).map((s) => s.text);
    expect(survivors.some((s) => /validate healthcare AI outputs/i.test(s))).toBe(true);
    expect(survivors.some((s) => /hn:48446141|Link:|I selected|No fresh/i.test(s))).toBe(false);
  });
});

describe('extractCandidateStatements — keeps real lessons', () => {
  for (const lesson of REAL_LESSONS) {
    it(`keeps: ${lesson.slice(0, 48)}…`, () => {
      const survivors = extractCandidateStatements(lesson).map((s) => s.text);
      expect(survivors).toHaveLength(1);
      expect(scoreStatement(lesson)).toBeGreaterThanOrEqual(FORMATION_MIN_SCORE);
    });
  }
});

describe('isRejectable — structural classes', () => {
  it.each([
    ['table row', '| 8 | hn:48446141 | 3.70 | signal'],
    ['ranking key', 'hn:48446141 is the top story today right now'],
    ['link line', 'Link: https://github.com/x/y'],
    ['first-person narration', 'I selected 8 stories because the rule allows it'],
    ['empty-result chatter', 'No fresh unsent important AI stories were found'],
    ['done status', 'Done.'],
  ])('rejects %s', (_label, text) => {
    expect(isRejectable(text)).toBe(true);
  });

  it.each([
    ['rule', 'Always quote CSV fields to survive embedded commas'],
    ['cause', 'The job fails because the token expires after one hour'],
  ])('keeps %s', (_label, text) => {
    expect(isRejectable(text)).toBe(false);
  });
});

describe('classifyOutputShape', () => {
  it('classifies a row list as list_rows', () => {
    const rows = ['| 1 | a |', '| 2 | b |', '| 3 | c |', '| 4 | d |'].join('\n');
    expect(classifyOutputShape(rows)).toBe('list_rows');
  });
  it('classifies empty output as empty', () => {
    expect(classifyOutputShape('')).toBe('empty');
    expect(classifyOutputShape(null)).toBe('empty');
  });
  it('classifies a short lesson as prose', () => {
    expect(classifyOutputShape('We should always retry on 429 responses.')).toBe('prose');
  });
});

describe('resolveMemoryPolicy — the write-policy gate', () => {
  it('honors an explicit node override', () => {
    expect(resolveMemoryPolicy({ explicitPolicy: 'none' }).policy).toBe('none');
  });
  it('gates a digest role to episodic_only', () => {
    expect(resolveMemoryPolicy({ nodeTitle: 'Daily Digest Delivery', output: 'anything here at all' }).policy).toBe('episodic_only');
  });
  it('gates a notifier role to episodic_only', () => {
    expect(resolveMemoryPolicy({ agentRole: 'notifier', output: 'sent the message' }).policy).toBe('episodic_only');
  });
  it('gates list-shaped output to episodic_only', () => {
    const rows = ['| 1 | a |', '| 2 | b |', '| 3 | c |', '| 4 | d |'].join('\n');
    expect(resolveMemoryPolicy({ nodeTitle: 'Build report', output: rows }).policy).toBe('episodic_only');
  });
  it('allows a normal task to form memory', () => {
    expect(resolveMemoryPolicy({ nodeTitle: 'Debug the auth flow', output: 'The login fails because the JWT clock skew exceeds 60 seconds.' }).policy).toBe('form');
  });
  it('writes nothing for empty output', () => {
    expect(resolveMemoryPolicy({ nodeTitle: 'noop', output: '' }).policy).toBe('none');
  });
});
