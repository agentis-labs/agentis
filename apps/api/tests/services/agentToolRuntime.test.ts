/**
 * Layer 2 §2.2.1 — AgentToolRuntime (role-scoped tool execution + security).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceVolumeService } from '../../src/services/workspace/workspaceVolume.js';
import { AgentToolRuntime } from '../../src/services/agent/agentToolRuntime.js';

let dataDir: string;
let volume: WorkspaceVolumeService;
let tools: AgentToolRuntime;
const WS = 'ws-tools-1';

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'agentis-tools-'));
  volume = new WorkspaceVolumeService(dataDir);
  tools = new AgentToolRuntime({ volume });
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('AgentToolRuntime', () => {
  it('write_file then read_file round-trips within the Volume', async () => {
    const w = await tools.execute(WS, 'write_file', { path: 'projects/app/index.ts', content: 'export const x = 1;' });
    expect(w.ok).toBe(true);
    const r = await tools.execute(WS, 'read_file', { path: 'projects/app/index.ts' });
    expect(r.ok).toBe(true);
    expect((r.result as { content: string }).content).toMatch(/export const x/);
  });

  it('blocks .env and path-escape', async () => {
    const env = await tools.execute(WS, 'read_file', { path: 'projects/.env' });
    expect(env.ok).toBe(false);
    expect(env.error).toMatch(/blocked/i);
    const escape = await tools.execute(WS, 'read_file', { path: '../../secret.txt' });
    expect(escape.ok).toBe(false);
    expect(escape.error).toMatch(/escape/i);
  });

  it('run_code evaluates in the sandbox (no process/require)', async () => {
    const ok = await tools.execute(WS, 'run_code', { expression: '({ doubled: input.n * 2 })', input: { n: 21 } });
    expect(ok.ok).toBe(true);
    expect((ok.result as { value: { doubled: number } }).value.doubled).toBe(42);

    const blocked = await tools.execute(WS, 'run_code', { expression: 'process.env' });
    const constructorEscape = await tools.execute(WS, 'run_code', {
      expression: 'typeof input["con" + "structor"]["con" + "structor"]("return pro" + "cess")()',
      input: {},
    });
    const neverReturns = await tools.execute(WS, 'run_code', {
      expression: '(() => { for (;;) {} })()',
    });
    expect(constructorEscape.ok).toBe(false);
    expect(neverReturns.ok).toBe(false);
    expect(neverReturns.error).toMatch(/timed out/i);
    expect(blocked.ok).toBe(false); // process is shadowed → throws
  });

  it('search_code finds matches across Volume files', async () => {
    await tools.execute(WS, 'write_file', { path: 'projects/a.ts', content: 'const TODO = 1;\nconst y = 2;' });
    await tools.execute(WS, 'write_file', { path: 'projects/b.ts', content: 'const z = 3; // TODO later' });
    const res = await tools.execute(WS, 'search_code', { query: 'TODO' });
    expect(res.ok).toBe(true);
    const matches = (res.result as { matches: Array<{ path: string }> }).matches;
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('enforces the open-vocabulary tool floor', async () => {
    // Built-in specialists were retired: no role gets file/git tools by default —
    // write_file is outside the universal knowledge-worker floor.
    const denied = await tools.execute(WS, 'write_file', { path: 'x.txt', content: 'y' }, 'researcher');
    expect(denied.ok).toBe(false);
    expect(denied.error).toMatch(/not granted/);
    // ...but every specialist role DOES get the floor (e.g. run_code).
    const allowed = await tools.execute(WS, 'run_code', { expression: '1 + 1' }, 'researcher');
    expect(allowed.ok).toBe(true);
  });

  it('reports unavailable tools clearly', async () => {
    const ws = await tools.execute(WS, 'web_search', { query: 'anything' });
    expect(ws.ok).toBe(false);
    expect(ws.error).toMatch(/not configured/);
    const git = await tools.execute(WS, 'git_status', {});
    expect(git.ok).toBe(false);
  });

  it('keeps browser screenshots transient by default and only persists intentional assets with App provenance', async () => {
    const persisted: Array<Record<string, unknown>> = [];
    const browser = { screenshot: async () => Buffer.from('png-bytes') };
    const artifacts = {
      persist: (input: Record<string, unknown>) => {
        persisted.push(input);
        return {
          id: `artifact-${persisted.length}`,
          name: input.name,
          title: input.title,
          type: input.type,
          ref: `artifact:artifact-${persisted.length}`,
          url: `/v1/artifacts/artifact-${persisted.length}`,
        };
      },
    };
    const runtime = new AgentToolRuntime({
      volume,
      browser: browser as never,
      artifacts: artifacts as never,
      resolveAppIdForWorkflow: (_ws, workflowId) => (workflowId === 'wf-app' ? 'app-1' : undefined),
    });

    const inspection = await runtime.execute(WS, 'browser_screenshot', { html: '<main>Preview</main>' }, undefined, {
      workflowId: 'wf-app',
      runId: 'run-1',
      agentId: 'agent-1',
    });

    expect(inspection.ok).toBe(true);
    expect(inspection.result).toMatchObject({ saved: false, mimeType: 'image/png' });
    expect(persisted).toHaveLength(0);

    const saved = await runtime.execute(WS, 'browser_screenshot', { html: '<main>Deliverable</main>', title: 'Login mockup', save: true }, undefined, {
      workflowId: 'wf-app',
      runId: 'run-1',
      agentId: 'agent-1',
    });

    expect(saved.ok).toBe(true);
    expect(saved.result).toMatchObject({ saved: true, artifactId: 'artifact-1', ref: 'artifact:artifact-1' });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      workspaceId: WS,
      type: 'image',
      title: 'Login mockup',
      workflowId: 'wf-app',
      runId: 'run-1',
      agentId: 'agent-1',
      appId: 'app-1',
      savedBy: 'browser_screenshot',
    });
  });

});
