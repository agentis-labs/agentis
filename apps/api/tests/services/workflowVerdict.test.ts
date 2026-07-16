/**
 * Run Verdict engine — layer-3 truth. Hermetic: every probe arrives via
 * injected deps. Fences the outcome taxonomy (accomplished / failed_checks /
 * hollow / partial), the world-probe evidence, the anti-hollow detectors, and
 * the doctrine that the agent's self-report is never consulted.
 */
import { describe, expect, it } from 'vitest';
import { evaluateRunVerdict, terminalOutputPaths, type VerdictProbeDeps } from '../../src/services/workflow/workflowVerdict.js';
import type { WorkflowSpec } from '../../src/services/workflow/workflowSpec.js';

function spec(overrides: Partial<WorkflowSpec> = {}): WorkflowSpec {
  return {
    version: 1,
    objective: 'Deploy the store live',
    acceptance: [
      { id: 'live', claim: 'store is live', verify: 'http_probe', url: '{output.deploymentUrl}', expectStatus: 200, expectContains: 'Nova Store' },
    ],
    sufficiency: [{ key: 'deploymentUrl', nonEmpty: true, format: 'url' }],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function okFetch(body = '<h1>Nova Store</h1>', status = 200): typeof fetch {
  return (async () => new Response(body, { status })) as unknown as typeof fetch;
}

const BASE = {
  graphHash: 'hash1',
  trigger: {},
  mode: 'full' as const,
};

describe('evaluateRunVerdict — outcome taxonomy', () => {
  it('reports canonical terminal paths when an expr contract targets the wrong envelope', async () => {
    const output = {
      seen: { value: ['one'] },
      last_result: { value: { status: 'sent', receipt: { id: 'provider-1' } } },
    };
    expect(terminalOutputPaths({ renderAs: 'json', value: output })).toContain('output.last_result.value.status');

    const verdict = await evaluateRunVerdict({
      ...BASE,
      spec: spec({
        acceptance: [{ id: 'sent', claim: 'message sent', verify: 'expr', expr: "output.value.last_result.value.status == 'sent'" }],
        sufficiency: [],
      }),
      output,
      deps: {},
    });
    expect(verdict.outcome).toBe('failed_checks');
    expect(verdict.checks[0]!.evidence).toContain('available canonical paths:');
    expect(verdict.checks[0]!.evidence).toContain('output.last_result.value.status');
  });

  it('ACCOMPLISHED: the world answers — probe 200 + content + sufficiency clean', async () => {
    const verdict = await evaluateRunVerdict({
      ...BASE,
      spec: spec(),
      output: { deploymentUrl: 'https://store.vercel.app' },
      deps: { fetchImpl: okFetch(), allowPrivateNetwork: true },
    });
    expect(verdict.outcome).toBe('accomplished');
    expect(verdict.checks[0]!.passed).toBe(true);
    expect(verdict.checks[0]!.evidence).toMatch(/GET https:\/\/store\.vercel\.app → 200/);
    expect(verdict.deficiencies).toEqual([]);
  });

  it('FAILED_CHECKS: a 404 from the world beats any self-report (evidence carried)', async () => {
    const verdict = await evaluateRunVerdict({
      ...BASE,
      spec: spec(),
      // The run may CLAIM success in its output text — the verdict never reads claims.
      output: { deploymentUrl: 'https://store.vercel.app', status: 'deployed successfully!' },
      nodeOutputs: { deploy: { deploymentUrl: 'https://store.vercel.app' } },
      deps: { fetchImpl: okFetch('not found', 404), allowPrivateNetwork: true },
    });
    expect(verdict.outcome).toBe('failed_checks');
    expect(verdict.checks[0]!.evidence).toMatch(/404/);
    // Deficiency maps back to the producing node — the re-work target.
    expect(verdict.deficiencies[0]!.producingNodeIds).toEqual(['deploy']);
  });

  it('HOLLOW: typed-empty output + advisory stub text counted honestly', async () => {
    const verdict = await evaluateRunVerdict({
      ...BASE,
      spec: spec({
        acceptance: [{ id: 'has_report', claim: 'report exists', verify: 'expr', expr: 'output.report != ""' }],
        sufficiency: [{ key: 'products', minItems: 3 }],
      }),
      output: { products: [], report: 'To deploy this to Vercel, run vercel deploy', extra: '' },
      deps: {},
    });
    // expr passes (report is non-empty string) but the output is hollow.
    expect(verdict.outcome).toBe('hollow');
    expect(verdict.sufficiency.floorViolations.join(' ')).toMatch(/"products" requires ≥3 items; got 0/);
    expect(verdict.sufficiency.stubSuspects.join(' ')).toMatch(/advisory/i);
    expect(verdict.sufficiency.typedEmptyFills).toContain('extra');
    expect(verdict.deficiencies.length).toBeGreaterThan(0);
  });

  it('PARTIAL: nothing failed but a probe could not run here (browser unwired)', async () => {
    const verdict = await evaluateRunVerdict({
      ...BASE,
      spec: spec({
        acceptance: [{ id: 'looks', claim: 'page renders', verify: 'browser_probe', url: 'https://x.app', expectText: 'Store' }],
        sufficiency: [],
      }),
      output: { anything: 'fine' },
      deps: {},
    });
    expect(verdict.outcome).toBe('partial');
    expect(verdict.checks[0]!.unavailable).toBe(true);
  });
});

describe('evaluateRunVerdict — probes', () => {
  it('data_probe: queries the connector and evaluates the expr over the probe result', async () => {
    const calls: Array<{ integration: string; operation: string; params: Record<string, unknown> }> = [];
    const deps: VerdictProbeDeps = {
      runIntegration: async (integration, operation, params) => {
        calls.push({ integration, operation, params });
        return { rows: [{ id: 1 }, { id: 2 }] };
      },
    };
    const verdict = await evaluateRunVerdict({
      ...BASE,
      spec: spec({
        acceptance: [{ id: 'persisted', claim: 'rows exist', verify: 'data_probe', integration: 'supabase', operation: 'select', params: { table: 'orders', projectUrl: '{output.projectUrl}' }, expr: 'probe.rows.length >= 2' }],
        sufficiency: [],
      }),
      output: { projectUrl: 'https://p.supabase.co' },
      deps,
    });
    expect(verdict.outcome).toBe('accomplished');
    expect(calls[0]).toMatchObject({ integration: 'supabase', operation: 'select', params: { table: 'orders', projectUrl: 'https://p.supabase.co' } });
  });

  it('browser_probe: renders, checks text, persists the screenshot as evidence', async () => {
    const saved: string[] = [];
    const verdict = await evaluateRunVerdict({
      ...BASE,
      spec: spec({
        acceptance: [{ id: 'render', claim: 'page shows the store', verify: 'browser_probe', url: '{output.url}', expectText: 'Nova', screenshot: true }],
        sufficiency: [],
      }),
      output: { url: 'https://store.app' },
      deps: {
        browser: {
          navigate: async () => ({ title: 'Nova Store', text: 'Welcome to Nova', html: '<div id="root">Nova</div>' }),
          screenshot: async () => Buffer.from('png-bytes'),
        },
        saveEvidence: async (name) => { saved.push(name); return 'asset-123'; },
      },
    });
    expect(verdict.outcome).toBe('accomplished');
    expect(verdict.checks[0]!.evidenceAssetId).toBe('asset-123');
    expect(saved[0]).toMatch(/verdict-render\.png/);
  });

  it('judge: evidence-grounded, honors minScore, and is skipped under probes_only (→ partial, never fake-passed)', async () => {
    const judged: unknown[] = [];
    const judgeSpec = spec({
      acceptance: [{ id: 'quality', claim: 'copy is good', verify: 'judge', rubric: 'Strictly grade the store copy.', minScore: 7 }],
      sufficiency: [],
    });
    const full = await evaluateRunVerdict({
      ...BASE,
      spec: judgeSpec,
      output: { copy: 'Elegant essentials for every day.' },
      deps: { judge: async (a) => { judged.push(a); return { score: 8.5, passed: true, critique: 'On-brand, specific.' }; } },
    });
    expect(full.outcome).toBe('accomplished');
    expect(full.checks[0]!.evidence).toMatch(/judge 8\.5\/10/);
    expect((judged[0] as { target: { terminalOutput: unknown } }).target.terminalOutput).toEqual({ copy: 'Elegant essentials for every day.' });

    const probesOnly = await evaluateRunVerdict({
      ...BASE,
      spec: judgeSpec,
      output: { copy: 'x' },
      mode: 'probes_only',
      deps: { judge: async () => { throw new Error('must not be called'); } },
    });
    expect(probesOnly.outcome).toBe('partial');
    expect(probesOnly.checks[0]!.unavailable).toBe(true);
  });

  it('file_probe: the FILESYSTEM catches a fabricated harvest — dir empty ⇒ failed, real files ⇒ accomplished', async () => {
    // Regression case: agent_task "harvested 15 products" but assets/ was empty.
    const empty = await evaluateRunVerdict({
      ...BASE,
      spec: spec({
        acceptance: [{ id: 'harvested', claim: '15 products written to disk', verify: 'file_probe', path: '{output.assetsDir}', minFiles: 15 }],
        sufficiency: [],
      }),
      output: { assetsDir: '/brand/sample-brand/curated' },
      deps: { statPath: async () => null }, // disk says: does not exist
    });
    expect(empty.outcome).toBe('failed_checks');
    expect(empty.checks[0]!.evidence).toMatch(/does not exist on disk/);

    const tooFew = await evaluateRunVerdict({
      ...BASE,
      spec: spec({
        acceptance: [{ id: 'harvested', claim: '15 products written to disk', verify: 'file_probe', path: '{output.assetsDir}', minFiles: 15 }],
        sufficiency: [],
      }),
      output: { assetsDir: '/brand/sample-brand/curated' },
      deps: { statPath: async () => ({ isDir: true, fileCount: 3, totalBytes: 900 }) },
    });
    expect(tooFew.outcome).toBe('failed_checks');
    expect(tooFew.checks[0]!.evidence).toMatch(/NEEDS ≥15 files/);

    const real = await evaluateRunVerdict({
      ...BASE,
      spec: spec({
        acceptance: [{ id: 'harvested', claim: '15 products written to disk', verify: 'file_probe', path: '{output.assetsDir}', minFiles: 15, minBytes: 1000 }],
        sufficiency: [],
      }),
      output: { assetsDir: '/brand/sample-brand/curated' },
      deps: { statPath: async () => ({ isDir: true, fileCount: 15, totalBytes: 42000 }) },
    });
    expect(real.outcome).toBe('accomplished');
    expect(real.checks[0]!.evidence).toMatch(/15 file\(s\)/);
  });

  it('file_probe: unavailable when no filesystem accessor is wired (→ partial, never a false pass)', async () => {
    const verdict = await evaluateRunVerdict({
      ...BASE,
      spec: spec({
        acceptance: [{ id: 'x', claim: 'files exist', verify: 'file_probe', path: '/x' }],
        sufficiency: [],
      }),
      output: {},
      deps: {},
    });
    expect(verdict.outcome).toBe('partial');
    expect(verdict.checks[0]!.unavailable).toBe(true);
  });

  it('http_probe: an empty url template is a failure with a diagnosis, not a crash', async () => {
    const verdict = await evaluateRunVerdict({
      ...BASE,
      spec: spec({ sufficiency: [] }),
      output: {},   // run never produced deploymentUrl
      deps: { fetchImpl: okFetch() },
    });
    expect(verdict.outcome).toBe('failed_checks');
    expect(verdict.checks[0]!.evidence).toMatch(/resolved empty/);
  });
});
