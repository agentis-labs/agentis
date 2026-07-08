/**
 * Run Verdict engine — SWIFT layer-3 truth (SWIFT-WORKFLOW-QUALITY-10X §2-T/V2).
 *
 * COMPLETED is a topology fact; ACCOMPLISHED is a world fact. After a run
 * settles, this module executes the spec's acceptance checks against the WORLD
 * — an HTTP probe of the deployed URL, a data probe of the datastore, a browser
 * render, an expression over the terminal output, and (last) an LLM judge over
 * the gathered evidence. It NEVER consults the run's self-report: an agent
 * claiming "deployed ✓" proves nothing; a 200 from the deployment URL does.
 *
 * Pipeline (deterministic first, judge last):
 *   1. sufficiency  — anti-hollow floors + typed-empty fills + stub detection (free)
 *   2. expr checks  — evalCondition over terminal output (free)
 *   3. world probes — http / browser / data (cheap, evidence-bearing)
 *   4. judge        — evaluator seam, evidence-grounded (routed, skippable)
 *
 * Outcome taxonomy:
 *   accomplished  — every check passed, no hollowness
 *   failed_checks — ≥1 check evaluated and failed
 *   hollow        — checks fine (or none ran) but the output is empty/stub/floor-violating
 *   partial       — nothing failed, but ≥1 check could not be verified here
 *
 * Pure module: all I/O arrives via injected deps (tests run hermetic).
 */

import { evalCondition } from '../../engine/SafeConditionParser.js';
import { assertSafeUrl } from '../safeUrl.js';
import {
  renderOutputTemplate,
  type AcceptanceCheck,
  type SufficiencyFloor,
  type WorkflowSpec,
} from './workflowSpec.js';

// ─── Shapes ──────────────────────────────────────────────────────────────────

export interface VerdictCheckResult {
  checkId: string;
  claim: string;
  passed: boolean;
  /** Human-readable proof: "GET https://… → 200 (4.1KB)", "judge 8.5/10: …". */
  evidence: string;
  /** Artifact id when the probe produced a persisted artifact (screenshot…). */
  evidenceAssetId?: string;
  /** True when the check could not be evaluated in this runtime (no browser, no judge). */
  unavailable?: boolean;
}

export interface VerdictDeficiency {
  checkId: string;
  claim: string;
  detail: string;
  /** Nodes whose output feeds the deficient key/claim — the re-work targets. */
  producingNodeIds: string[];
}

export interface RunVerdict {
  outcome: 'accomplished' | 'partial' | 'hollow' | 'failed_checks';
  at: string;
  graphHash: string;
  checks: VerdictCheckResult[];
  deficiencies: VerdictDeficiency[];
  sufficiency: {
    typedEmptyFills: string[];
    stubSuspects: string[];
    floorViolations: string[];
  };
  /** Outcome-heal bookkeeping (set by the engine when it re-works). */
  rework?: { attempts: number; nodesReworked: string[] };
}

