/**
 * Build-time expression validation + deterministic repair (WORKFLOW-RELIABILITY
 * Phase 1 / Phase 2 rung 0).
 *
 * `validateGraphReferences` already catches dangling `{{nodes.X}}` *template*
 * references. This sibling closes the other half of the gap: the JS expressions
 * inside `transform` / `filter` bodies and `{{= …}}` template expressions, which
 * the engine evaluates through `safeExpression` and which nothing checked before
 * a run. A free identifier that is not part of the unified Expression Contract
 * (AEC) — `payload`, `dat`, a misspelled `noeds` — used to ship clean and die at
 * runtime with "X is not defined". Here we catch it at `build_workflow` time and,
 * when it is a near-miss of a real contract name, repair it deterministically
 * (zero tokens) before it ever reaches the LLM self-healer.
 */

import type { WorkflowGraph, WorkflowNode } from '@agentis/core';
import { analyzeExpression, evaluateExpression, type SafeExpressionContext } from './safeExpression.js';

/** Canonical AEC roots (without the `$` alias prefix). Kept in sync with the
 *  preamble in safeExpression.ts. Used for near-miss repair. */
const CANONICAL_NAMES = [
  'input',
  'inputs',
  'output',
  'nodes',
  'trigger',
  'scratchpad',
  'store',
  'workspace',
  'run',
  'loop',
  'ctx',
] as const;

/** Every name (incl. `$`-aliases + JS globals authors legitimately use) that a
 *  reference is allowed to resolve to. A flagged identifier outside this set is
 *  what we treat as an unknown reference. */
const ALLOWED_REFERENCES = new Set<string>([
  ...CANONICAL_NAMES,
  ...CANONICAL_NAMES.map((n) => `$${n}`),
  '$json',
]);

export type ExpressionIssueCode = 'syntax_error' | 'unknown_reference' | 'blocked_token';

export interface ExpressionIssue {
  nodeId: string;
  nodeTitle: string;
  /** Which field the expression came from (`expression`, `condition`, or a config path for `{{=}}`). */
  field: string;
  /** The offending expression, clipped. */
  expression: string;
  severity: 'error' | 'warning';
  code: ExpressionIssueCode;
  identifier?: string;
  message: string;
}

interface ExtractedExpression {
  field: string;
  expression: string;
}

/** Collect the JS expressions a node feeds to safeExpression. */
function nodeExpressions(config: Record<string, unknown>): ExtractedExpression[] {
  const out: ExtractedExpression[] = [];
  const kind = config.kind;
  if (kind === 'transform' && typeof config.expression === 'string') {
    out.push({ field: 'expression', expression: config.expression });
  }
  if (kind === 'filter' && typeof config.condition === 'string') {
    out.push({ field: 'condition', expression: config.condition });
  }
  // `{{= … }}` template expressions can appear in any string field of any node.
  collectInlineExpressions(config, '', out);
  return out;
}

const INLINE_EXPRESSION_RE = /\{\{\s*=([\s\S]*?)\s*\}\}/g;

function collectInlineExpressions(value: unknown, path: string, out: ExtractedExpression[]): void {
  if (typeof value === 'string') {
    if (value.indexOf('{{') === -1) return;
    for (const m of value.matchAll(INLINE_EXPRESSION_RE)) {
      const expr = m[1]!.trim();
      if (expr) out.push({ field: path || 'config', expression: expr });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectInlineExpressions(item, `${path}[${i}]`, out));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      collectInlineExpressions(v, path ? `${path}.${k}` : k, out);
    }
  }
}

const clip = (s: string, n = 200): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Turn an expression diagnostic into a build issue, or `null` when it is not a
 * contract bug (ok / data-dependent runtime error / an allow-listed name). The
 * reference message carries a P4.3 "node grammar card": the contract for this
 * node kind plus a "did you mean" when the typo is a near-miss — so a flagged
 * expression tells the agent exactly what to use.
 */
