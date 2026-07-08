/**
 * Self-improving Workflow Playbook (WORKFLOW-DESIGN-10X Phase 5) — proves a learned
 * failure-mode→fix lesson round-trips through the workspace memory substrate and
 * renders into a synthesis-prompt block for the next build to design around.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../../src/services/memory/memoryStore.js';
import { recordWorkflowLesson, recallWorkflowLessons, renderPlaybookLessons } from '../../src/services/workflow/workflowPlaybook.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let memory: MemoryStore;

beforeEach(async () => {
  ctx = await createTestContext();
  memory = new MemoryStore(ctx.db, ctx.logger);
});
afterEach(() => ctx.close());

describe('workflow playbook', () => {
  it('records a lesson and recalls it for the next build', () => {
    const id = recordWorkflowLesson(memory, ctx.workspace.id, {
      failureMode: 'Instagram sidecar posts hide media from basic scrapers',
      fix: 'Validate the raw post payload first; fall back to screenshots only if the media is clearly usable',
      patternId: 'fetch-with-fallback',
    });
    expect(id).toBeTruthy();

    const recalled = recallWorkflowLessons(memory, ctx.workspace.id);
    expect(recalled.length).toBe(1);
    expect(recalled[0]!.content).toMatch(/WHEN: Instagram sidecar/);
    expect(recalled[0]!.content).toMatch(/DO: Validate the raw post payload/);
    expect(recalled[0]!.content).toMatch(/PATTERN: fetch-with-fallback/);

    const block = renderPlaybookLessons(recalled);
    expect(block).toMatch(/LEARNED LESSONS FROM PAST RUNS/);
    expect(block).toMatch(/Instagram sidecar/);
  });

  it('is a no-op when memory is unavailable or the lesson is empty', () => {
    expect(recordWorkflowLesson(undefined, ctx.workspace.id, { failureMode: 'x', fix: 'y' })).toBeNull();
    expect(recordWorkflowLesson(memory, ctx.workspace.id, { failureMode: '  ', fix: 'y' })).toBeNull();
    expect(recallWorkflowLessons(undefined, ctx.workspace.id)).toEqual([]);
    expect(renderPlaybookLessons([])).toBe('');
  });
});
