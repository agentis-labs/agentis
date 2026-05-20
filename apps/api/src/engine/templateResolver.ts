/**
 * Template resolver for workflow node configs.
 *
 * The engine evaluates `{{namespace.path.deep}}` placeholders against a snapshot of
 * the run context. Used for every text field a user can place a template in:
 * agent prompts, HTTP URLs/headers/bodies, transform/filter expressions,
 * integration input values, evaluator criteria, workflow_store keys, etc.
 *
 * Resolution is intentionally narrow:
 *   - Pure string interpolation. No code evaluation, no function calls.
 *   - Missing paths resolve to `''` and emit a structured warning. The engine
 *     surfaces these on the run's blockData so users can see what didn't resolve.
 *   - JSON literals (numbers, booleans, objects) inside `{{...}}` are stringified
 *     with `JSON.stringify` when the resolved value is non-string. This keeps the
 *     resolver useful for "give me the agent's whole output object as text."
 *
 * Forward compatibility note: brain-apps will add an `{{app.<tableName>.<field>}}`
 * namespace for app-scoped data lookups. The `TemplateContext` has a reserved
 * `apps` slot that the resolver already understands. On main it stays empty.
 */

export interface TemplateWarning {
  path: string;
  reason: 'missing_namespace' | 'missing_key' | 'invalid_index';
}

export interface TemplateContext {
  /** Trigger payload — the inputs that started this run. */
  trigger: Record<string, unknown>;
  /** Per-node outputs, keyed by node id. */
  nodes: Record<string, Record<string, unknown>>;
  /** Run-scoped scratchpad snapshot. */
  scratchpad: Record<string, unknown>;
  /** Workflow-scoped persistent store snapshot. */
  store: Record<string, unknown>;
  /** Loop-body context — only present inside a loop's child run. */
  loop?: { item: unknown; index: number };
  /** Brain-apps placeholder — left empty on main. */
  apps?: Record<string, Record<string, unknown>>;
  /** Out-param: warnings collected during resolution. */
  warnings?: TemplateWarning[];
}

const TEMPLATE_RE = /\{\{\s*([^{}\s][^{}]*?)\s*\}\}/g;

/** Resolve a single string. Returns the string with `{{...}}` placeholders replaced. */
export function resolveTemplate(text: string, ctx: TemplateContext): string {
  if (typeof text !== 'string' || text.indexOf('{{') === -1) return text;
  return text.replace(TEMPLATE_RE, (match, expression: string) => {
    const value = readPath(ctx, expression.trim());
    if (value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
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
  return readPath(ctx, expression.trim());
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
    case 'loop':
      root = ctx.loop;
      break;
    case 'apps':
      root = ctx.apps;
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

/**
 * Build a `TemplateContext` snapshot from a running engine context.
 *
 * Kept as a pure helper so `#dispatchNode()` can call it once per dispatch — the
 * resolver doesn't see the live RunningContext, only this immutable snapshot.
 */
export function buildTemplateContext(args: {
  /** Trigger inputs — first ready-queue item's inputData. */
  triggerInputs: Record<string, unknown>;
  /** Map of nodeId → completed-node outputData. */
  nodeOutputs: Record<string, Record<string, unknown>>;
  /** Run-scoped scratchpad snapshot. */
  scratchpad: Record<string, unknown>;
  /** Workflow-scoped store snapshot. */
  store: Record<string, unknown>;
  /** Loop iteration context, if any. */
  loop?: { item: unknown; index: number };
}): TemplateContext {
  return {
    trigger: args.triggerInputs,
    nodes: args.nodeOutputs,
    scratchpad: args.scratchpad,
    store: args.store,
    loop: args.loop,
    apps: {},
    warnings: [],
  };
}