export interface VerdictProbeDeps {
  /** http_probe transport. SSRF-guarded before use. */
  fetchImpl?: typeof fetch;
  /** browser_probe runtime (headless render). */
  browser?: {
    navigate(url: string): Promise<{ title: string; text: string; html: string }>;
    screenshot?(url: string): Promise<Buffer>;
  };
  /** data_probe — a connector invocation (credentials vault-resolved upstream). */
  runIntegration?: (integration: string, operation: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** file_probe — stat a local path (the filesystem is the world for a local
   *  harvest/build). Returns null when the path does not exist. Path-guarded by
   *  the caller (must resolve within an allowed root). */
  statPath?: (path: string) => Promise<{ isDir: boolean; fileCount: number; totalBytes: number } | null>;
  /** judge — the evaluator seam. */
  judge?: (args: { target: unknown; criteria: string }) => Promise<{ score: number; passed: boolean; critique: string }>;
  /** Persist probe evidence (screenshots, payload excerpts) as an artifact; returns its id. */
  saveEvidence?: (name: string, content: Buffer | string, mimeType: string) => Promise<string | undefined>;
  allowPrivateNetwork?: boolean;
  /** Per-probe timeout. */
  timeoutMs?: number;
}

export interface EvaluateRunVerdictArgs {
  spec: WorkflowSpec;
  graphHash: string;
  /** Terminal output surface (engine's collectFinalOutput). */
  output: Record<string, unknown>;
  /** Per-node outputs — expr `nodes.*` scope + producing-node mapping. */
  nodeOutputs?: Record<string, Record<string, unknown>>;
  trigger?: Record<string, unknown>;
  /** 'probes_only' skips judge checks (they report unavailable→partial). */
  mode: 'full' | 'probes_only';
  deps: VerdictProbeDeps;
}

const DEFAULT_PROBE_TIMEOUT_MS = 12_000;

/**
 * A `return_output` node wraps its payload as `{ renderAs, title?, value }`
 * (a VIEWER envelope). Acceptance checks target the DATA, so terminal-surface
 * outputs are unwrapped before evaluation: a record value becomes the record,
 * a scalar/array value becomes `{ value }`.
 */
export function unwrapReturnEnvelope(out: Record<string, unknown>): Record<string, unknown> {
  if ('value' in out && 'renderAs' in out) {
    const value = out.value;
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    return { value };
  }
  return out;
}

/** Placeholder / advisory patterns — the "gutted node" + "run vercel deploy" pathologies. */
const STUB_PATTERNS: RegExp[] = [
  /\blorem ipsum\b/i,
  /\bplaceholder\b/i,
  /\bTODO\b|\bTBD\b|\bFIXME\b/,
  /<[A-Z][A-Z0-9_]{2,}>/,          // <YOUR_KEY>, <INSERT_NAME>
  /\bYOUR_[A-Z_]+\b|\bINSERT_[A-Z_]+\b/,
  /\bexample\.com\b/i,
  /^to (deploy|run|do|complete) this\b/i,
  /\brun the following command\b/i,
];

// ─── Entry point ─────────────────────────────────────────────────────────────

export async function evaluateRunVerdict(args: EvaluateRunVerdictArgs): Promise<RunVerdict> {
  const { spec, output } = args;
  const sufficiency = evaluateSufficiency(spec.sufficiency ?? [], output);
  const checks: VerdictCheckResult[] = [];
  for (const check of spec.acceptance ?? []) {
    checks.push(await runCheck(check, args));
  }

  const realFailures = checks.filter((c) => !c.passed && !c.unavailable);
  const unavailable = checks.filter((c) => c.unavailable);
  const hollow = sufficiency.typedEmptyFills.length > 0
    || sufficiency.stubSuspects.length > 0
    || sufficiency.floorViolations.length > 0;

  const outcome: RunVerdict['outcome'] = realFailures.length > 0
    ? 'failed_checks'
    : hollow
      ? 'hollow'
      : unavailable.length > 0
        ? 'partial'
        : 'accomplished';

  const deficiencies: VerdictDeficiency[] = [
    ...realFailures.map((c) => ({
      checkId: c.checkId,
      claim: c.claim,
      detail: c.evidence,
      producingNodeIds: producingNodes(checkKeys(spec, c.checkId), args.nodeOutputs ?? {}),
    })),
    ...sufficiency.floorViolations.map((v) => deficiencyForKey('sufficiency', v, args.nodeOutputs ?? {})),
    ...sufficiency.typedEmptyFills.map((k) => deficiencyForKey('empty_output', `"${k}" is empty in the terminal output`, args.nodeOutputs ?? {}, k)),
    ...sufficiency.stubSuspects.map((s) => deficiencyForKey('stub_output', s, args.nodeOutputs ?? {})),
  ];

  return {
    outcome,
    at: new Date().toISOString(),
    graphHash: args.graphHash,
    checks,
    deficiencies,
    sufficiency,
  };
}

function deficiencyForKey(
  checkId: string,
  detail: string,
  nodeOutputs: Record<string, Record<string, unknown>>,
  key?: string,
): VerdictDeficiency {
  const inferredKey = key ?? detail.match(/^"([\w.]+)"/)?.[1];
  return {
    checkId,
    claim: detail,
    detail,
    producingNodeIds: inferredKey ? producingNodes([inferredKey], nodeOutputs) : [],
  };
}

/** Output keys a check touches (probe url templates, expr `output.x` refs). */
function checkKeys(spec: WorkflowSpec, checkId: string): string[] {
  const check = spec.acceptance.find((c) => c.id === checkId);
  if (!check) return [];
  const sources: string[] = [];
  if ('url' in check && check.url) sources.push(check.url);
  if ('expr' in check && check.expr) sources.push(check.expr);
  if ('params' in check && check.params) sources.push(JSON.stringify(check.params));
  const keys = new Set<string>();
  for (const src of sources) {
    for (const m of src.matchAll(/output\.([\w]+)/gu)) keys.add(m[1]!);
    for (const m of src.matchAll(/\{output\.([\w]+)/gu)) keys.add(m[1]!);
  }
  return [...keys];
}

/** Nodes whose outputData contains any of the given keys — the re-work targets. */
function producingNodes(keys: string[], nodeOutputs: Record<string, Record<string, unknown>>): string[] {
  if (keys.length === 0) return [];
  const out: string[] = [];
  for (const [nodeId, data] of Object.entries(nodeOutputs)) {
    if (data && typeof data === 'object' && keys.some((k) => k in data)) out.push(nodeId);
  }
  return out;
}

// ─── 1. Sufficiency (anti-hollow, free) ──────────────────────────────────────

function evaluateSufficiency(
  floors: SufficiencyFloor[],
  output: Record<string, unknown>,
): RunVerdict['sufficiency'] {
  const floorViolations: string[] = [];
  for (const floor of floors) {
    const value = output[floor.key];
    if (floor.nonEmpty && isEmptyValue(value)) {
      floorViolations.push(`"${floor.key}" must be non-empty; got ${describeValue(value)}`);
      continue;
    }
    if (floor.minItems !== undefined) {
      const length = Array.isArray(value) ? value.length : -1;
      if (length < floor.minItems) floorViolations.push(`"${floor.key}" requires ≥${floor.minItems} items; got ${length < 0 ? describeValue(value) : length}`);
    }
    if (floor.minLength !== undefined && typeof value === 'string' && value.trim().length < floor.minLength) {
      floorViolations.push(`"${floor.key}" requires ≥${floor.minLength} chars; got ${value.trim().length}`);
    }
    if (floor.format && typeof value === 'string' && value.trim() && !matchesFormat(value.trim(), floor.format)) {
      floorViolations.push(`"${floor.key}" is not a valid ${floor.format}: "${value.slice(0, 80)}"`);
    }
  }

  // Typed-empty fills: keys present but hollow ('' / [] / {}). The engine's
  // contract layer rightly stopped crashes with typed-empty defaults — the
  // verdict layer refuses to count them as success.
  const typedEmptyFills = Object.entries(output)
    .filter(([, v]) => isEmptyValue(v) && v !== undefined && v !== null)
    .map(([k]) => k);

  // Stub detection over string values (depth 1).
  const stubSuspects: string[] = [];
  for (const [key, value] of Object.entries(output)) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const pattern = STUB_PATTERNS.find((p) => p.test(value));
    if (pattern) stubSuspects.push(`"${key}" looks like placeholder/advisory content (${pattern.source.slice(0, 40)}): "${value.slice(0, 100)}"`);
    if (stubSuspects.length >= 5) break;
  }

  return { typedEmptyFills, stubSuspects, floorViolations };
}

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as object).length === 0;
  return false;
}

function describeValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  const raw = JSON.stringify(value) ?? String(value);
  return raw.length > 60 ? `${raw.slice(0, 57)}…` : raw;
}

function matchesFormat(value: string, format: NonNullable<SufficiencyFloor['format']>): boolean {
  switch (format) {
    case 'url': return /^https?:\/\/[^\s]+$/i.test(value);
    case 'email': return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    case 'iso_date': return !Number.isNaN(Date.parse(value));
  }
}

// ─── 2–4. Checks ─────────────────────────────────────────────────────────────

async function runCheck(check: AcceptanceCheck, args: EvaluateRunVerdictArgs): Promise<VerdictCheckResult> {
  const base = { checkId: check.id, claim: check.claim };
  try {
    switch (check.verify) {
      case 'expr': {
        const scope = { output: args.output, trigger: args.trigger ?? {}, nodes: args.nodeOutputs ?? {}, probe: {} };
        const passed = evalCondition(check.expr, scope);
        return { ...base, passed, evidence: `expr "${check.expr}" → ${passed} over the terminal output` };
      }
      case 'http_probe': return await httpProbe(check, args, base);
      case 'browser_probe': return await browserProbe(check, args, base);
      case 'data_probe': return await dataProbe(check, args, base);
      case 'file_probe': return await fileProbe(check, args, base);
      case 'judge': return await judgeCheck(check, args, base);
    }
  } catch (err) {
    return { ...base, passed: false, evidence: `check error: ${(err as Error).message}` };
  }
}

