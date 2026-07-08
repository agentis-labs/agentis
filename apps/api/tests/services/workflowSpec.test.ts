/**
 * Workflow Spec (SWIFT Scope artifact) — validation is mechanical at scope
 * time (bad exprs, unknown services, undeclared template keys caught BEFORE a
 * run), and derivation produces worldly checks (or the elicitation question).
 */
import { describe, expect, it } from 'vitest';
import {
  deriveSpecDraft,
  readWorkflowSpec,
  renderOutputTemplate,
  validateWorkflowSpec,
  type WorkflowSpec,
} from '../../src/services/workflow/workflowSpec.js';
import type { WorkflowGraph } from '@agentis/core';

function baseSpec(overrides: Partial<WorkflowSpec> = {}): WorkflowSpec {
  return {
    version: 1,
    objective: 'Deploy the store',
    acceptance: [
      { id: 'live', claim: 'site is live', verify: 'http_probe', url: '{output.deploymentUrl}', expectStatus: 200 },
    ],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('validateWorkflowSpec', () => {
  it('accepts a well-formed spec', () => {
    expect(validateWorkflowSpec(baseSpec())).toEqual([]);
  });

  it('rejects an expr that does not parse', () => {
    const spec = baseSpec({ acceptance: [{ id: 'x', claim: 'c', verify: 'expr', expr: 'output..??' }] });
    expect(validateWorkflowSpec(spec).join(' ')).toMatch(/does not parse/);
  });

  it('rejects a data_probe against a service the workspace cannot run', () => {
    const spec = baseSpec({ acceptance: [{ id: 'd', claim: 'c', verify: 'data_probe', integration: 'nonexistent_db', operation: 'select', expr: 'probe.rows.length >= 1' }] });
    expect(validateWorkflowSpec(spec, { knownServices: ['supabase', 'vercel'] }).join(' ')).toMatch(/not a runnable service/);
  });

  it('accepts a file_probe and rejects one with no path', () => {
    const ok = baseSpec({ acceptance: [{ id: 'f', claim: 'assets on disk', verify: 'file_probe', path: '{output.assetsDir}', minFiles: 15 }] });
    expect(validateWorkflowSpec(ok)).toEqual([]);
    const bad = baseSpec({ acceptance: [{ id: 'f', claim: 'c', verify: 'file_probe', path: '' } as never] });
    expect(validateWorkflowSpec(bad).join(' ')).toMatch(/path is required/);
  });

  it('rejects a probe template referencing an undeclared output key', () => {
    const graph = {
      version: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [],
      outputContract: { fields: [{ key: 'reportUrl', type: 'string' }] },
    } as unknown as WorkflowGraph;
    const errors = validateWorkflowSpec(baseSpec(), { graph });
    expect(errors.join(' ')).toMatch(/declares no "deploymentUrl" key/);
  });

  it('requires at least one acceptance claim + duplicate-id detection', () => {
    expect(validateWorkflowSpec(baseSpec({ acceptance: [] })).join(' ')).toMatch(/at least one verifiable claim/);
    const dup = baseSpec({
      acceptance: [
        { id: 'a', claim: 'c1', verify: 'expr', expr: 'output.x == 1' },
        { id: 'a', claim: 'c2', verify: 'expr', expr: 'output.y == 2' },
      ],
    });
    expect(validateWorkflowSpec(dup).join(' ')).toMatch(/duplicate id/);
  });
});

describe('deriveSpecDraft', () => {
  it('derives a worldly http_probe + floors for a deploy request', () => {
    const { spec, question } = deriveSpecDraft({ description: 'Build a fashion store with at least 10 products and deploy it live.', services: ['vercel'] });
    expect(question).toBeUndefined();
    const kinds = spec.acceptance.map((c) => c.verify);
    expect(kinds).toContain('http_probe');
    expect(kinds).toContain('expr');       // at least 10 products
    expect(kinds).toContain('judge');      // catch-all, always last
    expect(spec.sufficiency).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'deploymentUrl', format: 'url' }),
      expect.objectContaining({ key: 'products', minItems: 10 }),
    ]));
    expect(spec.reworkBudget).toBe(1);
  });

  it('derives a data_probe when persistence is requested and a data service is runnable', () => {
    const { spec } = deriveSpecDraft({ description: 'Collect leads and save them to the database.', services: ['supabase'] });
    expect(spec.acceptance.some((c) => c.verify === 'data_probe' && (c as { integration: string }).integration === 'supabase')).toBe(true);
  });

  it('asks the ONE pointed question when nothing worldly is derivable', () => {
    const { spec, question } = deriveSpecDraft({ description: 'Think about strategy.' });
    expect(question).toMatch(/what URL, record, file, or measurable value/i);
    // Judge-only is still present so the spec is usable, but it cannot harden alone.
    expect(spec.acceptance.every((c) => c.verify === 'judge')).toBe(true);
  });
});

describe('helpers', () => {
  it('renderOutputTemplate substitutes nested output values', () => {
    expect(renderOutputTemplate('{output.deploy.url}/health', { deploy: { url: 'https://x.vercel.app' } }))
      .toBe('https://x.vercel.app/health');
    expect(renderOutputTemplate('{output.missing}', {})).toBe('');
  });

  it('readWorkflowSpec tolerates junk settings', () => {
    expect(readWorkflowSpec(null)).toBeNull();
    expect(readWorkflowSpec({ spec: { acceptance: 'nope' } })).toBeNull();
    expect(readWorkflowSpec({ spec: baseSpec() })?.objective).toBe('Deploy the store');
  });
});
