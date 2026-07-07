/**
 * Workflow Spec — the SWIFT Scope artifact (SWIFT-WORKFLOW-QUALITY-10X §2-S).
 *
 * Captures the ONE question completion status cannot answer: *how will we KNOW
 * the run got exactly what was asked?* A spec is a persisted, machine-checkable
 * definition of done:
 *
 *  - `acceptance[]` — verifiable claims, each naming its verification METHOD
 *    (expr / http_probe / browser_probe / data_probe / judge). The verdict
 *    engine (`workflowVerdict.ts`) executes them against the WORLD at run
 *    settle — never against the run's self-report.
 *  - `sufficiency[]` — anti-hollow floors on terminal output keys (nonEmpty,
 *    minItems, minLength, format). The SHAPE contract stays on
 *    `graph.outputContract` (already enforced at settle); floors add "and it
 *    must not be hollow".
 *  - `constraints` — what the system may NOT do, compiled to enforcement
 *    (allowed services, mutation budget, approval classes, run budgets).
 *
 * Lives at `workflow.settings.spec`, reconciled to the graph content hash so a
 * graph edit honestly stales the scope. Pure module: no engine imports.
 */

import { evalCondition } from '../engine/SafeConditionParser.js';
import type { WorkflowGraph } from '@agentis/core';
import { graphContentHash } from './workflowCompass.js';

// ─── Shapes ──────────────────────────────────────────────────────────────────

export interface SufficiencyFloor {
  /** Terminal-output key the floor applies to. */
  key: string;
  nonEmpty?: boolean;
  minItems?: number;
  minLength?: number;
  format?: 'url' | 'email' | 'iso_date';
}

export type AcceptanceCheck = { id: string; claim: string } & (
  | { verify: 'expr'; expr: string }
  | { verify: 'http_probe'; url: string; expectStatus?: number; expectContains?: string }
  | { verify: 'browser_probe'; url: string; expectSelector?: string; expectText?: string; screenshot?: boolean }
  | { verify: 'data_probe'; integration: string; operation: string; params?: Record<string, unknown>; expr: string }
  // The filesystem IS the world for a local harvest/build. A `file_probe`
  // verifies that a step actually WROTE what it claimed (assets/, curated files,
  // a build dir) — the direct counter to an agent_task that fabricates "15
  // products harvested" while the directory is empty. `path` may template
  // `{output.key}`; checked against the real disk at run settle.
  | { verify: 'file_probe'; path: string; mustExist?: boolean; minFiles?: number; minBytes?: number }
  | { verify: 'judge'; rubric: string; minScore?: number }
);

export interface WorkflowSpecConstraints {
  /** integration/mcp services callable at run time. Absent = unrestricted. */
  allowedServices?: string[];
  /** Hard cap of external side-effecting calls (integration/mcp/extension) per run. */
  maxMutatingCalls?: number;
  requireApprovalFor?: Array<'delivery' | 'payment' | 'destructive_data'>;
  maxDurationMs?: number;
  maxCostCents?: number;
}

export interface WorkflowSpec {
  version: 1;
  /** One sentence: the job, frozen at scope time. */
  objective: string;
  acceptance: AcceptanceCheck[];
  sufficiency?: SufficiencyFloor[];
  constraints?: WorkflowSpecConstraints;
  /** Outcome re-work budget for PRODUCTION runs (debug always 0 — raw truth). */
  reworkBudget?: number;
  /** 'full' (probes + judge) or 'probes_only' (skip judge on production runs). */
  verification?: 'full' | 'probes_only';
  createdAt: string;
  /** Graph hash the spec was last confirmed against. */
  reconciledHash?: string;
}

// ─── Read / normalize ────────────────────────────────────────────────────────

export function readWorkflowSpec(settings: unknown): WorkflowSpec | null {
  const raw = settings && typeof settings === 'object' ? (settings as Record<string, unknown>).spec : undefined;
  if (!raw || typeof raw !== 'object') return null;
  const spec = raw as WorkflowSpec;
  if (!Array.isArray(spec.acceptance)) return null;
  return spec;
}

/** `{output.key}` template substitution for probe urls/params. */
export function renderOutputTemplate(template: string, output: Record<string, unknown>): string {
  return template.replace(/\{output\.([\w.]+)\}/gu, (_m, path: string) => {
    let value: unknown = output;
    for (const part of path.split('.')) {
      value = value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined;
    }
    return value === undefined || value === null ? '' : String(value);
  });
}

