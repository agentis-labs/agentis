/**
 * Agent transition & import — e2e (AGENT-TRANSITION).
 * Builds a fixture machine home with a Claude Code install (subagents +
 * CLAUDE.md + a real memory store), then drives discovery → preview → import →
 * re-import (idempotency) through the orchestrator.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { EpisodicMemoryStore } from '../../src/services/episodicMemoryStore.js';
import { StubEmbeddingProvider } from '../_helpers/stubEmbeddingProvider.js';
import { HarnessMemoryIngestionService } from '../../src/services/harness/harnessMemoryIngestion.js';
import { AdapterManager } from '../../src/adapters/AdapterManager.js';
import { MemoryStore } from '../../src/services/memory/memoryStore.js';
import { SharedIntelligenceService } from '../../src/services/sharedIntelligence.js';
import { SkillService } from '../../src/services/skillService.js';
import {
  discoverImportableAgents,
  previewAgentImport,
  importAgents,
  checkImportUpdates,
  syncImportedAgents,
  type HarnessImportDeps,
} from '../../src/services/harness/harnessAgentImport.js';
import type { FormationPromoter, IngestibleAgent } from '../../src/services/harness/harnessMemoryIngestion.js';
import type { ImportMemoryFile } from '../../src/services/harnessImport/types.js';
import { claudeProjectSlug } from '../../src/services/harnessImport/fsScan.js';
import { discoverAgents } from '../../src/services/harnessImport/registry.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let home: string | null = null;
let deps: HarnessImportDeps;
let store: EpisodicMemoryStore;
let env: NodeJS.ProcessEnv;

const CLAUDE_MD = `# Project Conventions

## Rules
- Always run the full test suite before pushing to main.
- Never commit secrets or API keys to the repository.
`;

const MEMORY_FACT = `---
name: db-choice
type: project
---

We chose SQLite over Postgres for local-first deployments because operators run single-node.
`;

const SUBAGENT = `---
name: Researcher
description: Finds and synthesises sources.
model: claude-opus-4-8
---

You are a meticulous research specialist. Always cite primary sources and never fabricate citations.
`;

beforeEach(async () => {
  ctx = await createTestContext();
  store = new EpisodicMemoryStore(ctx.db, ctx.logger, new StubEmbeddingProvider());
  const ingestion = new HarnessMemoryIngestionService(store, ctx.logger);
  const memory = new MemoryStore(ctx.db, ctx.logger);
  memory.setEpisodicStore(store);
  const brain = new SharedIntelligenceService(ctx.db, ctx.bus, store, ctx.logger);
  const skills = new SkillService(ctx.db, memory, brain, ctx.logger);
  deps = {
    db: ctx.db,
    vault: ctx.vault,
    adapters: new AdapterManager(ctx.logger),
    logger: ctx.logger,
    bus: ctx.bus,
    ingestion,
    skills,
  };

  home = mkdtempSync(path.join(os.tmpdir(), 'agentis-import-home-'));
  const claude = path.join(home, '.claude');
  mkdirSync(path.join(claude, 'agents'), { recursive: true });
  writeFileSync(path.join(claude, 'CLAUDE.md'), CLAUDE_MD, 'utf8');
  writeFileSync(path.join(claude, 'agents', 'researcher.md'), SUBAGENT, 'utf8');

  // A real Claude memory store for a fictional project cwd.
  const projectCwd = path.join(home, 'work', 'app');
  const memDir = path.join(claude, 'projects', claudeProjectSlug(projectCwd), 'memory');
  mkdirSync(memDir, { recursive: true });
  writeFileSync(path.join(memDir, 'MEMORY.md'), '# Index\n- [db](db-choice.md)\n', 'utf8');
  writeFileSync(path.join(memDir, 'db-choice.md'), MEMORY_FACT, 'utf8');

  // A user-authored skill (→ should transition into an Ability).
  const skillDir = path.join(claude, 'skills', 'pdf-fill');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: pdf-fill\ndescription: Fill PDF forms from structured data.\n---\n\nUse pdftk to fill AcroForm fields; always flatten the output.\n', 'utf8');

  // Isolate from the real machine: only the fixture Claude home should resolve.
  env = {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    CLAUDE_CONFIG_DIR: claude,
    CODEX_HOME: path.join(home, '.codex-none'),
    HERMES_HOME: path.join(home, '.hermes-none'),
  };
});

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = null;
  ctx.close();
});

/** discoverImportableAgents → scan with our fixture env (skip binary probing). */
async function discover() {
  // discoverImportableAgents calls discoverAgents() which probes binaries; pass
  // our env via the lower-level path by temporarily swapping process.env.
  const saved = process.env;
  process.env = env;
  try {
    return await discoverImportableAgents(deps, ctx.workspace.id, {});
  } finally {
    process.env = saved;
  }
}