function issueFromDiag(
  node: WorkflowNode,
  field: string,
  expression: string,
  diag: ReturnType<typeof analyzeExpression>,
): ExpressionIssue | null {
  if (diag.ok || diag.kind === 'runtime') return null;
  if (diag.kind === 'reference' && diag.identifier && ALLOWED_REFERENCES.has(diag.identifier)) return null;
  const base: Omit<ExpressionIssue, 'code' | 'message'> = {
    nodeId: node.id,
    nodeTitle: node.title ?? node.id,
    field,
    expression: clip(expression),
    severity: 'error',
    ...(diag.kind === 'reference' && diag.identifier ? { identifier: diag.identifier } : {}),
  };
  if (diag.kind === 'reference') {
    const suggestion = diag.identifier ? nearestCanonical(diag.identifier, { minTargetLength: 3 }) : null;
    return {
      ...base,
      code: 'unknown_reference',
      message:
        `Expression references "${diag.identifier}", which is not part of the Expression Contract. ` +
        `${nodeContractCard(node.config as unknown as Record<string, unknown>)}` +
        (suggestion ? ` Did you mean "${suggestion}"?` : ''),
    };
  }
  if (diag.kind === 'syntax') {
    return { ...base, code: 'syntax_error', message: `Expression has a syntax error: ${clip(diag.message, 160)}` };
  }
  return { ...base, code: 'blocked_token', message: `Expression uses a blocked token: ${clip(diag.message, 160)}` };
}

/** Per-node-kind expression contract card (P4.3). */
function nodeContractCard(config: Record<string, unknown>): string {
  const allowed = 'Allowed: input ($json), inputs, output, nodes["id"].field, trigger, scratchpad, store, workspace, run, loop.';
  if (config.kind === 'transform') return `A transform body returns a value (e.g. ({ x: input.field })). ${allowed}`;
  if (config.kind === 'filter') return `A filter condition returns a boolean (e.g. input.score > 5). ${allowed}`;
  return allowed;
}

/**
 * Validate every JS expression in the graph against the unified contract.
 * Pure; safe to call before `startRun` or inside `build_workflow`.
 */
export function validateGraphExpressions(graph: WorkflowGraph): ExpressionIssue[] {
  const issues: ExpressionIssue[] = [];
  for (const node of graph.nodes) {
    for (const { field, expression } of nodeExpressions(node.config as unknown as Record<string, unknown>)) {
      const issue = issueFromDiag(node, field, expression, analyzeExpression(expression));
      if (issue) issues.push(issue);
    }
  }
  return issues;
}

/**
 * Sample-data "dry run" (P4.1 — n8n pinned-data parity). The static probe in
 * `validateGraphExpressions` evaluates each expression against an EMPTY context,
 * so a reference error hidden behind a data access on empty input (`input.items`
 * → undefined → the later `payload` reference never reached) is masked. Here we
 * synthesize a representative sample from the workflow's inputContract + each
 * node's declared output keys, thread it through the graph in topological order,
 * and evaluate every expression against REALISTIC upstream data — unmasking those
 * references. Still zero false positives: only reference/syntax/blocked faults
 * are reported; data-shape (runtime) errors on the synthesized sample are ignored.
 */
export function dryRunGraphExpressions(graph: WorkflowGraph): ExpressionIssue[] {
  const issues: ExpressionIssue[] = [];
  const trigger = sampleFromContract(graph);
  const incoming = new Map<string, string[]>();
  for (const n of graph.nodes) incoming.set(n.id, []);
  for (const e of graph.edges) incoming.get(e.target)?.push(e.source);
  const outputs: Record<string, Record<string, unknown>> = {};

  for (const node of topoOrder(graph)) {
    const cfg = node.config as unknown as Record<string, unknown>;
    const preds = incoming.get(node.id) ?? [];
    const inputData = preds.length
      ? Object.assign({}, ...preds.map((p) => outputs[p] ?? {}))
      : trigger;
    const sampleCtx: SafeExpressionContext = {
      input: inputData,
      ctx: { trigger, nodes: outputs, scratchpad: {}, store: {}, workspace: { kv: {} }, run: {}, loop: undefined },
    };
    for (const { field, expression } of nodeExpressions(cfg)) {
      const issue = issueFromDiag(node, field, expression, analyzeExpression(expression, sampleCtx));
      if (issue) issues.push(issue);
    }
    outputs[node.id] = sampleNodeOutput(node, inputData, sampleCtx);
  }
  return issues;
}

