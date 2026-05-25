/**
 * §2.2 — AgentToolLoop (agentic tool-use execution loop).
 *
 * Verifies the bounded ReAct loop drives the role-scoped tool runtime: it calls
 * granted tools, feeds observations back, finishes on "final", enforces the role
 * manifest, and caps steps.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceVolumeService } from '../../src/services/workspaceVolume.js';
import { AgentToolRuntime } from '../../src/services/agentToolRuntime.js';
import { AgentToolLoop, type StructuredLlm } from '../../src/services/agentToolLoop.js';

let dataDir: string;
let volume: WorkspaceVolumeService;
let runtime: AgentToolRuntime;
const WS = 'ws-loop-1';

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'agentis-loop-'));
  volume = new WorkspaceVolumeService(dataDir);
  runtime = new AgentToolRuntime({ volume });
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

/** Scripted LLM: returns the next decision per call. */
function scriptedLlm(decisions: Array<Record<string, unknown>>): StructuredLlm {
  let i = 0;
  return {
    async completeStructured<T extends Record<string, unknown>>(): Promise<T | null> {
      const d = decisions[i] ?? { action: 'final', output: 'done' };
      i += 1;
      return d as T;
    },
  };
}

describe('AgentToolLoop', () => {
  it('calls a granted tool, then finishes with the synthesized output', async () => {
    await volume.write(WS, 'notes/spec.md', 'the answer is 42');
    const llm = scriptedLlm([
      { thought: 'read the spec', action: 'tool', tool: 'read_file', args: { path: 'notes/spec.md' } },
      { thought: 'have it', action: 'final', output: 'The spec says the answer is 42.' },
    ]);
    const loop = new AgentToolLoop({ runtime, llm });
    const res = await loop.run({ workspaceId: WS, role: 'coder', task: 'What does the spec say?' });

    expect(res.stoppedReason).toBe('final');
    expect(res.toolCalls).toBe(1);
    expect(res.output).toMatch(/42/);
    expect(res.steps.some((s) => s.tool === 'read_file' && (s.observation as { content?: string })?.content?.includes('42'))).toBe(true);
  });

  it('rejects a tool the role does not have, without counting it as a tool call', async () => {
    const llm = scriptedLlm([
      // 'writer' is not granted write_file.
      { action: 'tool', tool: 'write_file', args: { path: 'x.txt', content: 'no' } },
      { action: 'final', output: 'finished anyway' },
    ]);
    const loop = new AgentToolLoop({ runtime, llm });
    const res = await loop.run({ workspaceId: WS, role: 'writer', task: 'write a file' });

    expect(res.toolCalls).toBe(0);
    expect(res.steps[0]?.error).toMatch(/not available/);
    expect(await volume.read(WS, 'x.txt')).toBeNull();
    expect(res.output).toBe('finished anyway');
  });

  it('caps at maxSteps and still produces a final answer', async () => {
    // Always asks for a tool; never finishes on its own.
    const llm: StructuredLlm = {
      async completeStructured<T extends Record<string, unknown>>(args: { system: string }): Promise<T | null> {
        if (args.system.includes('OUT OF STEPS')) return { action: 'final', output: 'forced final' } as T;
        return { action: 'tool', tool: 'run_code', args: { expression: '1 + 1' } } as T;
      },
    };
    const loop = new AgentToolLoop({ runtime, llm });
    const res = await loop.run({ workspaceId: WS, role: 'coder', task: 'loop forever', maxSteps: 2 });

    expect(res.stoppedReason).toBe('max_steps');
    expect(res.toolCalls).toBe(2);
    expect(res.output).toBe('forced final');
  });
});