async function withEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env;
  process.env = env;
  try {
    return await fn();
  } finally {
    process.env = saved;
  }
}

describe('harness agent import (e2e)', () => {
  it('discovers the primary Claude agent + the subagent as distinct agents', async () => {
    const agents = await discover();
    const ids = agents.map((a) => a.externalId);
    expect(ids).toContain('claude_code:primary');
    expect(agents.some((a) => a.name === 'Researcher')).toBe(true);
    const primary = agents.find((a) => a.externalId === 'claude_code:primary')!;
    expect(primary.summary.memoryFiles).toBeGreaterThanOrEqual(1);
    expect(primary.alreadyImported).toBeNull();
  });

  it('previews scope-routed candidates: workspace rules + a memory fact', async () => {
    const preview = await withEnv(() => previewAgentImport(deps, ctx.workspace.id, 'claude_code:primary', {}));
    const ws = preview.candidates.filter((c) => c.scopeHint === 'workspace');
    expect(ws.some((c) => /Never commit secrets/.test(c.summary))).toBe(true);
    expect(preview.candidates.some((c) => /SQLite over Postgres/.test(c.summary))).toBe(true);
    // The MEMORY.md index file is not ingested as facts.
    expect(preview.candidates.some((c) => /\[db\]/.test(c.summary))).toBe(false);
  });

  it('imports the primary agent online: agent-scoped memory + workspace rules', async () => {
    const result = await withEnv(() => importAgents(deps, {
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      specs: [{ externalId: 'claude_code:primary' }],
    }));
    expect(result.imported).toHaveLength(1);
    const outcome = result.imported[0]!;
    expect(outcome.created).toBe(true);
    expect(outcome.memory.written).toBeGreaterThan(0);

    // The agent exists, carries its import origin, and is NOT paused (B4 online).
    const row = ctx.db.select().from(schema.agents).where(eq(schema.agents.id, outcome.agentId)).get();
    expect(row?.adapterType).toBe('claude_code');
    expect(row?.isPaused).toBe(false);
    expect((row?.config as Record<string, unknown>).importOrigin).toMatchObject({ externalId: 'claude_code:primary' });

    // D1: the personal memory fact landed on the AGENT (scopeId = agentId)…
    const agentAtoms = store.list({ workspaceId: ctx.workspace.id, scopeId: outcome.agentId });
    expect(agentAtoms.some((e) => /SQLite over Postgres/.test(e.summary))).toBe(true);
    // …and the shared rule file landed in the workspace Brain (scopeId null).
    const wsAtoms = store.list({ workspaceId: ctx.workspace.id, scopeId: undefined });
    expect(wsAtoms.some((e) => /Never commit secrets/.test(e.summary))).toBe(true);
  });

  it('carries the subagent persona into instructions (agent identity)', async () => {
    const externalId = await discoverSubagentId();
    const result = await withEnv(() => importAgents(deps, {
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      specs: [{ externalId }],
    }));
    const row = ctx.db.select().from(schema.agents).where(eq(schema.agents.id, result.imported[0]!.agentId)).get();
    expect(row?.name).toBe('Researcher');
    expect(row?.instructions ?? '').toMatch(/research specialist/i);
  });

  it('is idempotent: re-import reuses the agent and reinforces memory', async () => {
    const spec = { externalId: 'claude_code:primary' };
    const first = await withEnv(() => importAgents(deps, { workspaceId: ctx.workspace.id, userId: ctx.user.id, specs: [spec] }));
    const second = await withEnv(() => importAgents(deps, { workspaceId: ctx.workspace.id, userId: ctx.user.id, specs: [spec] }));

    expect(second.imported[0]!.created).toBe(false);
    expect(second.imported[0]!.agentId).toBe(first.imported[0]!.agentId);
    expect(second.imported[0]!.memory.written).toBe(0);
    expect(second.imported[0]!.memory.reinforced).toBeGreaterThan(0);

    // Exactly one agent for that origin; no duplicate workspace atoms.
    const agents = ctx.db.select().from(schema.agents).where(eq(schema.agents.workspaceId, ctx.workspace.id)).all();
    const imported = agents.filter((a) => (a.config as Record<string, unknown>).importOrigin);
    expect(imported).toHaveLength(1);
  });

  it('transitions user skills into agent-scoped Brain skill atoms', async () => {
    const preview = await withEnv(() => previewAgentImport(deps, ctx.workspace.id, 'claude_code:primary', {}));
    expect(preview.skills.some((s) => s.name === 'pdf-fill' && s.origin === 'user')).toBe(true);

    const result = await withEnv(() => importAgents(deps, {
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      specs: [{ externalId: 'claude_code:primary' }],
    }));
    const outcome = result.imported[0]!;
    expect(result.totalAbilities).toBeGreaterThan(0);
    expect(outcome.abilities.created).toBeGreaterThan(0);

    // The skill exists as an agent-scoped Brain skill atom (scoping replaces pinning).
    const skill = deps.skills!.getByScopeAndSlug(ctx.workspace.id, outcome.agentId, 'pdf-fill');
    expect(skill).toBeTruthy();
    expect(skill!.body).toContain('pdftk');
  });

  it('agent deletion can promote its memory to the workspace (B11)', async () => {
    const res = await withEnv(() => importAgents(deps, {
      workspaceId: ctx.workspace.id, userId: ctx.user.id, specs: [{ externalId: 'claude_code:primary' }],
    }));
    const agentId = res.imported[0]!.agentId;
    const before = store.list({ workspaceId: ctx.workspace.id, scopeId: agentId });
    expect(before.length).toBeGreaterThan(0);

    // promote: agent-scoped memory → workspace scope.
    const moved = store.reassignScope(ctx.workspace.id, agentId, null);
    expect(moved).toBe(before.length);
    expect(store.list({ workspaceId: ctx.workspace.id, scopeId: agentId })).toHaveLength(0);
    expect(store.list({ workspaceId: ctx.workspace.id, scopeId: undefined }).some((e) => /SQLite over Postgres/.test(e.summary))).toBe(true);
  });

  it('agent deletion can delete its memory (B11)', async () => {
    const res = await withEnv(() => importAgents(deps, {
      workspaceId: ctx.workspace.id, userId: ctx.user.id, specs: [{ externalId: 'claude_code:primary' }],
    }));
    const agentId = res.imported[0]!.agentId;
    expect(store.list({ workspaceId: ctx.workspace.id, scopeId: agentId }).length).toBeGreaterThan(0);
    const removed = store.deleteScope(ctx.workspace.id, agentId);
    expect(removed).toBeGreaterThan(0);
    expect(store.list({ workspaceId: ctx.workspace.id, scopeId: agentId })).toHaveLength(0);
  });

  async function discoverSubagentId(): Promise<string> {
    const agents = await discover();
    return agents.find((a) => a.name === 'Researcher')!.externalId;
  }
});