async function fileProbe(
  check: Extract<AcceptanceCheck, { verify: 'file_probe' }>,
  args: EvaluateRunVerdictArgs,
  base: { checkId: string; claim: string },
): Promise<VerdictCheckResult> {
  const stat = args.deps.statPath;
  if (!stat) return { ...base, passed: false, unavailable: true, evidence: 'file probe unavailable in this runtime (no filesystem accessor wired)' };
  const path = renderOutputTemplate(check.path, args.output).trim();
  if (!path) return { ...base, passed: false, evidence: `path template "${check.path}" resolved empty — the run produced no value for it` };
  const info = await stat(path);
  if (!info) {
    // The direct counter to fabrication: the step CLAIMED to write files; the
    // disk says otherwise.
    return { ...base, passed: check.mustExist === false, evidence: `path "${path}" does not exist on disk` };
  }
  const minFiles = check.minFiles ?? 0;
  const filesOk = info.fileCount >= minFiles;
  const bytesOk = check.minBytes === undefined ? true : info.totalBytes >= check.minBytes;
  const passed = filesOk && bytesOk;
  const detail = [
    `"${path}" exists (${info.isDir ? 'dir' : 'file'}, ${info.fileCount} file(s), ${info.totalBytes} bytes)`,
    minFiles > 0 ? (filesOk ? `≥${minFiles} files` : `NEEDS ≥${minFiles} files`) : '',
    check.minBytes !== undefined ? (bytesOk ? `≥${check.minBytes}B` : `NEEDS ≥${check.minBytes}B`) : '',
  ].filter(Boolean).join(', ');
  return { ...base, passed, evidence: detail };
}

