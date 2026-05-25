/**
 * Principle #11 — AgentLibraryService (agent identity as files).
 *
 * Platform specialists export to agents/platform/<role>.md (read-only defaults);
 * operator custom roles in agents/custom/*.md expand the casting vocabulary.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SPECIALIST_AGENTS } from '@agentis/core';
import { WorkspaceVolumeService } from '../../src/services/workspaceVolume.js';
import { AgentLibraryService } from '../../src/services/agentLibrary.js';

let dataDir: string;
let volume: WorkspaceVolumeService;
let library: AgentLibraryService;
const WS = 'ws-agentlib-1';

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'agentis-agentlib-'));
  volume = new WorkspaceVolumeService(dataDir);
  library = new AgentLibraryService(volume);
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('AgentLibraryService', () => {
  it('exports every platform specialist as agents/platform/<role>.md (idempotent)', async () => {
    await library.ensurePlatformAgents(WS);
    const sample = SPECIALIST_AGENTS[0]!;
    const md = await volume.read(WS, `agents/platform/${sample.role}.md`);
    expect(md).toMatch(new RegExp(`role: ${sample.role}`));
    expect(md).toMatch(/tools: \[/);

    // Idempotent: second call does not throw and platform files still parse.
    await library.ensurePlatformAgents(WS);
    const all = await library.list(WS);
    expect(all.filter((a) => a.source === 'platform')).toHaveLength(SPECIALIST_AGENTS.length);
  });

  it('round-trips a custom agent and surfaces it as a custom role', async () => {
    await library.writeCustom(WS, {
      name: 'Compliance Analyst',
      role: 'compliance_analyst',
      model: 'gpt-4o',
      tools: ['read_file', 'knowledge_search'],
      capabilityTags: ['compliance', 'audit'],
      body: 'You verify outputs against regulatory policy.',
    });

    const all = await library.list(WS);
    const custom = all.find((a) => a.role === 'compliance_analyst');
    expect(custom?.source).toBe('custom');
    expect(custom?.tools).toEqual(['read_file', 'knowledge_search']);
    expect(custom?.body).toMatch(/regulatory policy/);

    const roles = await library.listCustomRoles(WS);
    expect(roles.map((r) => r.role)).toContain('compliance_analyst');
    // Platform roles are NOT reported as custom.
    expect(roles.some((r) => SPECIALIST_AGENTS.some((s) => s.role === r.role))).toBe(false);
  });
});
