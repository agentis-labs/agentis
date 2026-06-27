/**
 * Step primitive — PlanService.setSteps / advanceStep project a linear checklist
 * onto the task spine and broadcast it on TASK_SPINE_UPDATED, the single source
 * the chat / Live Workspace / channel StepTrack consumes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { REALTIME_EVENTS, projectPlanSteps, summarizeWorkSteps, type WorkStep } from '@agentis/core';
import { PlanService } from '../../src/services/planService.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });

describe('PlanService step projection', () => {
  it('sets an ordered checklist and emits it on the task spine', () => {
    const plans = new PlanService(ctx.db, ctx.bus);
    const capture = ctx.captureBus();

    const plan = plans.setSteps(ctx.workspace.id, ctx.user.id, {
      title: 'Harvest lead',
      steps: ['Fetch profile', 'Extract metadata', 'Save artifact'],
    });

    const track = projectPlanSteps(plan);
    expect(track.total).toBe(3);
    expect(track.steps.map((step) => step.label)).toEqual(['Fetch profile', 'Extract metadata', 'Save artifact']);
    expect(track.steps.every((step) => step.status === 'pending')).toBe(true);

    const emitted = capture.events.some((message) =>
      message.envelope.event === REALTIME_EVENTS.TASK_SPINE_UPDATED
      && Array.isArray((message.envelope.payload as { steps?: unknown[] }).steps));
    capture.stop();
    expect(emitted).toBe(true);
  });

  it('advances the active step done and starts the next', () => {
    const plans = new PlanService(ctx.db, ctx.bus);
    const created = plans.setSteps(ctx.workspace.id, ctx.user.id, { steps: ['A', 'B', 'C'] });
    const planId = created.id;

    const afterFirst = plans.advanceStep(ctx.workspace.id, ctx.user.id, { planId });
    const t1 = projectPlanSteps(afterFirst);
    expect(t1.steps[0]?.status).toBe('done');
    expect(t1.steps[1]?.status).toBe('running');
    expect(t1.current).toBe(2);

    const afterFail = plans.advanceStep(ctx.workspace.id, ctx.user.id, { planId, status: 'failed' });
    const t2 = projectPlanSteps(afterFail);
    expect(t2.steps[1]?.status).toBe('failed');
    expect(afterFail.status).toBe('blocked');
  });

  it('summarizeWorkSteps reports current from the running step', () => {
    const steps: WorkStep[] = [
      { id: '1', label: 'A', status: 'done' },
      { id: '2', label: 'B', status: 'running' },
      { id: '3', label: 'C', status: 'pending' },
    ];
    expect(summarizeWorkSteps(steps)).toEqual({ steps, current: 2, total: 3 });
  });
});
