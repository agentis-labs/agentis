/**
 * ORCHESTRATOR-CREATION-10X §2 — Creation Pipeline (inventory, intent, preflight).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { type WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import {
  buildWorkspaceInventory,
  classifyIntent,
  preflightAndEnrich,
  buildTeamRoster,
  planWorkflow,
} from '../../src/services/creationPipeline.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

function seedCredential(credentialType: string, name: string) {
  ctx.db.insert(schema.credentials).values({
    id: randomUUID(), workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
    name, credentialType, encryptedValue: 'x',
  }).run();
}

function seedAgent(name: string, role: string, status: string) {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({
    id, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
    name, adapterType: 'http', capabilityTags: [], config: {}, status, role,
  }).run();
  return id;
}

describe('buildWorkspaceInventory', () => {
  it('reports agents, wireable integrations, and specialist roles', async () => {
    seedAgent('Mailer', 'ops', 'online');
    seedCredential('gmail', 'team-gmail');
    const inv = await buildWorkspaceInventory({ db: ctx.db }, ctx.workspace.id);
    expect(inv.availableAgents.map((a) => a.name)).toContain('Mailer');
    expect(inv.wireableIntegrations).toContain('gmail');
    expect(inv.configuredCredentials[0]!.integrationSlug).toBe('gmail');
    // Built-in specialists were retired; only custom roles (agents/custom/*.md)
    // are reported — none seeded here, so no built-in 'researcher' appears.
    expect(inv.specialistRoles.find((r) => r.role === 'researcher')).toBeUndefined();
  });

  it('loads independent build enrichments concurrently', async () => {
    const started = new Set<string>();
    let releaseGate!: () => void;
    let allStarted!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const ready = new Promise<void>((resolve) => { allStarted = resolve; });
    const enter = async (name: string) => {
      started.add(name);
      if (started.size === 4) allStarted();
      await gate;
    };
    const build = buildWorkspaceInventory({
      db: ctx.db,
      extensionLibrary: { listSourceFiles: async () => { await enter('extensions'); return []; } },
      knowledgeBases: {
        listKnowledgeBases: () => [{ id: 'kb-1', name: 'KB' }],
        search: async () => { await enter('knowledge'); return []; },
      },
      workspaceIntelligence: { buildContextBlock: async () => { await enter('context'); return ''; } },
      agentLibrary: { listCustomRoles: async () => { await enter('roles'); return []; } },
    } as never, ctx.workspace.id, 'build a workflow');

    await Promise.race([
      ready,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`serialized enrichments: ${[...started].join(',')}`)), 500)),
    ]);
    releaseGate();
    await build;
    expect([...started].sort()).toEqual(['context', 'extensions', 'knowledge', 'roles']);
  });
});

describe('classifyIntent', () => {
  it('classifies a morning digest as orchestrated cron with missing agentmail credential', async () => {
    const inv = await buildWorkspaceInventory({ db: ctx.db }, ctx.workspace.id);
    const c = classifyIntent('Every morning gather the latest AI articles from tech sites, summarize each, and email me a digest.', inv);
    expect(c.triggerType).toBe('cron');
    // Generic "email/digest" routes to AgentMail (agent-native default); explicit "gmail" still routes to Gmail.
    expect(c.requiredIntegrations).toContain('agentmail');
    expect(c.missingCredentials).toContain('agentmail'); // no credential configured
    expect(['orchestrated', 'enterprise']).toContain(c.archetype);
  });

  it('classifies an always-on website watcher as a persistent listener', async () => {
    const inv = await buildWorkspaceInventory({ db: ctx.db }, ctx.workspace.id);
    const c = classifyIntent(
      'Create an extension that constantly watches a website for new AI posts and email me immediately. Run 24/7.',
      inv,
    );
    expect(c.triggerType).toBe('persistent_listener');
  });

  it('escalates a multi-source ensemble request to enterprise', async () => {
    const inv = await buildWorkspaceInventory({ db: ctx.db }, ctx.workspace.id);
    const c = classifyIntent('Monitor patent registries, GitHub commits, community threads and hiring boards; use an ensemble of specialized LLMs to map breakthroughs, scrape competitor codebases, compile a dashboard, and signal my team via Slack.', inv);
    expect(c.archetype).toBe('enterprise');
    expect(c.requiresPlanConfirmation).toBe(true);
  });

  it('treats a one-liner as atomic/pipeline', async () => {
    const inv = await buildWorkspaceInventory({ db: ctx.db }, ctx.workspace.id);
    const c = classifyIntent('Show hello world', inv);
    expect(['atomic', 'pipeline']).toContain(c.archetype);
  });
});

describe('planWorkflow', () => {
  it('decomposes a digest request into gather/analyze/draft/deliver phases', async () => {
    const inv = await buildWorkspaceInventory({ db: ctx.db }, ctx.workspace.id);
    const desc = 'Every morning gather AI articles from tech sites, score them, write a digest and email me the top 5.';
    const plan = planWorkflow(desc, classifyIntent(desc, inv));
    const names = plan.phases.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['Gather Sources', 'Analyze & Score', 'Draft Output', 'Deliver']));
    expect(plan.missingDependencies).toContain('agentmail');
    expect(plan.phases.find((p) => p.name === 'Gather Sources')!.agentRole).toBe('researcher');
    expect(plan.question).toMatch(/agentmail/);
  });
});

describe('preflightAndEnrich', () => {
  const base = (nodes: WorkflowGraph['nodes'], edges: WorkflowGraph['edges']): WorkflowGraph =>
    ({ version: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes, edges });

  it('binds a credential from inventory to an integration node missing one', async () => {
    seedCredential('gmail', 'team-gmail');
    const inv = await buildWorkspaceInventory({ db: ctx.db }, ctx.workspace.id);
    const graph = base(
      [
        { id: 'T', type: 'trigger', title: 'M', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'mail', type: 'integration', title: 'Email', position: { x: 200, y: 0 }, config: { kind: 'integration', integrationId: 'gmail', operationId: 'send_email', inputs: {} } },
        { id: 'R', type: 'return_output', title: 'Out', position: { x: 400, y: 0 }, config: { kind: 'return_output', renderAs: 'json' } },
      ],
      [{ id: 'e1', source: 'T', target: 'mail' }, { id: 'e2', source: 'mail', target: 'R' }],
    );
    const res = preflightAndEnrich(graph, inv);
    const mail = res.graph.nodes.find((n) => n.id === 'mail')!;
    expect((mail.config as { credentialId?: string }).credentialId).toBeTruthy();
    expect(res.warnings.find((w) => w.code === 'CREDENTIAL_REQUIRED')).toBeUndefined();
  });

  it('warns CREDENTIAL_REQUIRED when no credential exists', async () => {
    const inv = await buildWorkspaceInventory({ db: ctx.db }, ctx.workspace.id);
    const graph = base(
      [
        { id: 'T', type: 'trigger', title: 'M', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'mail', type: 'integration', title: 'Email', position: { x: 200, y: 0 }, config: { kind: 'integration', integrationId: 'gmail', operationId: 'send_email', inputs: {} } },
        { id: 'R', type: 'return_output', title: 'Out', position: { x: 400, y: 0 }, config: { kind: 'return_output', renderAs: 'json' } },
      ],
      [{ id: 'e1', source: 'T', target: 'mail' }, { id: 'e2', source: 'mail', target: 'R' }],
    );
    const res = preflightAndEnrich(graph, inv);
    expect(res.warnings.some((w) => w.code === 'CREDENTIAL_REQUIRED')).toBe(true);
  });

  it('adds a terminal return_output when none exists', async () => {
    const inv = await buildWorkspaceInventory({ db: ctx.db }, ctx.workspace.id);
    const graph = base(
      [
        { id: 'T', type: 'trigger', title: 'M', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'X', type: 'transform', title: 'Shape', position: { x: 200, y: 0 }, config: { kind: 'transform', expression: '({ ok: true })' } },
      ],
      [{ id: 'e1', source: 'T', target: 'X' }],
    );
    const res = preflightAndEnrich(graph, inv);
    expect(res.graph.nodes.some((n) => n.config.kind === 'return_output')).toBe(true);
    expect(res.warnings.some((w) => w.code === 'MISSING_OUTPUT')).toBe(true);
  });

  it('flags CAPABILITY_MISMATCH when a role lacks the needed tool', async () => {
    const inv = await buildWorkspaceInventory({ db: ctx.db }, ctx.workspace.id);
    const graph = base(
      [
        { id: 'T', type: 'trigger', title: 'M', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        // A specialist gets the universal floor but NOT file/git tools; a task
        // that must write a file needs write_file, which is outside that floor.
        { id: 'A', type: 'agent_task', title: 'Export report', position: { x: 200, y: 0 }, config: { kind: 'agent_task', agentRole: 'writer', capabilityTags: [], prompt: 'save file with the final report in the workspace', inputKeys: [], outputKeys: [] } },
        { id: 'R', type: 'return_output', title: 'Out', position: { x: 400, y: 0 }, config: { kind: 'return_output', renderAs: 'json' } },
      ],
      [{ id: 'e1', source: 'T', target: 'A' }, { id: 'e2', source: 'A', target: 'R' }],
    );
    const res = preflightAndEnrich(graph, inv);
    const mismatch = res.warnings.find((w) => w.code === 'CAPABILITY_MISMATCH');
    expect(mismatch).toBeTruthy();
    expect(mismatch!.message).toMatch(/lacks write_file/);
  });

  it('flags agent_task nodes that bury source work inside language work', async () => {
    const inv = await buildWorkspaceInventory({ db: ctx.db }, ctx.workspace.id);
    const graph = base(
      [
        { id: 'T', type: 'trigger', title: 'M', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'A', type: 'agent_task', title: 'Fetch and summarize stories', position: { x: 200, y: 0 }, config: { kind: 'agent_task', agentRole: 'researcher', capabilityTags: [], prompt: 'Scrape Hacker News and summarize the top 3 AI stories.', inputKeys: [], outputKeys: [] } },
        { id: 'R', type: 'return_output', title: 'Out', position: { x: 400, y: 0 }, config: { kind: 'return_output', renderAs: 'json' } },
      ],
      [{ id: 'e1', source: 'T', target: 'A' }, { id: 'e2', source: 'A', target: 'R' }],
    );
    const res = preflightAndEnrich(graph, inv);
    const grammar = res.warnings.find((w) => w.code === 'GRAMMAR_VIOLATION');
    expect(grammar).toBeTruthy();
    expect(grammar!.message).toMatch(/Rule 1/);
  });

  it('buildTeamRoster lists cast roles with offline status + fallback', async () => {
    const inv = await buildWorkspaceInventory({ db: ctx.db }, ctx.workspace.id);
    const graph = base(
      [
        { id: 'T', type: 'trigger', title: 'M', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'A', type: 'agent_task', title: 'Research', position: { x: 200, y: 0 }, config: { kind: 'agent_task', agentRole: 'researcher', capabilityTags: [], prompt: 'research', inputKeys: [], outputKeys: [] } },
      ],
      [{ id: 'e1', source: 'T', target: 'A' }],
    );
    const roster = buildTeamRoster(graph, inv);
    const r = roster.find((m) => m.role === 'researcher')!;
    expect(r.status).toBe('offline'); // no online researcher agent
    expect(r.fallback).toBe('writer');
    expect(r.tools).toContain('read_url');
  });

  it('flags an unbound agent_task', async () => {
    const inv = await buildWorkspaceInventory({ db: ctx.db }, ctx.workspace.id);
    const graph = base(
      [
        { id: 'T', type: 'trigger', title: 'M', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'A', type: 'agent_task', title: 'Do', position: { x: 200, y: 0 }, config: { kind: 'agent_task', capabilityTags: [], prompt: 'go', inputKeys: [], outputKeys: [] } },
        { id: 'R', type: 'return_output', title: 'Out', position: { x: 400, y: 0 }, config: { kind: 'return_output', renderAs: 'json' } },
      ],
      [{ id: 'e1', source: 'T', target: 'A' }, { id: 'e2', source: 'A', target: 'R' }],
    );
    const res = preflightAndEnrich(graph, inv);
    expect(res.warnings.some((w) => w.code === 'AGENT_UNBOUND')).toBe(true);
  });
});
