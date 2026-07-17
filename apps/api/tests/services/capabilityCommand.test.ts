/**
 * Capability plane + Command Model — reach and comprehension
 * (AUTONOMOUS-ORCHESTRATOR-COMMAND-MODEL).
 *
 * Proves: the index maps the workspace (incl. deep node/phase atoms) and finds by
 * meaning; the router resolves URNs to real delegations (incl. deep-node replay);
 * scope resolves an agent to what it manages; and the Command Model fuses scoped
 * inventory + progress/deltas into a manager briefing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import { CapabilityIndex } from '../../src/services/capability/capabilityIndex.js';
import { CapabilityRouter } from '../../src/services/capability/capabilityRouter.js';
import { resolveCommandScope } from '../../src/services/command/commandScope.js';
import { CommandModelService } from '../../src/services/command/commandModel.js';
import { CommandHeartbeat, isWorkspaceAutonomyEnabled, setWorkspaceAutonomy } from '../../src/services/command/commandHeartbeat.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

const ws = () => ctx.workspace.id;

function seedAgent(name: string, role: string): string {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({ id, workspaceId: ws(), userId: ctx.user.id, name, role, adapterType: 'http', status: 'online' }).run();
  return id;
}
function seedDomain(name: string, managerId: string): string {
  const id = randomUUID();
  ctx.db.insert(schema.domains).values({ id, workspaceId: ws(), userId: ctx.user.id, name, slug: `${name.toLowerCase().replace(/\s+/g, '-')}-${id.slice(0, 6)}`, managerId }).run();
  return id;
}
function seedApp(name: string, opts: { ownerAgentId?: string; spaceId?: string } = {}): string {
  const id = randomUUID();
  ctx.db.insert(schema.apps).values({ id, workspaceId: ws(), slug: name.toLowerCase().replace(/\s+/g, '-'), name, createdBy: ctx.user.id, ...(opts.ownerAgentId ? { ownerAgentId: opts.ownerAgentId } : {}), ...(opts.spaceId ? { spaceId: opts.spaceId } : {}) }).run();
  return id;
}
function seedWorkflow(title: string, opts: { appId?: string; ownerAgentId?: string; outputLabels?: string[] } = {}): string {
  const id = randomUUID();
  const graph = {
    version: 1,
    nodes: [
      { id: 'trigger', type: 'trigger', title: 'Start', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      { id: 'qualify', type: 'agent_task', title: 'Qualify Leads', position: { x: 1, y: 0 }, config: { kind: 'agent_task' } },
      { id: 'out', type: 'return_output', title: 'Return', position: { x: 2, y: 0 }, config: { kind: 'return_output' } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'qualify' },
      { id: 'e2', source: 'qualify', target: 'out' },
    ],
    inputContract: { fields: [{ key: 'text', type: 'string', required: true }] },
    phases: [{ id: 'enrich', name: 'Enrichment', color: '#000', nodeIds: ['qualify'] }],
  };
  ctx.db.insert(schema.workflows).values({ id, workspaceId: ws(), userId: ctx.user.id, title, description: `${title} flow`, graph, ...(opts.appId ? { appId: opts.appId } : {}), ...(opts.ownerAgentId ? { ownerAgentId: opts.ownerAgentId } : {}), ...(opts.outputLabels ? { settings: { outputLabels: opts.outputLabels } } : {}) }).run();
  return id;
}
function seedRun(workflowId: string, status: string, opts: { failed?: boolean; createdAt?: string } = {}): string {
  const id = randomUUID();
  const runState = opts.failed
    ? { nodeStates: { qualify: { status: 'FAILED', error: 'rate limited' } }, completedNodeIds: [] }
    : { nodeStates: {}, completedNodeIds: ['qualify'] };
  ctx.db.insert(schema.workflowRuns).values({ id, workspaceId: ws(), workflowId, userId: ctx.user.id, status, runState, ...(opts.createdAt ? { createdAt: opts.createdAt } : {}) }).run();
  return id;
}

describe('CapabilityIndex', () => {
  it('manifest counts apps/workflows/nodes/phases/agents; search finds a deep node by meaning', async () => {
    seedAgent('Ada', 'worker');
    const app = seedApp('CRM');
    seedWorkflow('Lead Intake', { appId: app });
    const index = new CapabilityIndex({ db: ctx.db, logger: ctx.logger });

    const m = index.manifest(ws());
    expect(m.counts.app).toBe(1);
    expect(m.counts.workflow).toBe(1);
    expect(m.counts.node).toBe(1); // trigger + return_output are noise; only "qualify"
    expect(m.counts.phase).toBe(1);
    expect(m.counts.agent).toBe(1);
    expect(index.manifestBlock(ws())).toContain('CAPABILITY MANIFEST');

    // No embedding provider → deterministic lexical path.
    const hits = await index.search(ws(), 'qualify leads', { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.kind === 'node' && /qualify/i.test(h.title))).toBe(true);
  });

  it('indexes mounted MCP tools as mcp_tool atoms so the advertised filter is truthful', async () => {
    seedApp('CRM');
    const index = new CapabilityIndex({
      db: ctx.db,
      logger: ctx.logger,
      mcpTools: async () => [
        { id: 'supabase__query', serverName: 'Supabase', toolName: 'query', description: 'Run a SQL query', provides: 'database' },
        { id: 'supabase__insert', serverName: 'Supabase', toolName: 'insert' },
      ],
    });

    // First search warms + includes the MCP snapshot; the mcp_tool filter returns real tools.
    const hits = await index.search(ws(), 'run a sql query', { kind: 'mcp_tool', limit: 5 });
    expect(hits.length).toBe(2);
    expect(hits.every((h) => h.kind === 'mcp_tool')).toBe(true);
    expect(hits.some((h) => /Supabase.*query/.test(h.title))).toBe(true);
    // A cold snapshot must never throw when no resolver is configured.
    const bare = new CapabilityIndex({ db: ctx.db, logger: ctx.logger });
    expect(await bare.search(ws(), 'anything', { kind: 'mcp_tool' })).toEqual([]);
  });

  it('renders a mounted-connections block naming live MCP servers + credentialed integrations', async () => {
    const index = new CapabilityIndex({
      db: ctx.db,
      logger: ctx.logger,
      mcpTools: async () => [
        { id: 'supabase__query', serverName: 'Supabase', toolName: 'query' },
      ],
      configuredIntegrations: () => ({ configured: ['Vercel'], available: ['Stripe', 'Notion'] }),
    });

    const block = await index.mountedConnectionsBlock(ws());
    expect(block).toContain('MOUNTED CONNECTIONS');
    expect(block).toContain('Supabase');
    expect(block).toContain('agentis.mcp.call');
    expect(block).toContain('Vercel');
    expect(block).toContain('agentis.integration.call');
    expect(block).toContain('Stripe'); // available-but-not-credentialed still surfaced

    // Nothing mounted or configured → empty block, no prompt noise.
    const empty = new CapabilityIndex({ db: ctx.db, logger: ctx.logger });
    expect(await empty.mountedConnectionsBlock(ws())).toBe('');
  });

  it('domain scope boosts the caller\'s own workflows first (soft, never filters)', async () => {
    const mgr = seedAgent('Mira', 'manager');
    const dom = seedDomain('Marketing', mgr);
    const mineApp = seedApp('Mine', { ownerAgentId: mgr, spaceId: dom });
    const mine = seedWorkflow('Lead Intake', { appId: mineApp });
    const theirs = seedWorkflow('Lead Intake'); // identical title, out of scope
    const index = new CapabilityIndex({ db: ctx.db, logger: ctx.logger });

    const scoped = await index.search(ws(), 'lead intake', { kind: 'workflow', limit: 5, scope: { appIds: [mineApp], workflowIds: [mine] } });
    expect(scoped[0]?.workflowId).toBe(mine); // the manager's own ranks first
    // Still reaches everything — the out-of-scope twin is present, just lower.
    expect(scoped.map((h) => h.workflowId).sort()).toEqual([mine, theirs].sort());
  });
});

describe('CapabilityRouter', () => {
  it('resolves URNs to real delegations, incl. deep-node replay and honest guidance', () => {
    const agent = seedAgent('Rex', 'worker');
    const wf = seedWorkflow('Lead Intake');
    const router = new CapabilityRouter({ db: ctx.db, logger: ctx.logger });

    // whole workflow → workflow.run
    const wfRes = router.resolveInvoke(ws(), `wf:${wf}`, { text: 'hi' });
    expect(wfRes.ok).toBe(true);
    if (wfRes.ok) { expect(wfRes.plan.toolId).toBe('agentis.workflow.run'); expect(wfRes.plan.arguments.workflowId).toBe(wf); }

    // deep node with NO prior run → grounded guidance, not a silent wrong action
    const noRun = router.resolveInvoke(ws(), `wf:${wf}/node:qualify`, {});
    expect(noRun.ok).toBe(false);
    if (!noRun.ok) expect(noRun.guidance).toMatch(/run the whole workflow|upstream/i);

    // deep node WITH a run → replay-from-node
    const run = seedRun(wf, 'COMPLETED');
    const nodeRes = router.resolveInvoke(ws(), `wf:${wf}/node:qualify`, {});
    expect(nodeRes.ok).toBe(true);
    if (nodeRes.ok) {
      expect(nodeRes.plan.toolId).toBe('agentis.run.replay');
      expect(nodeRes.plan.arguments).toMatchObject({ mode: 'replay-from-node', targetNodeId: 'qualify', sourceRunId: run });
    }

    // phase → replay from its entry node (qualify)
    const phaseRes = router.resolveInvoke(ws(), `wf:${wf}/phase:enrich`, {});
    expect(phaseRes.ok).toBe(true);
    if (phaseRes.ok) expect(phaseRes.plan.arguments.targetNodeId).toBe('qualify');

    // agent → dispatch (needs a task)
    expect(router.resolveInvoke(ws(), `agent:${agent}`, {}).ok).toBe(false);
    const agentRes = router.resolveInvoke(ws(), `agent:${agent}`, { task: 'summarize the pipeline' });
    expect(agentRes.ok).toBe(true);
    if (agentRes.ok) { expect(agentRes.plan.toolId).toBe('agentis.agent.dispatch'); expect(agentRes.plan.arguments).toMatchObject({ agentId: agent, task: 'summarize the pipeline' }); }

    // mcp tool → mcp.call with the reconstructed bridge id
    const mcpRes = router.resolveInvoke(ws(), 'mcp:supabase__query', { sql: 'select 1' });
    expect(mcpRes.ok).toBe(true);
    if (mcpRes.ok) { expect(mcpRes.plan.toolId).toBe('agentis.mcp.call'); expect(mcpRes.plan.arguments.tool).toBe('mcp__supabase__query'); }
  });
});

describe('resolveCommandScope', () => {
  it('orchestrator → workspace; a domain manager → its domain inventory', () => {
    const orch = seedAgent('Orchestra', 'orchestrator');
    const mgr = seedAgent('Mira', 'manager');
    const marketing = seedDomain('Marketing', mgr);
    const crm = seedApp('CRM', { ownerAgentId: mgr, spaceId: marketing });
    const intake = seedWorkflow('Lead Intake', { appId: crm });
    seedWorkflow('Unrelated Ops'); // outside the domain

    const orchScope = resolveCommandScope(ctx.db, ws(), orch);
    expect(orchScope.kind).toBe('workspace');

    const mgrScope = resolveCommandScope(ctx.db, ws(), mgr);
    expect(mgrScope.kind).toBe('domain');
    expect(mgrScope.domainNames).toContain('Marketing');
    expect(mgrScope.appIds).toContain(crm);
    expect(mgrScope.workflowIds).toContain(intake);
    expect(mgrScope.workflowIds).not.toContain('Unrelated Ops');
  });
});

describe('CommandModelService', () => {
  it('fuses scoped inventory + progress + deltas into a manager briefing', () => {
    const mgr = seedAgent('Mira', 'manager');
    const marketing = seedDomain('Marketing', mgr);
    const crm = seedApp('CRM', { ownerAgentId: mgr, spaceId: marketing });
    const intake = seedWorkflow('Lead Intake', { appId: crm });
    seedRun(intake, 'COMPLETED');
    seedRun(intake, 'FAILED', { failed: true });

    const svc = new CommandModelService({ db: ctx.db, logger: ctx.logger });
    const model = svc.build(ws(), mgr);
    expect(model.scope.kind).toBe('domain');
    expect(model.inventory.apps).toBe(1);
    expect(model.inventory.workflows).toBe(1);
    expect(model.progress.runsCompleted).toBe(1);
    expect(model.progress.runsFailed).toBe(1);
    expect(model.progress.attention.some((a) => /FAILED/.test(a))).toBe(true);

    const briefing = svc.briefingBlock(ws(), mgr);
    expect(briefing).toContain('COMMAND MODEL');
    expect(briefing).toContain('MANAGER of Marketing');
    expect(briefing).toContain('USE YOUR MIND');

    // Watermark: no delta before review; after review, a NEW run shows in the delta.
    expect(svc.build(ws(), mgr).progress.sinceLastReview).toBeNull();
    svc.markReviewed(ws(), mgr);
    seedRun(intake, 'FAILED', { failed: true, createdAt: new Date(Date.now() + 1500).toISOString() });
    const after = svc.build(ws(), mgr);
    expect(after.progress.sinceLastReview).not.toBeNull();
    expect(after.progress.sinceLastReview!.runsFailed).toBe(1);
  });

  it('heartbeat surfaces manager attention once (deduped), and acts when autonomy is enabled', async () => {
    const mgr = seedAgent('Mira', 'manager');
    const marketing = seedDomain('Marketing', mgr);
    const crm = seedApp('CRM', { ownerAgentId: mgr, spaceId: marketing });
    const intake = seedWorkflow('Lead Intake', { appId: crm });
    seedRun(intake, 'FAILED', { failed: true });
    const commandModel = new CommandModelService({ db: ctx.db, logger: ctx.logger });

    // Surface mode: first tick surfaces the manager's attention, second dedupes.
    const surface = new CommandHeartbeat({ db: ctx.db, logger: ctx.logger, commandModel });
    expect(await surface.tick()).toBe(1);
    expect(await surface.tick()).toBe(0);

    // Autonomy: a NEW failure changes the signature and drives a bounded manager turn.
    const acted: string[] = [];
    const auto = new CommandHeartbeat({
      db: ctx.db, logger: ctx.logger, commandModel,
      autonomyEnabled: () => true,
      runManagerTurn: async ({ agentId }) => { acted.push(agentId); },
    });
    seedRun(intake, 'FAILED', { failed: true, createdAt: new Date(Date.now() + 1000).toISOString() });
    expect(await auto.tick()).toBe(1);
    expect(acted).toContain(mgr);
  });

  it('counts semantic outcomes across 24h/7d/30d windows', () => {
    const mgr = seedAgent('Mira', 'manager');
    const dom = seedDomain('Marketing', mgr);
    const app = seedApp('CRM', { ownerAgentId: mgr, spaceId: dom });
    const wf = seedWorkflow('Lead Intake', { appId: app, outputLabels: ['leads_qualified'] });
    seedRun(wf, 'COMPLETED');                                                                 // within 24h
    seedRun(wf, 'COMPLETED');                                                                 // within 24h
    seedRun(wf, 'COMPLETED', { createdAt: new Date(Date.now() - 3 * 24 * 3600_000).toISOString() }); // 3d ago
    seedRun(wf, 'FAILED', { failed: true });                                                  // no credit
    const svc = new CommandModelService({ db: ctx.db, logger: ctx.logger });
    const model = svc.build(ws(), mgr);
    const count = (win: string) => model.progress.outcomeWindows.find((w) => w.window === win)?.outcomes.find((o) => o.label === 'leads_qualified')?.count ?? 0;
    expect(count('24h')).toBe(2);
    expect(count('7d')).toBe(3);
    expect(count('30d')).toBe(3);
    // Back-compat: `outcomes` is the 7d slice.
    expect(model.progress.outcomes).toContainEqual({ label: 'leads_qualified', count: 3 });
    // Briefing renders the trend line (24h · 7d · 30d).
    expect(svc.briefingBlock(ws(), mgr)).toMatch(/leads_qualified: 2 . 3 . 3/);
  });

  it('orchestrator scope spans the whole workspace', () => {
    const orch = seedAgent('Orchestra', 'orchestrator');
    seedAgent('Ada', 'worker');
    seedApp('CRM');
    seedWorkflow('Lead Intake');
    seedWorkflow('Ops');
    const svc = new CommandModelService({ db: ctx.db, logger: ctx.logger });
    const model = svc.build(ws(), orch);
    expect(model.scope.kind).toBe('workspace');
    expect(model.inventory.scopeLabel).toBe('the entire workspace');
    expect(model.inventory.workflows).toBe(2);
    expect(model.inventory.apps).toBe(1);
  });
});

describe('workspace autonomy opt-in', () => {
  it('is off by default and toggles via setWorkspaceAutonomy', () => {
    expect(isWorkspaceAutonomyEnabled(ctx.db, ws())).toBe(false);
    setWorkspaceAutonomy(ctx.db, ws(), true);
    expect(isWorkspaceAutonomyEnabled(ctx.db, ws())).toBe(true);
    setWorkspaceAutonomy(ctx.db, ws(), false);
    expect(isWorkspaceAutonomyEnabled(ctx.db, ws())).toBe(false);
  });

  it('the heartbeat only acts when the per-workspace gate is on', async () => {
    const mgr = seedAgent('Mira', 'manager');
    const marketing = seedDomain('Marketing', mgr);
    const crm = seedApp('CRM', { ownerAgentId: mgr, spaceId: marketing });
    const intake = seedWorkflow('Lead Intake', { appId: crm });
    seedRun(intake, 'FAILED', { failed: true });
    const commandModel = new CommandModelService({ db: ctx.db, logger: ctx.logger });
    const acted: string[] = [];
    // Master switch ON, but workspace opt-in decides (mirrors bootstrap wiring).
    const hb = new CommandHeartbeat({
      db: ctx.db, logger: ctx.logger, commandModel,
      autonomyEnabled: (workspaceId) => isWorkspaceAutonomyEnabled(ctx.db, workspaceId),
      runManagerTurn: async ({ agentId }) => { acted.push(agentId); },
    });

    // Opt-in OFF → surfaces but does not act.
    expect(await hb.tick()).toBe(1);
    expect(acted).toHaveLength(0);

    // Opt-in ON + a new attention signature → acts.
    setWorkspaceAutonomy(ctx.db, ws(), true);
    seedRun(intake, 'FAILED', { failed: true, createdAt: new Date(Date.now() + 1000).toISOString() });
    expect(await hb.tick()).toBe(1);
    expect(acted).toContain(mgr);
  });
});