/**
 * P0.5 (WORKFLOW-BUILD-LOOP): input-reachability lint. When a node NARROWS its
 * input via `inputKeys` (allow-list) or `inputMapping` (remap) but its own
 * expressions/templates still reference an `input.X` that the narrowing drops,
 * that field is `undefined` at runtime — the silent "empty payload" class that
 * `inputMapping` toggling causes (the Fashion-Store `scoredCount: 0`). Surfaced
 * at build time as an error. Zero false positives: only flags a field the node
 * explicitly references AND explicitly excludes.
 */
export function analyzeInputReachability(graph: WorkflowGraph): ExpressionIssue[] {
  const issues: ExpressionIssue[] = [];
  for (const node of graph.nodes) {
    const cfg = node.config as unknown as Record<string, unknown>;
    const available = scopedAvailableKeys(cfg);
    if (!available) continue; // no narrowing → the whole input passes through
    const via = Array.isArray(cfg.inputKeys) && (cfg.inputKeys as string[]).length > 0 ? 'inputKeys' : 'inputMapping';
    for (const { field, ref, expression } of referencedInputFields(cfg)) {
      if (available.has(ref)) continue;
      issues.push({
        nodeId: node.id,
        nodeTitle: node.title ?? node.id,
        field,
        expression: clip(expression),
        severity: 'error',
        code: 'unknown_reference',
        identifier: `input.${ref}`,
        message:
          `References input field "${ref}", but this node's ${via} keeps only ` +
          `{ ${[...available].join(', ')} } — "${ref}" is dropped and is undefined at runtime. ` +
          `Add "${ref}" to ${via}, or clear ${via} to pass the whole input through.`,
      });
    }
  }
  return issues;
}

/** Keys that survive a node's input narrowing, or null when it doesn't narrow. */
function scopedAvailableKeys(cfg: Record<string, unknown>): Set<string> | null {
  const inputKeys = Array.isArray(cfg.inputKeys) ? (cfg.inputKeys as string[]) : [];
  if (inputKeys.length > 0) return new Set(inputKeys);
  const inputMapping = cfg.inputMapping && typeof cfg.inputMapping === 'object'
    ? (cfg.inputMapping as Record<string, string>)
    : null;
  if (inputMapping && Object.keys(inputMapping).length > 0) return new Set(Object.keys(inputMapping));
  return null;
}

const INPUT_FIELD_REF_RE = /\b(?:input|inputs|\$input|\$inputs|\$json)\.([A-Za-z_$][\w$]*)/g;

/** Every `input.X` / `inputs.X` field reference across a node's string config. */
function referencedInputFields(config: Record<string, unknown>): Array<{ field: string; ref: string; expression: string }> {
  const out: Array<{ field: string; ref: string; expression: string }> = [];
  const seen = new Set<string>();
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      for (const m of value.matchAll(INPUT_FIELD_REF_RE)) {
        const ref = m[1]!;
        const key = `${path}:${ref}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ field: path || 'config', ref, expression: value });
      }
      return;
    }
    if (Array.isArray(value)) { value.forEach((v, i) => walk(v, `${path}[${i}]`)); return; }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, path ? `${path}.${k}` : k);
    }
  };
  walk(config, '');
  return out;
}

const INPUT_PATH2_RE = /\b(?:input|inputs|\$input|\$inputs|\$json)\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g;

/** Every 2-segment `input.a.b` read across a node's string config (ORGAN 1-deep). */
function referencedInputPaths(config: Record<string, unknown>): Array<{ first: string; second: string; field: string; expression: string }> {
  const out: Array<{ first: string; second: string; field: string; expression: string }> = [];
  const seen = new Set<string>();
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      for (const m of value.matchAll(INPUT_PATH2_RE)) {
        const first = m[1]!, second = m[2]!;
        const key = `${path}:${first}.${second}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ first, second, field: path || 'config', expression: value });
      }
      return;
    }
    if (Array.isArray(value)) { value.forEach((v, i) => walk(v, `${path}[${i}]`)); return; }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, path ? `${path}.${k}` : k);
    }
  };
  walk(config, '');
  return out;
}

