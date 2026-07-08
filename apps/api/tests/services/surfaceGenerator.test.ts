/**
 * surfaceGenerator — agent-assisted AG-UI surface authoring.
 *
 * Proves the contract the builder's "Generate" prompt relies on: a valid model
 * result is returned verbatim (validated against the ViewNode grammar), and any
 * missing/invalid model output degrades to a deterministic scaffold so the
 * builder is never left empty.
 */
import { describe, expect, it } from 'vitest';
import type { CollectionInfo } from '@agentis/core';
import { generateSurfaceView, generateSurfacePatch } from '../../src/services/surfaceGenerator.js';
import type { ViewNode } from '@agentis/core';
import type { StructuredCompleter } from '../../src/services/structuredCompleter.js';

const tasks: CollectionInfo = {
  id: 'c1',
  appId: 'app-1',
  name: 'tasks',
  schema: { fields: [{ key: 'title', type: 'string', required: true, indexed: false }, { key: 'done', type: 'boolean', required: false, indexed: false }] },
  createdAt: '2026-06-23T00:00:00.000Z',
  updatedAt: '2026-06-23T00:00:00.000Z',
};

function completer(value: Record<string, unknown> | null): StructuredCompleter {
  return { completeStructured: async () => value as never };
}

describe('generateSurfaceView', () => {
  it('falls back to a deterministic scaffold when no model is configured', async () => {
    const result = await generateSurfaceView({ prompt: 'a task list', collections: [tasks], workspaceId: 'ws-1' });
    expect(result.source).toBe('fallback');
    expect(result.view).toMatchObject({ type: 'Stack' });
    // Scaffold binds a create form + table to the real collection and declares the insert action.
    expect(JSON.stringify(result.view)).toContain('"collection":"tasks"');
    expect(result.actions).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'create_tasks', kind: 'data', target: 'tasks.insert' })]),
    );
  });

  it('scaffolds an empty surface when there are no collections', async () => {
    const result = await generateSurfaceView({ prompt: 'something', collections: [], workspaceId: 'ws-1' });
    expect(result.source).toBe('fallback');
    expect(result.actions).toEqual([]);
    expect(JSON.stringify(result.view)).toContain('ActivityStream');
  });

  it('returns the model output when it is a valid ViewNode tree', async () => {
    const view = { type: 'Stack', children: [{ type: 'Heading', value: 'Tasks' }, { type: 'Table', bind: { collection: 'tasks' }, columns: [{ key: 'title' }] }] };
    const result = await generateSurfaceView({
      prompt: 'a task dashboard',
      collections: [tasks],
      workspaceId: 'ws-1',
      completer: completer({ view, actions: [] }),
    });
    expect(result.source).toBe('model');
    expect(result.view).toMatchObject({ type: 'Stack' });
    expect((result.view as { children: unknown[] }).children[0]).toMatchObject({ type: 'Heading', value: 'Tasks' });
  });

  it('falls back when the model output is not a valid ViewNode', async () => {
    const result = await generateSurfaceView({
      prompt: 'a task dashboard',
      collections: [tasks],
      workspaceId: 'ws-1',
      completer: completer({ view: { type: 'NotARealNode' } }),
    });
    expect(result.source).toBe('fallback');
  });

  it('falls back when the completer returns null', async () => {
    const result = await generateSurfaceView({
      prompt: 'x',
      collections: [tasks],
      workspaceId: 'ws-1',
      completer: completer(null),
    });
    expect(result.source).toBe('fallback');
  });
});

describe('generateSurfacePatch (Phase 4 — NL → SurfacePatch)', () => {
  const current: ViewNode = {
    type: 'Stack',
    children: [
      { type: 'Heading', value: 'Deals' },
      { type: 'Table', bind: { collection: 'tasks' }, columns: [{ key: 'title' }] },
    ],
  };

  it('turns an instruction into the SurfacePatch ops the model returns', async () => {
    const ops = [{ op: 'set', path: 'children/1/bind/query', value: { amount: { gt: 20000 } } }];
    const result = await generateSurfacePatch({
      instruction: 'show only deals over $20k',
      current,
      collections: [tasks],
      workspaceId: 'ws-1',
      completer: completer({ ops }),
    });
    expect(result.source).toBe('model');
    expect(result.ops).toEqual(ops);
  });

  it('is a safe no-op when no design model is configured', async () => {
    const result = await generateSurfacePatch({ instruction: 'do a thing', current, collections: [tasks], workspaceId: 'ws-1' });
    expect(result.source).toBe('none');
    expect(result.ops).toEqual([]);
  });

  it('no-ops when the model returns invalid or empty ops (keeps the surface untouched)', async () => {
    const bad = await generateSurfacePatch({ instruction: 'x', current, collections: [tasks], workspaceId: 'ws-1', completer: completer({ ops: [{ op: 'nope' }] }) });
    expect(bad.ops).toEqual([]);
    const empty = await generateSurfacePatch({ instruction: 'x', current, collections: [tasks], workspaceId: 'ws-1', completer: completer({ ops: [] }) });
    expect(empty.source).toBe('none');
  });
});
