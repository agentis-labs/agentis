import { describe, expect, it } from 'vitest';
import {
  runDateTime,
  runCryptoUtil,
  runMarkdown,
  markdownToHtml,
  htmlToMarkdown,
  runXmlParse,
  xmlToJson,
  jsonToXml,
  runJsonSchemaValidate,
  validateJsonSchema,
  runHtmlExtract,
  runStickyNote,
  parseHtml,
  queryAll,
} from '../../src/engine/handlers/utilityHandlers.js';

describe('datetime node', () => {
  it('parses to ISO', () => {
    const out = runDateTime({ kind: 'datetime', operation: 'parse', inputPath: 'd' }, { d: '2026-01-02T03:04:05Z' });
    expect(out.datetime).toBe('2026-01-02T03:04:05.000Z');
  });
  it('formats with tokens', () => {
    const out = runDateTime({ kind: 'datetime', operation: 'format', inputPath: 'd', outputFormat: 'YYYY-MM-DD', outputKey: 'f' }, { d: '2026-01-02T03:04:05Z' });
    expect(out.f).toBe('2026-01-02');
  });
  it('adds days', () => {
    const out = runDateTime({ kind: 'datetime', operation: 'add', inputPath: 'd', amount: 2, unit: 'days', outputFormat: 'date' }, { d: '2026-01-01T00:00:00Z' });
    expect(out.datetime).toBe('2026-01-03');
  });
  it('diffs in hours', () => {
    const out = runDateTime(
      { kind: 'datetime', operation: 'diff', inputPath: 'a', comparePath: 'b', diffUnit: 'hours' },
      { a: '2026-01-01T00:00:00Z', b: '2026-01-01T05:00:00Z' },
    );
    expect(out.datetime).toBe(5);
  });
});

describe('crypto_util node', () => {
  it('hashes sha256', () => {
    const out = runCryptoUtil({ kind: 'crypto_util', operation: 'hash', algorithm: 'sha256', inputPath: 'v' }, { v: 'hello' });
    expect(out.crypto).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });
  it('round-trips base64', () => {
    const enc = runCryptoUtil({ kind: 'crypto_util', operation: 'base64_encode', inputPath: 'v', outputKey: 'e' }, { v: 'hi' });
    const dec = runCryptoUtil({ kind: 'crypto_util', operation: 'base64_decode', inputPath: 'e' }, { e: enc.e });
    expect(dec.crypto).toBe('hi');
  });
  it('hmac uses the secret', () => {
    const out = runCryptoUtil({ kind: 'crypto_util', operation: 'hmac', inputPath: 'v', secretPath: 's' }, { v: 'msg', s: 'key' });
    expect(typeof out.crypto).toBe('string');
    expect((out.crypto as string).length).toBe(64);
  });
  it('generates a uuid', () => {
    const out = runCryptoUtil({ kind: 'crypto_util', operation: 'uuid' }, {});
    expect(out.crypto).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('markdown node', () => {
  it('converts markdown to html', () => {
    expect(markdownToHtml('# Title\n\nHello **world**')).toContain('<h1>Title</h1>');
    expect(markdownToHtml('Hello **world**')).toContain('<strong>world</strong>');
  });
  it('converts html to markdown', () => {
    expect(htmlToMarkdown('<h1>Title</h1><p>Hello <strong>world</strong></p>')).toContain('# Title');
    expect(htmlToMarkdown('<p>Hello <strong>world</strong></p>')).toContain('**world**');
  });
  it('runs via the handler', () => {
    const out = runMarkdown({ kind: 'markdown', operation: 'to_html', inputPath: 'md' }, { md: '# Hi' });
    expect(out.html).toContain('<h1>Hi</h1>');
  });
});

describe('xml_parse node', () => {
  it('parses XML to JSON', () => {
    const json = xmlToJson('<root><a>1</a><b>two</b></root>') as Record<string, any>;
    expect(json.root.a).toBe('1');
    expect(json.root.b).toBe('two');
  });
  it('parses attributes and repeated elements', () => {
    const json = xmlToJson('<list><item id="1">a</item><item id="2">b</item></list>') as any;
    expect(Array.isArray(json.list.item)).toBe(true);
    expect(json.list.item[0]['@_id']).toBe('1');
  });
  it('builds XML from JSON', () => {
    const xml = jsonToXml({ note: { to: 'me', body: 'hi' } });
    expect(xml).toContain('<note>');
    expect(xml).toContain('<to>me</to>');
  });
  it('runs via the handler', () => {
    const out = runXmlParse({ kind: 'xml_parse', operation: 'parse', inputPath: 'x' }, { x: '<r><n>5</n></r>' });
    expect((out.json as any).r.n).toBe('5');
  });
});

describe('json_schema_validate node', () => {
  it('passes a valid object', () => {
    const v = validateJsonSchema({ name: 'a', age: 3 }, { type: 'object', required: ['name'], properties: { age: { type: 'number' } } });
    expect(v).toHaveLength(0);
  });
  it('flags violations', () => {
    const out = runJsonSchemaValidate(
      { kind: 'json_schema_validate', schema: JSON.stringify({ type: 'object', required: ['name'] }), onViolation: 'flag' },
      { age: 3 },
    );
    expect(out.valid).toBe(false);
    expect((out.violations as unknown[]).length).toBeGreaterThan(0);
  });
  it('blocks (throws) on violation', () => {
    expect(() =>
      runJsonSchemaValidate(
        { kind: 'json_schema_validate', schema: JSON.stringify({ type: 'object', required: ['name'] }), onViolation: 'block' },
        { age: 3 },
      ),
    ).toThrow();
  });
});

describe('html_extract node', () => {
  const html = '<div class="post"><h2>One</h2><a href="/x">link</a></div><div class="post"><h2>Two</h2></div>';
  it('extracts text by selector', () => {
    const out = runHtmlExtract({ kind: 'html_extract', inputPath: 'html', selector: '.post h2', extractAs: 'text', multiple: true }, { html });
    expect(out.extracted).toEqual(['One', 'Two']);
  });
  it('extracts an attribute', () => {
    const out = runHtmlExtract({ kind: 'html_extract', inputPath: 'html', selector: 'a', extractAs: 'attribute', attribute: 'href' }, { html });
    expect(out.extracted).toBe('/x');
  });
  it('queryAll matches a tag selector', () => {
    const root = parseHtml(html);
    expect(queryAll(root, 'h2').length).toBe(2);
  });
});

describe('sticky_note node', () => {
  it('passes input through', () => {
    expect(runStickyNote({ kind: 'sticky_note', content: 'x' }, { a: 1 })).toEqual({ a: 1 });
  });
});
