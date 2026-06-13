/**
 * Template resolver for workflow node configs.
 *
 * The engine evaluates `{{namespace.path.deep}}` placeholders against a snapshot of
 * the run context. Used for every text field a user can place a template in:
 * agent prompts, HTTP URLs/headers/bodies, transform/filter expressions,
 * integration input values, evaluator criteria, workflow_store keys, etc.
 *
 * Resolution is intentionally narrow:
 *   - `{{path.to.value}}` stays pure path lookup.
 *   - `{{= expression }}` runs through `safeExpression.ts`, which exposes only the
 *     JSON-cloned template context and blocks Node globals.
 *   - Missing paths resolve to `''` and emit a structured warning. The engine
 *     surfaces these on the run's blockData so users can see what didn't resolve.
 *   - Non-string values inside mixed text templates are stringified with
 *     `JSON.stringify`; exact expression fields keep their typed value.
 */

import { evaluateExpression } from './safeExpression.js';

export interface TemplateWarning {
  path: string;
  reason: 'missing_namespace' | 'missing_key' | 'invalid_index';
}

export interface TemplateContext {
  /** Current node input (`$json` / `$input` in inline expressions). */
  input?: Record<string, unknown>;
  /** Trigger payload — the inputs that started this run. */
  trigger: Record<string, unknown>;
  /** Per-node outputs, keyed by node id. */
  nodes: Record<string, Record<string, unknown>>;
  /** Run-scoped scratchpad snapshot. */
  scratchpad: Record<string, unknown>;
  /** Workflow-scoped persistent store snapshot. */
  store: Record<string, unknown>;
  /** Workspace-scoped state (Tier 3): `{{workspace.id}}`, `{{workspace.kv.*}}`. */
  workspace?: { id?: string; kv: Record<string, unknown> };
  /** Current run metadata: `{{run.id}}`, `{{run.startedAt}}`, `{{run.triggeredBy}}`. */
  run?: { id?: string; startedAt?: string; triggeredBy?: string };
  /** Loop-body context — only present inside a loop's child run. */
  loop?: { item: unknown; index: number };
  /** Out-param: warnings collected during resolution. */
  warnings?: TemplateWarning[];
}

const TEMPLATE_RE = /\{\{\s*([\s\S]*?)\s*\}\}/g;
const EXACT_EXPRESSION_RE = /^\{\{\s*=([\s\S]*?)\s*\}\}$/;

/** Resolve a single string. Returns the string with `{{...}}` placeholders replaced. */
export function resolveTemplate(text: string, ctx: TemplateContext): string {
  if (typeof text !== 'string' || text.indexOf('{{') === -1) return text;
  return text.replace(TEMPLATE_RE, (_match, expression: string) => {
    const trimmed = expression.trim();
    const value = trimmed.startsWith('=')
      ? evaluateTemplateExpression(ctx, trimmed.slice(1).trim())
      : readPath(ctx, trimmed);
    if (value === undefined) return '';
    return stringifyTemplateValue(value);
  });
}

/**
 * Recursively resolve templates inside an object — applied to any node config field
 * that might contain user-typed templates. Arrays and nested objects are walked.
 * Primitive non-strings (numbers, booleans, null) pass through untouched.
 */