/** Output keys referenced by `{output.key}` templates in a string. */
function templatedOutputKeys(template: string): string[] {
  return [...template.matchAll(/\{output\.([\w.]+)\}/gu)].map((m) => m[1]!.split('.')[0]!);
}

// ─── Validation (mechanical, at scope time) ─────────────────────────────────

export interface SpecValidationArgs {
  /** Runnable services (connector catalog + mounted MCP slugs) for data_probe checks. */
  knownServices?: string[];
  /** When provided, probe `{output.key}` templates must reference declared contract keys. */
  graph?: WorkflowGraph;
}

/** Returns human-readable errors; empty array = valid. */
export function validateWorkflowSpec(spec: WorkflowSpec, args: SpecValidationArgs = {}): string[] {
  const errors: string[] = [];
  if (!spec.objective?.trim()) errors.push('objective is required — one sentence stating the job.');
  if (!Array.isArray(spec.acceptance) || spec.acceptance.length === 0) {
    errors.push('acceptance is required — at least one verifiable claim ("how will we KNOW it worked?").');
  }
  const declaredKeys = new Set(
    ((args.graph as { outputContract?: { fields?: Array<{ key: string }> } } | undefined)?.outputContract?.fields ?? [])
      .map((f) => f.key),
  );
  const seenIds = new Set<string>();
  for (const check of spec.acceptance ?? []) {
    const label = `acceptance "${check.id || check.claim || '?'}"`;
    if (!check.id?.trim()) errors.push(`${label}: id is required.`);
    else if (seenIds.has(check.id)) errors.push(`${label}: duplicate id.`);
    else seenIds.add(check.id);
    if (!check.claim?.trim()) errors.push(`${label}: claim is required.`);
    switch (check.verify) {
      case 'expr':
        if (!exprParses(check.expr)) errors.push(`${label}: expr does not parse ("${check.expr}").`);
        break;
      case 'http_probe':
      case 'browser_probe': {
        if (!check.url?.trim()) errors.push(`${label}: url is required.`);
        if (declaredKeys.size > 0) {
          for (const key of templatedOutputKeys(check.url ?? '')) {
            if (!declaredKeys.has(key)) {
              errors.push(`${label}: url references {output.${key}} but the graph outputContract declares no "${key}" key.`);
            }
          }
        }
        break;
      }
      case 'data_probe': {
        if (!check.integration?.trim()) errors.push(`${label}: integration is required.`);
        else if (args.knownServices && !args.knownServices.includes(check.integration)) {
          errors.push(`${label}: integration "${check.integration}" is not a runnable service in this workspace.`);
        }
        if (!check.operation?.trim()) errors.push(`${label}: operation is required.`);
        if (!exprParses(check.expr)) errors.push(`${label}: expr does not parse ("${check.expr}").`);
        break;
      }
      case 'file_probe': {
        if (!check.path?.trim()) errors.push(`${label}: path is required.`);
        if (declaredKeys.size > 0) {
          for (const key of templatedOutputKeys(check.path ?? '')) {
            if (!declaredKeys.has(key)) {
              errors.push(`${label}: path references {output.${key}} but the graph outputContract declares no "${key}" key.`);
            }
          }
        }
        break;
      }
      case 'judge':
        if (!check.rubric?.trim()) errors.push(`${label}: rubric is required for a judge check.`);
        break;
      default:
        errors.push(`${label}: unknown verify kind "${(check as { verify?: string }).verify}".`);
    }
  }
  for (const floor of spec.sufficiency ?? []) {
    if (!floor.key?.trim()) errors.push('sufficiency floor: key is required.');
    if (floor.minItems !== undefined && floor.minItems < 0) errors.push(`sufficiency "${floor.key}": minItems must be ≥ 0.`);
  }
  for (const svc of spec.constraints?.allowedServices ?? []) {
    if (args.knownServices && !args.knownServices.includes(svc)) {
      errors.push(`constraints.allowedServices: "${svc}" is not a runnable service in this workspace.`);
    }
  }
  return errors;
}