/**
 * ORGAN 1 (UNBREAKABLE-WORKFLOW): typed edge-coupling check, deterministic-first.
 * Infers each node's produced TOP-LEVEL output keys — from a transform's object
 * literal, an agent's declared `outputKeys`, an extension's `outputMapping`, or a
 * passthrough kind — threads them topologically, and flags a node that READS an
 * `input.X` (or `nodes["id"].Y`) the producer provably does NOT emit. This is the
 * exact silent shape-mismatch behind the Fashion Store bug (reads `.signals`,
 * upstream produces `.evidence`) turned into a NAMED build error. Zero false
 * positives: only flags when the producing shape is FULLY KNOWN (closed) and the
 * key is definitively absent; any uncertainty (spread, opaque node, computed key)
 * → treated as OPEN and never flagged.
 */
export function analyzeEdgeCouplings(graph: WorkflowGraph): ExpressionIssue[] {
  const issues: ExpressionIssue[] = [];
  const incoming = new Map<string, string[]>();
  for (const n of graph.nodes) incoming.set(n.id, []);
  for (const e of graph.edges) { if (e.type !== 'error') incoming.get(e.target)?.push(e.source); }
  const outKeys = new Map<string, Set<string> | null>(); // null = open / unknown shape
  const outNested = new Map<string, Map<string, Set<string> | null> | null>(); // ORGAN 1-deep: one-level shapes
  const triggerKeys = contractKeys(graph);

  for (const node of topoOrder(graph)) {
    const cfg = node.config as unknown as Record<string, unknown>;
    const preds = incoming.get(node.id) ?? [];
    // Composed input keys = union of predecessor outputs; OPEN if any pred is open.
    let inputKeys: Set<string> | null;
    if (preds.length === 0) {
      inputKeys = triggerKeys ? new Set(triggerKeys) : null;
    } else {
      inputKeys = new Set<string>();
      for (const p of preds) {
        const po = outKeys.get(p);
        if (!po) { inputKeys = null; break; }
        for (const k of po) inputKeys.add(k);
      }
    }
    // Nested shape: a single-producer chain carries it through; a trigger contract
    // or a multi-predecessor merge is nested-unknown (conservative — never flags).
    const inputNested: Map<string, Set<string> | null> | null = preds.length === 1 ? (outNested.get(preds[0]!) ?? null) : null;

    // Only check nodes that do NOT narrow their input (narrowing is owned by
    // analyzeInputReachability), and only when the input shape is fully known.
    if (inputKeys && !scopedAvailableKeys(cfg)) {
      for (const { field, ref, expression } of referencedInputFields(cfg)) {
        if (inputKeys.has(ref)) continue;
        const near = nearestKey(ref, inputKeys);
        issues.push({
          nodeId: node.id, nodeTitle: node.title ?? node.id, field, expression: clip(expression),
          severity: 'error', code: 'unknown_reference', identifier: `input.${ref}`,
          message:
            `Reads input field "${ref}", but its upstream produces { ${[...inputKeys].join(', ') || '—'} } — `
            + `"${ref}" is never produced and resolves to undefined at runtime.`
            + (near ? ` Did you mean "${near}"?` : ''),
        });
      }
      for (const { ref, key, expression } of referencedNodeFields(cfg)) {
        const producer = outKeys.get(ref);
        if (!producer || producer.has(key)) continue;
        const near = nearestKey(key, producer);
        issues.push({
          nodeId: node.id, nodeTitle: node.title ?? node.id, field: 'config', expression: clip(expression),
          severity: 'error', code: 'unknown_reference', identifier: `nodes["${ref}"].${key}`,
          message:
            `Reads nodes["${ref}"].${key}, but node "${ref}" produces { ${[...producer].join(', ') || '—'} } — `
            + `"${key}" is never produced.` + (near ? ` Did you mean "${near}"?` : ''),
        });
      }
      // ORGAN 1-deep: a 2-segment read input.a.b where "a" IS produced but with a
      // KNOWN shape that lacks "b" (e.g. reads input.evidence.signals while evidence
      // is produced as { candidates } — the deeper Fashion-Store shape cut).
      for (const { first, second, field, expression } of referencedInputPaths(cfg)) {
        const sub = inputNested?.get(first);
        if (sub == null || sub.has(second)) continue; // absent-first is the flat check's job; opaque value → skip
        const near = nearestKey(second, sub);
        issues.push({
          nodeId: node.id, nodeTitle: node.title ?? node.id, field, expression: clip(expression),
          severity: 'error', code: 'unknown_reference', identifier: `input.${first}.${second}`,
          message:
            `Reads input.${first}.${second}, but "${first}" is produced as { ${[...sub].join(', ') || '—'} } — `
            + `"${second}" is never produced and resolves to undefined at runtime.`
            + (near ? ` Did you mean "${near}"?` : ''),
        });
      }
    }

    outKeys.set(node.id, inferNodeOutputKeys(node, cfg, inputKeys));
    outNested.set(node.id, inferNodeOutputNested(node, cfg, inputNested));
  }
  return issues;
}

