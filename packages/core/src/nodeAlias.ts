/**
 * nodeAlias — readable `{{nodes.<slug>}}` template references.
 *
 * Node ids are opaque and stable (e.g. `trigger-mrj63dwv`) because edges,
 * phases, and `dependsOn` reference them — renaming a node must never break
 * those links. But typing `{{nodes.trigger-mrj63dwv.foo}}` into a prompt is
 * unreadable. This derives a human slug from each node's title and maps it
 * back to the real id, so `{{nodes.qualified_lead.foo}}` and
 * `{{nodes.trigger-mrj63dwv.foo}}` resolve to the same output.
 *
 * Both the frontend (deciding what to INSERT) and the engine (deciding what
 * to RESOLVE) run this exact algorithm so they always agree. Ambiguous or
 * reserved-namespace slugs are dropped from the map — those nodes keep only
 * their raw id, which still works.
 */

const RESERVED = new Set(['trigger', 'scratchpad', 'store', 'workspace', 'run', 'loop', 'nodes', 'input']);

/** A stable, readable slug from a node title — lowercase, `_`-separated, or '' if nothing usable. */
export function slugifyNodeTitle(title: string | undefined | null): string {
  return (title ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * slug -> nodeId for every node whose title slug is non-empty, not a reserved
 * namespace, different from its own id, and unique among the given nodes.
 */
export function buildNodeAliasMap(nodes: ReadonlyArray<{ id: string; title?: string | null }>): Record<string, string> {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    const slug = slugifyNodeTitle(n.title);
    if (!slug || RESERVED.has(slug)) continue;
    counts.set(slug, (counts.get(slug) ?? 0) + 1);
  }
  const alias: Record<string, string> = {};
  for (const n of nodes) {
    const slug = slugifyNodeTitle(n.title);
    if (!slug || RESERVED.has(slug)) continue;
    if (slug === n.id) continue;
    if ((counts.get(slug) ?? 0) > 1) continue;
    alias[slug] = n.id;
  }
  return alias;
}
