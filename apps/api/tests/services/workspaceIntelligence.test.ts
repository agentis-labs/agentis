/**
 * Layer 1 — Workspace Intelligence + Workspace Volume.
 *
 * Covers the path-escape guard on the Volume and the MEMORY.md
 * parse → score → select → buildContextBlock pipeline.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceVolumeService } from '../../src/services/workspaceVolume.js';
import {
  WorkspaceIntelligenceService,
  parseMemoryEntries,
  selectRelevantEntries,
} from '../../src/services/workspaceIntelligence.js';

let dataDir: string;
let volume: WorkspaceVolumeService;
let intel: WorkspaceIntelligenceService;
const WS = 'ws-test-1';

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'agentis-vol-'));
  volume = new WorkspaceVolumeService(dataDir);
  intel = new WorkspaceIntelligenceService(volume, () => ['github', 'slack']);
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('WorkspaceVolumeService', () => {
  it('writes, reads, and lists files', async () => {
    await volume.write(WS, 'reports/q2.md', '# Q2');
    expect(await volume.read(WS, 'reports/q2.md')).toBe('# Q2');
    const entries = await volume.list(WS, 'reports');
    expect(entries.map((e) => e.name)).toContain('q2.md');
  });

  it('refuses paths that escape the workspace root', async () => {
    await expect(volume.read(WS, '../../secret.txt')).rejects.toMatchObject({ code: 'WORKSPACE_VOLUME_PATH_ESCAPE' });
    expect(() => volume.resolve(WS, '../escape')).toThrow(/escape/i);
  });

  it('returns null for a missing file (not a throw)', async () => {
    expect(await volume.read(WS, 'nope.md')).toBeNull();
  });
});

describe('parseMemoryEntries', () => {
  it('parses inline metadata tags and section headers', () => {
    const md = [
      '# Session Memory Log',
      '## Patterns That Failed',
      '- [2026-05-19][uses:3][wf:standup][conf:high] Summarizer hallucinated authors with >50 PRs. Fix: truncate to 20.',
      '## Effective Patterns',
      '- [2026-05-08][uses:7][wf:any][conf:medium] Evaluator-retry cut failure 23%→4%.',
      '- a plain untagged note still parses',
    ].join('\n');
    const entries = parseMemoryEntries(md);
    expect(entries).toHaveLength(3);
    const failed = entries[0]!;
    expect(failed.section).toBe('Patterns That Failed');
    expect(failed.uses).toBe(3);
    expect(failed.workflowId).toBe('standup');
    expect(failed.confidence).toBe('high');
    expect(failed.text).toMatch(/Summarizer hallucinated/);
    expect(entries[2]!.workflowId).toBe('any'); // default
  });
});

describe('selectRelevantEntries', () => {
  it('ranks workflow-matching, recent, high-use entries first', () => {
    const now = Date.now();
    const day = 86_400_000;
    const entries = parseMemoryEntries([
      '## Effective Patterns',
      `- [${iso(now - day)}][uses:9][wf:standup][conf:high] Recent matching workflow pattern.`,
      `- [${iso(now - 200 * day)}][uses:0][wf:other][conf:low] Old unrelated pattern.`,
    ].join('\n'));
    const selected = selectRelevantEntries(entries, { workflowId: 'standup', tokenBudget: 2000, maxEntries: 10 });
    expect(selected[0]!.text).toMatch(/Recent matching/);
  });

  it('respects the token budget', () => {
    const entries = parseMemoryEntries([
      '## Effective Patterns',
      `- ${'x'.repeat(8000)}`,
    ].join('\n'));
    const selected = selectRelevantEntries(entries, { workflowId: 'a', tokenBudget: 100, maxEntries: 10 });
    expect(selected).toHaveLength(0); // single entry costs ~2000 tokens > 100
  });
});

describe('WorkspaceIntelligenceService', () => {
  it('seeds default context files on first read', async () => {
    const ws = await intel.getContextFile(WS, 'WORKSPACE.md');
    expect(ws).toMatch(/# Workspace Context/);
    // Persisted to the volume's context dir.
    expect(await volume.read(WS, 'context/WORKSPACE.md')).toBe(ws);
  });

  it('assembles a context block with workspace facts, integrations, and memory', async () => {
    await intel.setContextFile(WS, 'WORKSPACE.md', '# Workspace Context\n\n## Tech Stack\nTypeScript + pnpm');
    await intel.setContextFile(WS, 'MEMORY.md', [
      '# Session Memory Log',
      '## Effective Patterns',
      '- [2026-05-20][uses:5][wf:any][conf:high] Prefer deterministic transform nodes over agent_task.',
    ].join('\n'));
    const block = await intel.buildContextBlock(WS);
    expect(block).toMatch(/<workspace_context>/);
    expect(block).toMatch(/TypeScript \+ pnpm/);
    expect(block).toMatch(/Active Integrations\ngithub, slack/);
    expect(block).toMatch(/deterministic transform nodes/);
  });

  it('appendMemory inserts under the named section', async () => {
    await intel.getContextFile(WS, 'MEMORY.md'); // seed
    await intel.appendMemory(WS, 'Patterns That Failed', '[2026-05-22][uses:0][wf:x][conf:low] New failure note.');
    const md = await intel.getContextFile(WS, 'MEMORY.md');
    expect(md).toMatch(/## Patterns That Failed\n- \[2026-05-22\].*New failure note/);
  });
});

function iso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
