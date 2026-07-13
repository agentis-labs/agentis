import { describe, expect, it } from 'vitest';
import { buildNodeAliasMap, slugifyNodeTitle } from '../src/nodeAlias.js';

describe('slugifyNodeTitle', () => {
  it('lowercases and underscore-joins a human title', () => {
    expect(slugifyNodeTitle('Qualified Lead')).toBe('qualified_lead');
  });

  it('strips non-alphanumerics and leading/trailing underscores', () => {
    expect(slugifyNodeTitle('  Send WhatsApp #1! ')).toBe('send_whatsapp_1');
  });

  it('returns empty for empty/whitespace/null titles', () => {
    expect(slugifyNodeTitle('')).toBe('');
    expect(slugifyNodeTitle('   ')).toBe('');
    expect(slugifyNodeTitle(null)).toBe('');
    expect(slugifyNodeTitle(undefined)).toBe('');
  });
});

describe('buildNodeAliasMap', () => {
  it('maps a readable slug to the node id', () => {
    const alias = buildNodeAliasMap([{ id: 'trigger-mrj63dwv', title: 'Qualified Lead' }]);
    expect(alias).toEqual({ qualified_lead: 'trigger-mrj63dwv' });
  });

  it('drops slugs that collide across two nodes — both keep only their raw id', () => {
    const alias = buildNodeAliasMap([
      { id: 'a', title: 'Send Message' },
      { id: 'b', title: 'Send Message' },
    ]);
    expect(alias).toEqual({});
  });

  it('drops slugs that collide with a reserved namespace', () => {
    const alias = buildNodeAliasMap([{ id: 'x1', title: 'trigger' }, { id: 'x2', title: 'Store' }]);
    expect(alias).toEqual({});
  });

  it('skips a node whose slug already equals its own id (no benefit)', () => {
    const alias = buildNodeAliasMap([{ id: 'qualified_lead', title: 'Qualified Lead' }]);
    expect(alias).toEqual({});
  });

  it('skips nodes with no usable title', () => {
    const alias = buildNodeAliasMap([{ id: 'n1', title: '' }, { id: 'n2' }]);
    expect(alias).toEqual({});
  });
});
