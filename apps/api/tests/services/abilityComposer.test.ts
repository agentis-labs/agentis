/**
 * AbilityComposer — Composer + Conflict Resolver + Ability Cache
 * (docs/ABILITIES_10X_RFC.md §4).
 */
import { describe, expect, it } from 'vitest';
import { AbilityComposer, type ComposerEntry } from '../../src/services/abilityComposer.js';

function entry(p: Partial<ComposerEntry> & { id: string }): ComposerEntry {
  return {
    name: p.id,
    contentHash: p.contentHash ?? `hash-${p.id}`,
    depth: p.depth ?? 'd0_instinct',
    tier: p.tier ?? 'semantic',
    score: p.score ?? 0.5,
    rulesAlways: p.rulesAlways ?? [],
    rulesNever: p.rulesNever ?? [],
    toolHints: p.toolHints ?? [],
    ...p,
  };
}

describe('AbilityComposer — ordering', () => {
  it('orders by tier: required → pinned → always → semantic', () => {
    const c = new AbilityComposer();
    const out = c.compose([
      entry({ id: 'sem', tier: 'semantic', score: 0.99 }),
      entry({ id: 'req', tier: 'required' }),
      entry({ id: 'pin', tier: 'pinned' }),
      entry({ id: 'alw', tier: 'always' }),
    ]);
    expect(out.ordered.map((e) => e.id)).toEqual(['req', 'pin', 'alw', 'sem']);
  });

  it('orders the task-invariant prefix by content hash (prefix-cache stability)', () => {
    const c = new AbilityComposer();
    // Two pinned abilities: order must follow content hash, not score/insertion.
    const out = c.compose([
      entry({ id: 'b', tier: 'pinned', contentHash: 'zzz', score: 0.9 }),
      entry({ id: 'a', tier: 'pinned', contentHash: 'aaa', score: 0.1 }),
    ]);
    expect(out.ordered.map((e) => e.id)).toEqual(['a', 'b']); // aaa < zzz
  });

  it('orders the semantic suffix by relevance score (best first)', () => {
    const c = new AbilityComposer();
    const out = c.compose([
      entry({ id: 'low', tier: 'semantic', score: 0.3 }),
      entry({ id: 'high', tier: 'semantic', score: 0.8 }),
    ]);
    expect(out.ordered.map((e) => e.id)).toEqual(['high', 'low']);
  });
});

describe('AbilityComposer — conflict resolution', () => {
  it('detects a NEVER-vs-ALWAYS rule conflict and the higher-precedence side wins', () => {
    const c = new AbilityComposer();
    const out = c.compose([
      entry({ id: 'pinned', tier: 'pinned', rulesNever: ['Never use inline styles'] }),
      entry({ id: 'sem', tier: 'semantic', rulesAlways: ['Always use inline styles'] }),
    ]);
    expect(out.conflicts).toHaveLength(1);
    const conflict = out.conflicts[0]!;
    expect(conflict.kind).toBe('rule_conflict');
    expect(conflict.winnerId).toBe('pinned'); // pinned tier outranks semantic
    expect(conflict.loserId).toBe('sem');
    // The loser's rule is suppressed.
    expect(out.suppressed.get('sem')?.size).toBeGreaterThan(0);
  });

  it('deeper depth wins a conflict within the same tier', () => {
    const c = new AbilityComposer();
    const out = c.compose([
      entry({ id: 'shallow', tier: 'semantic', depth: 'd0_instinct', rulesAlways: ['Always cite sources'], score: 0.9 }),
      entry({ id: 'deep', tier: 'semantic', depth: 'd3_method', rulesNever: ['Never cite sources'], score: 0.5 }),
    ]);
    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts[0]!.winnerId).toBe('deep');
  });

  it('does not flag unrelated rules as conflicts', () => {
    const c = new AbilityComposer();
    const out = c.compose([
      entry({ id: 'a', rulesNever: ['Never use inline styles'] }),
      entry({ id: 'b', rulesAlways: ['Always write tests'] }),
    ]);
    expect(out.conflicts).toHaveLength(0);
  });
});

describe('AbilityComposer — cache', () => {
  it('is a cache miss then hit for the same stack signature', () => {
    const c = new AbilityComposer();
    const stack = [entry({ id: 'x', tier: 'pinned' }), entry({ id: 'y', tier: 'semantic', score: 0.6 })];
    const first = c.compose(stack);
    const second = c.compose(stack);
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(c.stats().hits).toBe(1);
    expect(c.stats().misses).toBe(1);
    // Decision is identical.
    expect(second.ordered.map((e) => e.id)).toEqual(first.ordered.map((e) => e.id));
  });

  it('treats a changed content hash as a new stack (cache miss)', () => {
    const c = new AbilityComposer();
    c.compose([entry({ id: 'x', tier: 'pinned', contentHash: 'v1' })]);
    const after = c.compose([entry({ id: 'x', tier: 'pinned', contentHash: 'v2' })]);
    expect(after.cacheHit).toBe(false);
    expect(c.stats().misses).toBe(2);
  });

  it('evicts least-recently-used decisions past the cap', () => {
    const c = new AbilityComposer({ cacheSize: 16 });
    for (let i = 0; i < 40; i++) c.compose([entry({ id: `a${i}`, tier: 'pinned' })]);
    expect(c.stats().size).toBeLessThanOrEqual(16);
  });
});
