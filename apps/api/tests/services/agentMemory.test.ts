/**
 * AgentMemoryService + the agent-scoped Brain tools (§G11).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schema } from '@agentis/db/sqlite';
import { AgentMemoryService } from '../../src/services/agentMemory.js';
import { AgentToolRuntime } from '../../src/services/agentToolRuntime.js';
import { WorkflowStoreService } from '../../src/services/workflowStore.js';
import { WorkspaceVolumeService } from '../../src/services/workspaceVolume.js';
import { WorkspaceIntelligenceService } from '../../src/services/workspaceIntelligence.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let dataDir: string;
let agentMemory: AgentMemoryService;
let runtime: AgentToolRuntime;
let intelligence: WorkspaceIntelligenceService;

beforeEach(async () => {
  ctx = await createTestContext();
  dataDir = mkdtempSync(join(tmpdir(), 'agentmem-test-'));
  const volume = new WorkspaceVolumeService(dataDir);
  intelligence = new WorkspaceIntelligenceService(volume);
  agentMemory = new AgentMemoryService(ctx.db);
  runtime = new AgentToolRuntime({
    volume,
    workspaceIntelligence: intelligence,
    workflowStore: new WorkflowStoreService(ctx.db),
    agentMemory,
  });
});

afterEach(() => {
  ctx.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function seedAgent(): string {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({
    id, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
    name: 'Researcher', adapterType: 'http', capabilityTags: [], config: {}, status: 'online', role: 'researcher',
  }).run();
  return id;
}

describe('AgentMemoryService', () => {
  it('appends, lists, and searches an agent memory', () => {
    const agentId = seedAgent();
    agentMemory.append({ agentId, workspaceId: ctx.workspace.id, section: 'Findings', content: 'Competitor X shipped SAML SSO in April.' });
    agentMemory.append({ agentId, workspaceId: ctx.workspace.id, section: 'Findings', content: 'Pricing page lists three tiers.' });

    expect(agentMemory.list(agentId, ctx.workspace.id)).toHaveLength(2);
    const hits = agentMemory.search(agentId, ctx.workspace.id, 'SAML SSO');
    expect(hits[0]!.content).toContain('SAML SSO');
  });

  it('scopes memory per agent', () => {
    const a = seedAgent();
    const b = seedAgent();
    agentMemory.append({ agentId: a, workspaceId: ctx.workspace.id, content: 'belongs to A' });
    expect(agentMemory.list(a, ctx.workspace.id)).toHaveLength(1);
    expect(agentMemory.list(b, ctx.workspace.id)).toHaveLength(0);
  });

  it('clears all of an agent memory', () => {
    const agentId = seedAgent();
    agentMemory.append({ agentId, workspaceId: ctx.workspace.id, content: 'one' });
    agentMemory.append({ agentId, workspaceId: ctx.workspace.id, content: 'two' });
    expect(agentMemory.clear(agentId, ctx.workspace.id)).toBe(2);
    expect(agentMemory.list(agentId, ctx.workspace.id)).toHaveLength(0);
  });

  it('renders a context section only when the agent has memory', () => {
    const agentId = seedAgent();
    expect(agentMemory.contextSection(agentId, ctx.workspace.id)).toBe('');
    agentMemory.append({ agentId, workspaceId: ctx.workspace.id, content: 'remembered fact' });
    expect(agentMemory.contextSection(agentId, ctx.workspace.id)).toContain('remembered fact');
  });
});

describe('AgentToolRuntime — Brain memory tools', () => {
  it('memory_append scope:agent writes to the agent and scope:workspace writes the shared log', async () => {
    const agentId = seedAgent();
    const agentWrite = await runtime.execute(ctx.workspace.id, 'memory_append', { section: 'Findings', entry: 'private note', scope: 'agent' }, 'researcher', { agentId });
    expect(agentWrite.ok).toBe(true);
    expect(agentMemory.list(agentId, ctx.workspace.id)).toHaveLength(1);

    const wsWrite = await runtime.execute(ctx.workspace.id, 'memory_append', { section: 'Decisions Made', entry: 'shared note', scope: 'workspace' }, 'researcher', { agentId });
    expect(wsWrite.ok).toBe(true);
    const md = await intelligence.getContextFile(ctx.workspace.id, 'MEMORY.md');
    expect(md).toContain('shared note');
    // The shared write must NOT have landed in the agent's private memory.
    expect(agentMemory.list(agentId, ctx.workspace.id)).toHaveLength(1);
  });

  it('agent_memory_search recalls the calling agent own findings', async () => {
    const agentId = seedAgent();
    await runtime.execute(ctx.workspace.id, 'memory_append', { section: 'Findings', entry: 'Latency regressed after the cache change', scope: 'agent' }, 'researcher', { agentId });
    const res = await runtime.execute(ctx.workspace.id, 'agent_memory_search', { query: 'latency cache' }, 'researcher', { agentId });
    expect(res.ok).toBe(true);
    const results = (res.result as { results: Array<{ content: string }> }).results;
    expect(results[0]!.content).toContain('Latency');
  });

  it('agent memory tools fail cleanly without an agent identity', async () => {
    const res = await runtime.execute(ctx.workspace.id, 'agent_memory_search', { query: 'x' }, 'researcher', {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/agent identity/i);
  });

  it('workflow_memory_write then read round-trips within a workflow', async () => {
    const wfId = randomUUID();
    ctx.db.insert(schema.workflows).values({
      id: wfId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
      title: 'Cron Tracker', graph: { version: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
    }).run();
    const write = await runtime.execute(ctx.workspace.id, 'workflow_memory_write', { key: 'cursor', value: '2026-05-24' }, 'monitor', { workflowId: wfId });
    expect(write.ok).toBe(true);
    const read = await runtime.execute(ctx.workspace.id, 'workflow_memory_read', { key: 'cursor' }, 'monitor', { workflowId: wfId });
    expect((read.result as { value: unknown }).value).toBe('2026-05-24');
  });
});
