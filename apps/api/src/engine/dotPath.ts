/**
 * Read a value at a dot-delimited path from an unknown object graph, returning
 * `undefined` when any segment is missing or a non-object is traversed. Pure and
 * dependency-free so it can be shared across the engine (the dispatch template
 * layer and the convergence loop) without pulling in the engine itself.
 */
export function readDotPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  let cursor: unknown = obj;
  for (const segment of path.split('.')) {
    if (cursor == null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}