async function httpProbe(
  check: Extract<AcceptanceCheck, { verify: 'http_probe' }>,
  args: EvaluateRunVerdictArgs,
  base: { checkId: string; claim: string },
): Promise<VerdictCheckResult> {
  const url = renderOutputTemplate(check.url, args.output).trim();
  if (!url) return { ...base, passed: false, evidence: `url template "${check.url}" resolved empty — the run produced no value for it` };
  const fetchImpl = args.deps.fetchImpl ?? fetch;
  const safeUrl = await assertSafeUrl(url, { allowPrivate: args.deps.allowPrivateNetwork ?? false });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  (timer as { unref?: () => void }).unref?.();
  try {
    const res = await fetchImpl(safeUrl, { method: 'GET', redirect: 'follow', signal: controller.signal });
    const text = await res.text().catch(() => '');
    const statusOk = check.expectStatus !== undefined ? res.status === check.expectStatus : res.status >= 200 && res.status < 300;
    const containsOk = check.expectContains ? text.includes(check.expectContains) : true;
    const passed = statusOk && containsOk;
    const detail = [
      `GET ${url} → ${res.status} (${text.length} bytes)`,
      check.expectContains ? (containsOk ? `contains "${check.expectContains}"` : `MISSING "${check.expectContains}"`) : '',
    ].filter(Boolean).join(', ');
    return { ...base, passed, evidence: detail };
  } catch (err) {
    return { ...base, passed: false, evidence: `GET ${url} failed: ${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

async function browserProbe(
  check: Extract<AcceptanceCheck, { verify: 'browser_probe' }>,
  args: EvaluateRunVerdictArgs,
  base: { checkId: string; claim: string },
): Promise<VerdictCheckResult> {
  const url = renderOutputTemplate(check.url, args.output).trim();
  if (!url) return { ...base, passed: false, evidence: `url template "${check.url}" resolved empty` };
  const browser = args.deps.browser;
  if (!browser) return { ...base, passed: false, unavailable: true, evidence: 'browser probe unavailable in this runtime — verify manually or via http_probe' };
  try {
    const page = await browser.navigate(url);
    const textOk = check.expectText ? page.text.includes(check.expectText) : true;
    const selectorOk = check.expectSelector
      ? page.html.includes(check.expectSelector) || page.html.includes(check.expectSelector.replace(/^[#.]/u, ''))
      : true;
    const nonEmpty = page.text.trim().length > 0;
    const passed = nonEmpty && textOk && selectorOk;
    let evidenceAssetId: string | undefined;
    if (check.screenshot && browser.screenshot && args.deps.saveEvidence) {
      try {
        const shot = await browser.screenshot(url);
        evidenceAssetId = await args.deps.saveEvidence(`verdict-${check.id}.png`, shot, 'image/png');
      } catch { /* screenshot is bonus evidence, never fatal */ }
    }
    const detail = [
      `rendered ${url} (${page.text.length} chars${page.title ? `, title "${page.title.slice(0, 60)}"` : ''})`,
      check.expectText ? (textOk ? `has text "${check.expectText}"` : `MISSING text "${check.expectText}"`) : '',
      check.expectSelector ? (selectorOk ? `has "${check.expectSelector}"` : `MISSING "${check.expectSelector}"`) : '',
      nonEmpty ? '' : 'PAGE EMPTY',
    ].filter(Boolean).join(', ');
    return { ...base, passed, evidence: detail, ...(evidenceAssetId ? { evidenceAssetId } : {}) };
  } catch (err) {
    return { ...base, passed: false, evidence: `browser render of ${url} failed: ${(err as Error).message}` };
  }
}

async function dataProbe(
  check: Extract<AcceptanceCheck, { verify: 'data_probe' }>,
  args: EvaluateRunVerdictArgs,
  base: { checkId: string; claim: string },
): Promise<VerdictCheckResult> {
  const run = args.deps.runIntegration;
  if (!run) return { ...base, passed: false, unavailable: true, evidence: 'data probe unavailable in this runtime (no connector runner wired)' };
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(check.params ?? {})) {
    params[k] = typeof v === 'string' ? renderOutputTemplate(v, args.output) : v;
  }
  try {
    const result = await run(check.integration, check.operation, params);
    const passed = evalCondition(check.expr, { probe: result, output: args.output, trigger: args.trigger ?? {}, nodes: args.nodeOutputs ?? {} });
    return {
      ...base,
      passed,
      evidence: `${check.integration}.${check.operation} probed; expr "${check.expr}" → ${passed} (probe: ${describeValue(result)})`,
    };
  } catch (err) {
    return { ...base, passed: false, evidence: `${check.integration}.${check.operation} probe failed: ${(err as Error).message}` };
  }
}

async function judgeCheck(
  check: Extract<AcceptanceCheck, { verify: 'judge' }>,
  args: EvaluateRunVerdictArgs,
  base: { checkId: string; claim: string },
): Promise<VerdictCheckResult> {
  if (args.mode === 'probes_only') {
    return { ...base, passed: false, unavailable: true, evidence: 'judge skipped (verification: probes_only)' };
  }
  const judge = args.deps.judge;
  if (!judge) return { ...base, passed: false, unavailable: true, evidence: 'judge unavailable in this runtime (no evaluator wired)' };
  try {
    const verdict = await judge({
      // Evidence-grounded: the judge sees the objective + terminal output — and
      // never a self-report narrative.
      target: { objective: args.spec.objective, terminalOutput: args.output },
      criteria: check.rubric,
    });
    const passed = check.minScore !== undefined ? verdict.score >= check.minScore : verdict.passed;
    return {
      ...base,
      passed,
      evidence: `judge ${verdict.score}/10${check.minScore !== undefined ? ` (min ${check.minScore})` : ''}: ${verdict.critique.slice(0, 200)}`,
    };
  } catch (err) {
    return { ...base, passed: false, unavailable: true, evidence: `judge errored: ${(err as Error).message}` };
  }
}
