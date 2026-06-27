/**
 * referenceTemplates — the design-taste layer. Classifies an App's data shape
 * into an archetype and composes a distinct, themed, data-bound surface for it.
 */
import { describe, expect, it } from 'vitest';
import type { CollectionInfo } from '@agentis/core';
import { buildArchetypeSurface, classifyArchetype } from '@agentis/core';

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

const leads = coll('leads', [{ key: 'name', type: 'string' }, { key: 'stage', type: 'string' }]);
const metrics = coll('metrics', [{ key: 'day', type: 'string' }, { key: 'visits', type: 'number' }, { key: 'signups', type: 'number' }]);
const notes = coll('notes', [{ key: 'title', type: 'string' }, { key: 'body', type: 'string' }]);

describe('classifyArchetype', () => {
  it('routes by data shape', () => {
    expect(classifyArchetype([leads])).toBe('pipeline');   // has a status/stage field
    expect(classifyArchetype([metrics])).toBe('analytics'); // numeric fields
    expect(classifyArchetype([notes])).toBe('operations');  // plain records
    expect(classifyArchetype([])).toBe('operations');
  });
});

describe('buildArchetypeSurface', () => {
  it('pipeline → themed board + operator rail, declares insert', () => {
    const built = buildArchetypeSurface([leads]);
    expect(built.archetype).toBe('pipeline');
    const json = JSON.stringify(built.view);
    expect(built.view).toMatchObject({ type: 'Stack', style: { theme: 'product' } });
    expect(json).toContain('"type":"DataBoard"');
    expect(json).toContain('"type":"Hero"');
    expect(json).toContain('"type":"AgentConsole"');
    expect(built.actions).toEqual([{ name: 'create_leads', kind: 'data', target: 'leads.insert' }]);
  });

  it('analytics → multi-series chart + records tabs', () => {
    const built = buildArchetypeSurface([metrics]);
    expect(built.archetype).toBe('analytics');
    expect(built.view).toMatchObject({ type: 'Stack', style: { theme: 'analytics' } });
    const json = JSON.stringify(built.view);
    expect(json).toContain('"type":"Chart"');
    expect(json).toContain('"series"'); // two numeric fields → multi-series
    expect(json).toContain('"type":"Tabs"');
  });

  it('operations → console table + add tab', () => {
    const built = buildArchetypeSurface([notes]);
    expect(built.archetype).toBe('operations');
    expect(built.view).toMatchObject({ type: 'Stack', style: { theme: 'console' } });
    expect(JSON.stringify(built.view)).toContain('"type":"Table"');
  });

  it('empty → operator hero, no actions', () => {
    const built = buildArchetypeSurface([]);
    const json = JSON.stringify(built.view);
    expect(json).toContain('"type":"AgentConsole"');
    expect(json).toContain('"type":"ActivityStream"');
    expect(built.actions).toEqual([]);
  });
});
