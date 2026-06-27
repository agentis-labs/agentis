/**
 * Workflow Pattern Library (WORKFLOW-DESIGN-10X Phase 4) — proves the robust
 * control-flow fragments exist with their reject/fallback/rollback branches and
 * that signal-driven suggestion maps to the right patterns.
 */
import { describe, expect, it } from 'vitest';
import { WORKFLOW_PATTERNS, getWorkflowPattern, suggestPatterns } from '../../src/services/workflowPatterns.js';

describe('workflow pattern library', () => {
  it('exposes the named robust patterns', () => {
    const ids = WORKFLOW_PATTERNS.map((p) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'qualify-or-reject-loop',
        'fetch-with-fallback',
        'approval-before-irreversible',
        'validate-before-transition',
        'bounded-parallel-batch',
        'stateful-cursor-dedup',
        'convergence-loop',
      ]),
    );
  });

  it('exposes the convergence loop as a converge-node fragment (D7)', () => {
    const conv = getWorkflowPattern('convergence-loop')!;
    expect(conv.doctrine).toBe('D7');
    const node = conv.nodes.find((n) => n.kind === 'converge')!;
    expect(node).toBeDefined();
    expect((node.config as { continuation?: { type?: string } }).continuation?.type).toBeDefined();
  });

  it('includes the exception branches, not just the happy path', () => {
    const validate = getWorkflowPattern('validate-before-transition')!;
    expect(validate.edges.some((e) => /rollback/i.test(e.branch ?? ''))).toBe(true);
    const qualify = getWorkflowPattern('qualify-or-reject-loop')!;
    expect(qualify.edges.some((e) => e.to === 'fetch' && /fail/i.test(e.branch ?? ''))).toBe(true); // reject loops back
    const batch = getWorkflowPattern('bounded-parallel-batch')!;
    expect((batch.nodes.find((n) => n.kind === 'loop')!.config as { maxConcurrency?: number }).maxConcurrency).toBe(5);
  });

  it('suggests patterns from the request robustness signals', () => {
    const ids = suggestPatterns({ qualifies: true, recurring: true, irreversible: true, validates: true }).map((p) => p.id);
    expect(ids).toContain('qualify-or-reject-loop');
    expect(ids).toContain('stateful-cursor-dedup');
    expect(ids).toContain('validate-before-transition');
    expect(ids).not.toContain('bounded-parallel-batch'); // batch signal not set
    expect(ids).not.toContain('convergence-loop'); // iterative signal not set
  });

  it('suggests the convergence loop for an iterative goal', () => {
    const ids = suggestPatterns({ iterative: true }).map((p) => p.id);
    expect(ids).toContain('convergence-loop');
  });
});
