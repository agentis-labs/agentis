/**
 * /v1/domains — subdomain nesting + specialist responsibility wiring.
 *
 * Exercises the manager-owned org structure (Phase 1): a Subdomain is a domains
 * row with parent_domain_id set, owned by a responsible specialist whose
 * reports_to is wired to the parent Domain's manager. Also asserts the agents
 * read model surfaces subdomain + parent-domain labels for the canvas.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { buildDomainRoutes } from '../../src/routes/domains.js';
import { buildAgentRoutes } from '../../src/routes/agents.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import { ConversationStore } from '../../src/services/conversationStore.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let adapters: AdapterManager;
let conversations: ConversationStore;

beforeEach(async () => {
  ctx = await createTestContext();
  adapters = new AdapterManager(ctx.logger);
  conversations = new ConversationStore({ db: ctx.db, bus: ctx.bus });
});

function domainsApp() {
  return ctx.buildApp([
    { path: '/v1/domains', app: buildDomainRoutes({ db: ctx.db, auth: ctx.auth, logger: ctx.logger, adapters, bus: ctx.bus }) },
  ]);
}

function agentsApp() {
  return ctx.buildApp([
    { path: '/v1/agents', app: buildAgentRoutes({ db: ctx.db, auth: ctx.auth, vault: ctx.vault, adapters, logger: ctx.logger, conversations }) },
  ]);
}

function seedAgent(name: string, role: string): string {
  const id = randomUUID();
  ctx.db
    .insert(schema.agents)
    .values({
      id,
      workspaceId: ctx.workspace.id,
      ambientId: ctx.ambient.id,
      userId: ctx.user.id,
      name,
      adapterType: 'http',
      capabilityTags: [],
      config: {},
      status: 'offline',
      role,
    })
    .run();
  return id;
}

async function createDomain(body: Record<string, unknown>) {
  const res = await domainsApp().request('/v1/domains', {
    method: 'POST',
    headers: ctx.authHeaders,
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { id: string; parentDomainId: string | null } }).data;
}

describe('subdomains', () => {
  it('nests a subdomain under a parent and reports its specialist to the parent manager', async () => {
    const manager = seedAgent('Marketing Lead', 'manager');
    const specialist = seedAgent('SEO Specialist', 'specialist');

    const marketing = await createDomain({ name: 'Marketing', slug: 'marketing', managerId: manager });
    expect(marketing.parentDomainId).toBeNull();

    const seo = await createDomain({ name: 'SEO', slug: 'seo', managerId: specialist, parentDomainId: marketing.id });
    expect(seo.parentDomainId).toBe(marketing.id);

    const specialistRow = ctx.db.select().from(schema.agents).where(eq(schema.agents.id, specialist)).get();
    expect(specialistRow?.reportsTo).toBe(manager);
    expect(specialistRow?.spaceId).toBe(seo.id);
  });

  it('surfaces subdomain + parent-domain labels in the agents read model', async () => {
    const manager = seedAgent('Marketing Lead', 'manager');
    const specialist = seedAgent('SEO Specialist', 'specialist');
    const marketing = await createDomain({ name: 'Marketing', slug: 'marketing', managerId: manager });
    const seo = await createDomain({ name: 'SEO', slug: 'seo', managerId: specialist, parentDomainId: marketing.id });

    const res = await agentsApp().request('/v1/agents', { headers: ctx.authHeaders });
    const body = (await res.json()) as { agents: Array<Record<string, unknown>> };
    const seoAgent = body.agents.find((a) => a.id === specialist)!;
    expect(seoAgent.subdomainId).toBe(seo.id);
    expect(seoAgent.subdomainName).toBe('SEO');
    expect(seoAgent.domainName).toBe('Marketing');
    expect(seoAgent.managerId).toBe(manager);
  });

  it('removes nested subdomains and detaches agents when the parent domain is deleted', async () => {
    const manager = seedAgent('Marketing Lead', 'manager');
    const specialist = seedAgent('SEO Specialist', 'specialist');
    const marketing = await createDomain({ name: 'Marketing', slug: 'marketing', managerId: manager });
    const seo = await createDomain({ name: 'SEO', slug: 'seo', managerId: specialist, parentDomainId: marketing.id });

    const res = await domainsApp().request(`/v1/domains/${marketing.id}`, { method: 'DELETE', headers: ctx.authHeaders });
    expect(res.status).toBe(200);

    const remaining = ctx.db.select().from(schema.domains).where(eq(schema.domains.workspaceId, ctx.workspace.id)).all();
    expect(remaining.map((d) => d.id)).not.toContain(seo.id);
    expect(remaining.map((d) => d.id)).not.toContain(marketing.id);
    const specialistRow = ctx.db.select().from(schema.agents).where(eq(schema.agents.id, specialist)).get();
    expect(specialistRow?.spaceId).toBeNull();
  });
});
