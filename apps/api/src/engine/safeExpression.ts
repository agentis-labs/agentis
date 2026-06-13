/**
 * Constrained expression evaluator for transform, filter, and run_code.
 *
 * Expressions receive only JSON-cloned `input` and `ctx` values. Evaluation
 * runs in a fresh VM realm with string/WASM code generation disabled, which
 * prevents constructor-chain escapes from obtaining Node globals.
 */

import { createContext, Script } from 'node:vm';

const DEFAULT_EVALUATION_TIMEOUT_MS = 5_000;
const MAX_EVALUATION_TIMEOUT_MS = 30_000;
const INPUT_BYTES_PER_EXTRA_SECOND = 64 * 1024;
const EXPRESSION_CHARS_PER_EXTRA_SECOND = 4_000;

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

export interface SafeExpressionOptions {
  /** Hard execution deadline. Clamped to protect the API process. */
  timeoutMs?: number;
}

export function evaluateExpression<T = unknown>(
  expression: string,
  args: SafeExpressionContext,
  options: SafeExpressionOptions = {},
): T {
  staticGuard(expression);

  let serializedArgs: string;
  try {
    serializedArgs = JSON.stringify([args.input, args.ctx ?? {}]);
  } catch (err) {
    throw new Error(`expression input serialization failed: ${(err as Error).message}`);
  }
  const timeoutMs = resolveEvaluationTimeout(expression, serializedArgs, options.timeoutMs);

  const context = createContext(Object.create(null), {
    name: 'agentis-safe-expression',
    codeGeneration: { strings: false, wasm: false },
  });

  try {
    new Script(`
      const [input, ctx] = JSON.parse(${JSON.stringify(serializedArgs)});
      const $input = input;
      const $json = input;
      const $ctx = ctx;
      const nodes = ctx.nodes || {};
      const trigger = ctx.trigger || {};
      const scratchpad = ctx.scratchpad || {};
      const store = ctx.store || {};
      const workspace = ctx.workspace || {};
      const run = ctx.run || {};
      const loop = ctx.loop || undefined;
      const $nodes = ctx.nodes || {};
      const $trigger = ctx.trigger || {};
      const $scratchpad = ctx.scratchpad || {};
      const $store = ctx.store || {};
      const $workspace = ctx.workspace || {};
      const $run = ctx.run || {};
      const $loop = ctx.loop || undefined;
    `).runInContext(context, {
      timeout: timeoutMs,
    });
    const serializedResult = runExpressionScript(context, expression, timeoutMs);
    return (serializedResult === undefined ? undefined : JSON.parse(serializedResult)) as T;
  } catch (err) {
    throw new Error(`expression evaluation failed: ${(err as Error).message}`);
  }
}

/**
 * Run the user expression and return its JSON-serialized result.
 *
 * Accepts BOTH supported forms so synthesized workflows actually run — not only
 * the trivial single-expression case:
 *   - a single expression:        `({ to: input.email })`
 *   - a function body / statements: `const x = input.email; return { to: x };`
 *
 * We try the single-expression form first (the historical, fast path); if that
 * is a SyntaxError (e.g. it used `return` / declarations / multiple statements)
 * we re-run it as a function body. Security is unchanged: the same fresh VM
 * realm (codeGeneration disabled, no Node globals) and static guard apply to
 * both forms — "statement vs expression" was never the sandbox boundary.
 */
function runExpressionScript(
  context: ReturnType<typeof createContext>,
  expression: string,
  timeoutMs: number,
): string | undefined {
  try {
    return new Script(`JSON.stringify((${expression}))`).runInContext(context, {
      timeout: timeoutMs,
    }) as string | undefined;
  } catch (err) {
    if (err instanceof SyntaxError) {
      return new Script(`JSON.stringify((function () { ${expression} })())`).runInContext(context, {
        timeout: timeoutMs,
      }) as string | undefined;
    }
    throw err;
  }
}

/** Boolean form: any truthy JSON result counts as pass. */
export function evaluateBooleanExpression(
  expression: string,
  args: SafeExpressionContext,
  options: SafeExpressionOptions = {},
): boolean {
  return Boolean(evaluateExpression(expression, args, options));
}

function resolveEvaluationTimeout(
  expression: string,
  serializedArgs: string,
  requestedTimeoutMs?: number,
): number {
  if (requestedTimeoutMs !== undefined) {
    return clampTimeout(requestedTimeoutMs);
  }
  const inputHeadroom = Math.ceil(serializedArgs.length / INPUT_BYTES_PER_EXTRA_SECOND) * 1_000;
  const expressionHeadroom = Math.ceil(expression.length / EXPRESSION_CHARS_PER_EXTRA_SECOND) * 1_000;
  return clampTimeout(DEFAULT_EVALUATION_TIMEOUT_MS + inputHeadroom + expressionHeadroom);
}

function clampTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs)) return DEFAULT_EVALUATION_TIMEOUT_MS;
  return Math.max(1, Math.min(Math.floor(timeoutMs), MAX_EVALUATION_TIMEOUT_MS));
}
