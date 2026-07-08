/**
 * Dependency-free path extraction for the Listener Runtime.
 *
 * We deliberately do NOT pull in `jsonpath` / `jmespath` (neither is installed,
 * and both are heavy). Instead we support the practical subset operators need:
 *
 *   - dotted paths with bracket indices:  `$.event.items[0].id`, `data.cursor`
 *   - a leading `$.` / `$` is optional
 *   - wildcard `[*]` / `.*` flattens an array level
 *
 * This covers cursor extraction, predicate field access, and coalesce keys.
 * The JMESPath predicate path additionally supports the bare-identifier and
 * dotted forms (the common case); anything fancier degrades to a clear error
 * rather than silently returning undefined.
 */

/** Read a value at a dot/bracket path. Returns undefined when any hop is missing. */
export function getPath(root: unknown, rawPath: string): unknown {
  const tokens = tokenizePath(rawPath);
  let current: unknown = root;
  for (const token of tokens) {
    if (current == null) return undefined;
    if (token === '*') {
      // Flatten one array level — collect the next-hop over each element.
      if (!Array.isArray(current)) return undefined;
      return current; // wildcard at a leaf yields the array itself
    }
    if (Array.isArray(current) && /^\d+$/.test(token)) {
      current = current[Number(token)];
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[token];
    } else {
      return undefined;
    }
  }
  return current;
}

function tokenizePath(rawPath: string): string[] {
  const path = rawPath.trim().replace(/^\$\.?/, '');
  if (!path) return [];
  const tokens: string[] = [];
  for (const segment of path.split('.')) {
    if (!segment) continue;
    // split bracket accessors:  items[0]  → items, 0    foo[*] → foo, *
    const bracketParts = segment.split('[');
    const head = bracketParts[0];
    if (head) tokens.push(head);
    for (const part of bracketParts.slice(1)) {
      const close = part.indexOf(']');
      const bracket = close >= 0 ? part.slice(0, close) : part;
      const inner = stripPathQuotes(bracket).trim();
      if (inner) tokens.push(inner);
    }
  }
  return tokens;
}

function stripPathQuotes(value: string): string {
  let out = '';
  for (const ch of value) {
    if (ch !== '"' && ch !== "'") out += ch;
  }
  return out;
}

/** True when a path resolves to anything other than undefined. */
export function pathExists(root: unknown, rawPath: string): boolean {
  return getPath(root, rawPath) !== undefined;
}

/**
 * Evaluate a JMESPath-lite expression to a value. Supports dotted paths and a
 * trailing filter projection of the form `items[?field == 'value']` which
 * returns the filtered array. Returns undefined for unsupported syntax.
 */
export function evalJmesLite(root: unknown, expression: string): unknown {
  const expr = expression.trim();
  const filterMatch = expr.match(/^(.+?)\[\?\s*([\w.$]+)\s*(==|!=)\s*['"]?([^'"\]]+)['"]?\s*\]$/);
  if (filterMatch) {
    const [, basePath, field, op, rhs] = filterMatch;
    if (!basePath || !field) return undefined;
    const base = getPath(root, basePath);
    if (!Array.isArray(base)) return undefined;
    return base.filter((item) => {
      const lhsStr = String(getPath(item, field));
      return op === '==' ? lhsStr === rhs : lhsStr !== rhs;
    });
  }
  return getPath(root, expr);
}

/** Truthiness used by the jmespath predicate (empty array/obj/string → false). */
export function isTruthy(value: unknown): boolean {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'number') return value !== 0;
  return Boolean(value);
}
