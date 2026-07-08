import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listAgentInstructionFiles } from '../../src/services/agent/agentInstructionFiles.js';

let tmp: string | null = null;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('agent instruction file discovery', () => {
  it('includes platform and workspace instruction files', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'agentis-instructions-'));
    writeFileSync(path.join(tmp, 'AGENTS.md'), 'workspace rules', 'utf8');

    const files = listAgentInstructionFiles({
      adapterType: 'codex',
      config: { cwd: tmp },
      instructions: 'platform rules',
    });

    expect(files.some((file) => file.name === 'agentis.md' && file.source === 'platform')).toBe(true);
    expect(files.some((file) => file.name === 'AGENTS.md' && file.source === 'workspace' && file.content === 'workspace rules')).toBe(true);
  });
});
