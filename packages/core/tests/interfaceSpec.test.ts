/**
 * InterfaceSpec — the typed intent layer over the genui compiler. The spec
 * carries intent (page purposes, copy, app-wide look knobs); the compiler owns
 * composition and must produce complete, gate-clean surfaces deterministically.
 */
import { describe, it, expect } from 'vitest';
import { compileInterfaceSpec, interfaceSpecSchema, repairSurface, type CollectionInfo, type ViewNode } from '../src/index.js';

const COLLECTIONS: CollectionInfo[] = [
  {
    id: 'c1', appId: 'a', name: 'leads', createdAt: '', updatedAt: '',
    schema: { fields: [
      { key: 'company', type: 'string', required: false, indexed: false },
      { key: 'stage', type: 'string', required: false, indexed: false },
      { key: 'value', type: 'number', required: false, indexed: false },
    ] },
  },
  {
    id: 'c2', appId: 'a', name: 'orders', createdAt: '', updatedAt: '',
    schema: { fields: [
      { key: 'sku', type: 'string', required: false, indexed: false },
      { key: 'total', type: 'number', required: false, indexed: false },
    ] },
  },
];

describe('compileInterfaceSpec', () => {
  it('compiles one surface per page, named, riding the archetype builders', () => {
    const spec = interfaceSpecSchema.parse({
      pages: [
        { name: 'home', purpose: 'mission-control' },
        { name: 'board', purpose: 'board', collection: 'leads' },
        { name: 'revenue', purpose: 'analytics', collection: 'orders' },
      ],
    });
    const pages = compileInterfaceSpec(spec, COLLECTIONS);
    expect(pages.map((p) => p.name)).toEqual(['home', 'board', 'revenue']);
    expect(JSON.stringify(pages[1]!.view)).toContain('"Kanban"');
    expect(JSON.stringify(pages[2]!.view)).toContain('"Chart"');
    // every page declares its CRUD actions (the compiler never emits dead composites)
    expect(pages[1]!.actions.some((a) => a.target === 'leads.update')).toBe(true);
  });

  it('stamps app-wide appearance + accent on every page root and applies page copy to the Hero', () => {
    const spec = interfaceSpecSchema.parse({
      appearance: 'light',
      accent: 'purple',
      pages: [{ name: 'home', purpose: 'operations', collection: 'leads', title: 'Lead desk', subtitle: 'Live pipeline' }],
    });
    const [page] = compileInterfaceSpec(spec, COLLECTIONS);
    expect(page!.view.style?.appearance).toBe('light');
    expect(page!.view.style?.accent).toBe('purple');
    const hero = (page!.view as Extract<ViewNode, { type: 'Stack' }>).children.find((c) => c.type === 'Hero') as Extract<ViewNode, { type: 'Hero' }>;
    expect(hero.title).toBe('Lead desk');
    expect(hero.subtitle).toBe('Live pipeline');
  });

  it('produces gate-clean output: the operability gate has nothing to repair', () => {
    const spec = interfaceSpecSchema.parse({ pages: [{ name: 'board', purpose: 'board', collection: 'leads' }] });
    const [page] = compileInterfaceSpec(spec, COLLECTIONS);
    const { fixes } = repairSurface(page!.view, { collections: COLLECTIONS.map((c) => c.name), actions: page!.actions });
    expect(fixes.filter((f) => !f.startsWith('set root'))).toEqual([]);
  });

  it('rejects an empty spec at the boundary', () => {
    expect(interfaceSpecSchema.safeParse({ pages: [] }).success).toBe(false);
  });
});