export function resolveTemplateDeep<T>(value: T, ctx: TemplateContext): T {
  if (value == null) return value;
  if (typeof value === 'string') {
    const exact = value.match(EXACT_EXPRESSION_RE);
    if (exact) {
      return evaluateTemplateExpression(ctx, exact[1]!.trim()) as unknown as T;
    }
    return resolveTemplate(value, ctx) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplateDeep(item, ctx)) as unknown as T;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveTemplateDeep(v, ctx);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Resolves a single template expression to its raw (non-stringified) value.
 * Used by `transform` / `filter` / `evaluator` / `guardrails` / `workflow_store`
 * — handlers that need the typed value, not a string render.
 *
 * Returns `undefined` if any segment in the path is missing.
 */
export function readTemplatePath(ctx: TemplateContext, expression: string): unknown {
  const trimmed = expression.trim();
  if (trimmed.startsWith('=')) return evaluateTemplateExpression(ctx, trimmed.slice(1).trim());
  return readPath(ctx, trimmed);
}

export interface TemplateReference {
  /** Raw expression inside `{{ }}`, trimmed. */
  raw: string;
  /** First path segment — a namespace (`trigger`, `nodes`, …) or a bare node id. */
  head: string;
  /** Remaining path segments after the head. */
  rest: string[];
}

/**
 * Extract every `{{...}}` reference from a string, parsed into head + path.
 * Shares the exact tokenizer the resolver uses at runtime, so static analysis
 * sees references the same way execution does. Returns [] for plain strings.
 */
export function extractTemplateReferences(text: string): TemplateReference[] {
  if (typeof text !== 'string' || text.indexOf('{{') === -1) return [];
  const refs: TemplateReference[] = [];
  // `matchAll` over a fresh regex so the shared global `TEMPLATE_RE` lastIndex
  // is never carried between calls.
  for (const m of text.matchAll(/\{\{\s*([\s\S]*?)\s*\}\}/g)) {
    const raw = m[1]!.trim();
    if (raw.startsWith('=')) {
      refs.push(...extractExpressionNodeReferences(raw.slice(1).trim()));
      continue;
    }
    const segments = tokenizePath(raw);
    if (segments.length === 0) continue;
    refs.push({ raw, head: segments[0]!, rest: segments.slice(1) });
  }
  return refs;
}

function extractExpressionNodeReferences(expression: string): TemplateReference[] {
  const refs: TemplateReference[] = [];
  const seen = new Set<string>();
  for (const match of expression.matchAll(/\$nodes\.([A-Za-z0-9_-]+)/g)) {
    const nodeId = match[1]!;
    const raw = `$nodes.${nodeId}`;
    if (seen.has(raw)) continue;
    seen.add(raw);
    refs.push({ raw, head: 'nodes', rest: [nodeId] });
  }
  return refs;
}

function readPath(ctx: TemplateContext, expression: string): unknown {
  // Tokenize: trigger.foo[0].bar  → ['trigger', 'foo', '0', 'bar']
  const segments = tokenizePath(expression);
  if (segments.length === 0) {
    pushWarning(ctx, expression, 'missing_namespace');
    return undefined;
  }

  const [head, ...rest] = segments;
  let root: unknown;
  switch (head) {
    case 'trigger':
      root = ctx.trigger;
      break;
    case 'nodes':
      root = ctx.nodes;
      break;
    case 'scratchpad':
      root = ctx.scratchpad;
      break;
    case 'store':
      root = ctx.store;
      break;
    case 'workspace':
      root = ctx.workspace;
      break;
    case 'run':
      root = ctx.run;
      break;
    case 'loop':
      root = ctx.loop;
      break;
    default:
      // Permissive fallback: allow callers to address `nodes.X.Y` without the
      // `nodes.` prefix. If the head matches a node id, treat it as such.
      if (head && ctx.nodes[head!]) {
        root = ctx.nodes[head!];
        break;
      }
      pushWarning(ctx, expression, 'missing_namespace');
      return undefined;
  }

  let cursor: unknown = root;
  for (const segment of rest) {
    if (cursor == null) {
      pushWarning(ctx, expression, 'missing_key');
      return undefined;
    }
    if (Array.isArray(cursor)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= cursor.length) {
        pushWarning(ctx, expression, 'invalid_index');
        return undefined;
      }
      cursor = cursor[index];
      continue;
    }
    if (typeof cursor === 'object') {
      const record = cursor as Record<string, unknown>;
      if (!(segment in record)) {
        pushWarning(ctx, expression, 'missing_key');
        return undefined;
      }
      cursor = record[segment];
      continue;
    }
    // Primitive — can't go deeper.
    pushWarning(ctx, expression, 'missing_key');
    return undefined;
  }
  return cursor;
}

/** Split `foo.bar[2].baz` into `['foo','bar','2','baz']`. */
function tokenizePath(expression: string): string[] {
  const out: string[] = [];
  let buf = '';
  for (let i = 0; i < expression.length; i += 1) {
    const c = expression.charAt(i);
    if (c === '.') {
      if (buf) {
        out.push(buf);
        buf = '';
      }
      continue;
    }
    if (c === '[') {
      if (buf) {
        out.push(buf);
        buf = '';
      }
      const end = expression.indexOf(']', i + 1);
      if (end === -1) {
        // Unterminated bracket — treat the rest as a single segment.
        out.push(expression.slice(i + 1));
        return out;
      }
      out.push(expression.slice(i + 1, end).replace(/['"]/g, ''));
      i = end;
      continue;
    }
    buf += c;
  }
  if (buf) out.push(buf);
  return out;
}

function pushWarning(ctx: TemplateContext, path: string, reason: TemplateWarning['reason']): void {
  if (!ctx.warnings) return;
  ctx.warnings.push({ path, reason });
}

function evaluateTemplateExpression(ctx: TemplateContext, expression: string): unknown {
  return evaluateExpression(expression, {
    input: ctx.input ?? ctx.trigger,
    ctx: {
      trigger: ctx.trigger,
      nodes: ctx.nodes,
      scratchpad: ctx.scratchpad,
      store: ctx.store,
      workspace: ctx.workspace,
      run: ctx.run,
      loop: ctx.loop,
    },
  });
}

function stringifyTemplateValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/**
 * Build a `TemplateContext` snapshot from a running engine context.
 *
 * Kept as a pure helper so `#dispatchNode()` can call it once per dispatch — the
 * resolver doesn't see the live RunningContext, only this immutable snapshot.
 */
export function buildTemplateContext(args: {
  inputData?: Record<string, unknown>;
  /** Trigger inputs — first ready-queue item's inputData. */
  triggerInputs: Record<string, unknown>;
  /** Map of nodeId → completed-node outputData. */
  nodeOutputs: Record<string, Record<string, unknown>>;
  /** Run-scoped scratchpad snapshot. */
  scratchpad: Record<string, unknown>;
  /** Workflow-scoped store snapshot. */
  store: Record<string, unknown>;
  /** Workspace-scoped KV snapshot (Tier 3) + workspace id. */
  workspace?: { id?: string; kv: Record<string, unknown> };
  /** Run metadata. */
  run?: { id?: string; startedAt?: string; triggeredBy?: string };
  /** Loop iteration context, if any. */
  loop?: { item: unknown; index: number };
}): TemplateContext {
  return {
    input: args.inputData ?? args.triggerInputs,
    trigger: args.triggerInputs,
    nodes: args.nodeOutputs,
    scratchpad: args.scratchpad,
    store: args.store,
    workspace: args.workspace,
    run: args.run,
    loop: args.loop,
    warnings: [],
  };
}