function exprParses(expr: string | undefined): boolean {
  if (!expr?.trim()) return false;
  try {
    evalCondition(expr, { output: {}, trigger: {}, nodes: {}, probe: {} });
    return true;
  } catch {
    return false;
  }
}

// ─── Derivation (deterministic templates — SWIFT §2-S1) ─────────────────────

export interface SpecDraftArgs {
  description: string;
  /** Runnable services available in the workspace (steers worldly checks). */
  services?: string[];
  graph?: WorkflowGraph;
}

export interface SpecDraftResult {
  spec: WorkflowSpec;
  /** Present when no WORLDLY (non-judge) check could be derived — the ONE
   *  pointed question the agent should ask the operator. */
  question?: string;
}

/**
 * Derive an acceptance draft from the request. Deterministic: pattern → check
 * templates keyed off intent verbs + available services. Judge is always
 * appended as the catch-all, but hardening requires ≥1 worldly check — when
 * none is derivable, the draft carries the elicitation question.
 */
export function deriveSpecDraft(args: SpecDraftArgs): SpecDraftResult {
  const description = args.description.trim();
  const lower = description.toLowerCase();
  const objective = firstSentence(description);
  const acceptance: AcceptanceCheck[] = [];
  const sufficiency: SufficiencyFloor[] = [];

  // Deploy/publish → the live-URL probe (the Fashion-Store lesson: a deploy
  // claim is only true when the URL answers).
  if (/\b(deploy|publish|launch|host)\b/.test(lower) || /\b(site|store|app|page)\b.*\b(live|online)\b/.test(lower)) {
    acceptance.push({
      id: 'live_url',
      claim: 'The deployed site is reachable and non-empty',
      verify: 'http_probe',
      url: '{output.deploymentUrl}',
      expectStatus: 200,
    });
    sufficiency.push({ key: 'deploymentUrl', nonEmpty: true, format: 'url' });
  }

  // "at least N <things>" → a minItems floor + an expr check on the collection.
  const atLeast = lower.match(/at least (\d+) (\w+)/);
  if (atLeast) {
    const [, count, noun] = atLeast;
    const key = (noun ?? 'items').replace(/s$/u, '') + 's';
    acceptance.push({
      id: `min_${key}`,
      claim: `The run produced at least ${count} ${key}`,
      verify: 'expr',
      expr: `output.${key}.length >= ${count}`,
    });
    sufficiency.push({ key, minItems: Number(count) });
  }

  // Persisted-data outcomes → a data probe when a data service is runnable.
  const dataService = (args.services ?? []).find((s) => ['supabase', 'postgres', 'airtable', 'mongodb', 'mysql'].includes(s));
  if (dataService && /\b(save|store|insert|record|persist|database|table)\b/.test(lower)) {
    acceptance.push({
      id: 'data_persisted',
      claim: `The records exist in ${dataService} after the run`,
      verify: 'data_probe',
      integration: dataService,
      operation: 'select',
      params: {},
      expr: 'probe.rows.length >= 1',
    });
  }

  const worldly = acceptance.length;
  // Judge — the catch-all for quality judgment, evidence-grounded at verdict time.
  acceptance.push({
    id: 'objective_met',
    claim: 'The final output fulfills the stated objective, with no placeholder or partial content',
    verify: 'judge',
    rubric: `Evaluate STRICTLY whether the run's final output fulfills: "${objective}". Fail empty, placeholder, truncated, or advisory-only content (e.g. instructions to do the work instead of the work).`,
    minScore: 7,
  });

  const spec: WorkflowSpec = {
    version: 1,
    objective,
    acceptance,
    ...(sufficiency.length > 0 ? { sufficiency } : {}),
    reworkBudget: 1,
    createdAt: new Date().toISOString(),
    ...(args.graph ? { reconciledHash: graphContentHash(args.graph) } : {}),
  };
  return worldly > 0
    ? { spec }
    : {
        spec,
        question:
          'No mechanically verifiable acceptance could be derived. When this run ends, what URL, record, file, or measurable value would PROVE it worked? (e.g. "GET {output.reportUrl} returns 200", "supabase table orders has ≥1 new row")',
      };
}

function firstSentence(text: string): string {
  const sentence = text.split(/[.!?\n]/)[0]?.trim() ?? text.trim();
  return sentence.length > 180 ? `${sentence.slice(0, 177)}…` : sentence;
}
