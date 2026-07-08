import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { WorkspaceVolumeService } from '../../src/services/workspace/workspaceVolume.js';
import { WorkspaceIntelligenceService } from '../../src/services/workspace/workspaceIntelligence.js';
import { MemoryStore } from '../../src/services/memory/memoryStore.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

describe('WorkspaceVolumeService', () => {
  let dataDir: string;
  let volume: WorkspaceVolumeService;
  const WS = 'ws-test-1';

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'agentis-vol-'));
    volume = new WorkspaceVolumeService(dataDir);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

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

  it('returns null for a missing file', async () => {
    expect(await volume.read(WS, 'nope.md')).toBeNull();
  });

  it('refuses reads and writes through a symlink inside the volume', async () => {
    const external = path.join(dataDir, 'outside');
    await mkdir(external, { recursive: true });
    await writeFile(path.join(external, 'secret.txt'), 'outside', 'utf8');
    await volume.ensureScaffold(WS);
    await symlink(
      external,
      path.join(volume.rootFor(WS), 'reports', 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await expect(volume.read(WS, 'reports/escape/secret.txt')).rejects.toMatchObject({
      code: 'WORKSPACE_VOLUME_PATH_ESCAPE',
    });
    await expect(volume.write(WS, 'reports/escape/new.txt', 'blocked')).rejects.toMatchObject({
      code: 'WORKSPACE_VOLUME_PATH_ESCAPE',
    });
  });
});

describe('WorkspaceIntelligenceService', () => {
  let ctx: TestContext;
  let intel: WorkspaceIntelligenceService;

  beforeEach(async () => {
    ctx = await createTestContext();
    intel = new WorkspaceIntelligenceService(new MemoryStore(ctx.db, ctx.logger), ctx.db, () => ['github', 'slack']);
  });

  afterEach(() => ctx.close());

  it('returns empty for unauthored context (no placeholder seeding)', () => {
    expect(intel.getContextFile(ctx.workspace.id, 'WORKSPACE.md')).toBe('');
  });

  it('stores authored context as an operator charter atom, not a Markdown file', () => {
    intel.setContextFile(ctx.workspace.id, 'WORKSPACE.md', 'Tech stack: TypeScript + pnpm');
    expect(intel.getContextFile(ctx.workspace.id, 'WORKSPACE.md')).toBe('Tech stack: TypeScript + pnpm');

    // §B4 — charter atoms live in memory_episodes (plane-tagged); operator → operator_write.
    const rows = ctx.db.select().from(schema.memoryEpisodes).where(eq(schema.memoryEpisodes.workspaceId, ctx.workspace.id)).all()
      .filter((row) => (row.tags as string[]).includes('plane:workspace_memory'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe('operator_write');
    expect(Number(rows[0]!.importance)).toBeGreaterThanOrEqual(0.8);
    expect(rows[0]!.tags as string[]).toEqual(expect.arrayContaining(['charter', 'workspace']));
  });

  it('clearing a document deletes its atom so it stops injecting', () => {
    intel.setContextFile(ctx.workspace.id, 'WORKSPACE.md', 'Tech stack: TypeScript + pnpm');
    intel.setContextFile(ctx.workspace.id, 'WORKSPACE.md', '   ');
    expect(intel.getContextFile(ctx.workspace.id, 'WORKSPACE.md')).toBe('');
    expect(ctx.db.select().from(schema.memoryEpisodes).all().filter((row) => (row.tags as string[]).includes('plane:workspace_memory'))).toHaveLength(0);
  });

  it('assembles a context block with workspace docs and integrations', async () => {
    intel.setContextFile(ctx.workspace.id, 'WORKSPACE.md', 'Tech Stack: TypeScript + pnpm');
    intel.setContextFile(ctx.workspace.id, 'DECISIONS.md', 'Use DB-backed memory.');
    intel.setContextFile(ctx.workspace.id, 'WORKFLOW.md', 'Prefer deterministic transform nodes.');

    const block = await intel.buildContextBlock(ctx.workspace.id);
    expect(block).toMatch(/<workspace_context>/);
    expect(block).toMatch(/TypeScript \+ pnpm/);
    expect(block).toMatch(/Use DB-backed memory/);
    expect(block).toMatch(/Prefer deterministic transform nodes/);
    expect(block).toMatch(/Active Integrations\ngithub, slack/);
    expect(block).not.toMatch(/MEMORY\.md|Session Memory Log/);
  });
});
