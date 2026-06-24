/**
 * resolveResponsibleSpecialist — deterministic owner → subdomain → domain precedence.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { resolveResponsibleSpecialist } from '../../src/services/responsibleSpecialist.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

function seedAgent(name: string, role: string): string {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({
    id, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
    name, adapterType: 'http', capabilityTags: [], config: {}, status: 'offline', role,
  }).run();
  return id;
}

function seedDomain(name: string, opts: { managerId?: string; parentDomainId?: string } = {}): string {
  const id = randomUUID();
  ctx.db.insert(schema.domains).values({
    id, workspaceId: ctx.workspace.id, userId: ctx.user.id,
    name, slug: name.toLowerCase(), managerId: opts.managerId ?? null, parentDomainId: opts.parentDomainId ?? null,
  }).run();
  return id;
}

function seedWorkflow(opts: { ownerAgentId?: string; spaceId?: string; appId?: string } = {}): string {
  const id = randomUUID();
  ctx.db.insert(schema.workflows).values({
    id, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
    title: 'WF', graph: { version: 1, nodes: [], edges: [] }, settings: {},
    ownerAgentId: opts.ownerAgentId ?? null, spaceId: opts.spaceId ?? null, appId: opts.appId ?? null,
  }).run();
  return id;
}

function seedApp(opts: { ownerAgentId?: string; spaceId?: string } = {}): string {
  const id = randomUUID();
  ctx.db.insert(schema.apps).values({
    id, workspaceId: ctx.workspace.id, slug: `app-${id.slice(0, 8)}`, name: 'App', createdBy: ctx.user.id,
    ownerAgentId: opts.ownerAgentId ?? null, spaceId: opts.spaceId ?? null,
  }).run();
  return id;
}

describe('resolveResponsibleSpecialist', () => {
  it('prefers the workflow owner', () => {
    const owner = seedAgent('SEO Specialist', 'specialist');
    const manager = seedAgent('Marketing Lead', 'manager');
    const marketing = seedDomain('Marketing', { managerId: manager });
    const seo = seedDomain('SEO', { managerId: seedAgent('Other', 'specialist'), parentDomainId: marketing });
    const wf = seedWorkflow({ ownerAgentId: owner, spaceId: seo });

    expect(resolveResponsibleSpecialist(ctx.db, ctx.workspace.id, { workflowId: wf }))
      .toEqual({ agentId: owner, via: 'owner' });
  });

  it('falls back to the subdomain specialist when the workflow has no owner', () => {
    const specialist = seedAgent('SEO Specialist', 'specialist');
    const manager = seedAgent('Marketing Lead', 'manager');
    const marketing = seedDomain('Marketing', { managerId: manager });
    const seo = seedDomain('SEO', { managerId: specialist, parentDomainId: marketing });
    const wf = seedWorkflow({ spaceId: seo });

    expect(resolveResponsibleSpecialist(ctx.db, ctx.workspace.id, { workflowId: wf }))
      .toEqual({ agentId: specialist, via: 'subdomain' });
  });

  it('tags a top-level domain manager as the domain fallback (not a specialist)', () => {
    const manager = seedAgent('Marketing Lead', 'manager');
    const marketing = seedDomain('Marketing', { managerId: manager });
    const wf = seedWorkflow({ spaceId: marketing });

    expect(resolveResponsibleSpecialist(ctx.db, ctx.workspace.id, { workflowId: wf }))
      .toEqual({ agentId: manager, via: 'domain' });
  });

  it('inherits the owning App\'s specialist owner when the workflow has none', () => {
    const appOwner = seedAgent('App Operator', 'specialist');
    const app = seedApp({ ownerAgentId: appOwner });
    const wf = seedWorkflow({ appId: app });

    expect(resolveResponsibleSpecialist(ctx.db, ctx.workspace.id, { workflowId: wf }))
      .toEqual({ agentId: appOwner, via: 'app' });
  });

  it('inherits the owning App\'s subdomain specialist when neither workflow nor App is owner-pinned', () => {
    const specialist = seedAgent('SEO Specialist', 'specialist');
    const manager = seedAgent('Marketing Lead', 'manager');
    const marketing = seedDomain('Marketing', { managerId: manager });
    const seo = seedDomain('SEO', { managerId: specialist, parentDomainId: marketing });
    const app = seedApp({ spaceId: seo });
    const wf = seedWorkflow({ appId: app });

    expect(resolveResponsibleSpecialist(ctx.db, ctx.workspace.id, { workflowId: wf }))
      .toEqual({ agentId: specialist, via: 'subdomain' });
  });

  it('prefers the workflow\'s own assignment over the owning App', () => {
    const wfOwner = seedAgent('WF Owner', 'specialist');
    const appOwner = seedAgent('App Owner', 'specialist');
    const app = seedApp({ ownerAgentId: appOwner });
    const wf = seedWorkflow({ ownerAgentId: wfOwner, appId: app });

    expect(resolveResponsibleSpecialist(ctx.db, ctx.workspace.id, { workflowId: wf }))
      .toEqual({ agentId: wfOwner, via: 'owner' });
  });

  it('returns null when nothing is responsible', () => {
    const wf = seedWorkflow({});
    expect(resolveResponsibleSpecialist(ctx.db, ctx.workspace.id, { workflowId: wf })).toBeNull();
  });
});
