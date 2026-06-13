import { describe, it, expect } from 'vitest';
import {
  resolveTemplate,
  resolveTemplateDeep,
  readTemplatePath,
  buildTemplateContext,
} from '../../src/engine/templateResolver.js';

function ctx() {
  return buildTemplateContext({
    triggerInputs: { name: 'Ada', metadata: { source: 'cli' } },
    nodeOutputs: {
      research: {
        summary: 'A short summary.',
        sources: ['https://a.example', 'https://b.example'],
        nested: { score: 0.84 },
      },
    },
    scratchpad: { leadStatus: 'qualified' },
    store: { runsToday: 3 },
    loop: { item: { id: 7, label: 'seven' }, index: 0 },
    inputData: { name: 'Grace', items: [{ active: true }, { active: false }] },
  });
}

describe('resolveTemplate', () => {
  it('substitutes a single placeholder', () => {
    expect(resolveTemplate('Hello {{trigger.name}}', ctx())).toBe('Hello Ada');
  });

  it('walks nested paths', () => {
    expect(resolveTemplate('From {{trigger.metadata.source}}', ctx())).toBe('From cli');
  });

  it('reads node outputs via the `nodes.<id>.<path>` namespace', () => {
    expect(resolveTemplate('{{nodes.research.summary}}', ctx())).toBe('A short summary.');
  });

  it('supports bracket array access', () => {
    expect(resolveTemplate('First source: {{nodes.research.sources[0]}}', ctx()))
      .toBe('First source: https://a.example');
  });

  it('emits empty string for missing namespaces (no exception)', () => {
    expect(resolveTemplate('hi {{noSuchThing.foo}}', ctx())).toBe('hi ');
  });

  it('stringifies non-string values with JSON.stringify', () => {
    const result = resolveTemplate('{{nodes.research.sources}}', ctx());
    expect(result).toBe(JSON.stringify(['https://a.example', 'https://b.example']));
  });

  it('loop context resolves item + index', () => {
    expect(resolveTemplate('item={{loop.item.label}} idx={{loop.index}}', ctx()))
      .toBe('item=seven idx=0');
  });

  it('scratchpad + store namespaces resolve', () => {
    expect(resolveTemplate('{{scratchpad.leadStatus}} / {{store.runsToday}}', ctx()))
      .toBe('qualified / 3');
  });

  it('evaluates inline AScript expressions in mixed strings', () => {
    expect(resolveTemplate('Hello {{= $json.name.toUpperCase() }} ({{= $nodes.research.sources.length }})', ctx()))
      .toBe('Hello GRACE (2)');
  });

  it('returns the input untouched when no placeholders are present', () => {
    expect(resolveTemplate('plain text', ctx())).toBe('plain text');
  });
});

describe('resolveTemplateDeep', () => {
  it('walks nested objects and arrays', () => {
    const config = {
      url: 'https://api.example/users/{{trigger.name}}',
      headers: { 'x-source': '{{trigger.metadata.source}}' },
      params: ['{{nodes.research.nested.score}}', 'static'],
      depth: { keepNonString: true, count: 42 },
    };
    const resolved = resolveTemplateDeep(config, ctx());
    expect(resolved.url).toBe('https://api.example/users/Ada');
    expect(resolved.headers['x-source']).toBe('cli');
    expect(resolved.params[0]).toBe('0.84');
    expect(resolved.params[1]).toBe('static');
    expect(resolved.depth.keepNonString).toBe(true);
    expect(resolved.depth.count).toBe(42);
  });

  it('returns typed values for exact inline AScript fields', () => {
    const resolved = resolveTemplateDeep({
      count: '{{= $json.items.filter((item) => item.active).length }}',
      firstSource: '{{= $nodes.research.sources[0] }}',
      payload: '{{= ({ source: $trigger.metadata.source, score: $nodes.research.nested.score }) }}',
    }, ctx());
    expect(resolved).toEqual({
      count: 1,
      firstSource: 'https://a.example',
      payload: { source: 'cli', score: 0.84 },
    });
  });

  it('preserves null and undefined', () => {
    const out = resolveTemplateDeep({ a: null, b: undefined as unknown as string }, ctx());
    expect(out.a).toBeNull();
    expect(out.b).toBeUndefined();
  });
});

describe('readTemplatePath', () => {
  it('returns the typed value (not stringified)', () => {
    const c = ctx();
    expect(readTemplatePath(c, 'nodes.research.sources')).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
    expect(readTemplatePath(c, 'nodes.research.nested.score')).toBe(0.84);
    expect(readTemplatePath(c, 'store.runsToday')).toBe(3);
  });

  it('returns undefined for missing paths', () => {
    expect(readTemplatePath(ctx(), 'nodes.research.no_such')).toBeUndefined();
  });

  it('returns undefined when the head namespace is unknown and not a node id', () => {
    expect(readTemplatePath(ctx(), 'missing.namespace.path')).toBeUndefined();
  });

  it('evaluates readTemplatePath expressions as typed values', () => {
    expect(readTemplatePath(ctx(), '= $nodes.research.sources.filter((url) => url.includes("b."))'))
      .toEqual(['https://b.example']);
  });

  it('permissive head: bare nodeId resolves through the nodes map', () => {
    // {{research.summary}} is accepted as shorthand for {{nodes.research.summary}}.
    expect(readTemplatePath(ctx(), 'research.summary')).toBe('A short summary.');
  });
});