describe('formation pipeline routing (deferred item A)', () => {
  const wsFiles: ImportMemoryFile[] = [
    { path: '/fixture/CLAUDE.md', name: 'CLAUDE.md', content: CLAUDE_MD, scopeHint: 'workspace', typeHint: 'rule', kind: 'instruction' },
  ];
  const agent: IngestibleAgent = { id: 'agentF', workspaceId: '', adapterType: 'claude_code', config: {}, instructions: '' };

  it('routes imported memory through the formation pipeline when a promoter is wired', async () => {
    agent.workspaceId = ctx.workspace.id;
    const calls: Array<{ scopeId: string | null }> = [];
    const promoter: FormationPromoter = {
      async promote(input) { calls.push({ scopeId: input.scopeId ?? null }); return { created: 2, reinforced: 0, linked: 0 }; },
    };
    const ingestion = new HarnessMemoryIngestionService(store, ctx.logger);
    ingestion.setFormationPromoter(promoter);

    const res = await ingestion.commitImport(agent, wsFiles);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.scopeId === null)).toBe(true); // workspace files → workspace scope
    expect(res.written).toBe(2);
  });

  it('falls back to the deterministic write when formation forms nothing (curated atoms never lost)', async () => {
    agent.workspaceId = ctx.workspace.id;
    const ingestion = new HarnessMemoryIngestionService(store, ctx.logger);
    ingestion.setFormationPromoter({ async promote() { return { created: 0, reinforced: 0, linked: 0 }; } });

    const res = await ingestion.commitImport(agent, wsFiles);
    expect(res.written).toBeGreaterThan(0); // deterministic fallback wrote the reviewed atoms
    const wsAtoms = store.list({ workspaceId: ctx.workspace.id, scopeId: undefined });
    expect(wsAtoms.some((e) => /Never commit secrets/.test(e.summary))).toBe(true);
  });
});

