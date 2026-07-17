import { describe, it, expect } from 'vitest';
import { toCsv, parseCsv, cellText } from '../../src/lib/download';

describe('download — CSV serialization', () => {
  it('serializes rows over the given columns, quoting when needed', () => {
    const rows = [
      { name: 'Ada', note: 'hello, world', n: 1 },
      { name: 'Grace', note: 'quote " and\nnewline', n: 2 },
    ];
    const csv = toCsv(rows, ['name', 'note', 'n']);
    expect(csv.split('\n')[0]).toBe('name,note,n');
    expect(csv).toContain('"hello, world"');
    expect(csv).toContain('"quote "" and\nnewline"');
  });

  it('cellText JSON-stringifies objects and blanks null', () => {
    expect(cellText(null)).toBe('');
    expect(cellText({ a: 1 })).toBe('{"a":1}');
    expect(cellText(true)).toBe('true');
  });
});

describe('download — CSV parsing (round-trip)', () => {
  it('parses a header + rows into keyed records', () => {
    const csv = 'a,b\n1,x\n2,y\n';
    expect(parseCsv(csv)).toEqual([
      { a: '1', b: 'x' },
      { a: '2', b: 'y' },
    ]);
  });

  it('round-trips quoted fields with commas, quotes, and newlines', () => {
    const rows = [{ msg: 'a, b', q: 'say "hi"', multi: 'line1\nline2' }];
    const cols = ['msg', 'q', 'multi'];
    const parsed = parseCsv(toCsv(rows, cols));
    expect(parsed).toEqual([{ msg: 'a, b', q: 'say "hi"', multi: 'line1\nline2' }]);
  });

  it('ignores a blank trailing line and handles CRLF', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([{ a: '1', b: '2' }]);
  });
});
