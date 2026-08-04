/**
 * Paired black-box runtime parity evaluation.
 *
 * Runs the same task corpus through (a) the native CLI harness and (b) the
 * Agentis conversation surface, then emits machine-readable score/delta data.
 * No provider SDK is used: this measures the exact operator-facing paths.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

interface EvalTask {
  id: string;
  prompt: string;
  timeoutMs?: number;
  assertions?: { require?: string[]; forbid?: string[]; minChars?: number };
}

interface NativeConfig { command: string; args?: string[]; cwd?: string; env?: Record<string, string>; promptVia?: 'stdin' | 'arg' }
interface Observation { surface: 'native' | 'agentis'; taskId: string; ok: boolean; durationMs: number; text: string; toolCalls: string[]; error?: string }

const args = new Map(process.argv.slice(2).map((value, index, all) => value.startsWith('--') ? [value.slice(2), all[index + 1] && !all[index + 1]!.startsWith('--') ? all[index + 1]! : 'true'] : ['', '']));
const root = process.cwd();
const fixturePath = path.resolve(root, args.get('fixtures') ?? 'evals/runtime-parity.json');
const tasks = JSON.parse(readFileSync(fixturePath, 'utf8')) as EvalTask[];
const nativeConfig = parseJsonEnv<NativeConfig>('AGENTIS_PARITY_NATIVE_JSON');
const baseUrl = process.env.AGENTIS_PARITY_URL?.replace(/\/$/, '');
const apiKey = process.env.AGENTIS_PARITY_API_KEY;
const workspaceId = process.env.AGENTIS_PARITY_WORKSPACE_ID;
const agentId = process.env.AGENTIS_PARITY_AGENT_ID;

if (!nativeConfig && !(baseUrl && apiKey && workspaceId && agentId)) {
  throw new Error('Configure AGENTIS_PARITY_NATIVE_JSON and/or AGENTIS_PARITY_URL, AGENTIS_PARITY_API_KEY, AGENTIS_PARITY_WORKSPACE_ID, AGENTIS_PARITY_AGENT_ID.');
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const observations: Observation[] = [];
  for (const task of tasks) {
    if (nativeConfig) observations.push(await runNative(task, nativeConfig));
    if (baseUrl && apiKey && workspaceId && agentId) observations.push(await runAgentis(task, { baseUrl, apiKey, workspaceId, agentId }));
  }

  const scored = observations.map((observation) => ({ ...observation, score: score(tasks.find((task) => task.id === observation.taskId)!, observation) }));
  const pairs = tasks.map((task) => {
    const native = scored.find((item) => item.taskId === task.id && item.surface === 'native');
    const agentis = scored.find((item) => item.taskId === task.id && item.surface === 'agentis');
    return {
      taskId: task.id,
      native: native ? summarize(native) : null,
      agentis: agentis ? summarize(agentis) : null,
      scoreDelta: native && agentis ? agentis.score - native.score : null,
      latencyRatio: native && agentis && native.durationMs > 0 ? agentis.durationMs / native.durationMs : null,
    };
  });
  const evaluatedPairs = pairs.filter((pair) => pair.scoreDelta !== null).length;
  const regressions = pairs.filter((pair) => pair.scoreDelta !== null && pair.scoreDelta! < -0.05).map((pair) => pair.taskId);
  const allowUnpaired = args.get('allow-unpaired') === 'true';
  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    fixturePath,
    pairs,
    observations: scored,
    acceptance: {
      evaluatedPairs,
      expectedPairs: tasks.length,
      regressions,
      passed: regressions.length === 0 && (allowUnpaired || evaluatedPairs === tasks.length),
    },
  };
  const outputDir = path.resolve(root, args.get('output') ?? 'artifacts/runtime-parity');
  mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(outputPath, JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify({ outputPath, acceptance: report.acceptance, pairs }, null, 2)}\n`);
  if (!report.acceptance.passed) process.exitCode = 1;
}

async function runNative(task: EvalTask, config: NativeConfig): Promise<Observation> {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), task.timeoutMs ?? 180_000);
  try {
    const promptVia = config.promptVia ?? 'stdin';
    const runtimeArgs = (config.args ?? []).map((arg) => arg.replaceAll('{{PROMPT}}', task.prompt));
    if (promptVia === 'arg' && !runtimeArgs.some((arg) => arg.includes(task.prompt))) runtimeArgs.push(task.prompt);
    const child = spawn(config.command, runtimeArgs, {
      cwd: config.cwd ? path.resolve(config.cwd) : root,
      env: { ...process.env, ...(config.env ?? {}) },
      windowsHide: true,
      signal: controller.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    if (promptVia === 'stdin') child.stdin.end(task.prompt);
    else child.stdin.end();
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    const parsed = parseNativeOutput(stdout);
    return { surface: 'native', taskId: task.id, ok: code === 0, durationMs: Date.now() - started, text: parsed.text, toolCalls: parsed.toolCalls, ...(code === 0 ? {} : { error: stderr.trim() || `native exited ${code}` }) };
  } catch (error) {
    return { surface: 'native', taskId: task.id, ok: false, durationMs: Date.now() - started, text: '', toolCalls: [], error: controller.signal.aborted ? 'timed out' : (error as Error).message };
  } finally { clearTimeout(timeout); }
}

async function runAgentis(task: EvalTask, config: { baseUrl: string; apiKey: string; workspaceId: string; agentId: string }): Promise<Observation> {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), task.timeoutMs ?? 180_000);
  try {
    const response = await fetch(`${config.baseUrl}/v1/conversations/${config.agentId}/send`, {
      method: 'POST',
      signal: controller.signal,
      headers: { authorization: `Bearer ${config.apiKey}`, 'x-agentis-workspace': config.workspaceId, accept: 'text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({ body: task.prompt, permissionMode: 'auto', useViewportContext: false }),
    });
    if (!response.ok || !response.body) throw new Error(`Agentis HTTP ${response.status}: ${await response.text()}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let finishReason: string | null = null;
    let streamError: string | null = null;
    const toolCalls: string[] = [];
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        try {
          const event = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
          text += extractEventText(event);
          if (event.type === 'done' && typeof event.finishReason === 'string') finishReason = event.finishReason;
          if (event.type === 'error') streamError = typeof event.error === 'string' ? event.error : 'Agentis stream error';
          const call = extractToolName(event);
          if (call) toolCalls.push(call);
        } catch { /* heartbeats and non-JSON events are intentionally ignored */ }
      }
    }
    const finalText = text.trim();
    const ok = !streamError && finishReason !== 'error' && finalText.length > 0;
    return {
      surface: 'agentis',
      taskId: task.id,
      ok,
      durationMs: Date.now() - started,
      text: finalText,
      toolCalls,
      ...(!ok ? { error: streamError ?? (finishReason === 'error' ? 'Agentis turn finished with error' : 'Agentis turn returned no answer') } : {}),
    };
  } catch (error) {
    return { surface: 'agentis', taskId: task.id, ok: false, durationMs: Date.now() - started, text: '', toolCalls: [], error: controller.signal.aborted ? 'timed out' : (error as Error).message };
  } finally { clearTimeout(timeout); }
}

