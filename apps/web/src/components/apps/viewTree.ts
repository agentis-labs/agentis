/**
 * viewTree — pure structural helpers for the AG-UI `ViewNode` tree.
 *
 * Shared by the WYSIWYG builder (`SurfaceCanvas`, `AppEditorPage`) so the page
 * and the canvas mutate one tree the same way. A "path" is the list of child
 * indices from the root to a node (`[]` is the root). Everything here is pure —
 * it returns a new tree and never mutates its input.
 */
import type { ViewNode } from '@agentis/core';

/** A node that holds an editable `children` array (the structural containers). */
export type ContainerNode = Extract<ViewNode, { children: ViewNode[] }>;

export function canHaveChildren(node: ViewNode): node is ContainerNode {
  return 'children' in node && Array.isArray((node as ContainerNode).children);
}

export function emptySurfaceView(): ViewNode {
  return { type: 'Stack', gap: 12, children: [] };
}

/** Parse a JSON draft into a ViewNode, or null when it is not a node. */
export function parseViewDraft(draft: string): ViewNode | null {
  try {
    const parsed = JSON.parse(draft) as ViewNode;
    return parsed && typeof parsed === 'object' && 'type' in parsed ? parsed : null;
  } catch {
    return null;
  }
}

export function pathsEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function pathKey(path: number[]): string {
  return path.join('.');
}

export function getNodeAtPath(root: ViewNode, path: number[]): ViewNode | null {
  let current: ViewNode = root;
  for (const index of path) {
    if (!canHaveChildren(current)) return null;
    const next = current.children[index];
    if (!next) return null;
    current = next;
  }
  return current;
}

export function updateNodeAtPath(
  root: ViewNode,
  path: number[],
  mutator: (node: ViewNode) => ViewNode,
): ViewNode {
  if (path.length === 0) return mutator(root);
  if (!canHaveChildren(root)) return root;
  const [index, ...rest] = path;
  return {
    ...root,
    children: root.children.map((child, childIndex) => (
      childIndex === index ? updateNodeAtPath(child, rest, mutator) : child
    )),
  };
}

export function removeNodeAtPath(root: ViewNode, path: number[]): ViewNode {
  if (path.length === 0 || !canHaveChildren(root)) return root;
  const [index, ...rest] = path;
  if (rest.length === 0) {
    return { ...root, children: root.children.filter((_, childIndex) => childIndex !== index) };
  }
  return {
    ...root,
    children: root.children.map((child, childIndex) => (
      childIndex === index ? removeNodeAtPath(child, rest) : child
    )),
  };
}

/** Append `node` as the last child of `root` (wrapping a leaf root in a Stack). */
export function appendNode(root: ViewNode, node: ViewNode): ViewNode {
  if (canHaveChildren(root)) return { ...root, children: [...root.children, node] };
  return { type: 'Stack', gap: 12, children: [root, node] };
}

/** Path to the last child of the root after an append, for auto-selection. */
export function pathToLastChild(root: ViewNode): number[] {
  return canHaveChildren(root) ? [Math.max(0, root.children.length - 1)] : [];
}

/** Add `node` inside the container at `path` (no-op if the target is a leaf). */
export function addChildAtPath(root: ViewNode, path: number[], node: ViewNode): ViewNode {
  return updateNodeAtPath(root, path, (item) => (
    canHaveChildren(item) ? { ...item, children: [...item.children, node] } : item
  ));
}

/** Move the node at `path` among its siblings by `dir` (-1 up, +1 down). */
export function moveNodeAtPath(root: ViewNode, path: number[], dir: -1 | 1): ViewNode {
  if (path.length === 0) return root;
  const parentPath = path.slice(0, -1);
  const index = path[path.length - 1];
  if (index === undefined) return root;
  return updateNodeAtPath(root, parentPath, (parent) => {
    if (!canHaveChildren(parent)) return parent;
    const target = index + dir;
    if (target < 0 || target >= parent.children.length) return parent;
    const children = [...parent.children];
    const moved = children[index];
    const swapped = children[target];
    if (!moved || !swapped) return parent;
    children[index] = swapped;
    children[target] = moved;
    return { ...parent, children };
  });
}

/** Insert a duplicate of the node at `path` directly after it. */
export function duplicateNodeAtPath(root: ViewNode, path: number[]): ViewNode {
  if (path.length === 0) return root;
  const parentPath = path.slice(0, -1);
  const index = path[path.length - 1];
  if (index === undefined) return root;
  return updateNodeAtPath(root, parentPath, (parent) => {
    if (!canHaveChildren(parent)) return parent;
    const original = parent.children[index];
    if (!original) return parent;
    const children = [...parent.children];
    children.splice(index + 1, 0, cloneNode(original));
    return { ...parent, children };
  });
}

function cloneNode(node: ViewNode): ViewNode {
  return JSON.parse(JSON.stringify(node)) as ViewNode;
}
