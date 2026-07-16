/**
 * app.plan — the plan-first decomposition ordering (GAP A1/B4). The dependency
 * order is the one non-trivial bit: a workflow must be built after everything it
 * dependsOn, so the returned checklist is executable top-to-bottom.
 */
import { describe, expect, it } from 'vitest';
import { buildChecklist, orderByDependsOn } from '../../src/services/agentisToolHandlers/appPlan.js';

const wf = (key: string, dependsOn: string[] = []) => ({ key, title: key, purpose: key, dependsOn });

describe('orderByDependsOn', () => {
  it('places each workflow after the ones it depends on', () => {
    const order = orderByDependsOn([wf('deliver', ['build']), wf('build', ['find']), wf('find')]).map((w) => w.key);
    expect(order.indexOf('find')).toBeLessThan(order.indexOf('build'));
    expect(order.indexOf('build')).toBeLessThan(order.indexOf('deliver'));
  });

  it('keeps independent workflows and tolerates unknown deps without looping', () => {
    const order = orderByDependsOn([wf('a'), wf('b', ['ghost']), wf('c', ['a'])]).map((w) => w.key);
    expect(order).toHaveLength(3);
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('c'));
  });

  it('does not hang on a dependency cycle (emits every node once)', () => {
    const order = orderByDependsOn([wf('x', ['y']), wf('y', ['x'])]).map((w) => w.key).sort();
    expect(order).toEqual(['x', 'y']);
  });
});

describe('buildChecklist', () => {
  it('keeps every workflow build inside the planned App and compiles dependencies', () => {
    const checklist = buildChecklist('app-1', {
      intent: 'ingest and publish',
      workflows: [wf('ingest'), wf('publish', ['ingest'])],
      conversation: false,
      collections: [],
      cast: [],
    });
    const builds = checklist.filter((step) => step.tool === 'agentis.build_workflow');
    expect(builds).toHaveLength(2);
    expect(builds.every((step) => step.args.appId === 'app-1')).toBe(true);
    const compile = checklist.find((step) => step.id === 'compile_workflow_rules');
    expect(compile?.args).toMatchObject({
      appId: 'app-1',
      workflows: [
        { workflowId: '${workflows.ingest.workflowId}', dependsOn: [] },
        { workflowId: '${workflows.publish.workflowId}', dependsOn: ['${workflows.ingest.workflowId}'] },
      ],
    });
    expect(checklist.at(-1)).toMatchObject({ id: 'compile_app', tool: 'agentis.app.compile', args: { appId: 'app-1', target: 'debug' } });
  });

  it('installs success contracts before compiling workflow rules', () => {
    const checklist = buildChecklist('app-1', {
      intent: 'perform verified work',
      workflows: [{
        ...wf('work'),
        success: { objective: 'artifact exists', acceptance: [{ id: 'exists', claim: 'artifact exists', verify: 'expr', expr: 'output.ok == true' }] },
      }],
      conversation: false,
      collections: [],
      cast: [],
    });
    expect(checklist.map((step) => step.id)).toEqual(['build_work', 'scope_work', 'compile_workflow_rules', 'compile_app']);
    expect(checklist[1]?.args.workflowId).toBe('${workflows.work.workflowId}');
  });

  it('keeps human/event-gated work out of success chains and operator Run Pipeline roots', () => {
    const checklist = buildChecklist('app-1', {
      intent: 'wait for a reply before acting',
      workflows: [
        wf('contact'),
        { ...wf('reply', ['contact']), trigger: 'inbound human reply', activation: 'event' as const },
      ],
      conversation: true,
      collections: [],
      cast: [],
    });
    const compile = checklist.find((step) => step.id === 'compile_workflow_rules');
    expect(compile?.args).toMatchObject({ workflows: [
      { workflowId: '${workflows.contact.workflowId}', dependsOn: [], operatorEntrypoint: true },
      { workflowId: '${workflows.reply.workflowId}', dependsOn: [], operatorEntrypoint: false },
    ] });
  });
});
