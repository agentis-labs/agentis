import { beforeEach, describe, expect, it } from 'vitest';
import { REALTIME_EVENTS } from '@agentis/core';
import { AppStore } from '@agentis/app';
import { BuildSessionService, validateAppBlueprint } from '../../src/services/buildSessionService.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });

const topology = {
  roles: [{ key: 'lead', role: 'Operator', durable: true as const, skillIds: [], brainIds: [] }],
  swarms: [{
    key: 'audit-workers',
    purpose: 'Inspect independent partitions',
    workerRole: 'Auditor',
    maxWorkers: 3,
    skillIds: [],
    brainIds: [],
    persist: 'evidence_only' as const,
  }],
  workflows: [{
    key: 'audit',
    title: 'Audit',
    purpose: 'Inspect inputs',
    dependsOn: [],
    activation: 'operator' as const,
    ownerRoleKey: 'lead',
    swarmKey: 'audit-workers',
    inputs: [{ key: 'scope', type: 'string' as const, required: true }],
    outputs: [{ key: 'findings', type: 'array' as const }],
    acceptanceCriteria: ['A persisted findings artifact exists.'],
  }],
  collections: [{ key: 'findings', purpose: 'Durable audit evidence' }],
  interfaces: [{ key: 'operations', title: 'Operations', purpose: 'Review verified findings' }],
};

describe('BuildSessionService', () => {
  it('persists a grounded validated blueprint before App materialization', () => {
    const service = new BuildSessionService(ctx.db, ctx.bus);
    const capture = ctx.captureBus();
    const result = service.create({
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      name: 'Audit Operations',
      intent: 'Audit arbitrary workspace resources',
      topology,
      acceptanceCriteria: ['Every finding is traceable to evidence.'],
      capabilityCatalogHash: 'catalog-hash',
    });
    expect(result.blueprint.status).toBe('validated');
    expect(result.blueprint.revision).toBe(1);
    expect(result.session.status).toBe('validated');
    expect(result.session.appId).toBeNull();
    expect(result.session.snapshot.workspaceId).toBe(ctx.workspace.id);
    expect(result.session.snapshot.capabilityCatalogHash).toBe('catalog-hash');
    expect(result.session.evidence[0]?.kind).toBe('snapshot');
    expect(capture.events.some((event) => event.envelope.event === REALTIME_EVENTS.BUILD_SESSION_UPDATED)).toBe(true);
    capture.stop();
  });

  it('blocks invalid or ordinally named blueprints with actionable issues', () => {
    const result = validateAppBlueprint({
      name: 'Builder V2',
      topology: { ...topology, workflows: [{ ...topology.workflows[0]!, dependsOn: ['missing'], acceptanceCriteria: [] }] },
      acceptanceCriteria: [],
    });
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'ORDINAL_FEATURE_NAME',
      'UNKNOWN_DEPENDENCY',
      'MISSING_ACCEPTANCE',
    ]));
  });

  it('settles from compiler evidence and never from chat prose', () => {
    const service = new BuildSessionService(ctx.db, ctx.bus);
    const created = service.create({
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      name: 'Audit Operations',
      intent: 'Audit arbitrary workspace resources',
      topology,
      acceptanceCriteria: ['Every finding is traceable to evidence.'],
    });
    const app = new AppStore(ctx.db).create(ctx.workspace.id, ctx.user.id, { name: 'Audit Operations' });
    service.bindApp(ctx.workspace.id, created.session.id, app.id);
    const blocked = service.settleAppVerification({
      workspaceId: ctx.workspace.id,
      appId: app.id,
      passed: false,
      summary: 'One workflow has no proof.',
      repairAttempted: true,
    });
    expect(blocked?.status).toBe('blocked');
    expect(blocked?.repairAttempts).toBe(1);
    expect(blocked?.diagnostic?.retryable).toBe(false);
    const completed = service.settleAppVerification({
      workspaceId: ctx.workspace.id,
      appId: app.id,
      passed: true,
      summary: 'Compiler gates passed.',
    });
    expect(completed?.status).toBe('completed');
    expect(completed?.stage).toBe('deliver');
    expect(completed?.evidence.at(-1)?.label).toBe('Compiler gates passed.');
  });
});