/** Declared workflow-input keys, or null when no inputContract is declared. */
function contractKeys(graph: WorkflowGraph): Set<string> | null {
  const fields = (graph as { inputContract?: { fields?: Array<{ key?: string }> } }).inputContract?.fields;
  if (!Array.isArray(fields)) return null;
  const keys = new Set<string>();
  for (const f of fields) if (f && typeof f.key === 'string' && f.key) keys.add(f.key);
  return keys.size > 0 ? keys : null;
}

/** A node's produced top-level output keys, or null when the shape is open/unknown. */
function inferNodeOutputKeys(node: WorkflowNode, cfg: Record<string, unknown>, inputKeys: Set<string> | null): Set<string> | null {
  const kind = String(cfg.kind ?? node.type ?? '');
  if (['merge', 'parallel', 'wait', 'return_output', 'router', 'filter', 'trigger', 'guardrails', 'checkpoint', 'human_input'].includes(kind)) {
    return inputKeys; // passthrough — output shape is the input shape
  }
  if (kind === 'transform') {
    const expr = typeof cfg.expression === 'string' ? cfg.expression : '';
    if (/^\s*(inputs?|\$json|\$inputs?)\s*$/.test(expr)) return inputKeys; // bare passthrough
    const lit = extractObjectLiteralKeys(expr);
    return lit ? (lit.open ? null : lit.keys) : null;
  }
  if (kind === 'agent_task' || kind === 'agent_session' || kind === 'planner') {
    const ok = Array.isArray(cfg.outputKeys) ? (cfg.outputKeys as unknown[]).filter((k): k is string => typeof k === 'string' && k.length > 0) : [];
    return ok.length > 0 ? new Set(ok) : null;
  }
  if (kind === 'extension_task' || kind === 'subflow') {
    const om = cfg.outputMapping && typeof cfg.outputMapping === 'object' ? Object.keys(cfg.outputMapping as object) : [];
    return om.length > 0 ? new Set(om) : null;
  }
  return null; // integration / http_request / code / data_* / mcp / … → open
}

/**
 * Extract the TOP-LEVEL keys of a transform's returned object literal, plus an
 * `open` flag set on ANY uncertainty (spread, computed/quoted key, non-literal).
 * Conservative by design: `open` means "may have other keys" → the caller treats
 * the node's shape as unknown and never flags a downstream read against it.
 */
