/**
 * ExperimentService — the experiment/measurement substrate (§3.5). Proves the
 * operator's exact ask: A/B the messages and read the success % of each — falling out
 * of a general, domain-neutral primitive (assign → record → per-variant success rate).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExperimentService } from '../../src/services/experiments.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

describe('ExperimentService', () => {
  it('define is idempotent by key', () => {
    const svc = new ExperimentService(ctx.db);
    const a = svc.define({ workspaceId: ctx.workspace.id, key: 'first_message', variants: ['A', 'B'] });
    const b = svc.define({ workspaceId: ctx.workspace.id, key: 'first_message', variants: ['A', 'B', 'C'] });
    expect(b.id).toBe(a.id);
    expect(b.variantsJson).toEqual(['A', 'B', 'C']); // re-define updates arms
  });

  it('assigns stickily + deterministically, and returns null before define', () => {
    const svc = new ExperimentService(ctx.db);
    expect(svc.assign({ workspaceId: ctx.workspace.id, key: 'x', subjectKey: 'lead-1' })).toBeNull();
    svc.define({ workspaceId: ctx.workspace.id, key: 'first_message', variants: ['A', 'B'] });
    const first = svc.assign({ workspaceId: ctx.workspace.id, key: 'first_message', subjectKey: 'lead-1' });
    const again = svc.assign({ workspaceId: ctx.workspace.id, key: 'first_message', subjectKey: 'lead-1' });
    expect(again).toBe(first); // sticky — same subject, same arm
    expect(['A', 'B']).toContain(first);
  });

  it('records outcomes and reports the success rate of each variant', () => {
    const svc = new ExperimentService(ctx.db);
    svc.define({ workspaceId: ctx.workspace.id, key: 'first_message', variants: ['A', 'B'] });
    // Assign a spread of subjects (deterministic → reproducible arms) and score them.
    const subjects = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];
    const arm: Record<string, string> = {};
    for (const s of subjects) arm[s] = svc.assign({ workspaceId: ctx.workspace.id, key: 'first_message', subjectKey: s })!;
    // Win every A, lose every B — the rates must reflect that exactly.
    for (const s of subjects) {
      svc.record({ workspaceId: ctx.workspace.id, key: 'first_message', subjectKey: s, outcome: arm[s] === 'A' ? 'won' : 'lost' });
    }
    const results = svc.results(ctx.workspace.id, 'first_message')!;
    const A = results.variants.find((v) => v.variant === 'A')!;
    const B = results.variants.find((v) => v.variant === 'B')!;
    expect(A.assigned + B.assigned).toBe(8);
    if (A.assigned > 0) expect(A.successRate).toBe(1); // all A won
    if (B.assigned > 0) expect(B.successRate).toBe(0); // all B lost
    expect(A.outcomes.won ?? 0).toBe(A.assigned);
    expect(B.outcomes.lost ?? 0).toBe(B.assigned);
  });

  it('record is a no-op for an unknown experiment; results is null', () => {
    const svc = new ExperimentService(ctx.db);
    expect(svc.record({ workspaceId: ctx.workspace.id, key: 'nope', subjectKey: 's1', outcome: 'won' })).toBe(false);
    expect(svc.results(ctx.workspace.id, 'nope')).toBeNull();
  });
});
