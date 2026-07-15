import { describe, expect, it } from 'vitest';
import type { WorkflowGraph } from '@agentis/core';
import { validateAppConformance, type AppDoctorSnapshot } from '../../src/services/app/appDoctor.js';

const trigger = (triggerType = 'manual'): WorkflowGraph['nodes'][number] => ({
  id: `trigger-${triggerType}`,
  type: 'trigger',
  title: `${triggerType} trigger`,
  position: { x: 0, y: 0 },
  config: { kind: 'trigger', triggerType } as WorkflowGraph['nodes'][number]['config'],
});

const graph = (triggerType = 'manual'): WorkflowGraph => ({
  version: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [trigger(triggerType)],
  edges: [],
});

function snapshot(overrides: Partial<AppDoctorSnapshot> = {}): AppDoctorSnapshot {
  return {
    app: { id: 'app-1', name: 'Generic operations', status: 'active' },
    workflows: [],
    subscriptions: [],
    connections: [],
    collections: [],
    surfaces: [],
    ...overrides,
  };
}

describe('validateAppConformance', () => {
  it('detects a hollow multi-workflow UI that has no executable orchestration rules', () => {
    const report = validateAppConformance(snapshot({
      workflows: [
        { id: 'a', title: 'A', graph: graph(), settings: { appBinding: { order: 0 } }, triggers: [] },
        { id: 'b', title: 'B', graph: graph(), settings: { appBinding: { order: 1 } }, triggers: [] },
      ],
      surfaces: [{ id: 'home', name: 'Home', view: { type: 'OrchestrationPanel' }, actions: [] }],
    }), new Date('2026-01-01T00:00:00.000Z'));

    expect(report.health).toBe('broken');
    expect(report.topology.dependencyEdges).toBe(0);
    expect(report.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      'BINDING_MULTIPLE_STANDALONE_ROOTS',
      'SURFACE_ORCHESTRATION_WITHOUT_RULES',
    ]));
  });

  it('requires accomplished outcomes for success chains and detects disabled upstreams', () => {
    const report = validateAppConformance(snapshot({ workflows: [
      { id: 'a', title: 'Acquire', graph: graph(), settings: { appBinding: { enabled: false } }, triggers: [] },
      { id: 'b', title: 'Use result', graph: graph(), settings: { appBinding: { dependsOn: ['a'], chainOn: 'success' } }, triggers: [] },
    ] }));
    expect(report.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      'BINDING_DISABLED_UPSTREAM',
      'OUTCOME_CHAIN_USES_COMPLETION',
    ]));
  });

  it('checks authored unattended triggers against deployed activation state', () => {
    const report = validateAppConformance(snapshot({ workflows: [
      { id: 'a', title: 'Listener', graph: graph('webhook'), settings: {}, triggers: [] },
      { id: 'b', title: 'Schedule', graph: graph('cron'), settings: {}, triggers: [{ id: 't-1', triggerType: 'cron', status: 'paused' }] },
    ] }));
    expect(report.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      'ACTIVATION_TRIGGER_NOT_DEPLOYED',
      'ACTIVATION_TRIGGER_NOT_ACTIVE',
    ]));
    expect(report.readyForUnattended).toBe(false);
  });

  it('distinguishes completion events from accomplished business outcomes', () => {
    const report = validateAppConformance(snapshot({
      workflows: [
        { id: 'a', title: 'A', graph: graph(), settings: {}, triggers: [] },
        { id: 'b', title: 'B', graph: graph(), settings: {}, triggers: [] },
      ],
      subscriptions: [
        { id: 'legacy', sourceWorkflowId: 'a', targetWorkflowId: 'b', eventType: 'run.completed', enabled: true },
        { id: 'business', sourceWorkflowId: 'a', targetWorkflowId: 'b', eventType: 'run.accomplished', enabled: true },
      ],
    }));
    const findings = report.findings.filter((finding) => finding.code === 'OUTCOME_EVENT_USES_COMPLETION');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.evidence).toMatchObject({ eventType: 'run.completed', accomplishedEvent: 'run.accomplished' });
  });

  it('validates conversation workflow references, mappings, collection, and channel binding generically', () => {
    const script = {
      version: 1,
      contactCollection: 'subject_state',
      initialStage: 'waiting',
      stages: [
        { id: 'waiting', entry: { kind: 'none' }, onReply: { kind: 'goto', stage: 'work' } },
        { id: 'work', entry: { kind: 'run_workflow', workflowId: 'worker', inputsFrom: { item: "facts.id + ':suffix'", extra: 'facts.extra' } }, onComplete: { stage: 'done' } },
        { id: 'done', terminal: true },
      ],
    };
    const workerGraph = graph();
    workerGraph.inputContract = { fields: [{ key: 'item', type: 'string', required: true }] };
    const report = validateAppConformance(snapshot({
      workflows: [{ id: 'worker', title: 'Worker', graph: workerGraph, settings: {}, triggers: [] }],
      collections: [{ name: 'conversation_script', schema: { fields: [{ key: 'script' }] }, records: [{ id: 'script-1', data: { script } }] }],
    }));
    expect(report.topology.conversationTransitions).toBe(2);
    expect(report.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      'STATE_CONTACT_COLLECTION_MISSING',
      'STATE_INPUT_SOURCE_NOT_A_PATH',
      'STATE_INPUT_TARGET_UNDECLARED',
      'CONNECTION_STATE_MACHINE_UNBOUND',
    ]));
  });

  it('accepts a real dependency rule backed by a valid outcome contract', () => {
    const validSpec = {
      version: 1,
      objective: 'Produce a verifiable result',
      acceptance: [{ id: 'result', claim: 'result exists', verify: 'expr', expr: 'output.ok == true' }],
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const report = validateAppConformance(snapshot({
      workflows: [
        { id: 'a', title: 'A', graph: graph(), settings: { spec: validSpec }, triggers: [] },
        { id: 'b', title: 'B', graph: graph(), settings: { appBinding: { dependsOn: ['a'] } }, triggers: [] },
      ],
      surfaces: [{ id: 'home', name: 'Home', view: { type: 'OrchestrationPanel' }, actions: [] }],
    }));
    expect(report.summary.executableRules).toBe(1);
    expect(report.findings.map((finding) => finding.code)).not.toContain('SURFACE_ORCHESTRATION_WITHOUT_RULES');
    expect(report.findings.map((finding) => finding.code)).not.toContain('OUTCOME_CHAIN_USES_COMPLETION');
  });
});
