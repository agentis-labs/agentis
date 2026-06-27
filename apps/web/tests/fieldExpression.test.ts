import { describe, it, expect } from 'vitest';
import { generateFieldExpression, describeFieldSource, type FieldSource } from '../src/components/canvas/fieldExpression';

describe('generateFieldExpression — template dialect', () => {
  it('references a node output field as a dotted template path', () => {
    expect(generateFieldExpression({ origin: 'node', nodeId: 'fetch', path: 'data.items' }, 'template')).toBe('{{nodes.fetch.data.items}}');
  });

  it('references a node with no field as the whole node output', () => {
    expect(generateFieldExpression({ origin: 'node', nodeId: 'fetch' }, 'template')).toBe('{{nodes.fetch}}');
  });

  it('references trigger, scratchpad and store', () => {
    expect(generateFieldExpression({ origin: 'trigger', path: 'email' }, 'template')).toBe('{{trigger.email}}');
    expect(generateFieldExpression({ origin: 'scratchpad', key: 'summary' }, 'template')).toBe('{{scratchpad.summary}}');
    expect(generateFieldExpression({ origin: 'store', key: 'counter' }, 'template')).toBe('{{store.counter}}');
  });
});

describe('generateFieldExpression — js dialect', () => {
  it('references a node output field via ctx.nodes', () => {
    expect(generateFieldExpression({ origin: 'node', nodeId: 'fetch', path: 'data.items' }, 'js')).toBe('ctx.nodes.fetch.data.items');
  });

  it('brackets a node id that is not a valid identifier', () => {
    expect(generateFieldExpression({ origin: 'node', nodeId: 'fetch-1', path: 'name' }, 'js')).toBe('ctx.nodes["fetch-1"].name');
  });

  it('brackets numeric and non-identifier path segments', () => {
    expect(generateFieldExpression({ origin: 'node', nodeId: 'list', path: 'items.0.full name' }, 'js')).toBe('ctx.nodes.list.items[0]["full name"]');
  });

  it('references trigger, input, scratchpad and store', () => {
    expect(generateFieldExpression({ origin: 'trigger', path: 'email' }, 'js')).toBe('ctx.trigger.email');
    expect(generateFieldExpression({ origin: 'input', path: 'value' }, 'js')).toBe('input.value');
    expect(generateFieldExpression({ origin: 'scratchpad', key: 'summary' }, 'js')).toBe('ctx.scratchpad["summary"]');
    expect(generateFieldExpression({ origin: 'store', key: 'counter' }, 'js')).toBe('ctx.store["counter"]');
  });

  it('ignores a path on scratchpad/store (the key is the whole address)', () => {
    expect(generateFieldExpression({ origin: 'scratchpad', key: 'k', path: 'ignored' } as FieldSource, 'js')).toBe('ctx.scratchpad["k"]');
  });
});

describe('describeFieldSource', () => {
  it('uses a node label and field path', () => {
    expect(describeFieldSource({ origin: 'node', nodeId: 'n1', path: 'a.b' }, 'Fetch users')).toBe('Fetch users → a.b');
  });
  it('falls back to the node id', () => {
    expect(describeFieldSource({ origin: 'node', nodeId: 'n1' })).toBe('n1');
  });
});
