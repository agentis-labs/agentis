/**
 * Shared ViewNode patch application (ui_patch / SURFACE_PATCH). One implementation
 * used by BOTH the backend (appSurfaceStore persist) and the web renderer
 * (AppRuntime, to apply a SURFACE_PATCH incrementally instead of a full reload),
 * so client and server can never drift on patch semantics.
 *
 * Paths are slash-separated and walk the JSON tree from the root node; numeric
 * segments index arrays (e.g. "children/2/title"). Immutable: every op returns a
 * new tree, structurally shared where untouched.
 */

import { AgentisError } from './errors.js';
import type { UiPatchOp } from './types/view.js';

/** Apply a sequence of ui_patch ops to a surface tree, left to right. */
export function applyUiPatchOps<T = unknown>(root: T, ops: UiPatchOp[]): T {
  let tree: unknown = root;
  for (const op of ops) tree = applyUiPatchOp(tree, op);
  return tree as T;
}

export function applyUiPatchOp(root: unknown, op: UiPatchOp): unknown {
  if (op.op === 'set') {
    return setAtPath(root, splitPath(op.path), op.value);
  }
  if (op.op === 'remove') {
    return removeAtPath(root, splitPath(op.path));
  }
  // insert into an array at path (path points at the array; index optional)
  const segments = splitPath(op.path);
  const target = getAtPath(root, segments);
  if (!Array.isArray(target)) throw new AgentisError('VALIDATION_FAILED', `insert target is not an array: ${op.path}`);
  const arr = target.slice();
  const at = op.index ?? arr.length;
  arr.splice(at, 0, op.node);
  return setAtPath(root, segments, arr);
}

function splitPath(path: string): Array<string | number> {
  return path
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => (/^\d+$/.test(s) ? Number.parseInt(s, 10) : s));
}

function getAtPath(root: unknown, segments: Array<string | number>): unknown {
  let cur: unknown = root;
  for (const seg of segments) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[seg];
  }
  return cur;
}

function setAtPath(root: unknown, segments: Array<string | number>, value: unknown): unknown {
  if (segments.length === 0) return value;
  const [head, ...rest] = segments;
  const clone: Record<string | number, unknown> = Array.isArray(root)
    ? [...(root as unknown[])] as unknown as Record<string | number, unknown>
    : { ...(root as Record<string | number, unknown>) };
  clone[head!] = setAtPath(clone[head!], rest, value);
  return clone;
}

function removeAtPath(root: unknown, segments: Array<string | number>): unknown {
  if (segments.length === 0) return undefined;
  const [head, ...rest] = segments;
  if (rest.length === 0) {
    if (Array.isArray(root)) {
      const arr = [...(root as unknown[])];
      arr.splice(Number(head), 1);
      return arr;
    }
    const obj = { ...(root as Record<string | number, unknown>) };
    delete obj[head!];
    return obj;
  }
  const clone: Record<string | number, unknown> = Array.isArray(root)
    ? [...(root as unknown[])] as unknown as Record<string | number, unknown>
    : { ...(root as Record<string | number, unknown>) };
  clone[head!] = removeAtPath(clone[head!], rest);
  return clone;
}