function extractObjectLiteralKeys(src: string): { keys: Set<string>; open: boolean; nested: Map<string, Set<string> | null> } | null {
  let s = src.trim();
  const ret = /^return\b/.exec(s);
  if (ret) s = s.slice(ret[0].length).trim();
  while (s.startsWith('(') && s.endsWith(')')) s = s.slice(1, -1).trim();
  if (!s.startsWith('{') || !s.endsWith('}')) return null;
  const body = s.slice(1, -1);
  const keys = new Set<string>();
  // nested[key] = the value's own top-level keys when it is an object literal, or
  // null when the value is opaque (a call, variable, array, spread, …). ORGAN 1-deep:
  // lets the caller check a 2-segment read like `input.evidence.signals`.
  const nested = new Map<string, Set<string> | null>();
  let open = false, depth = 0, expectKey = true, token = '';
  let curKey = '', valueStart = -1;
  let str: string | null = null;
  const flushPending = (): void => {
    const t = token.trim(); token = '';
    if (!t) return;
    if (t.startsWith('...')) { open = true; return; }
    if (/^[A-Za-z_$][\w$]*$/.test(t)) { keys.add(t); nested.set(t, null); } else open = true;
  };
  const flushValue = (endIdx: number): void => {
    if (!curKey) return;
    const inner = extractObjectLiteralKeys(body.slice(valueStart, endIdx).trim());
    nested.set(curKey, inner && !inner.open ? inner.keys : null);
    curKey = '';
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (str) { if (c === '\\') i++; else if (c === str) str = null; continue; }
    if (c === '"' || c === "'" || c === '`') { if (depth === 0 && expectKey) open = true; str = c; continue; }
    if (c === '{' || c === '[' || c === '(') { depth++; continue; }
    if (c === '}' || c === ']' || c === ')') { depth--; continue; }
    if (depth > 0) continue;
    if (c === ',') { if (expectKey) flushPending(); else flushValue(i); expectKey = true; token = ''; continue; }
    if (expectKey && c === ':') {
      const key = token.trim(); token = '';
      if (key.startsWith('...')) open = true;
      else if (/^[A-Za-z_$][\w$]*$/.test(key)) { keys.add(key); curKey = key; valueStart = i + 1; }
      else open = true;
      expectKey = false;
      continue;
    }
    if (expectKey) token += c;
  }
  if (expectKey) flushPending(); else flushValue(body.length);
  return { keys, open, nested };
}

/** A node's produced ONE-LEVEL nested shape (topKey → its own keys | null), or null. */
function inferNodeOutputNested(node: WorkflowNode, cfg: Record<string, unknown>, inputNested: Map<string, Set<string> | null> | null): Map<string, Set<string> | null> | null {
  const kind = String(cfg.kind ?? node.type ?? '');
  if (['merge', 'parallel', 'wait', 'return_output', 'router', 'filter', 'trigger', 'guardrails', 'checkpoint', 'human_input'].includes(kind)) {
    return inputNested; // passthrough
  }
  if (kind === 'transform') {
    const expr = typeof cfg.expression === 'string' ? cfg.expression : '';
    if (/^\s*(inputs?|\$json|\$inputs?)\s*$/.test(expr)) return inputNested;
    const lit = extractObjectLiteralKeys(expr);
    return lit && !lit.open ? lit.nested : null;
  }
  return null; // agents/extensions declare only top-level keys → nested unknown
}