function parseNativeOutput(stdout: string): { text: string; toolCalls: string[] } {
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  let text = '';
  const toolCalls: string[] = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      text += extractEventText(event);
      const call = extractToolName(event);
      if (call) toolCalls.push(call);
    } catch { text += `${line}\n`; }
  }
  return { text: text.trim(), toolCalls };
}

function extractEventText(event: Record<string, unknown>): string {
  const candidates = [event.delta, event.text, event.content, event.message, objectOf(event.msg).message, objectOf(event.item).text];
  const value = candidates.find((candidate) => typeof candidate === 'string');
  return typeof value === 'string' ? value : '';
}
function extractToolName(event: Record<string, unknown>): string | null {
  const value = event.name ?? event.tool ?? objectOf(event.item).name ?? objectOf(event.msg).name;
  return typeof value === 'string' ? value : null;
}
function score(task: EvalTask, observation: Observation): number {
  if (!observation.ok) return 0;
  const checks = [
    ...((task.assertions?.require ?? []).map((pattern) => new RegExp(pattern, 'iu').test(observation.text))),
    ...((task.assertions?.forbid ?? []).map((pattern) => !new RegExp(pattern, 'iu').test(observation.text))),
    observation.text.length >= (task.assertions?.minChars ?? 1),
  ];
  return checks.filter(Boolean).length / Math.max(1, checks.length);
}
function summarize(observation: Observation & { score: number }) { return { ok: observation.ok, score: observation.score, durationMs: observation.durationMs, toolCalls: observation.toolCalls.length, error: observation.error }; }
function objectOf(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function parseJsonEnv<T>(name: string): T | null { const raw = process.env[name]; return raw ? JSON.parse(raw) as T : null; }
