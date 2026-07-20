/**
 * §PERF-BOOT — boot-budget regression gate.
 *
 * The port once bound ~18s into boot because synchronous housekeeping (a full
 * knowledge-base repair, the baileys module graph) sat in front of it — and
 * nothing measured it, so it shipped. This test boots the REAL entry point on
 * a scratch data dir and asserts, from the /healthz boot profile, that the
 * stretch between "services wired" and "port bound" stays trivial. A PR that
 * re-introduces sync work on the pre-bind path fails here instead of shipping
 * an N-second regression.
 *
 * Budgets are deliberately generous (measured: 25ms; budget: 3s) — this gate
 * exists to catch seconds-scale regressions, not CI jitter.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PORT = 3900 + Math.floor(Math.random() * 900);
const API_DIR = resolve(__dirname, '..');
const TSX = resolve(API_DIR, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');

let child: ChildProcess | null = null;
let dataDir: string | null = null;

afterAll(() => {
  try { child?.kill(); } catch { /* best effort */ }
  try { if (dataDir) rmSync(dataDir, { recursive: true, force: true }); } catch { /* scratch */ }
});

interface BootProfile {
  ready: boolean;
  phases: Array<{ phase: string; atMs: number; deltaMs: number }>;
}

async function pollHealthz(timeoutMs: number): Promise<{ ok: boolean; boot: BootProfile }> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no attempt';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      if (res.ok) return await res.json() as { ok: boolean; boot: BootProfile };
      lastError = `status ${res.status}`;
    } catch (err) {
      lastError = (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`API never became reachable on :${PORT} — last error: ${lastError}`);
}

describe('boot budget', () => {
  it('binds the port within budget of services being wired', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'agentis-boot-budget-'));
    child = spawn(process.execPath, [TSX, 'src/index.ts'], {
      cwd: API_DIR,
      env: {
        ...process.env,
        AGENTIS_DATA_DIR: dataDir,
        AGENTIS_HTTP_PORT: String(PORT),
        // Keep the probe hermetic: no model download attempts from CI.
        AGENTIS_EMBEDDING_OFFLINE: 'true',
      },
      stdio: 'ignore',
    });

    const health = await pollHealthz(60_000);
    expect(health.ok).toBe(true);

    const at = (phase: string) => health.boot.phases.find((p) => p.phase === phase);
    // The profile itself is part of the contract — if these disappear, the
    // observability this gate depends on was removed.
    for (const phase of ['modules_loaded', 'foundation_wired', 'services_wired', 'port_bound']) {
      expect(at(phase), `missing boot phase '${phase}'`).toBeDefined();
    }

    // THE gate: nothing synchronous may creep between wiring and binding.
    const bindDelta = at('port_bound')!.atMs - at('services_wired')!.atMs;
    expect(bindDelta, `services_wired→port_bound took ${bindDelta}ms — sync work crept onto the pre-bind path`).toBeLessThan(3_000);

    // Wiring itself stays bounded on an empty DB (measured ~1.3s under tsx).
    const wireDelta = at('services_wired')!.atMs - at('modules_loaded')!.atMs;
    expect(wireDelta, `bootstrap wiring took ${wireDelta}ms on an empty DB`).toBeLessThan(15_000);
  }, 90_000);
});
