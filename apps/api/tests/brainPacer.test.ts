/**
 * PACER classifier (Phase 1+2) — the deterministic routing layer. These cases
 * lock in the class assignments that drive TTL, decay-resistance, and
 * compression behaviour. If a class flips, the downstream lifecycle changes, so
 * these must not regress silently.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyPacer,
  pacerRouting,
  coercePacerClass,
  type PacerClass,
} from '../src/services/brainPacer.js';

describe('classifyPacer — procedural', () => {
  const procedural = [
    'Always retry the Slack API with exponential backoff because it rate-limits bursts.',
    'When the build step fails validation, patch the missing node config before retrying the run.',
    'Never send the daily digest before 9am; recipients flag earlier sends as spam.',
  ];
  for (const text of procedural) {
    it(`classifies as procedural: ${text.slice(0, 40)}…`, () => {
      expect(classifyPacer({ text, surface: 'run_completion' }).pacerClass).toBe('procedural');
    });
  }

  it('uses the episode-type prior (recovery → procedural)', () => {
    const v = classifyPacer({ text: 'Restarting the worker cleared the stuck queue.', episodeType: 'recovery' });
    expect(v.pacerClass).toBe('procedural');
  });
});

describe('classifyPacer — reference', () => {
  it('classifies identifier/path-dense lookup material as reference', () => {
    const v = classifyPacer({
      text: 'The export endpoint is defined at src/routes/export.ts and reads the EXPORT_BUCKET env variable.',
      surface: 'knowledge_ingest',
    });
    expect(v.pacerClass).toBe('reference');
  });

  it('honors an operator fact tag', () => {
    const v = classifyPacer({ text: 'Our company is headquartered in Lisbon.', surface: 'operator_chat', tags: ['fact'] });
    expect(v.pacerClass).toBe('reference');
  });
});

describe('classifyPacer — conceptual', () => {
  it('classifies rationale/invariant statements as conceptual', () => {
    const v = classifyPacer({
      text: 'Caching the tokenizer matters because re-loading it dominates latency on short tasks.',
      episodeType: 'distilled_lesson',
    });
    expect(v.pacerClass).toBe('conceptual');
  });
});

describe('classifyPacer — evidence default', () => {
  it('falls back to evidence for low-signal observations', () => {
    const v = classifyPacer({ text: 'The run returned 12 rows.', surface: 'tool_output', episodeType: 'observation' });
    expect(v.pacerClass).toBe('evidence');
  });

  it('staged tool output stays evidence (cold by default)', () => {
    const v = classifyPacer({ text: 'Fetched the page and parsed the headlines.', surface: 'tool_output' });
    expect(v.pacerClass).toBe('evidence');
  });
});

describe('classifyPacer — analogical', () => {
  it('detects analogical cues', () => {
    const v = classifyPacer({ text: 'This outage resembles the earlier Redis connection storm.' });
    expect(v.pacerClass).toBe('analogical');
  });
});

describe('pacerRouting — lifecycle invariants', () => {
  it('procedural/conceptual/reference are decay-resistant; evidence/analogical are not', () => {
    expect(pacerRouting('procedural').decayResistant).toBe(true);
    expect(pacerRouting('conceptual').decayResistant).toBe(true);
    expect(pacerRouting('reference').decayResistant).toBe(true);
    expect(pacerRouting('evidence').decayResistant).toBe(false);
    expect(pacerRouting('analogical').decayResistant).toBe(false);
  });

  it('evidence has the shortest staged TTL', () => {
    const classes: PacerClass[] = ['procedural', 'conceptual', 'reference', 'analogical'];
    for (const c of classes) {
      expect(pacerRouting(c).stagedTtlDays).toBeGreaterThan(pacerRouting('evidence').stagedTtlDays);
    }
  });

  it('procedural merges only when near-identical (highest threshold among durable classes)', () => {
    expect(pacerRouting('procedural').mergeSimilarity).toBeGreaterThanOrEqual(pacerRouting('conceptual').mergeSimilarity);
    expect(pacerRouting('procedural').mergeSimilarity).toBeGreaterThan(pacerRouting('evidence').mergeSimilarity);
  });

  it('evidence is lowest curator priority (kept archival, not distilled)', () => {
    expect(pacerRouting('evidence').curatorPriority).toBeLessThan(pacerRouting('conceptual').curatorPriority);
    expect(pacerRouting('evidence').curatorPriority).toBeLessThan(pacerRouting('procedural').curatorPriority);
  });
});

describe('coercePacerClass', () => {
  it('round-trips valid classes and rejects junk', () => {
    expect(coercePacerClass('procedural')).toBe('procedural');
    expect(coercePacerClass('nonsense')).toBeNull();
    expect(coercePacerClass(undefined)).toBeNull();
  });
});