describe('remote endpoint import (deferred item C)', () => {
  it('surfaces a configured OpenClaw gateway as a single identity-only agent (no fabricated roster)', async () => {
    const agents = await discoverAgents({
      env: { USERPROFILE: home!, HOME: home!, CODEX_HOME: 'x', HERMES_HOME: 'y', CLAUDE_CONFIG_DIR: 'z' },
      detections: [
        { adapterType: 'openclaw', harness: 'OpenClaw', status: 'found', config: { gatewayUrl: 'wss://gw.example/agent' }, detail: 'wss://gw.example/agent' },
      ],
    });
    const remote = agents.filter((a) => a.adapterType === 'openclaw');
    expect(remote).toHaveLength(1);
    expect(remote[0]!.externalId).toBe('openclaw:remote');
    expect(remote[0]!.config.gatewayUrl).toBe('wss://gw.example/agent');
    expect(remote[0]!.summary).toEqual({ memoryFiles: 0, workspaceFiles: 0, agentFiles: 0, skills: 0 });
  });
});

describe('continuous transition updates (deferred item B)', () => {
  it('surfaces new memory accrued by an imported agent (approval-gated)', async () => {
    await withEnv(() => importAgents(deps, { workspaceId: ctx.workspace.id, userId: ctx.user.id, specs: [{ externalId: 'claude_code:primary' }] }));

    // Nothing new immediately after import.
    const none = await withEnv(() => checkImportUpdates(deps, ctx.workspace.id, {}));
    expect(none.find((u) => u.externalId === 'claude_code:primary')).toBeUndefined();

    // The harness accumulates a new memory fact.
    const memDir = path.join(home!, '.claude', 'projects', claudeProjectSlug(path.join(home!, 'work', 'app')), 'memory');
    writeFileSync(path.join(memDir, 'new-rule.md'), '---\ntype: project\n---\n\nAlways prefer feature flags over long-lived branches for risky changes.\n', 'utf8');

    const after = await withEnv(() => checkImportUpdates(deps, ctx.workspace.id, {}));
    const update = after.find((u) => u.externalId === 'claude_code:primary');
    expect(update?.pendingNew).toBeGreaterThan(0);
    expect(update?.pendingMemory).toBeGreaterThan(0);
  });

  it('detects and continuously syncs new harness skills into the Brain', async () => {
    await withEnv(() => importAgents(deps, { workspaceId: ctx.workspace.id, userId: ctx.user.id, specs: [{ externalId: 'claude_code:primary' }] }));

    const skillDir = path.join(home!, '.claude', 'skills', 'release-notes');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: release-notes\ndescription: Draft release notes from merged changes.\n---\n\nAlways group changes by user-visible outcome and call out migration risks.\n',
      'utf8',
    );

    const before = await withEnv(() => checkImportUpdates(deps, ctx.workspace.id, {}));
    const update = before.find((u) => u.externalId === 'claude_code:primary');
    expect(update?.pendingMemory).toBe(0);
    expect(update?.pendingSkills).toBe(1);

    const synced = await withEnv(() => syncImportedAgents(deps, ctx.workspace.id, {}));
    expect(synced.totalAbilities).toBe(1);
    // The new skill landed as an agent-scoped Brain skill atom.
    const skill = deps.skills!.getByScopeAndSlug(ctx.workspace.id, synced.synced[0]!.agentId, 'release-notes');
    expect(skill).toBeTruthy();
    expect(skill!.body).toContain('migration risks');

    const after = await withEnv(() => checkImportUpdates(deps, ctx.workspace.id, {}));
    expect(after.find((u) => u.externalId === 'claude_code:primary')).toBeUndefined();
  });
});
