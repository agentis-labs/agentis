/**
 * Tiny sandbox for `transform` / `filter` node expressions.
 *
 * What it allows:
 *   - Pure JS expressions that read from `input` and the `ctx.*` snapshot.
 *   - Access to `JSON`, `Math`, `Date.now`, and `String/Number/Boolean/Array/Object`.
 *
 * What it blocks:
 *   - `require`, `import`, `process`, `globalThis`, `eval`, `Function`, network,
 *     filesystem, child processes, timers — every API that touches the outside
 *     world.
 *
 * The implementation runs the expression inside a `Function` constructor with the
 * arguments shadowing every dangerous global. It's not a hard security boundary
 * (a determined attacker who can write workflow expressions can probably do more
 * harm via the agent prompt anyway), but it catches accidents and obvious abuse.
 *
 * For untrusted user code, the proper sandbox lives in the node_worker skill
 * runtime (isolated-vm). Transform/filter expressions are operator-written and
 * trust-equivalent to agent prompts.
 */

// Globals we shadow by passing them as `undefined` parameters. NOTE: strict
// mode forbids `eval` and `arguments` as parameter names, so those two are
// covered by the static guard regex (BLOCKED_PATTERNS) only.
const BLOCKED_GLOBALS: ReadonlyArray<string> = [
  'globalThis',
  'global',
  'self',
  'window',
  'process',
  'require',
  'module',
  'exports',
  '__dirname',
  '__filename',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'clearTimeout',
  'clearInterval',
  'clearImmediate',
  'queueMicrotask',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
];

const BLOCKED_PATTERNS: ReadonlyArray<RegExp> = [
  /\bimport\s*\(/,
  /\brequire\s*\(/,
  /\bFunction\s*\(/,
  /\beval\s*\(/,
  /\beval\b/,
  /\barguments\b/,
  /\bprocess\b/,
  /\bglobalThis\b/,
  /\b__proto__\b/,
  /\bconstructor\s*\[/,
  /\bconstructor\s*\./,
];

/** Throws on syntactically dangerous expressions. */
function staticGuard(expression: string): void {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(expression)) {
      throw new Error(`expression rejected: contains blocked token ${pattern}`);
    }
  }
}

export interface SafeExpressionContext {
  input: unknown;
  ctx?: Record<string, unknown>;
}

/**
 * Evaluate a JS expression in a constrained scope.
 *
 * Throws a tagged Error on syntax errors or runtime errors. Callers should catch
 * and route through the engine's error-edge logic.
 */
export function evaluateExpression<T = unknown>(
  expression: string,
  args: SafeExpressionContext,
): T {
  staticGuard(expression);
  // Build a parameter list that shadows every dangerous global with `undefined`.
  const params = ['input', 'ctx', ...BLOCKED_GLOBALS];
  // `"use strict"` + `return (...)` so the expression must evaluate to a value.
  // Wrapped in (…) so object literals like `({ a: 1 })` work without needing `()` from the user.
  const body = `"use strict"; return (${expression});`;
  let fn: (...rest: unknown[]) => T;
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    fn = new Function(...params, body) as (...rest: unknown[]) => T;
  } catch (err) {
    throw new Error(`expression parse failed: ${(err as Error).message}`);
  }
  return fn(args.input, args.ctx ?? {}, ...new Array(BLOCKED_GLOBALS.length).fill(undefined));
}

/** Boolean form: any truthy result counts as pass. */
export function evaluateBooleanExpression(expression: string, args: SafeExpressionContext): boolean {
  return Boolean(evaluateExpression(expression, args));
}
