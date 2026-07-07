/**
 * Workflow Pattern Library (WORKFLOW-DESIGN-10X Phase 4) — proves the robust
 * control-flow fragments exist with their reject/fallback/rollback branches and
 * that signal-driven suggestion maps to the right patterns.
 */
import { describe, expect, it } from 'vitest';
import type { WorkflowGraph } from '@agentis/core';
import { WORKFLOW_PATTERNS, getWorkflowPattern, suggestPatterns } from '../../src/services/workflowPatterns.js';
import { evalCondition } from '../../src/engine/SafeConditionParser.js';
import { validateGraphExpressions } from '../../src/engine/validateExpressions.js';

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

  it('exposes the pursuit (cognitive loop) as a pursue-node fragment (D7)', () => {
    const conv = getWorkflowPattern('convergence-loop')!;
    expect(conv.doctrine).toBe('D7');
    const node = conv.nodes.find((n) => n.kind === 'pursue')!;
    expect(node).toBeDefined();
    expect((node.config as { doneWhen?: { type?: string } }).doneWhen?.type).toBeDefined();
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

// WORKFLOW-RELIABILITY P4.2 — the blocks the planner composes from must be
// dry-run clean, or a pattern teaches the very expression-contract bug this
// program removes.
const conditionScope = {
  input: {}, inputs: {}, output: {}, trigger: {}, nodes: {}, scratchpad: {}, store: {}, workspace: {}, run: {}, loop: {},
};

describe('workflow pattern library is self-verifying', () => {
  for (const pattern of WORKFLOW_PATTERNS) {
    it(`${pattern.id}: every router condition parses under the safe-condition grammar`, () => {
      for (const node of pattern.nodes) {
        if (node.config.kind !== 'router') continue;
        const branches = (node.config as { branches?: Array<{ condition?: string }> }).branches ?? [];
        for (const branch of branches) {
          if (typeof branch.condition === 'string' && branch.condition.trim()) {
            expect(() => evalCondition(branch.condition!, conditionScope)).not.toThrow();
          }
        }
      }
    });

    it(`${pattern.id}: every JS / {{=}} expression is on-contract`, () => {
      const graph = {
        nodes: pattern.nodes.map((n) => ({ id: n.id, type: n.config.kind, title: n.title, position: { x: 0, y: 0 }, config: n.config })),
        edges: [],
      } as unknown as WorkflowGraph;
      expect(validateGraphExpressions(graph)).toEqual([]);
    });
  }
});
