/**
 * Workflow readiness — connector-agnostic, plain-language setup detection.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import type { WorkflowGraph } from '@agentis/core';
import { analyzeWorkflowReadiness } from '../../src/services/workflowReadiness.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
const prevEnv = process.env.ACME_CRM_API_KEY;

beforeEach(async () => {
  ctx = await createTestContext();
  delete process.env.ACME_CRM_API_KEY;
});
afterEach(() => {
  ctx.close();
  if (prevEnv === undefined) delete process.env.ACME_CRM_API_KEY;
  else process.env.ACME_CRM_API_KEY = prevEnv;
});

function graphWith(...nodes: Array<{ id: string; title: string; config: Record<string, unknown> }>): WorkflowGraph {
  return {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: nodes.map((n) => ({ id: n.id, type: (n.config.kind as string) ?? 'integration', title: n.title, position: { x: 0, y: 0 }, config: n.config as never })),
    edges: [],
  };
}

function seedCredential(type: string) {
  ctx.db.insert(schema.credentials).values({
    id: randomUUID(),
    workspaceId: ctx.workspace.id,
    userId: ctx.user.id,
    name: `${type} cred`,
    credentialType: type,
    encryptedValue: 'x',
  }).run();
}

function seedAgent(name: string, adapterType: string, config: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  ctx.db.insert(schema.agents).values({
    id: randomUUID(),
    workspaceId: ctx.workspace.id,
    userId: ctx.user.id,
    name,
    adapterType,
    config,
    status: 'offline',
    createdAt: now,
    updatedAt: now,
  }).run();
}

describe('analyzeWorkflowReadiness', () => {
  it('flags an integration with no credential, in plain language', () => {
    const graph = graphWith({ id: 'crm', title: 'Create CRM Lead', config: { kind: 'integration', integrationId: 'acme_crm', operationId: 'create_lead' } });
    const r = analyzeWorkflowReadiness(ctx.db, ctx.workspace.id, graph);
    expect(r.ready).toBe(false);
    expect(r.requirements).toHaveLength(1);
    expect(r.requirements[0]).toMatchObject({ nodeId: 'crm', kind: 'credential', integration: 'acme_crm' });
    expect(r.requirements[0]!.message).toContain('Create CRM Lead');
    expect(r.summary).toContain('Before this can run');
  });

  it('is satisfied when the node already references a credential', () => {
    const graph = graphWith({ id: 'crm', title: 'Create CRM Lead', config: { kind: 'integration', integrationId: 'acme_crm', operationId: 'create_lead', credentialId: randomUUID() } });
    expect(analyzeWorkflowReadiness(ctx.db, ctx.workspace.id, graph).ready).toBe(true);
  });

  it('is satisfied when the workspace holds a credential of that type', () => {
    seedCredential('acme_crm');
    const graph = graphWith({ id: 'crm', title: 'Create CRM Lead', config: { kind: 'integration', integrationId: 'acme_crm', operationId: 'create_lead' } });
    expect(analyzeWorkflowReadiness(ctx.db, ctx.workspace.id, graph).ready).toBe(true);
  });

  it('is satisfied by a conventional env fallback', () => {
    process.env.ACME_CRM_API_KEY = 'token';
    const graph = graphWith({ id: 'crm', title: 'Create CRM Lead', config: { kind: 'integration', integrationId: 'acme_crm', operationId: 'create_lead' } });
    expect(analyzeWorkflowReadiness(ctx.db, ctx.workspace.id, graph).ready).toBe(true);
  });

  it('flags an http_request that needs auth', () => {
    const graph = graphWith({ id: 'h', title: 'Call Partner API', config: { kind: 'http_request', url: 'https://x', method: 'POST', auth: { type: 'bearer' } } });
    const r = analyzeWorkflowReadiness(ctx.db, ctx.workspace.id, graph);
    expect(r.ready).toBe(false);
    expect(r.requirements[0]!.message).toContain('Call Partner API');
  });

  it('reports ready for a purely-local workflow', () => {
    const graph = graphWith(
      { id: 'T', title: 'Trigger', config: { kind: 'trigger', triggerType: 'manual' } },
      { id: 'x', title: 'Transform', config: { kind: 'transform', expression: '{}' } },
      { id: 'o', title: 'Return', config: { kind: 'return_output' } },
    );
    const r = analyzeWorkflowReadiness(ctx.db, ctx.workspace.id, graph);
    expect(r.ready).toBe(true);
    expect(r.summary).toBe('This workflow is ready to run.');
  });

  it('flags an agent node requiring native browser when no runtime can provide it, steering to a Browser node', () => {
    seedAgent('Claude', 'claude_code');
    const graph = graphWith({ id: 'a', title: 'Qualify Candidate', config: { kind: 'agent_task', prompt: 'x', requires: { browser: true } } });
    const r = analyzeWorkflowReadiness(ctx.db, ctx.workspace.id, graph);
    expect(r.ready).toBe(false);
    expect(r.requirements[0]).toMatchObject({ nodeId: 'a', kind: 'config' });
    expect(r.requirements[0]!.message).toContain('Browser node');
  });

  it('points at the enablable Codex runtime when one exists', () => {
    seedAgent('Codex', 'codex');
    const graph = graphWith({ id: 'a', title: 'Qualify Candidate', config: { kind: 'agent_task', prompt: 'x', requires: { browser: true } } });
    const r = analyzeWorkflowReadiness(ctx.db, ctx.workspace.id, graph);
    expect(r.ready).toBe(false);
    expect(r.requirements[0]!.message).toContain('Codex');
    expect(r.requirements[0]!.message).toContain('Enable');
  });

  it('is satisfied when a runtime is already configured for the required affordance', () => {
    seedAgent('OpenClaw', 'openclaw');
    const graph = graphWith({ id: 'a', title: 'Qualify Candidate', config: { kind: 'agent_task', prompt: 'x', requires: { browser: true } } });
    expect(analyzeWorkflowReadiness(ctx.db, ctx.workspace.id, graph).ready).toBe(true);
  });

  it('treats a fileSystem-only requirement as satisfiable by the platform loop', () => {
    const graph = graphWith({ id: 'a', title: 'Summarize', config: { kind: 'agent_task', prompt: 'x', requires: { fileSystem: true } } });
    expect(analyzeWorkflowReadiness(ctx.db, ctx.workspace.id, graph).ready).toBe(true);
  });
});