const NODE_REF_BRACKET_RE = /\bnodes\s*\[\s*["']([A-Za-z0-9_-]+)["']\s*\]\s*\.\s*([A-Za-z_$][\w$]*)/g;
const NODE_REF_DOT_RE = /\bnodes\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g;

/** Every `nodes["id"].key` / `nodes.id.key` reference across a node's string config. */
function referencedNodeFields(config: Record<string, unknown>): Array<{ ref: string; key: string; expression: string }> {
  const out: Array<{ ref: string; key: string; expression: string }> = [];
  const seen = new Set<string>();
  const add = (ref: string, key: string, expression: string): void => {
    const k = `${ref}.${key}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ ref, key, expression });
  };
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const m of value.matchAll(NODE_REF_BRACKET_RE)) add(m[1]!, m[2]!, value);
      for (const m of value.matchAll(NODE_REF_DOT_RE)) add(m[1]!, m[2]!, value);
      return;
    }
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach(walk);
  };
  walk(config);
  return out;
}

function keyEditDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i]![0] = i;
  for (let j = 0; j <= n; j++) d[0]![j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[m]![n]!;
}

function nearestKey(ref: string, keys: Set<string>): string | null {
  let best: string | null = null, bestD = Infinity;
  for (const k of keys) {
    const dd = keyEditDistance(ref.toLowerCase(), k.toLowerCase());
    if (dd < bestD) { bestD = dd; best = k; }
  }
  return best && bestD <= 2 && bestD < ref.length ? best : null;
}

/** Kahn topological order; falls back to declaration order if the graph isn't a DAG. */
function topoOrder(graph: WorkflowGraph): WorkflowNode[] {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of graph.nodes) { indeg.set(n.id, 0); adj.set(n.id, []); }
  for (const e of graph.edges) {
    if (!indeg.has(e.target) || !adj.has(e.source)) continue;
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
    adj.get(e.source)!.push(e.target);
  }
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const queue = graph.nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const order: WorkflowNode[] = [];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (node) order.push(node);
    for (const next of adj.get(id) ?? []) {
      indeg.set(next, (indeg.get(next) ?? 1) - 1);
      if ((indeg.get(next) ?? 0) === 0) queue.push(next);
    }
  }
  for (const n of graph.nodes) if (!seen.has(n.id)) order.push(n); // cycle remnant
  return order;
}

/** Sample trigger payload from the workflow inputContract (by field type). */
function sampleFromContract(graph: WorkflowGraph): Record<string, unknown> {
  const fields = (graph as { inputContract?: { fields?: Array<{ key: string; type: string }> } }).inputContract?.fields;
  if (!Array.isArray(fields)) return {};
  const out: Record<string, unknown> = {};
  for (const f of fields) if (f?.key) out[f.key] = sampleByType(f.type);
  return out;
}

function sampleByType(type: string): unknown {
  switch (type) {
    case 'number': return 1;
    case 'boolean': return true;
    case 'array': return [{}];
    case 'object': return {};
    default: return 'sample';
  }
}

/** Synthesize a node's sample output so downstream expressions see realistic data. */
function sampleNodeOutput(
  node: WorkflowNode,
  inputData: Record<string, unknown>,
  sampleCtx: SafeExpressionContext,
): Record<string, unknown> {
  const cfg = node.config as unknown as Record<string, unknown>;
  if (cfg.kind === 'trigger') return inputData;
  if (cfg.kind === 'transform' && typeof cfg.expression === 'string') {
    try {
      const result = evaluateExpression<unknown>(cfg.expression, sampleCtx, { timeoutMs: 1_000 });
      if (cfg.outputKey && typeof cfg.outputKey === 'string') return { [cfg.outputKey]: result };
      if (result && typeof result === 'object' && !Array.isArray(result)) return result as Record<string, unknown>;
      return { value: result };
    } catch { return {}; }
  }
  if (cfg.kind === 'filter') return { passed: true, input: inputData };
  // Declared output keys → permissive array samples (support .map/.filter/.length).
  const keys = Array.isArray(cfg.outputKeys) ? cfg.outputKeys : cfg.outputKey ? [cfg.outputKey] : [];
  const out: Record<string, unknown> = {};
  for (const k of keys) if (typeof k === 'string' && k) out[k] = [];
  return out;
}

// ── Deterministic repair (Phase 2 rung 0) ──────────────────────────────────

export interface ExpressionRepair {
  expression: string;
  changed: boolean;
  rewrites: Array<{ from: string; to: string }>;
}

/**
 * Repair an expression whose only fault is a near-miss of a contract name
 * (`noeds`→`nodes`, `inpt`→`input`, `triger`→`trigger`). Conservative: it only
 * rewrites a free identifier the probe actually flagged as undefined, and only
 * to a canonical name within a small edit distance. Returns the original
 * untouched when no confident repair exists.
 */
export function repairExpressionReferences(expression: string): ExpressionRepair {
  const unchanged: ExpressionRepair = { expression, changed: false, rewrites: [] };
  const before = analyzeExpression(expression);
  // Nothing to repair if the expression already passes or only hits a
  // data-dependent (runtime) error — never rewrite a working expression.
  if (before.ok || before.kind === 'runtime') return unchanged;

  // Static scan for free identifiers (not a property access) that are a single
  // typo away from a length-safe contract name. Doing it statically — rather than
  // one-at-a-time via the probe — fixes EVERY typo in one pass, immune to the
  // execution-order masking that hides a later typo behind an earlier one.
  const rewrites: Array<{ from: string; to: string }> = [];
  const planned = new Map<string, string>();
  for (const m of expression.matchAll(/(?<![.\w$])(\$?[A-Za-z_][\w$]*)\b/g)) {
    const token = m[1]!;
    if (planned.has(token) || ALLOWED_REFERENCES.has(token) || token.length < 4) continue;
    const target = nearestCanonical(token, { minTargetLength: 5 });
    if (target) planned.set(token, target);
  }
  if (planned.size === 0) return unchanged;
  let current = expression;
  for (const [from, to] of planned) {
    current = current.replace(new RegExp(`(?<![.\\w$])${escapeRegExp(from)}\\b`, 'g'), to);
    rewrites.push({ from, to });
  }
  // Only accept the rewrite if it fully resolves the contract violation (no
  // remaining reference/syntax/blocked error). A partial fix (e.g. an unrelated
  // unknowable reference remains) is discarded so we never mask a real problem.
  const after = analyzeExpression(current);
  if (!after.ok && (after.kind === 'reference' || after.kind === 'syntax' || after.kind === 'blocked')) {
    return unchanged;
  }
  return { expression: current, changed: true, rewrites };
}

export interface GraphExpressionRepair {
  nodeId: string;
  field: 'expression' | 'condition';
  from: string;
  to: string;
}

/**
 * Apply `repairExpressionReferences` to the JS bodies the engine evaluates
 * through safeExpression (`transform.expression`, `filter.condition`) across the
 * whole graph, returning a new graph + the rewrites made. Immutable: untouched
 * nodes are returned by reference. Template (`{{= …}}`) expressions are reported
 * by `validateGraphExpressions` but not auto-rewritten here, to avoid mutating
 * surrounding template strings.
 */
export function repairGraphExpressions(graph: WorkflowGraph): {
  graph: WorkflowGraph;
  repairs: GraphExpressionRepair[];
} {
  const repairs: GraphExpressionRepair[] = [];
  const nodes = graph.nodes.map((node) => {
    const cfg = node.config as unknown as Record<string, unknown>;
    const field: 'expression' | 'condition' | null =
      cfg.kind === 'transform' && typeof cfg.expression === 'string'
        ? 'expression'
        : cfg.kind === 'filter' && typeof cfg.condition === 'string'
          ? 'condition'
          : null;
    if (!field) return node;
    const repair = repairExpressionReferences(cfg[field] as string);
    if (!repair.changed) return node;
    for (const w of repair.rewrites) repairs.push({ nodeId: node.id, field, from: w.from, to: w.to });
    return { ...node, config: { ...cfg, [field]: repair.expression } };
  });
  return { graph: { ...graph, nodes } as WorkflowGraph, repairs };
}

function nearestCanonical(identifier: string, opts: { minTargetLength?: number } = {}): string | null {
  const bare = identifier.replace(/^\$/, '').toLowerCase();
  // Budget of 1 with transposition-aware distance: catches a single typo of any
  // kind (insert/delete/substitute/transpose — `noeds`→`nodes`, `inpt`→`input`,
  // `triger`→`trigger`) while refusing risky 2-edit guesses like `state`→`store`.
  // `minTargetLength` guards against short-name collisions (`ran`→`run`).
  const min = opts.minTargetLength ?? 0;
  let best: { name: string; dist: number } | null = null;
  for (const name of CANONICAL_NAMES) {
    if (name.length < min) continue;
    if (bare === name) return null; // already canonical
    const dist = damerauOsa(bare, name);
    if (dist <= 1 && (!best || dist < best.dist)) best = { name, dist };
  }
  return best?.name ?? null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Optimal String Alignment distance (Levenshtein + adjacent transposition). */
function damerauOsa(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i += 1) d[i]![0] = i;
  for (let j = 0; j <= n; j += 1) d[0]![j] = j;
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (
        i > 1 &&
        j > 1 &&
        a.charCodeAt(i - 1) === b.charCodeAt(j - 2) &&
        a.charCodeAt(i - 2) === b.charCodeAt(j - 1)
      ) {
        d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
      }
    }
  }
  return d[m]![n]!;
}
