/**
 * applyUiPatchOps — the shared ui_patch / SURFACE_PATCH applier used by BOTH the
 * backend persist and the web renderer, so client + server never drift.
 */
import { describe, it, expect } from 'vitest';
import { applyUiPatchOps, type UiPatchOp, type ViewNode } from '../src/index.js';

const base: ViewNode = {
  type: 'Stack',
  children: [
    { type: 'Hero', title: 'Old' },
    { type: 'Text', value: 'keep' },
  ],
};

describe('applyUiPatchOps', () => {
  it('set replaces a value at a slash path (numeric = array index)', () => {
    const out = applyUiPatchOps(base, [{ op: 'set', path: 'children/0/title', value: 'New' }]) as ViewNode;
    expect(JSON.stringify(out)).toContain('"New"');
    expect(JSON.stringify(out)).not.toContain('"Old"');
    // Immutable — original untouched.
    expect((base.children as ViewNode[])[0]).toMatchObject({ title: 'Old' });
  });

  it('insert splices a node into an array (default append, else at index)', () => {
    const append = applyUiPatchOps(base, [{ op: 'insert', path: 'children', node: { type: 'Divider' } }]) as ViewNode & { children: ViewNode[] };
    expect(append.children.at(-1)?.type).toBe('Divider');
    const atFront = applyUiPatchOps(base, [{ op: 'insert', path: 'children', node: { type: 'Divider' }, index: 0 }]) as ViewNode & { children: ViewNode[] };
    expect(atFront.children[0]?.type).toBe('Divider');
  });

  it('remove deletes an array element', () => {
    const out = applyUiPatchOps(base, [{ op: 'remove', path: 'children/0' }]) as ViewNode & { children: ViewNode[] };
    expect(out.children).toHaveLength(1);
    expect(out.children[0]?.type).toBe('Text');
  });

  it('applies a sequence left-to-right', () => {
    const ops: UiPatchOp[] = [
      { op: 'set', path: 'children/0/title', value: 'A' },
      { op: 'insert', path: 'children', node: { type: 'Badge', value: 'x' } },
    ];
    const out = applyUiPatchOps(base, ops) as ViewNode & { children: ViewNode[] };
    expect((out.children[0] as { title?: string }).title).toBe('A');
    expect(out.children.at(-1)?.type).toBe('Badge');
  });

  it('throws when inserting into a non-array target', () => {
    expect(() => applyUiPatchOps(base, [{ op: 'insert', path: 'children/0/title', node: { type: 'Divider' } }])).toThrow();
  });
});
