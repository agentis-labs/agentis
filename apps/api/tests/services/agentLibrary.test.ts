/**
 * Principle #11 — AgentLibraryService (agent identity as files).
 *
 * Built-in platform specialists are no longer exported; operator custom roles
 * in agents/custom/*.md expand the casting vocabulary.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceVolumeService } from '../../src/services/workspace/workspaceVolume.js';
import { AgentLibraryService } from '../../src/services/agent/agentLibrary.js';

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
  it('does not export platform specialists', async () => {
    await library.ensurePlatformAgents(WS);
    await library.ensurePlatformAgents(WS);
    const all = await library.list(WS);
    expect(all.filter((a) => a.source === 'platform')).toHaveLength(0);
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
    expect(roles.every((r) => r.source !== 'platform')).toBe(true);
  });
});
