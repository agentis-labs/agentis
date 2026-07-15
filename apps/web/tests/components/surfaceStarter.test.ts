/**
 * Regression: "create interface" must use the shared archetype taste engine —
 * NOT the old agent-card + board + status-board stub. This is the exact bug the
 * operator hit (a new interface rendered the old garbage default).
 */
import { describe, it, expect } from 'vitest';
import type { CollectionInfo } from '@agentis/core';
import { buildStarterSurface } from '../../src/components/apps/surfaceTemplates';

function coll(name: string, fields: Array<{ key: string; type: 'string' | 'number' | 'boolean' | 'date' | 'json' }>): CollectionInfo {
  return {
    id: `c-${name}`,
    appId: 'app-1',
    name,
    schema: { fields: fields.map((f) => ({ ...f, required: false, indexed: false })) },
    createdAt: '2026-06-25T00:00:00.000Z',
    updatedAt: '2026-06-25T00:00:00.000Z',
  };
}

describe('buildStarterSurface (create interface default)', () => {
  it('produces a themed archetype surface, not the old stub', () => {
    const { view } = buildStarterSurface([coll('metrics', [{ key: 'day', type: 'string' }, { key: 'count', type: 'number' }])]);
    expect(view).toMatchObject({ type: 'Stack', style: { theme: 'analytics' } });
    const json = JSON.stringify(view);
    expect(json).toContain('"type":"Hero"');
    expect(json).toContain('"type":"Chart"');
    // The old default's tell-tale status board must be gone.
    expect(json).not.toContain('Accepting work');
  });

  it('themes a status collection as a pipeline board', () => {
    const { view } = buildStarterSurface([coll('leads', [{ key: 'name', type: 'string' }, { key: 'stage', type: 'string' }])]);
    expect(view).toMatchObject({ type: 'Stack', style: { theme: 'product' } });
    const json = JSON.stringify(view);
    expect(json).toContain('"type":"OrchestrationPanel"');
    expect(json).toContain('"type":"PipelineFlow"');
    expect(json).toContain('"type":"Kanban"');
  });
});
