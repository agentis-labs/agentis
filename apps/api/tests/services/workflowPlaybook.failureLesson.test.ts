/**
 * Workflow Playbook — failure-lesson classification + distillation
 * (COGNITIVE-LOOPING "fail-forward, don't dead-end"). Pure helpers: an
 * instructive failure becomes a durable playbook lesson that build recalls.
 */
import { describe, it, expect } from 'vitest';
import { isInstructiveFailure, distillFailureLesson } from '../../src/services/workflow/workflowPlaybook.js';

describe('isInstructiveFailure', () => {
  it('flags guard / precondition / validation rejections as instructive', () => {
    expect(isInstructiveFailure('expression evaluation failed: BLOCKED_UNRESOLVED_BIO_LINK: Linktree/bio link must be opened and resolved before ICP')).toBe(true);
    expect(isInstructiveFailure('BLOCKED_OWNED_ECOMMERCE_IN_BIO_LINK: owned ecommerce detected')).toBe(true);
    expect(isInstructiveFailure("missing required field 'icp'")).toBe(true);
    expect(isInstructiveFailure('validation failed: expected a non-empty array')).toBe(true);
  });

  it('does NOT flag transient / runtime-class failures (self-heal territory)', () => {
    expect(isInstructiveFailure('request timeout after 30s')).toBe(false);
    expect(isInstructiveFailure('ECONNREFUSED 127.0.0.1:5432')).toBe(false);
    expect(isInstructiveFailure('rate limit exceeded (429)')).toBe(false);
    expect(isInstructiveFailure('claude_code exited 1')).toBe(false);
    expect(isInstructiveFailure('model provider out of credits')).toBe(false);
    expect(isInstructiveFailure(undefined)).toBe(false);
    expect(isInstructiveFailure('')).toBe(false);
  });
});

describe('distillFailureLesson', () => {
  it('produces a failureMode → fix lesson that prescribes failing forward', () => {
    const lesson = distillFailureLesson({
      workflowTitle: 'Agentis Fashion Store',
      nodeTitle: 'Transform',
      error: 'BLOCKED_UNRESOLVED_BIO_LINK: bio link must be opened and resolved before ICP',
    });
    expect(lesson.failureMode).toContain('Agentis Fashion Store');
    expect(lesson.failureMode).toContain('Transform');
    expect(lesson.failureMode).toContain('BLOCKED_UNRESOLVED_BIO_LINK');
    // The fix teaches the corrective loop AND carries the requirement forward.
    expect(lesson.fix).toContain('pursue');
    expect(lesson.fix.toLowerCase()).toContain('feedback');
    expect(lesson.fix).toContain('bio link must be opened and resolved before ICP');
    // Bounded lengths so the playbook stays legible.
    expect(lesson.failureMode.length).toBeLessThanOrEqual(280);
    expect(lesson.fix.length).toBeLessThanOrEqual(500);
  });

  it('works without a workflow title', () => {
    const lesson = distillFailureLesson({ nodeTitle: 'Guard', error: 'must have a resolved URL first' });
    expect(lesson.failureMode).toContain('Guard');
    expect(lesson.fix).toContain('corrective loop');
  });
});
