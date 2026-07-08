/**
 * fieldExpression — turns a *visual* field pick ("use output from [step] → [field]")
 * into the correct value reference, so non-developers never hand-write expressions.
 *
 * Two dialects, matching the two kinds of node form field:
 *  - `'template'` → `{{nodes.<id>.<path>}}`, for templated text fields (HTTP url/body,
 *    agent prompts, workflow_store keys…) resolved by the engine's template renderer.
 *  - `'js'` → a JavaScript accessor (`ctx.nodes["<id>"].<path>`) for the sandboxed
 *    expression fields (transform `expression`, filter `condition`, evaluator target),
 *    which evaluate against `{ input, ctx: { trigger, nodes, scratchpad, store } }`
 *    (see `apps/api/src/engine/handlers/pureHandlers.ts`).
 */

export type FieldSource =
  | { origin: 'node'; nodeId: string; path?: string }
  | { origin: 'trigger'; path?: string }
  | { origin: 'input'; path?: string }
  | { origin: 'scratchpad'; key: string }
  | { origin: 'store'; key: string };

export type ExpressionDialect = 'template' | 'js';

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Append a dotted path to a JS base, bracketing numeric / non-identifier segments. */
function jsAccess(base: string, path?: string): string {
  if (!path) return base;
  let out = base;
  for (const seg of path.split('.')) {
    if (seg === '') continue;
    if (IDENT.test(seg)) out += `.${seg}`;
    else if (/^\d+$/.test(seg)) out += `[${seg}]`;
    else out += `[${JSON.stringify(seg)}]`;
  }
  return out;
}

/** Append a dotted path for the dot-path template dialect (engine resolves dotted paths). */
function dotAccess(base: string, path?: string): string {
  if (!path) return base;
  const clean = path
    .split('.')
    .filter((seg) => seg !== '')
    .join('.');
  return clean ? `${base}.${clean}` : base;
}

function jsBase(source: FieldSource): string {
  switch (source.origin) {
    case 'node':
      return IDENT.test(source.nodeId) ? `ctx.nodes.${source.nodeId}` : `ctx.nodes[${JSON.stringify(source.nodeId)}]`;
    case 'trigger':
      return 'ctx.trigger';
    case 'input':
      return 'input';
    case 'scratchpad':
      return `ctx.scratchpad[${JSON.stringify(source.key)}]`;
    case 'store':
      return `ctx.store[${JSON.stringify(source.key)}]`;
  }
}

function templateBase(source: FieldSource): string {
  switch (source.origin) {
    case 'node':
      return `nodes.${source.nodeId}`;
    case 'trigger':
      return 'trigger';
    case 'input':
      return 'input';
    case 'scratchpad':
      return `scratchpad.${source.key}`;
    case 'store':
      return `store.${source.key}`;
  }
}

/** Generate the value reference for a picked field in the requested dialect. */
export function generateFieldExpression(source: FieldSource, dialect: ExpressionDialect): string {
  const path = source.origin === 'scratchpad' || source.origin === 'store' ? undefined : source.path;
  if (dialect === 'js') return jsAccess(jsBase(source), path);
  return `{{${dotAccess(templateBase(source), path)}}}`;
}

/** Human-readable summary of a field source (for the picker's preview line). */
export function describeFieldSource(source: FieldSource, label?: string): string {
  const where =
    source.origin === 'node'
      ? label || source.nodeId
      : source.origin === 'scratchpad'
        ? `working memory · ${source.key}`
        : source.origin === 'store'
          ? `store · ${source.key}`
          : source.origin;
  const path = source.origin === 'scratchpad' || source.origin === 'store' ? undefined : source.path;
  return path ? `${where} → ${path}` : where;
}
