/**
 * Layer 2 §2.5 — SkillLibraryService (behavioral skill protocols).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceVolumeService } from '../../src/services/workspaceVolume.js';
import { SkillLibraryService } from '../../src/services/skillLibrary.js';

let dataDir: string;
let volume: WorkspaceVolumeService;
let skills: SkillLibraryService;
const WS = 'ws-skill-1';

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'agentis-skill-'));
  volume = new WorkspaceVolumeService(dataDir);
  skills = new SkillLibraryService(volume);
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('SkillLibraryService', () => {
  it('seeds platform skills as .md files and lists them', async () => {
    await skills.ensureSeeded(WS);
    const md = await volume.read(WS, 'skills/tdd-protocol.md');
    expect(md).toMatch(/name: tdd-protocol/);
    expect(md).toMatch(/Test-Driven Development/);
    const all = await skills.list(WS);
    expect(all.map((s) => s.name)).toContain('owasp-checklist');
    expect(all.length).toBeGreaterThanOrEqual(7);
  });

  it('resolves a skill, with operator edits on the Volume winning over defaults', async () => {
    const def = await skills.resolve(WS, 'tdd-protocol');
    expect(def?.body).toMatch(/failing test first/i);

    await volume.write(WS, 'skills/tdd-protocol.md', '---\nname: tdd-protocol\nversion: 2.0.0\ntags: [coding]\n---\nCUSTOM RULE: always pair-program.');
    const edited = await skills.resolve(WS, 'tdd-protocol');
    expect(edited?.version).toBe('2.0.0');
    expect(edited?.body).toMatch(/CUSTOM RULE/);
  });

  it('builds an injectable skill block within a token budget', async () => {
    const block = await skills.buildSkillBlock(WS, ['tdd-protocol', 'owasp-checklist']);
    expect(block).toMatch(/<skill name="tdd-protocol">/);
    expect(block).toMatch(/<skill name="owasp-checklist">/);

    // Tiny budget drops everything.
    const tiny = await skills.buildSkillBlock(WS, ['tdd-protocol'], 5);
    expect(tiny).toBe('');
  });
});
